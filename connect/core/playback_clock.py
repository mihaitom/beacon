"""core/playback_clock.py — Wall-clock position tracking for the current track/stream.

Bundles the handful of interacting fields that together answer "how far into
the track are we, right now" (play_start_time, paused_elapsed, position_offset,
resume_offset, track_start_position, play_generation) plus the operations that
mutate them together (start/pause/resume/seek/calibrate). These used to be
loose AppState fields, independently re-derived across /play, /pause, /resume,
/seek and the buffering-delay calibration task in routes/playback.py — which is
exactly how a mid-track-start_position bug once corrupted the calibration math.
Keeping the invariants in one place (with tests, see test_playback_clock.py)
is meant to prevent that class of bug from recurring.
"""

import time
from dataclasses import dataclass, field

# How long a background position-resync correction (calibrate(), called from
# routes/playback.py's periodic resync loop and its one-shot startup
# counterpart) takes to blend fully into elapsed()'s *output*, rather than
# applying instantly. position_offset itself still updates immediately —
# seconds_until()'s auto-advance scheduling and every log line that reads it
# want the true value right away, not a transitional one — only elapsed()
# blends, since that's what both the frontend's lyrics sync and the audio
# visualizer's own frame pacing (core/audio_analysis.py's _release_frames(),
# built directly on this same elapsed_fn) are driven by. Without this, a
# legitimate multi-second correction — exactly what repeated real device
# reconnects accumulate, e.g. from mashing play/pause — read live as lyrics
# and the visualizer both suddenly snapping backward in the same instant,
# instead of just quietly catching up (observed 2026-08-20). 2s is short
# enough that a real, deliberate device-side seek (the other thing
# calibrate() catches, see _resync_position_once()'s docstring) still feels
# responsive rather than sluggish.
_OFFSET_SLEW_SECONDS = 2.0


