"""core/visualizer_feed.py — Owns *when* the cast visualizer's analysis runs.

One instance per session. GET /visualizer (routes/stream.py) subscribes for
as long as a client actually has the fullscreen visualizer open, and nothing
is decoded or analyzed while nobody does — which is the whole point of this
module existing. Analysis used to be started unconditionally by the streaming
loop for every cast, running a second ffmpeg plus ~43 FFTs/s per stream
whether or not a single person was watching the result; the frames just
piled into a bounded queue and got dropped.

A supervisor task does the actual watching: every _SUPERVISE_INTERVAL (and
immediately whenever something notify()s it) it compares what *should* be
analyzed right now against what is, and reconciles the difference by
starting or stopping an AudioAnalyzer. Polling rather than hooking into
/play, /seek, /resume, auto-advance and /stop individually: those five paths
already carry a lot of playback bookkeeping each, and every one of them
would have to remember this too. PlaybackClock.play_generation already
increments on exactly the events that invalidate a running analysis (a new
track, a seek, a resume — each of which restarts the device's stream), so
watching that one value covers all of them without adding a sixth thing for
each to get wrong, at the cost of up to _SUPERVISE_INTERVAL of latency for
the paths that don't bother to notify().
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import TYPE_CHECKING

from .audio_analysis import AudioAnalyzer, should_analyze
from .state import TEST_TONE_TRACK_ID, list_target_pairs, test_tone_url

if TYPE_CHECKING:  # avoids a session <-> visualizer_feed import cycle at runtime
    from .radio_position import RadioPositionTracker
    from .radio_relay import RadioRelay
    from .session import SessionState

logger = logging.getLogger("connect.visualizer")

# How long the supervisor sleeps between checks when nothing wakes it sooner.
# Only an upper bound on how long a *silent* change (one whose handler
# doesn't call notify()) can go unnoticed — a stale analyzer keeps producing
# frames for the wrong track/position for that long, so this shouldn't be
# much longer, and the check itself is a couple of attribute reads.
_SUPERVISE_INTERVAL = 0.5

# A track's visualizer clock (st.clock, see PlaybackClock) is calibrated
# against the *device's own reported position* — routes/playback.py's
# position-resync — so it already accounts for however long the device
# buffers before content becomes audible. Radio has no equivalent whenever
# nothing can report a real position back (see this constant's own history
# below), so this is a fixed estimate instead, same spirit as
# core/streamer.py's own LOOKAHEAD_SECONDS assumption about how far a cast
# device's connection can legitimately run ahead of what it's actually
# playing, but not the same number — that one bounds how far *content
# dispatch* is allowed to lead, this one guesses how far *this analyzer's
# clock* needs to lag to match what's actually audible.
#
# Was an unverified guess (3.0s) until 2026-09-04, when delivery/sonos.py's
# own x-rincon-mp3radio:// dispatch (see _dispatch_uri()'s docstring — added
# to fix Sonos-only audio dropouts while relayed, a *device*-side buffering
# problem, unrelated to this constant) made _FirstByteClock the *common*
# case for Sonos radio again rather than the rare fallback it was between
# 2026-09-02 and then (real position feedback traded away for the same
# reason it was avoided in the first place — see core/state.py's
# first_radio_position_delivery()). Reusing the old 3.0s guess as-is read
# as "syncing to completely different content" (reported live) — not
# surprising, once actually measured: scripts/icy_sync_probe.py against a
# real Sonos on this exact x-rincon-mp3radio:// dispatch (2026-09-04) put
# the device's own lag at 4.699-4.994s (median 4.724s), comfortably outside
# the old guess. Still an estimate, not a live measurement — a real device
# lag that drifts session-to-session or station-to-station has no feedback
# signal here to correct for it, unlike Chromecast/DLNA's own
# RadioPositionTracker-backed clock — so this may need retuning again if a
# station or a firmware update shifts the real number. Reported live
# 2026-09-01: with no lead at all (0.0), a perfectly smooth visualizer
# still read as playing "in the future" relative to the speaker, badly
# enough to notice immediately — a reason to round up rather than down if
# this ever needs adjusting again.
ASSUMED_DEVICE_LEAD_SECONDS = 4.7

# Per-clock corrections, added on top of whatever each clock measures.
#
# Two separate values, not one, because the error is not the same on both
# paths — and the split falls exactly on the code boundary. Observed live
# 2026-09-05 against routes/debug.py's beep station: the visualizer ran
# ahead of the audio on every target, but Sonos differed from Chromecast
# and DLNA, while those two behaved alike. Chromecast and DLNA are the same
# path (_OffsetTrackerClock, fed by RadioPositionTracker polling the
# device's own reported position); Sonos is the other one (_FirstByteClock,
# fed by an ICY title echoed back over UPnP eventing). An error that tracks
# the path rather than the device is a property of how each path derives
# its lead, so one shared number would only ever be right for one of them.
#
# What each is correcting for is not established. A device needing a moment
# after its last reported position before sound leaves it would explain
# some of it, but not why two quite different devices (a Chromecast handing
# off over HDMI, a generic DLNA renderer) land in the same place while a
# Sonos does not. The honest description is a per-path calibration whose
# cause is still open — most likely in how each lead relates to this
# analyzer's own decode start, since everything downstream of that is
# shared by all three.
#
# Both default to 0 — deliberately, and that is a retraction. The first
# figure measured this way (about a second, 2026-09-05) came from watching
# routes/debug.py's beep station back when every beep was the same pitch,
# which makes "a second early" and "an interval minus a second late" the
# same observation. The number could not distinguish them, so it was not a
# measurement, and shipping it as a default would bake a guess into every
# install. The beep station now cycles through distinct pitches precisely so
# the reading is unambiguous (see _TONE_SEQUENCE_HZ there); whoever runs it
# sets these from what they actually see, and 0 until then means the clocks
# behave exactly as their own measurements say.
#
# Both read per call so trying a value needs no restart: watch the station,
# adjust, watch again.
_LEAD_CORRECTION_DEFAULT = 0.0
FIRST_BYTE_LEAD_CORRECTION_ENV = "BEACON_LEAD_CORRECTION_SONOS"
TRACKER_LEAD_CORRECTION_ENV = "BEACON_LEAD_CORRECTION_TRACKER"


def _lead_correction(env_var: str) -> float:
    """Seconds to add for one clock. A value that isn't a number falls back
    rather than raising — these are calibration aids, and a typo in one must
    not take radio casting down with it."""
    raw = os.environ.get(env_var)
    if raw is None:
        return _LEAD_CORRECTION_DEFAULT
    try:
        return float(raw)
    except ValueError:
        logger.warning(
            f"[visualizer] {env_var}={raw!r} is not a number — using {_LEAD_CORRECTION_DEFAULT}s"
        )
        return _LEAD_CORRECTION_DEFAULT


def first_byte_lead_correction() -> float:
    """For _FirstByteClock — the ICY-lead path, i.e. a relayed Sonos."""
    return _lead_correction(FIRST_BYTE_LEAD_CORRECTION_ENV)


def tracker_lead_correction() -> float:
    """For _OffsetTrackerClock — the polled-position path, i.e. Chromecast
    and DLNA, which were observed behaving alike and unlike Sonos."""
    return _lead_correction(TRACKER_LEAD_CORRECTION_ENV)


class _FirstByteClock:
    """elapsed_fn for a radio AudioAnalyzer with no RadioPositionTracker to
    drive it — a target type radio_position.py doesn't cover at all
    (AirPlay), or one it deliberately excludes for a specific dispatch (a
    relayed Sonos since 2026-09-04, see ASSUMED_DEVICE_LEAD_SECONDS' own
    history and core/state.py's first_radio_position_delivery()) — see
    _start_radio_analyzer()'s own comment for the current split. Zero
    until mark() (passed to AudioAnalyzer as
    `on_first_byte`) fires on this run's first decoded PCM, not from
    construction — spawning this analyzer's own ffmpeg and it actually
    having produced a byte are not the same moment (its own connect/first-
    response latency still has to elapse, a gap that varies by station).
    Zeroing at construction counted that gap as already-elapsed content
    time, so every frame this analyzer ever produced started life "late" by
    exactly that amount — past _MAX_LATENESS_SECONDS (0.15s) for good,
    since the gap doesn't shrink over time. core/audio_analysis.py's
    _release_frames() drops a frame that late rather than releasing it
    stale, so the practical effect was a visualizer stuck at whatever rare
    frame happened to land inside that 150ms window by chance — reported
    live 2026-09-01 as "0.5fps", worse on some stations than others,
    exactly matching a fetch-latency-dependent bug rather than a pacing
    one. Also subtracts a device lead — ASSUMED_DEVICE_LEAD_SECONDS by
    default, or session.radio_icy_measured_lag once a real one exists (see
    elapsed()) — see that constant's own comment for the separate problem
    the subtraction itself fixes.

    The lead is the fixed estimate, adjustable via
    first_byte_lead_correction(). It is deliberately *not* taken from
    session.radio_icy_measured_lag, though that measurement still runs and
    is still logged — routes/upnp.py keeps producing it, because seeing it
    is useful, and because it is the only visibility there is into what the
    device reports.

    Driving the clock from it was tried and measured, and it made the sync
    worse. Four consecutive runs against a real Sonos on 2026-09-05 produced
    16.63s, 3.48s, 3.01s and 1.43s, and a station restart moved it again —
    while the uncalibrated fixed estimate stayed the closest match by ear
    throughout. Every sample also came out *below* the real figure, which
    fits how the signal is produced: a device reports a StreamTitle once it
    has decoded the block carrying it, which is earlier than playing it, so
    the round trip understates the lead by whatever the device's own output
    stage adds.

    That downward bias is what makes the estimator worse the harder it
    works. Keeping the smallest sample is the right shape for noise that can
    only overshoot (Sonos's own event moderation, which produced the 16.63s
    reading) — but with a bias that only ever undershoots, the minimum
    chases it, and every additional sample drags the lead further from the
    truth. The 8-second marker pulse added to supply more samples (see
    core/icy_metadata.py's pulsed_title()) therefore accelerated the drift
    rather than converging it. A measurement that degrades with more data is
    not measuring the quantity it is being read as."""

    def __init__(self, session: SessionState) -> None:
        self._session = session
        self._first_byte_at: float | None = None

    def mark(self) -> None:
        if self._first_byte_at is None:
            self._first_byte_at = time.monotonic()

    def elapsed(self) -> float:
        if self._first_byte_at is None:
            return 0.0
        lead, _ = self._lead()
        return max(0.0, time.monotonic() - self._first_byte_at - lead)

    def _lead(self) -> tuple[float, bool]:
        """(lead to use, whether it's a live ICY measurement).

        Always the fixed estimate now — the ICY round trip is measured and
        logged, but no longer steers this clock. See the class docstring for
        the measurements that retired it.
        """
        return (ASSUMED_DEVICE_LEAD_SECONDS + first_byte_lead_correction(), False)

    def debug_lead(self) -> tuple[float, bool]:
        """(lead currently in use, whether it's a live ICY measurement) —
        the same value elapsed() itself uses, exposed for GET /visualizer's
        debug overlay (core/audio_analysis.py's
        AudioAnalyzer.last_release_lead) so a listener can tell "still the
        fixed guess" apart from "a real measurement landed" — the whole
        reason this overlay was built in the first place, per the exact
        question live 2026-09-05: seeing -4.7s on the delta overlay alone
        doesn't say whether that's the constant being echoed back (nothing
        measured yet) or a coincidence.

        Reads through _lead() rather than the session field directly, so
        the overlay reports the lead actually in effect — a later, differing
        measurement landing on the session is deliberately not adopted, and
        showing it here would describe a clock this run isn't using."""
        return self._lead()


class _OffsetTrackerClock:
    """elapsed_fn for a radio AudioAnalyzer backed by a
    core/radio_position.py RadioPositionTracker — see
    VisualizerFeed._start_radio_analyzer()'s own comment for why the raw
    tracker value needs an offset at all (it's the device's *absolute*
    position, content_position is relative to this one subscription's own
    start).

    Also smooths the tracker's own ~0.5s poll cadence into something
    continuous, the same reason stores/playback/positionTracker.ts exists
    on the frontend side for the exact same kind of stepped value: without
    it, elapsed_fn only actually changes once per poll, so
    _release_frames() only ever finds a frame due right at that instant —
    everything else sits waiting for the next poll to unblock it, capping
    the effective frame rate at roughly the poll rate (~2fps) instead of
    the ~43fps this is sized for. Reported live 2026-09-02, right after
    the offset fix above finally got real frames releasing at all.

    Only extrapolates once `tracker.ready` — before that, the device may
    still be sitting in its own startup stall (raw value not really
    moving), and extrapolating forward through that would grow a number
    with nothing real behind it, exactly the failure mode
    core/radio_position.py's own RadioPositionTracker.elapsed_fn() was
    built to avoid at the source. A raw (unsmoothed, but still
    offset-corrected) step is what this returns until then — no worse
    than before this class existed, since nothing is really happening yet
    either way.

    Monotonic once extrapolating: a fresh poll only ever moves the anchor
    *forward*, never back, even if the newly-polled raw value reads below
    what was already being extrapolated (that itself running a hair ahead
    of the device's real rate is expected jitter, not a rewind — radio
    never plays backward). Snapping down to a lower raw value would freeze
    _release_frames() until content_position caught back down to match,
    on top of whatever real gap already existed — reported live
    2026-09-02 as the visualizer visibly running fast for a stretch and
    then freezing for 0.5-1s, repeating roughly every poll: exactly this
    round-trip of over-extrapolating and then snapping back.

    Folds in RadioPositionTracker.buffer_lag() once it's measurable — see
    _apply_measured_lag(). Without it, `raw` above reduces algebraically to
    plain wall-clock time since mark() regardless of the device's own
    buffering delay: for a steady-state device, elapsed_fn() at any later
    moment equals its value at mark() plus however much wall time has
    passed, so subtracting the two cancels that delay out of the result
    instead of preserving it. That is invisible in a unit test that only
    checks the *shape* of the output (which is exactly right — smoothed,
    monotonic, forward-only) but not its absolute lag against real device
    audio, and it was invisible live too, for the same reason: a visualizer
    that free-runs fast doesn't look broken by itself, it looks broken next
    to the speaker. Reported live 2026-09-03/04 as the cast visualizer
    running seconds ahead of the actual audio — worst on Chromecast (~10-11s
    own startup buffer, see core/radio_position.py's module docstring),
    smaller but still audible on DLNA and Sonos."""

    def __init__(self, session: SessionState) -> None:
        self._session = session
        self._tracker: RadioPositionTracker | None = None
        self._baseline: float | None = None
        self._last_value: float | None = None
        self._last_seen_at: float = 0.0
        # The last value handed out, so a tracker swap can carry on from it
        # rather than restarting the count — see _rebase_if_tracker_changed().
        self._last_elapsed: float = 0.0
        # Set once mark() fires, even if no tracker was available at that
        # exact moment — see _try_set_baseline().
        self._first_byte_seen: bool = False
        # Whether this run's _baseline already has the current tracker's
        # measured buffer_lag() folded in — see _apply_measured_lag(). Reset
        # whenever the tracker itself changes (_rebase_if_tracker_changed()),
        # since a swapped-in tracker can belong to a different device with
        # its own, differently-lagging buffer.
        self._lag_applied: bool = False

    def _rebase_if_tracker_changed(self, tracker: RadioPositionTracker) -> None:
        """Follow whichever RadioPositionTracker the session currently
        holds, rather than the one that existed when this run started.

        routes/playback.py's /play-url replaces that tracker on every
        dispatch, and a Sonos re-dispatches seconds into its own flow as a
        matter of routine. A clock pinned to the previous one reads its
        frozen last value forever — a flat 0.00s once the baseline is
        subtracted — and no frame is ever released again.

        Rebasing keeps the value continuous across the swap: content
        position keeps counting through it, so resetting to zero here would
        leave every already-decoded frame stranded in the future. The new
        tracker starting from 0 simply holds this clock still until the
        device is playing again, which is exactly right."""
        if tracker is self._tracker:
            return
        self._tracker = tracker
        # A new tracker means a new device (or the same device re-dispatched
        # from scratch) with its own buffer_lag() to measure — whatever was
        # folded into _baseline for the old one no longer applies. Cleared
        # unconditionally, not just in the branch below: _try_set_baseline()
        # must not skip the fold for a first-ever baseline either.
        self._lag_applied = False
        if self._baseline is None:
            # Nothing decoded yet — mark() still owns the first baseline,
            # and taking one here would put it back at construction time,
            # which is the very thing mark() exists to avoid.
            return
        self._baseline = tracker.elapsed_fn() - self._last_elapsed
        self._last_value = None
        self._last_seen_at = 0.0

    def mark(self) -> None:
        """Passed to AudioAnalyzer as `on_first_byte`. The baseline has to
        be the device's position at the moment this analyzer's *first
        decoded byte* exists, not at the moment it was constructed:
        content_position counts from that first byte, while the tracker
        keeps climbing through ffmpeg's spawn and the relay's first
        hand-off in between. Taking it at construction charged that gap to
        content time, leaving every frame of the run that much ahead of
        the device — the same mistake _FirstByteClock exists to avoid, and
        the reason that class's own comment about the tracker "having
        nothing to zero" was wrong: the tracker needs no zeroing, but the
        baseline drawn from it still has to be taken at the right moment —
        and, since that fix alone still left the device's own buffering
        delay cancelled out of the result (see this class's own docstring
        and _apply_measured_lag()), corrected for that too, once it's
        measurable."""
        self._first_byte_seen = True
        self._try_set_baseline()

    def _try_set_baseline(self) -> None:
        """The actual baseline-taking behind mark() — also retried from
        elapsed(). A station change or /stop can clear
        session.radio_position_tracker in the narrow window between this
        analyzer's first decoded byte and mark() reading it, which used to
        mean no baseline was *ever* taken for that run: mark() only fires
        once, and _rebase_if_tracker_changed() only rebases an *existing*
        baseline. Retrying this from elapsed() closes that gap — the
        baseline still lands as close to first-byte as a tracker being
        available allows, instead of freezing this clock at 0.0 for the
        rest of the run."""
        if self._baseline is not None or not self._first_byte_seen:
            return
        tracker = self._session.radio_position_tracker
        if tracker is None:
            return
        self._tracker = tracker
        self._baseline = tracker.elapsed_fn()
        self._last_elapsed = 0.0

    def elapsed(self) -> float:
        tracker = self._session.radio_position_tracker
        if tracker is None:
            # Radio stopped casting to a tracked target — hold the last
            # value rather than snapping to zero, which would strand every
            # decoded frame in the future.
            return self._last_elapsed
        self._rebase_if_tracker_changed(tracker)
        if self._baseline is None:
            self._try_set_baseline()
        if self._baseline is None:
            # Nothing decoded yet, so no frame can be due: content_position
            # starts at 0 and _release_frames() holds back anything above
            # elapsed. Judging that first frame against a baseline that
            # doesn't exist yet is exactly what mark() prevents.
            return 0.0
        self._apply_measured_lag(tracker)
        raw = max(0.0, tracker.elapsed_fn() - self._baseline)
        if not tracker.ready:
            self._last_elapsed = raw
            return raw
        now = time.monotonic()
        if self._last_value is None:
            self._last_value = raw
            self._last_seen_at = now
            self._last_elapsed = raw
            return raw
        extrapolated = self._last_value + (now - self._last_seen_at)
        if raw >= extrapolated:
            self._last_value = raw
            self._last_seen_at = now
            self._last_elapsed = raw
            return raw
        self._last_elapsed = extrapolated
        return extrapolated

    def _apply_measured_lag(self, tracker: RadioPositionTracker) -> None:
        """Fold RadioPositionTracker.buffer_lag() into _baseline, once it's
        actually measurable — i.e. once `tracker.ready`, same gate that
        method uses itself.

        Without this, _baseline is exactly what _try_set_baseline() /
        _rebase_if_tracker_changed() leave it at: the device's own (already
        lagging) reported position, taken once. `raw` in elapsed() is then
        `tracker.elapsed_fn() - _baseline`, and for a device playing at
        real-time speed that reduces to plain wall-clock time since the
        baseline was taken — do the algebra: elapsed_fn() at any later
        moment is (baseline_value + buffer_lag) - buffer_lag +
        wall_time_since = baseline_value + wall_time_since, so the lag term
        cancels out of the subtraction instead of surviving it. Every frame
        this clock ever releases would then be exactly `lag` seconds ahead
        of what the device is actually playing — reported live 2026-09-03/
        04, worst on Chromecast (~10-11s of its own startup buffer, see
        core/radio_position.py's module docstring for the measured numbers)
        but present on DLNA and Sonos too, just by less.

        Adding the measured lag to _baseline instead keeps that quantity in
        the subtraction: `raw` becomes tracker.elapsed_fn() - (baseline +
        lag), i.e. exactly `lag` seconds *behind* where it would otherwise
        read, until the device (and content_position, decode having spent
        that same stretch paused against its own lookahead cap — see
        core/audio_analysis.py's _MAX_LOOKAHEAD_SECONDS) genuinely catches
        up to it. That is a one-time, real hold at the point this first
        applies (typically right as `ready` flips, seconds into the run) —
        the visualizer staying dark that long is correct, not a bug: none
        of this content was actually audible yet either.

        Applied once per baseline (see _lag_applied and its own reset in
        _rebase_if_tracker_changed()), not re-applied on every call even
        though buffer_lag() itself is a live measurement that could in
        principle be read again and again: a real device's own buffering
        delay is a steady pipeline constant for the run, not something
        expected to wander, and re-adding a slightly different reading
        later would jump _baseline (and so elapsed()'s output) by that
        difference for no benefit — the same class of visible glitch the
        monotonic-extrapolation logic above exists to avoid for tracker
        jitter generally."""
        if self._lag_applied:
            return
        lag = tracker.buffer_lag()
        if lag is None:
            return
        # Plus the output stage the device does not report — the same term
        # _FirstByteClock adds to its own, unrelated measurement, for the
        # reason spelled out at VISUALIZER_LEAD_CORRECTION_ENV: a polled position
        # is where the decoder is, not where the sound is.
        self._baseline += lag + tracker_lead_correction()
        self._lag_applied = True


class VisualizerFeed:
    """Start/stop lifecycle around at most one AudioAnalyzer per session.

    `analyzer` is what GET /visualizer reads frames from, and is None
    whenever nothing should be analyzed — nobody watching, nothing playing,
    or playing to a target that can't be analyzed (radio, see
    should_analyze()). The route re-reads it on every iteration rather than
    capturing it once, since it's replaced on every track change and seek.
    """

    def __init__(self, session: SessionState) -> None:
        self._session = session
        self._subscribers = 0
        self._task: asyncio.Task | None = None
        # Set to wake the supervisor early — a subscriber arriving or
        # leaving, or a handler that just changed playback state and doesn't
        # want to wait out _SUPERVISE_INTERVAL for it to be noticed.
        self._wake = asyncio.Event()
        # Set alongside _wake whenever the subscriber count changes, so
        # core/radio_position.py's RadioPositionTracker can react to
        # is_watching_radio() flipping without waiting out its own current
        # sleep first — see that module's _poll_interval().
        self.watch_changed = asyncio.Event()
        # What `analyzer` was started for: (play_generation, track id). The
        # supervisor restarts analysis whenever this no longer matches what's
        # actually playing — see _target_key().
        self._key: tuple[int, str] | None = None
        # The relay fan-out subscription a radio run holds, so _stop_analyzer()
        # can hand it back — a queue left subscribed keeps being filled with
        # audio nobody decodes any more, for as long as the station plays.
        # Paired with the relay it was actually taken out on: a station
        # change replaces session.radio_relay with a fresh RadioRelay before
        # the old analyzer is torn down, so unsubscribing from whatever
        # relay is *current* at teardown time can silently miss — the
        # subscription lives on the old relay, not the new one.
        self._audio_queue: asyncio.Queue[bytes | None] | None = None
        self._audio_relay: RadioRelay | None = None
        self.analyzer: AudioAnalyzer | None = None

    def subscribe(self) -> None:
        """One more client is watching. Starts the supervisor (and, on its
        first pass, analysis itself) if this is the first — there is no
        supervisor task at all while nobody is watching, same as there is no
        decoder."""
        self._subscribers += 1
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._supervise())
        self._wake.set()
        self.watch_changed.set()

    def unsubscribe(self) -> None:
        """One fewer client is watching. Analysis stops as soon as the
        supervisor wakes (immediately, unless it's mid-await) if that was
        the last one — floored at 0 so a double unsubscribe, e.g. a route
        whose finally runs after an error path already released, can't drive
        the count negative and strand the analyzer running forever."""
        self._subscribers = max(0, self._subscribers - 1)
        self._wake.set()
        self.watch_changed.set()

    def notify(self) -> None:
        """Tell the supervisor something about playback just changed, so it
        reconciles now instead of on its next tick. Purely a latency
        optimization — never required for correctness, since the next tick
        would notice the same thing anyway."""
        self._wake.set()

    async def shutdown(self) -> None:
        """Stop analysis and the supervisor for good — for a session being
        reaped (core/session.py's reap_once()), not for playback merely
        stopping, which the supervisor handles on its own. Subscribers
        aren't cleared: the session itself is going away, and its /visualizer
        connections with it."""
        if self._task:
            self._task.cancel()
            self._task = None
        await self._stop_analyzer()

    def _target_key(self) -> tuple[int, str] | None:
        """(play_generation, track id) of what should be analyzed right now,
        or None if that's nothing. play_generation is what makes a seek or a
        resume — both of which move playback without changing the track —
        restart analysis at the new position; see core/playback_clock.py.

        Radio (current_track is None — see routes/playback.py's /play-url)
        is analyzable too, but only once routed through Beacon's own relay
        (core/radio_relay.py): that's the only case with a shared PCM
        stream to tap at all. The opt-in "direct to device" exception
        (PlayUrlRequest.cast_directly) has no such source — the device
        reads the station straight from itself or Beacon's proxy, never
        through this backend's own analysis pipeline — so it stays
        unanalyzable, same as before this branch existed.

        In practice this branch never actually returns non-None today: the
        frontend never subscribes to GET /visualizer for radio while
        casting at all (NowPlayingView.vue's visualizerAvailable, gated off
        deliberately — see _start_radio_analyzer()'s own docstring for
        why), which already means self._subscribers stays 0 for it above.
        Left in rather than removed — a real, tested implementation with
        nothing wrong with it except needing a clock nothing can currently
        give it a reliable answer for."""
        if self._subscribers == 0:
            return None
        st = self._session.state
        if not st.is_streaming:
            return None
        if not should_analyze(list_target_pairs(st.active_delivery)):
            return None
        if st.current_track is not None:
            return (st.clock.play_generation, st.current_track.id)
        relay = self._session.radio_relay
        if st.radio_info and relay is not None:
            return (st.clock.play_generation, f"radio:{relay.url}")
        return None

    async def _supervise(self) -> None:
        """Lives exactly as long as somebody is subscribed — an idle session
        has no supervisor and no decoder, only the counter."""
        try:
            while self._subscribers > 0:
                key = self._target_key()
                if key != self._key:
                    await self._stop_analyzer()
                    self._key = key
                    if key is not None:
                        await self._start_analyzer(key)
                try:
                    await asyncio.wait_for(self._wake.wait(), _SUPERVISE_INTERVAL)
                except TimeoutError:
                    pass
                self._wake.clear()
        except asyncio.CancelledError:
            pass
        finally:
            # Nothing this run started outlives it, however it ended.
            # Skipped entirely once shutdown() has already taken ownership
            # away (it clears _task before cancelling, then tears down
            # itself) — this run must not then clobber state belonging to
            # whatever came after it.
            if self._task is asyncio.current_task():
                self._task = None
                await self._stop_analyzer()
                self._key = None
                if self._subscribers > 0:
                    # Somebody subscribed in the same breath this run was
                    # winding down: they saw a task that hadn't finished
                    # yet, so they left starting the next one to us.
                    self._task = asyncio.create_task(self._supervise())

    async def _start_analyzer(self, key: tuple[int, str]) -> None:
        if self._session.state.current_track is not None:
            await self._start_track_analyzer(key)
        else:
            await self._start_radio_analyzer(key)

    async def _start_track_analyzer(self, key: tuple[int, str]) -> None:
        st = self._session.state
        track = st.current_track
        if track is None:
            return
        try:
            # Resolving a track id is a real network round-trip for Plex
            # (see media/plex.py) — off the event loop, same as
            # routes/stream.py's own resolution does it.
            source_url = (
                test_tone_url()
                if track.id == TEST_TONE_TRACK_ID
                else await asyncio.to_thread(self._session.media.get_stream_url, track.id)
            )
        except Exception as e:
            logger.warning(f"[visualizer] Could not resolve {track.id} for analysis: {e}")
            return
        # That await took time — a track change, a seek, or the last
        # subscriber leaving during it means this analyzer would start at a
        # position nothing is playing at any more.
        if self._target_key() != key:
            return
        # Read *after* the URL is in hand, so the decoder seeks to where
        # playback is when it actually starts rather than where it was when
        # this was decided. Whatever startup delay remains (spawning ffmpeg,
        # its first fetch) is absorbed by _release_frames() dropping the
        # frames it makes it late for — see _MAX_LATENESS_SECONDS.
        position = st.clock.elapsed()
        analyzer = AudioAnalyzer(
            elapsed_fn=lambda: st.clock.elapsed(),
            source_url=source_url,
            start_offset=position,
            gain=st.current_track_gain,
            # Same function as elapsed_fn above, not a stand-in for a
            # "second opinion" the way radio's own has one — see
            # AudioAnalyzer's own docstring for why that's fine (still
            # meaningful) rather than redundant: GET /visualizer's debug
            # overlay comparing content_position against a *live* re-read
            # of this still surfaces a real backlog in this analyzer's own
            # release pipeline, or in SSE/render delivery further out, even
            # when the two clocks feeding it are identical by construction.
            # Reported live 2026-09-05: the listener wanting the overlay
            # available for track casts too, not just Sonos radio.
            debug_cast_elapsed_fn=lambda: st.clock.elapsed(),
        )
        await analyzer.start()
        if not analyzer.started:
            # Spawn failed (see AudioAnalyzer.start()) — leave self._key
            # unset so the next supervisor tick retries instead of staying
            # stuck on this generation forever.
            self._key = None
            return
        self.analyzer = analyzer
        logger.debug(
            f"[visualizer] Analysis started at {position:.1f}s — {track.artist} — "
            f"{track.title} (generation={key[0]})"
        )

    async def _start_radio_analyzer(self, key: tuple[int, str]) -> None:
        """Reachable for Chromecast/DLNA always, and for Sonos when cast
        directly to the station (see core/radio_position.py's module
        docstring) — see that clock-picking `if` below for the exact split.
        _FirstByteClock is the fallback for everything else: AirPlay (never
        covered here at all), and, since 2026-09-04, a *relayed* Sonos too.

        That last one is a reversal, not an oversight. Original decision,
        live 2026-09-01 after actually shipping the _FirstByteClock-only
        version and measuring it: a Sonos cast over the "real" radio URI
        scheme (x-rincon-mp3radio://) gives no real position feedback for a
        continuous stream, only a guessed constant lead was available to
        compensate for the device's own buffering, and that measured
        roughly a second off and station-dependent — a visualizer that's
        confidently wrong lost out to one that's honestly absent.
        Chromecast/DLNA/Sonos (all three, briefly, over the http:// dispatch
        delivery/sonos.py used to always use for radio) then didn't have
        that problem: all three reported a real, stable position once past
        their own startup buffer (measured live 2026-09-02, see core/
        radio_position.py), so all three got a real clock instead of a
        guess — until delivery/sonos.py's own _dispatch_uri() went back to
        x-rincon-mp3radio:// for a relayed Sonos specifically, 2026-09-04,
        to fix audio dropouts that http:// dispatch caused only for Sonos
        (device-side buffering, an unrelated problem from this clock's own)
        — trading the real position feedback back away for exactly the
        device it was originally measured to be missing from. core/state.py's
        first_radio_position_delivery() is what keeps a relayed Sonos from
        even getting a RadioPositionTracker any more, so this class's own
        "no tracker" branch below is reached for it again, same as before
        2026-09-02 — now calibrated against the freshly re-measured number
        (ASSUMED_DEVICE_LEAD_SECONDS' own history) instead of the original,
        looser one.

        Taps core/radio_relay.py's own device-audio fan-out (subscribe_
        audio(lossy=True) below — the same bytes the cast target gets, not
        a second fetch of the station) but decodes them with its own,
        independent ffmpeg (AudioAnalyzer's `source_queue` path) rather
        than ever sharing *that relay's* ffmpeg process — see that
        module's own docstring for why: a bug in this analyzer's own
        decode/pacing used to be one step away from stalling the
        *device's* audio too, back when both outputs came from the same
        ffmpeg process. Removed 2026-09-03 after that happened repeatedly
        (see this function's own change history below); this analyzer now
        has no pipe in common with device audio to ever stall again — at
        worst a bug here drops frames into its own, separately-bounded
        queue (_ANALYSIS_QUEUE_MAXSIZE) instead.

        `start_offset` is always 0: a station has no track position to
        seek to, so every attach — including one that joins minutes into
        an already-playing station — starts decoding from whatever this
        analyzer's own fresh connection to the station happens to be at,
        tagged as "now" rather than "however far into the station this
        technically is".

        _FirstByteClock's own clock is zeroed on the *first PCM byte this
        analyzer's own ffmpeg actually decodes*, not on construction —
        spawning that ffmpeg and it actually producing a byte are not the
        same moment: its own connect/first-response latency still has to
        elapse, a gap that varies by station. Zeroing at construction
        counted that (variable, station-dependent) gap as already-elapsed
        content time — every frame this analyzer ever produced then started
        life "late" by exactly that gap, past _MAX_LATENESS_SECONDS (0.15s)
        for good, and _release_frames() drops a frame that late rather than
        releasing it stale. Reported live 2026-09-01 as a visualizer stuck
        around "0.5fps" (only the rare frame landing within 150ms of real
        time by chance survived) — worse on some stations than others,
        exactly matching a fetch-latency-dependent bug rather than a pacing
        one. RadioPositionTracker.elapsed_fn() doesn't need that fix at
        all — it reports the device's own real position directly, nothing
        to zero."""
        relay = self._session.radio_relay
        if relay is None:
            return
        if self._target_key() != key:
            return
        tracker = self._session.radio_position_tracker
        if tracker is not None:
            # tracker.elapsed_fn() is the device's *absolute* position
            # (since its own dispatch) — content_position below is relative
            # to *this analyzer's own fresh decode* instead (always starts
            # at "now", position 0, even one joining minutes into an
            # already-playing station). Without this baseline, opening the
            # visualizer any time after the device already had a real
            # position (which includes every reconnect/reload of an
            # already-playing radio session, not just "joined late" in the
            # everyday sense) permanently offset elapsed_fn ahead of
            # content_position by exactly that amount — every frame
            # computed forever after read as impossibly late, so
            # _release_frames() never released a single one, only dropped,
            # in a tight loop with no yield between drops (see that
            # function's own comment) once _read_pcm() had anything queued
            # to drop. Reported live 2026-09-02 as stuttering *device*
            # audio (this loop starving the whole event loop, not just the
            # visualizer, back when this analyzer's decode still shared a
            # pipe with device audio at all), a permanently blank/0.5fps
            # visualizer, and the visualizer only ever working when opened
            # before casting started (the one case this offset happens to
            # already be ~0 by coincidence).
            # Smoothed by _OffsetTrackerClock, not read straight through —
            # see that class's own docstring for why a raw, offset-corrected
            # step (only actually changing once per RadioPositionTracker
            # poll, ~every 0.5s) caps the effective frame rate at roughly
            # the poll rate instead of the ~43fps this is sized for.
            clock = _OffsetTrackerClock(self._session)
            elapsed_fn = clock.elapsed
            on_first_byte = clock.mark
            # No fixed/measured lead concept for a real, live-polled device
            # position — see _OffsetTrackerClock's own docstring for why
            # Chromecast/DLNA (and Sonos cast directly) never needed one.
            debug_lead_fn = None
        else:
            fallback = _FirstByteClock(self._session)
            elapsed_fn = fallback.elapsed
            on_first_byte = fallback.mark
            debug_lead_fn = fallback.debug_lead
        # The relay's own device-audio fan-out, not a second fetch of the
        # station: these are the very bytes the device is being sent, so a
        # given moment of audio means the same thing on both sides. A
        # second fetch (what this did until now) cannot be lined up at all
        # — a station greets every new client with a burst of
        # already-elapsed audio to prime its buffer with, seconds' worth
        # and station-dependent, so this analyzer's "first byte" was
        # simply an unknown distance behind what the device was playing.
        # Reported live 2026-09-03 as the visualizer running 5-10s behind
        # the speaker, varying by station.
        #
        # Bounded queue, and _fan_out() drops into a full one rather than
        # blocking (see core/radio_relay.py) — so this cannot stall device
        # audio the way sharing the relay's *ffmpeg* once did, which is the
        # whole reason that sharing was removed. Decoding stays in this
        # analyzer's own separate process.
        # lossy=True: analysis wants the live edge, never a backlog. See
        # core/radio_relay.py's _ANALYSIS_QUEUE_MAXSIZE for what working
        # through one costs — full-speed decode+FFT starving the event loop
        # device audio is paced on, and every frame it produces too late to
        # release anyway.
        queue = relay.subscribe_audio(lossy=True)
        analyzer = AudioAnalyzer(
            elapsed_fn=elapsed_fn,
            source_queue=queue,
            on_first_byte=on_first_byte,
            # See AudioAnalyzer's own docstring for what this drives
            # (GET /visualizer's debug overlay) — the *other* clock radio
            # has for "where is playback", independent of whichever one
            # (elapsed_fn, above) this analyzer's own delivery is paced by.
            debug_cast_elapsed_fn=lambda: self._session.state.clock.elapsed(),
            # None whenever elapsed_fn is _OffsetTrackerClock's (a real
            # device position, no lead to report on) — only _FirstByteClock
            # has one worth surfacing. See AudioAnalyzer.last_release_lead.
            debug_lead_fn=debug_lead_fn,
        )
        await analyzer.start()
        if not analyzer.started:
            # Spawn failed (see AudioAnalyzer.start()) — hand the
            # subscription back rather than leaking it, and leave self._key
            # unset so the next supervisor tick retries instead of staying
            # stuck on this generation forever.
            relay.unsubscribe_audio(queue)
            self._key = None
            return
        self.analyzer = analyzer
        self._audio_queue = queue
        self._audio_relay = relay
        logger.debug(f"[visualizer] Radio analysis started (generation={key[0]})")

    async def _stop_analyzer(self) -> None:
        if self.analyzer is None:
            return
        analyzer, self.analyzer = self.analyzer, None
        await analyzer.stop()
        queue, self._audio_queue = self._audio_queue, None
        relay, self._audio_relay = self._audio_relay, None
        if queue is not None and relay is not None:
            relay.unsubscribe_audio(queue)
        logger.debug("[visualizer] Analysis stopped")

    def is_watching_radio(self) -> bool:
        """Whether an AudioAnalyzer is actually running for radio right
        now — i.e. GET /visualizer has a subscriber and playback is radio,
        not just "radio is casting to a capable target". Read by
        core/radio_position.py's RadioPositionTracker to decide its own
        poll cadence: sub-second updates only matter while something is
        actually consuming elapsed_fn() at visualizer frame rate. Nobody
        watching leaves only the (one-shot, latching) radio_buffering flag
        needing this tracker at all, which tolerates a far slower cadence
        — see that module's own comment on why this exists."""
        return self.analyzer is not None and self._session.state.current_track is None
