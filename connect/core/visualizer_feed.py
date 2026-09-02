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
import time
from typing import TYPE_CHECKING

from .audio_analysis import AudioAnalyzer, should_analyze
from .state import TEST_TONE_TRACK_ID, list_target_pairs, test_tone_url

if TYPE_CHECKING:  # avoids a session <-> visualizer_feed import cycle at runtime
    from .radio_position import RadioPositionTracker
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
# buffers before content becomes audible. Radio has no equivalent: a Sonos
# reports position 0.00s for a continuous stream (nothing for
# _resync_position_periodically to calibrate against), so there is no way
# to measure a real device's lead the way tracks do. This is a fixed
# estimate instead, same spirit as core/streamer.py's own LOOKAHEAD_SECONDS
# assumption about how far a cast device's connection can legitimately run
# ahead of what it's actually playing, but not the same number — that one
# bounds how far *content dispatch* is allowed to lead, this one guesses
# how far *this analyzer's clock* needs to lag to match what's actually
# audible. Unverified against a real device by design (there is no
# feedback signal to verify it against) — expect to have to tune this
# empirically: still visibly ahead of the audio, raise it; now behind,
# lower it. Reported live 2026-09-01: with no lead at all (0.0), a
# perfectly smooth visualizer still read as playing "in the future"
# relative to the speaker, badly enough to notice immediately.
_ASSUMED_DEVICE_LEAD_SECONDS = 3.0


class _FirstByteClock:
    """elapsed_fn for a radio AudioAnalyzer with no RadioPositionTracker to
    drive it (a target type radio_position.py doesn't cover — see
    _start_radio_analyzer()'s own comment on when this fallback is actually
    reached today). Zero until mark() (passed to AudioAnalyzer as
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
    one. Also subtracts _ASSUMED_DEVICE_LEAD_SECONDS — see that constant's
    own comment for the separate problem that fixes."""

    def __init__(self) -> None:
        self._first_byte_at: float | None = None

    def mark(self) -> None:
        if self._first_byte_at is None:
            self._first_byte_at = time.monotonic()

    def elapsed(self) -> float:
        if self._first_byte_at is None:
            return 0.0
        return max(0.0, time.monotonic() - self._first_byte_at - _ASSUMED_DEVICE_LEAD_SECONDS)


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
    round-trip of over-extrapolating and then snapping back."""

    def __init__(self, session: SessionState) -> None:
        self._session = session
        self._tracker: RadioPositionTracker | None = None
        self._baseline: float | None = None
        self._last_value: float | None = None
        self._last_seen_at: float = 0.0
        # The last value handed out, so a tracker swap can carry on from it
        # rather than restarting the count — see _rebase_if_tracker_changed().
        self._last_elapsed: float = 0.0

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
        baseline drawn from it still has to be taken at the right
        moment."""
        tracker = self._session.radio_position_tracker
        if self._baseline is None and tracker is not None:
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
            # Nothing decoded yet, so no frame can be due: content_position
            # starts at 0 and _release_frames() holds back anything above
            # elapsed. Judging that first frame against a baseline that
            # doesn't exist yet is exactly what mark() prevents.
            return 0.0
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
        # What `analyzer` was started for: (play_generation, track id). The
        # supervisor restarts analysis whenever this no longer matches what's
        # actually playing — see _target_key().
        self._key: tuple[int, str] | None = None
        # The relay fan-out subscription a radio run holds, so _stop_analyzer()
        # can hand it back — a queue left subscribed keeps being filled with
        # audio nobody decodes any more, for as long as the station plays.
        self._audio_queue: asyncio.Queue[bytes | None] | None = None
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

    def unsubscribe(self) -> None:
        """One fewer client is watching. Analysis stops as soon as the
        supervisor wakes (immediately, unless it's mid-await) if that was
        the last one — floored at 0 so a double unsubscribe, e.g. a route
        whose finally runs after an error path already released, can't drive
        the count negative and strand the analyzer running forever."""
        self._subscribers = max(0, self._subscribers - 1)
        self._wake.set()

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
        )
        await analyzer.start()
        self.analyzer = analyzer
        logger.debug(
            f"[visualizer] Analysis started at {position:.1f}s — {track.artist} — "
            f"{track.title} (generation={key[0]})"
        )

    async def _start_radio_analyzer(self, key: tuple[int, str]) -> None:
        """Reachable for Chromecast/DLNA/Sonos since 2026-09-02 — see
        core/radio_position.py's module docstring. _FirstByteClock below
        now only runs as a defensive fallback (kept, not deleted, in case
        a target with no RadioPositionTracker ever reaches here — AirPlay,
        or a future protocol not yet added to
        core/state.py's first_radio_position_delivery()). Original
        decision, live 2026-09-01 after actually shipping the
        _FirstByteClock-only version and measuring it: a Sonos cast over
        the "real" radio URI scheme (x-rincon-mp3radio://) gives no real
        position feedback for a continuous stream, only a guessed constant
        lead was available to compensate for the device's own buffering,
        and that measured roughly a second off and station-dependent — a
        visualizer that's confidently wrong lost out to one that's
        honestly absent. Chromecast/DLNA/Sonos (over the http:// dispatch
        Beacon actually uses, see delivery/sonos.py's own comment) don't
        have that problem: all three report a real, stable position once
        past their own startup buffer (measured live 2026-09-02, see
        core/radio_position.py), so they get a real clock instead of a
        guess.

        Decodes the station a second time with its own, independent ffmpeg
        (AudioAnalyzer's `source_url` path — the same one track analysis
        already uses) rather than tapping core/radio_relay.py's device-audio
        fan-out — see that module's own docstring for why: a bug in this
        analyzer's own decode/pacing used to be one step away from stalling
        the *device's* audio too, since both shared one ffmpeg process.
        Removed 2026-09-03 after that happened repeatedly (see this
        function's own change history below); this analyzer now has no
        pipe in common with device audio to ever stall again.

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
        else:
            fallback = _FirstByteClock()
            elapsed_fn = fallback.elapsed
            on_first_byte = fallback.mark
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
        )
        await analyzer.start()
        self.analyzer = analyzer
        self._audio_queue = queue
        logger.debug(f"[visualizer] Radio analysis started (generation={key[0]})")

    async def _stop_analyzer(self) -> None:
        if self.analyzer is None:
            return
        analyzer, self.analyzer = self.analyzer, None
        await analyzer.stop()
        queue, self._audio_queue = self._audio_queue, None
        if queue is not None:
            relay = self._session.radio_relay
            if relay is not None:
                relay.unsubscribe_audio(queue)

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
        logger.debug("[visualizer] Analysis stopped")