@dataclass
class PlaybackClock:
    # Wall-clock time the current track (logically) started, backdated by
    # track_start_position so elapsed() is track-relative from the first tick.
    play_start_time: float = 0.0
    # Position frozen at the moment of pause(); only meaningful while paused.
    paused_elapsed: float = 0.0
    # Constant per-track correction added to the wall-clock position to
    # account for the device's startup buffering delay. See calibrate().
    position_offset: float = 0.0
    # Seek offset for the next /stream reconnect — consumed once (read then
    # reset to 0) by routes/stream.py when the device (re)connects.
    resume_offset: float = 0.0
    # start_position passed to start() for the current play_generation. Needed
    # by calibrate(): device_pos is relative to the post-seek FFmpeg stream
    # (starts near 0), not to the track, so it isn't directly comparable to
    # elapsed() — see elapsed_since_stream_start().
    track_start_position: float = 0.0
    # Incremented on every start()/resume()/seek_to() (while playing) so
    # stale async handlers (calibration task, stream-completion) from a
    # superseded play/seek don't act after the fact.
    play_generation: int = 0
    is_paused: bool = False
    # Slew state for elapsed()'s blended offset — see _OFFSET_SLEW_SECONDS'
    # own comment. _slew_start_time is None whenever no correction is
    # currently blending in (the common case); excluded from __repr__ since
    # it's pure implementation detail of elapsed(), not part of this
    # object's externally-meaningful state the way every other field is.
    _slew_start_offset: float = field(default=0.0, repr=False)
    _slew_start_time: float | None = field(default=None, repr=False)

    def start(self, start_position: float = 0.0) -> None:
        """Begin a fresh clock at `start_position` seconds into the track (0 =
        from the beginning). Called by /play and /play-url."""
        self.play_start_time = time.time() - start_position
        self.paused_elapsed = 0.0
        self.resume_offset = start_position
        self.position_offset = 0.0
        self.track_start_position = start_position
        self.is_paused = False
        self.play_generation += 1
        self._slew_start_time = None

    def _effective_offset(self) -> float:
        """position_offset, blended in over _OFFSET_SLEW_SECONDS if a
        calibrate() correction landed recently — see that constant's own
        comment. Only elapsed() reads this; seconds_until() and everything
        else wants the true, immediately-updated position_offset itself."""
        if self._slew_start_time is None:
            return self.position_offset
        t = (time.time() - self._slew_start_time) / _OFFSET_SLEW_SECONDS
        if t >= 1.0:
            self._slew_start_time = None
            return self.position_offset
        return self._slew_start_offset + (self.position_offset - self._slew_start_offset) * t

    def elapsed(self) -> float:
        """Current position in seconds, corrected for device buffering delay
        (position_offset, blended smoothly in — see _effective_offset()) but
        *not* clamped to track duration — callers with a known track
        duration should clamp themselves (see state.compute_position)."""
        if self.is_paused:
            return self.paused_elapsed
        return max(0.0, time.time() - self.play_start_time + self._effective_offset())

    def seconds_until(self, duration: float) -> float:
        """Wall-clock seconds from now until elapsed() would reach `duration`
        — the inverse of elapsed(), solving `elapsed(t) == duration` for t.
        Used to schedule the auto-advance/track-end signal so it fires when
        the device has *actually* finished playing (position_offset-
        corrected), not when the raw, uncorrected wall clock reaches the
        track's nominal duration — which fires early by exactly
        position_offset otherwise. Assumes playback is ongoing (not
        paused); callers already only use this while actively streaming."""
        return max(0.0, self.play_start_time + duration - self.position_offset - time.time())

    def elapsed_since_stream_start(self) -> float:
        """Wall-clock seconds since start()/resume()/seek_to() was called,
        *excluding* track_start_position. This is the reference frame a
        device's own reported position (device_pos) is in — the FFmpeg output
        stream itself starts at "stream time" 0 regardless of where in the
        original track it was seeked to. See calibrate()."""
        return time.time() - self.play_start_time - self.track_start_position

    def pause(self, elapsed: float) -> None:
        """Freeze the clock at `elapsed` (typically state.compute_position(),
        i.e. already duration-clamped). Called by /pause."""
        # resume_offset is the raw wall-clock position (without position_offset),
        # so resuming doesn't double-apply the device's startup-buffering delay.
        self.resume_offset = max(0.0, elapsed - self.position_offset)
        self.paused_elapsed = elapsed
        self.is_paused = True

    def resume(self) -> None:
        """Recalibrate so elapsed() immediately returns resume_offset. Called
        by /resume."""
        self.play_start_time = time.time() - self.resume_offset
        self.paused_elapsed = 0.0
        self.is_paused = False
        self.play_generation += 1
        # Nothing to blend across a pause boundary — elapsed() was frozen
        # (paused_elapsed) for its whole duration regardless of any slew in
        # progress when pause() happened, so resuming should read the true
        # position_offset immediately, same as start()/seek_to() do.
        self._slew_start_time = None
        # The exact same "mid-track start_position" bug class seek_to()
        # already guards against (see its own comment) — /resume's route
        # handler reconnects to a *fresh* stream here too (FFmpeg output
        # restarts near 0 again, same -ss reconnect /seek does), so
        # elapsed_since_stream_start() needs re-zeroing to resume_offset,
        # not left pointing at wherever the track's original (pre-pause)
        # stream began. Missing this was a real bug (found live
        # 2026-08-20): a Sonos device resets its own reported position to
        # ~0 on every such reconnect too, so periodic resync's device_pos
        # vs. wall_elapsed comparison drifted by the *entire* pre-resume
        # elapsed time — position_offset got "corrected" by roughly that
        # whole amount on the very next check, corrupting elapsed() (and
        # therefore lyrics sync/the audio visualizer/the progress bar,
        # everything downstream of it) by minutes after enough resumes.
        self.track_start_position = self.resume_offset

    def seek_to(self, position: float) -> None:
        """Jump to `position` seconds (the displayed, offset-adjusted value —
        typically already duration-clamped by the caller). Called by /seek."""
        raw_position = max(0.0, position - self.position_offset)
        self.resume_offset = raw_position
        self.play_start_time = time.time() - raw_position
        if self.is_paused:
            self.paused_elapsed = position
        else:
            # Same "mid-track start_position" bug start() already guards
            # against (see the module docstring) — /seek's route handler
            # reconnects to a *fresh* stream here (FFmpeg output restarts
            # near 0 again, same as a new /play), so elapsed_since_stream_
            # start() needs re-zeroing to this seek's own raw_position, not
            # left pointing at wherever the track's original stream began.
            # Without this, the calibration task's device_pos vs. wall_elapsed
            # comparison drifts by the full seek distance and never lands
            # within MAX_PLAUSIBLE_POSITION_LEAD, spamming "ignoring
            # implausible device position" for the whole 10s window instead
            # of calibrating.
            self.track_start_position = raw_position
            self.play_generation += 1
        # A fresh stream reconnect, same reasoning as start()/resume() above.
        self._slew_start_time = None

    def stream_restart_position(self) -> float:
        """Where a stream being reopened *right now* should start.

        The raw wall-clock position, without position_offset — the same
        convention pause() uses for resume_offset, and for the same reason:
        the device is about to re-incur its own startup buffering, so handing
        it the buffering-corrected position would send it a second helping of
        that correction. Paused, resume_offset already holds exactly this."""
        if self.is_paused:
            return self.resume_offset
        return max(0.0, time.time() - self.play_start_time)

    def restream_from(self, position: float) -> None:
        """The device reopened the stream on its own and is being served from
        `position` (raw, as returned by stream_restart_position()).

        Deliberately touches only track_start_position, and neither
        play_start_time nor play_generation: nobody seeked, so the *track*
        timeline is unchanged and elapsed() must keep reporting what it
        reported a moment ago — `position` is that same value by
        construction. What does restart is the *stream* timeline, and
        elapsed_since_stream_start() is the reference frame a device's own
        reported position is compared against (see calibrate()). A device
        that reopens the stream reports ~0 again, so without re-basing here,
        the next resync compares that fresh 0 against the whole time since
        the track began and "corrects" position_offset by that entire amount.
        Observed live 2026-08-23: a reconnect 59s into a track dragged
        position_offset to -60.35s and then -68.68s, which poisons everything
        downstream of elapsed() — displayed position, lyrics sync, the cast
        visualizer's pacing, auto-advance scheduling."""
        self.track_start_position = position

    def calibrate(self, device_pos: float) -> float:
        """Set position_offset from a measured device position and return it.
        device_pos must be in the post-seek stream's own reference frame (see
        elapsed_since_stream_start()), not track-relative. The *returned*
        value (and position_offset itself) is the new, true offset,
        immediately — only elapsed() phases it in gradually, see
        _OFFSET_SLEW_SECONDS."""
        self._slew_start_offset = self._effective_offset()
        self._slew_start_time = time.time()
        self.position_offset = device_pos - self.elapsed_since_stream_start()
        return self.position_offset

    def set_fixed_offset(self, offset: float) -> None:
        """Set a constant position_offset directly (AirPlay has no position
        feedback, so it gets a fixed startup-buffering estimate instead of
        calibrate()). Applied immediately, not blended — same "authoritative
        reset" reasoning as start()/seek_to() above; unlike calibrate(),
        this is only ever called once, right as a track starts, not as a
        background correction mid-track."""
        self.position_offset = offset
        self._slew_start_time = None
