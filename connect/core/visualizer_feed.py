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

from .audio_analysis import AudioAnalyzer, PcmSource, should_analyze
from .state import TEST_TONE_TRACK_ID, list_target_pairs, test_tone_url

if TYPE_CHECKING:  # avoids a session <-> visualizer_feed import cycle at runtime
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
    """elapsed_fn for a radio AudioAnalyzer. Zero until wrap()'s returned
    source's first non-empty read, not from construction — attaching a PCM
    subscription and the relay actually having produced a byte for it are
    not the same moment (the relay's own fetch/demux/ffmpeg/queue pipeline
    still has to run first, a gap that varies by station). Zeroing at
    construction counted that gap as already-elapsed content time, so
    every frame this analyzer ever produced started life "late" by exactly
    that amount — past _MAX_LATENESS_SECONDS (0.15s) for good, since the
    gap doesn't shrink over time. core/audio_analysis.py's
    _release_frames() drops a frame that late rather than releasing it
    stale, so the practical effect was a visualizer stuck at whatever rare
    frame happened to land inside that 150ms window by chance — reported
    live 2026-09-01 as "0.5fps", worse on some stations than others,
    exactly matching a fetch-latency-dependent bug rather than a pacing
    one. Also subtracts _ASSUMED_DEVICE_LEAD_SECONDS — see that constant's
    own comment for the separate problem that fixes."""

    def __init__(self) -> None:
        self._first_byte_at: float | None = None

    def wrap(self, source: PcmSource) -> PcmSource:
        return _ClockedPcmSource(source, self)

    def mark(self) -> None:
        if self._first_byte_at is None:
            self._first_byte_at = time.monotonic()

    def elapsed(self) -> float:
        if self._first_byte_at is None:
            return 0.0
        return max(0.0, time.monotonic() - self._first_byte_at - _ASSUMED_DEVICE_LEAD_SECONDS)


class _ClockedPcmSource:
    def __init__(self, source: PcmSource, clock: _FirstByteClock) -> None:
        self._source = source
        self._clock = clock

    async def read(self, n: int) -> bytes:
        data = await self._source.read(n)
        if data:
            self._clock.mark()
        return data


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
        """Currently unreachable from the shipped frontend, deliberately —
        NowPlayingView.vue's visualizerAvailable never lets the visualizer
        mount for radio while casting, so GET /visualizer is never
        subscribed for it and _target_key()'s radio branch never returns
        non-None in practice. Not dead code to delete, though: this class
        and everything below it works, is unit-tested, and stays as the
        real implementation for whenever there's a trustworthy clock to
        drive it with — see _FirstByteClock's own docstring for why there
        currently isn't one. Decided live 2026-09-01, after actually
        shipping this once and measuring it: a Sonos gives no real
        position feedback for a continuous stream, only a guessed constant
        lead was available to compensate for the device's own buffering,
        and that measured roughly a second off and station-dependent — a
        visualizer that's confidently wrong lost out to one that's
        honestly absent.

        Taps core/radio_relay.py's shared PCM stream instead of
        decoding anything itself — see AudioAnalyzer's own docstring on
        its pcm_source parameter for why, and why elapsed_fn here is a
        wall clock rather than the session's PlaybackClock.

        `start_offset` is always 0: a station has no track position to
        seek to, so every attach — including one that joins minutes into
        an already-playing station — starts from whatever byte the relay
        hands over next, tagged as "now" rather than "however far into the
        station this technically is".

        That clock is zeroed on the *first byte this subscription actually
        receives* (see _FirstByteClock below), not on attach — attaching
        and the first byte arriving are not the same moment: subscribe_pcm()
        returns immediately, but the relay's own fetch/demux/ffmpeg/queue
        pipeline still has to produce something before this analyzer sees
        a single sample. Zeroing at attach counted that (variable, station-
        dependent) gap as already-elapsed content time — every frame this
        analyzer ever produced then started life "late" by exactly that
        gap, past _MAX_LATENESS_SECONDS (0.15s) for good, and
        _release_frames() drops a frame that late rather than releasing it
        stale. Reported live 2026-09-01 as a visualizer stuck around
        "0.5fps" (only the rare frame landing within 150ms of real time by
        chance survived) — worse on some stations than others, exactly
        matching a fetch-latency-dependent bug rather than a pacing one."""
        relay = self._session.radio_relay
        if relay is None:
            return
        if self._target_key() != key:
            return
        # Subscribes to the relay's always-drained PCM fan-out (see
        # RadioRelay._drain_pcm()'s own docstring for why "always" matters
        # here) rather than a raw pipe reader — unsubscribe_pcm() below is
        # this analyzer's own cleanup, wired through AudioAnalyzer's
        # cleanup callback so it fires exactly once, whenever this run ends
        # for any reason (track/station change, last subscriber leaving,
        # shutdown).
        subscription = relay.subscribe_pcm()
        clock = _FirstByteClock()
        analyzer = AudioAnalyzer(
            elapsed_fn=clock.elapsed,
            pcm_source=clock.wrap(subscription),
            cleanup=lambda: relay.unsubscribe_pcm(subscription),
        )
        await analyzer.start()
        self.analyzer = analyzer
        logger.debug(f"[visualizer] Radio analysis started (generation={key[0]})")

    async def _stop_analyzer(self) -> None:
        if self.analyzer is None:
            return
        analyzer, self.analyzer = self.analyzer, None
        await analyzer.stop()
        logger.debug("[visualizer] Analysis stopped")
