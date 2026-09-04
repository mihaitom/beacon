"""core/radio_position.py — tracks a cast device's own reported position for
radio, for the two things that both need "has the device started really
playing yet, and if so what does it say": the radio-cast visualizer's
frame-release clock (core/visualizer_feed.py) and the frontend's "still
buffering" label (core/session.py's build_status_dict()). One shared poller
for both, not two — DlnaDelivery.get_position() is a real SOAP round trip
per call (see delivery/dlna.py), and this shouldn't double it.

Chromecast, DLNA, and Sonos — not AirPlay, which has no device-side
position to poll for radio at all. Chromecast/DLNA were measured live
(icy_sync_probe.py, 2026-09-02) to report a real, stable position for a
continuous radio stream once past their own startup buffer (~10.6-11.0s
for Chromecast, ~5.4-5.6s for DLNA). Sonos joined the same day: its own
http:// radio dispatch (see delivery/sonos.py's own comment on why that's
kept over x-rincon-mp3radio://) already makes it report a real, live
position too — confirmed live (device=6.00s at wall=8.08s) — so the ICY
marker injection once planned for it turned out unnecessary; this same
poll-and-wait-for-movement approach just works there as well.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from .state import is_still_targeted

if TYPE_CHECKING:  # avoids a session <-> radio_position import cycle at runtime
    from delivery import BaseDelivery

    from .session import SessionState

logger = logging.getLogger("connect.radio_position")

# Cadence proven live against real Chromecast/DLNA devices during the
# ICY-sync investigation (scripts/icy_sync_probe.py) — tight enough for
# smooth visualizer pacing, without hammering DLNA's real per-call SOAP
# round trip. Only actually used while that pacing matters — see
# _poll_interval().
_POLL_INTERVAL_SECONDS = 0.5

# Cadence once `ready` has already latched True (radio_buffering has
# already gone False for good — see build_status_dict()) and nobody has
# the radio visualizer open to consume continuous updates from this
# tracker. Matches routes/playback.py's own _resync_position_periodically
# cadence, on the same reasoning: at that point this poll exists only so
# elapsed_fn() isn't stale *if* a visualizer opens later, not because
# anything is consuming it right now. Reported live 2026-09-02/03: this
# tracker used to poll at _POLL_INTERVAL_SECONDS for a radio session's
# entire lifetime regardless of whether the visualizer was ever opened —
# for Sonos, whose get_position() is two real HTTP round trips per call
# (delivery/sonos.py's own comment), that is 4 requests/second sustained
# against the physical speaker for as long as radio played, a scale of
# continuous network chatter this app had never produced before (compare
# _resync_position_periodically's own 8s cadence, called "the loudest
# thing this app does to the network" in its own comment) — user reported
# general radio playback (not just visualizer use) regressing compared to
# the previous day's build, traced to this via a diff against that day's
# last commit.
_IDLE_POLL_INTERVAL_SECONDS = 8.0

# How much higher than the current baseline reading a later one has to be
# before this is trusted as "the device actually started playing" rather
# than noise/rounding on a device still sitting at a standstill. Deliberately
# not "any increase at all" — DLNA's RelTime is whole-second resolution (see
# delivery/dlna.py's own get_position()), so two adjacent integer-second
# readings could differ by rounding alone even with nothing really moving.
_MOVEMENT_THRESHOLD_SECONDS = 1.5

# How long a baseline is trusted before re-baselining against whatever the
# latest reading is instead. Chromecast's get_position() (see
# delivery/chromecast.py) reads a cached, socket-pushed status object rather
# than forcing a fresh one — a Chromecast object is reused across dispatches
# (delivery/chromecast.py's own _chromecast_cache), so the very first poll
# after a fresh /play-url can catch leftover status from whatever this same
# device was doing a moment ago (a previous station, a previous session)
# instead of anything belonging to the new one. A poisoned baseline like
# that can sit arbitrarily far ahead of the real, newly-climbing position,
# so "wait for +1.5s over the *first* reading" could then never fire.
# Re-baselining periodically bounds how long a bad first sample can block
# readiness — reported live 2026-09-02 as the buffering indicator never
# clearing for an actual, audibly-playing Chromecast radio cast.
_REBASELINE_AFTER_SECONDS = 3.0


class RadioPositionTracker:
    """One per radio dispatch to a Chromecast/DLNA target — created fresh in
    routes/playback.py's /play-url and stored on
    SessionState.radio_position_tracker, replacing whatever was there
    before (a station change, a different target type, or /stop all just
    move that reference on).

    Self-terminates the same way routes/playback.py's
    _resync_position_periodically() does: checks play_generation/
    is_streaming every cycle rather than needing an explicit stop() call,
    so a fresh /play-url (new generation, new tracker) simply leaves the
    old one to notice and exit on its own — nothing else needs to reach in
    and cancel it, and nothing reads it anymore once the session's own
    reference has moved on.

    That self-termination cuts both ways, though: /resume and /seek both
    bump play_generation (PlaybackClock.resume()/seek_to()) for the same
    reason _resync_position_periodically needs rescheduling there (see
    those two routes' identical comments) — a tracker that isn't
    explicitly restarted at the new generation just quietly exits on its
    next poll and never comes back, leaving radio_buffering stuck True
    forever even though playback resumes completely normally. Reported
    live 2026-09-02: a Sonos radio dispatch auto-pauses/resumes seconds
    after /play-url as apparently a routine part of its own dispatch flow
    (not something this module can prevent or predict), which hit this
    exact gap immediately, every time.
    """

    def __init__(
        self,
        session: SessionState,
        delivery: BaseDelivery,
        generation: int,
        started_at: float | None = None,
    ) -> None:
        self._session = session
        self.delivery = delivery
        self._generation = generation
        self._position: float = 0.0
        self._baseline: float | None = None
        self._baseline_set_at: float = 0.0
        self.ready = False
        # Wall-clock reference for buffer_lag() below — "the moment this
        # station was dispatched to the device". monotonic(), like every
        # other timestamp in this class, not time.time() — this is only
        # ever compared against other monotonic() reads, never persisted or
        # shown to a user, so it doesn't need wall-clock meaning.
        #
        # Defaults to now, which is right for every call site that builds a
        # tracker immediately after actually dispatching (routes/playback.py's
        # /play-url, /resume and /seek all do). routes/devices.py's
        # /device-stop does not: it hands tracking over to a device that has
        # been playing all along and is not re-dispatched, so it passes that
        # device's real dispatch time through instead (see `started_at` in
        # this class's own `started_at` property). Defaulting there would put
        # `_started_at` at `now` while `_position` is already minutes in,
        # making buffer_lag() negative — see that method for what silently
        # went wrong downstream.
        self._started_at = time.monotonic() if started_at is None else started_at
        # Held so the poll loop can't be silently garbage-collected mid-run
        # — asyncio only keeps a weak reference to a task once nothing else
        # holds a strong one.
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    @property
    def started_at(self) -> float:
        """This tracker's dispatch reference, for a caller building a
        replacement tracker for a device that is still playing the same
        dispatch — see __init__'s `started_at` and routes/devices.py."""
        return self._started_at

    def elapsed_fn(self) -> float:
        """Cheap, synchronous — the last polled position, held constant
        between polls rather than extrapolated. Extrapolating during the
        device's own startup buffering would grow a number that has
        nothing real behind it yet — precisely the failure mode the
        Chromecast measurement this module is built from ruled out."""
        return self._position

    def buffer_lag(self) -> float | None:
        """How far behind wall-clock-time-since-dispatch the device's own
        reported position currently runs — i.e. a live measurement of this
        specific device's own startup-buffering delay, for
        core/visualizer_feed.py's _OffsetTrackerClock to fold into its
        baseline (see that class's own comment on why the naive baseline it
        used before this method existed silently cancelled this same
        quantity back out instead of preserving it).

        None until `ready`: before that, the device is still sitting in its
        own startup stall (elapsed_fn() not really moving yet — see that
        method's own comment), so "time since dispatch minus position"
        isn't a stable buffering delay yet, just however far into that
        stall the device happens to be at this exact instant. Once ready,
        this device has settled into playing at real-time speed, and the
        gap becomes a genuine, steady per-device constant — Chromecast's
        own decode+HDMI pipeline, DLNA's own render buffer, or Sonos's own
        buffer over the http:// dispatch delivery/sonos.py uses (all three
        measured live via scripts/icy_sync_probe.py, see this module's own
        docstring for the numbers) — not something that should keep
        drifting the caller's baseline around for the rest of the run on
        ordinary poll jitter, which is why the caller applies this once
        rather than calling it on every frame.

        None, rather than 0.0, when the arithmetic comes out negative —
        `self._started_at` is a proxy for the real dispatch moment, not the
        moment itself (see its own comment), and a negative result means
        that proxy is simply wrong for this tracker, not that the device
        has no buffering delay.

        That distinction is load-bearing, because one call site breaks the
        proxy outright: routes/devices.py's /device-stop builds a
        replacement tracker for a device that is *already playing* and was
        never re-dispatched, so `_started_at` is `now` while `_position` is
        already however many minutes into the station. Flooring that at
        0.0 handed _OffsetTrackerClock._apply_measured_lag() a lag of zero
        — which it then folds in and latches (`_lag_applied`) permanently,
        losing the correction for the rest of the session and leaving the
        visualizer running the device's whole buffer ahead of the audio, up
        to the ~10-11s a Chromecast alone accounts for. Returning None
        instead simply leaves that fold un-applied, so it is retried on
        every later call and lands as soon as a usable measurement exists."""
        if not self.ready:
            return None
        lag = time.monotonic() - self._started_at - self._position
        return lag if lag > 0 else None

    async def _run(self) -> None:
        try:
            while True:
                # Waiting on VisualizerFeed.watch_changed rather than a
                # plain sleep(self._poll_interval()) lets a subscriber
                # arriving mid-sleep cut a still-in-flight 8s idle wait
                # short — see _poll_interval() and that event's own
                # comment. A timeout is the common case (nothing watching
                # yet, or already past the interval).
                watch_changed = self._session.visualizer.watch_changed
                try:
                    await asyncio.wait_for(watch_changed.wait(), self._poll_interval())
                except TimeoutError:
                    pass
                watch_changed.clear()
                if not await self._poll_once():
                    return
        except asyncio.CancelledError:
            pass

    def _poll_interval(self) -> float:
        """See _IDLE_POLL_INTERVAL_SECONDS' own comment for why this isn't
        just a constant. Still not ready: always fast, so the buffering
        flag clears promptly. Already ready: fast only while
        VisualizerFeed.is_watching_radio() says something is actually
        consuming continuous updates, slow otherwise."""
        if not self.ready:
            return _POLL_INTERVAL_SECONDS
        if self._session.visualizer.is_watching_radio():
            return _POLL_INTERVAL_SECONDS
        return _IDLE_POLL_INTERVAL_SECONDS

    def _current(self) -> bool:
        st = self._session.state
        return st.clock.play_generation == self._generation and st.is_streaming

    async def _poll_once(self) -> bool:
        """One poll cycle — split out from _run() purely so it's directly
        testable without needing to unwind an infinite loop (same reasoning
        as routes/playback.py's _resync_position_once()). Returns False if
        the tracker should stop for good (generation changed, streaming
        stopped, or the device is no longer targeted); True to keep
        polling, whether or not this particular cycle found anything worth
        recording."""
        st = self._session.state
        if not self._current():
            return False
        # /device-stop can drop this delivery from the session without
        # touching play_generation — see is_still_targeted() (core/state.py)
        # for the prod incident that guard exists for. Checked before the
        # round trip too, not just after, so a device that's already gone
        # isn't polled at all.
        if not is_still_targeted(st.active_delivery, self.delivery):
            return False
        # A real device round trip while paused would just poll a frozen
        # position for as long as the pause lasts — same reasoning as
        # _resync_position_periodically's identical check. Matters more
        # here than there: a Sonos get_position() is two real HTTP round
        # trips (delivery/sonos.py's own comment), and a pause/resume
        # happening seconds into a fresh dispatch (see the play_generation
        # comment below) is apparently routine, not rare.
        if st.clock.is_paused:
            return True
        try:
            position = await self.delivery.get_position()
        except Exception as e:
            logger.debug(f"[radio-position] {self.delivery.target}: get_position() failed: {e}")
            return True
        # get_position() above is a real device round trip — same race
        # routes/playback.py's _resync_position_once() guards against: a
        # station change or /stop landing while it was in flight means this
        # reading belongs to a stream that isn't current anymore.
        if not self._current() or not is_still_targeted(st.active_delivery, self.delivery):
            return False
        if position is None or position < 0:
            return True
        self._position = position
        now = time.monotonic()
        if self._baseline is None:
            self._baseline = position
            self._baseline_set_at = now
            return True
        if not self.ready and position - self._baseline >= _MOVEMENT_THRESHOLD_SECONDS:
            self.ready = True
            logger.info(
                f"[radio-position] {self.delivery.target}: real movement detected "
                f"({self._baseline:.2f}s -> {position:.2f}s) — buffering done"
            )
        elif not self.ready and now - self._baseline_set_at >= _REBASELINE_AFTER_SECONDS:
            # No movement past the threshold within the window — either a
            # genuinely stalled device, or (see _REBASELINE_AFTER_SECONDS'
            # own comment) a poisoned first reading. Either way, watching
            # from here forward self-corrects without waiting indefinitely.
            self._baseline = position
            self._baseline_set_at = now
        return True
