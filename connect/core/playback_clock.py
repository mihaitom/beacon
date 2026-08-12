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
from dataclasses import dataclass


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

    def elapsed(self) -> float:
        """Current position in seconds, corrected for device buffering delay
        (position_offset) but *not* clamped to track duration — callers with a
        known track duration should clamp themselves (see state.compute_position)."""
        if self.is_paused:
            return self.paused_elapsed
        return max(0.0, time.time() - self.play_start_time + self.position_offset)

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

    def seek_to(self, position: float) -> None:
        """Jump to `position` seconds (the displayed, offset-adjusted value —
        typically already duration-clamped by the caller). Called by /seek."""
        raw_position = max(0.0, position - self.position_offset)
        self.resume_offset = raw_position
        self.play_start_time = time.time() - raw_position
        if self.is_paused:
            self.paused_elapsed = position
        else:
            self.play_generation += 1

    def calibrate(self, device_pos: float) -> float:
        """Set position_offset from a measured device position and return it.
        device_pos must be in the post-seek stream's own reference frame (see
        elapsed_since_stream_start()), not track-relative."""
        self.position_offset = device_pos - self.elapsed_since_stream_start()
        return self.position_offset

    def set_fixed_offset(self, offset: float) -> None:
        """Set a constant position_offset directly (AirPlay has no position
        feedback, so it gets a fixed startup-buffering estimate instead of
        calibrate())."""
        self.position_offset = offset
