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
from typing import TYPE_CHECKING

from .audio_analysis import AudioAnalyzer, should_analyze
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


class VisualizerFeed:
    """Start/stop lifecycle around at most one AudioAnalyzer per session.

    `analyzer` is what GET /visualizer reads frames from, and is None
    whenever nothing should be analyzed — nobody watching, nothing playing,
    or playing to a target that can't be analyzed (AirPlay/radio, see
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
        restart analysis at the new position; see core/playback_clock.py."""
        if self._subscribers == 0:
            return None
        st = self._session.state
        # radio_info without a current_track is a station URL playing
        # straight on the device (see routes/playback.py's /play-url):
        # nothing here to seek into, and no track position to seek to.
        if not st.is_streaming or st.current_track is None:
            return None
        if not should_analyze(list_target_pairs(st.active_delivery)):
            return None
        return (st.clock.play_generation, st.current_track.id)

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

    async def _stop_analyzer(self) -> None:
        if self.analyzer is None:
            return
        analyzer, self.analyzer = self.analyzer, None
        await analyzer.stop()
        logger.debug("[visualizer] Analysis stopped")
