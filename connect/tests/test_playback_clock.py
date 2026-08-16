"""Tests for PlaybackClock — the wall-clock position math in isolation,
without going through the HTTP routes. See core/playback_clock.py."""

import time

from core.playback_clock import PlaybackClock


# ── start ─────────────────────────────────────────────────────────────────────


def test_start_from_zero():
    clock = PlaybackClock()
    clock.start()

    assert abs(clock.elapsed()) < 0.1
    assert clock.resume_offset == 0.0
    assert clock.position_offset == 0.0
    assert clock.track_start_position == 0.0
    assert clock.is_paused is False


def test_start_with_start_position_is_immediately_reflected():
    clock = PlaybackClock()
    clock.start(42.0)

    assert 41.5 < clock.elapsed() <= 42.5
    assert clock.resume_offset == 42.0
    assert clock.track_start_position == 42.0


def test_start_increments_play_generation():
    clock = PlaybackClock()
    assert clock.play_generation == 0
    clock.start()
    assert clock.play_generation == 1
    clock.start()
    assert clock.play_generation == 2


# ── elapsed ───────────────────────────────────────────────────────────────────


def test_elapsed_grows_while_playing():
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 30
    assert abs(clock.elapsed() - 30.0) < 1.0


def test_elapsed_while_paused_ignores_wall_clock():
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 9999
    clock.is_paused = True
    clock.paused_elapsed = 45.0

    assert clock.elapsed() == 45.0


def test_elapsed_applies_position_offset():
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 30
    clock.position_offset = -4.0

    assert abs(clock.elapsed() - 26.0) < 1.0


def test_elapsed_clamps_to_zero():
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 1
    clock.position_offset = -10.0

    assert clock.elapsed() == 0.0


# ── pause / resume ────────────────────────────────────────────────────────────


def test_pause_freezes_elapsed_and_sets_paused():
    clock = PlaybackClock()
    clock.start()

    clock.pause(30.0)

    assert clock.is_paused is True
    assert clock.paused_elapsed == 30.0
    assert clock.elapsed() == 30.0


def test_pause_accounts_for_position_offset_in_resume_offset():
    """resume_offset must be the raw position so resume() doesn't
    double-apply the device's buffering lag (a negative position_offset)."""
    clock = PlaybackClock()
    clock.position_offset = -4.0

    clock.pause(26.0)

    assert clock.resume_offset == 30.0


def test_pause_clamps_resume_offset_to_zero():
    clock = PlaybackClock()
    clock.position_offset = 10.0

    clock.pause(1.0)

    assert clock.resume_offset == 0.0


def test_resume_recalibrates_elapsed_to_resume_offset():
    clock = PlaybackClock()
    clock.pause(30.0)

    clock.resume()

    assert clock.is_paused is False
    assert abs(clock.elapsed() - 30.0) < 0.5


def test_resume_increments_play_generation():
    clock = PlaybackClock()
    clock.start()
    generation_after_start = clock.play_generation

    clock.resume()

    assert clock.play_generation == generation_after_start + 1


# ── seek_to ───────────────────────────────────────────────────────────────────


def test_seek_to_while_playing_bumps_generation_and_moves_elapsed():
    clock = PlaybackClock()
    clock.start()
    generation_before = clock.play_generation

    clock.seek_to(50.0)

    assert clock.play_generation == generation_before + 1
    assert clock.is_paused is False
    assert abs(clock.elapsed() - 50.0) < 0.5


def test_seek_to_while_paused_sets_paused_elapsed_without_bumping_generation():
    clock = PlaybackClock()
    clock.pause(10.0)
    generation_before = clock.play_generation

    clock.seek_to(75.0)

    assert clock.play_generation == generation_before
    assert clock.paused_elapsed == 75.0
    assert clock.elapsed() == 75.0


def test_seek_to_accounts_for_position_offset():
    clock = PlaybackClock()
    clock.position_offset = -4.0

    clock.seek_to(50.0)

    # raw wall-clock position should be 50 - (-4) = 54
    assert abs(clock.resume_offset - 54.0) < 0.01


def test_seek_to_clamps_raw_position_to_zero():
    clock = PlaybackClock()
    clock.position_offset = 4.0

    clock.seek_to(1.0)

    assert clock.resume_offset == 0.0


def test_seek_to_while_playing_updates_track_start_position():
    """Regression test: /seek reconnects to a *fresh* stream (FFmpeg output
    restarts near 0 again, same as start()) — without re-zeroing
    track_start_position to the seek's own raw_position, a later
    elapsed_since_stream_start() call (the calibration task's own
    device_pos-vs-wall_elapsed comparison) drifts by the full seek
    distance and never lands within a plausible range, spamming "ignoring
    implausible device position" for the whole calibration window instead
    of ever calibrating. Same bug class the module docstring says was
    already fixed for start() — see
    test_calibrate_mid_track_start_is_not_corrupted_by_start_position."""
    clock = PlaybackClock()
    clock.start(0.0)

    clock.seek_to(27.0)

    assert clock.track_start_position == clock.resume_offset
    assert abs(clock.elapsed_since_stream_start()) < 0.5


def test_seek_to_while_paused_does_not_update_track_start_position():
    # No stream reconnect happens while paused (deferred to /resume) — see
    # seek_to()'s own is_paused branch — so re-zeroing here would be
    # premature, not just unnecessary.
    clock = PlaybackClock()
    clock.pause(10.0)
    track_start_before = clock.track_start_position

    clock.seek_to(75.0)

    assert clock.track_start_position == track_start_before


# ── calibrate ─────────────────────────────────────────────────────────────────


def test_calibrate_from_track_start():
    """Device lags behind the wall clock -> position_offset must be negative."""
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 5.0

    offset = clock.calibrate(1.5)

    # device is ~1.5s in, wall-clock elapsed ~5s -> offset ~-3.5s
    assert -4.0 < offset < -3.0
    assert clock.position_offset == offset


def test_calibrate_mid_track_start_is_not_corrupted_by_start_position():
    """Regression test: connecting mid-track (start_position > 0) must not
    corrupt the calibration. device_pos is relative to the post-seek FFmpeg
    stream (starts near 0), not to the track, so it must be compared against
    wall-clock time since the stream was requested — not since track-relative
    play_start_time, which is backdated by start_position. A prior bug
    compared device_pos to elapsed() directly, yielding an offset of roughly
    -start_position instead of a small buffering correction."""
    clock = PlaybackClock()
    clock.start(10.0)

    offset = clock.calibrate(1.0)

    # device is ~1s into the post-seek stream -> offset should be a small
    # buffering correction, NOT ~-10s (-start_position).
    assert -2.0 < offset < 2.0


def test_elapsed_since_stream_start_excludes_track_start_position():
    clock = PlaybackClock()
    clock.start(10.0)

    # elapsed() is track-relative (~10s in), but elapsed_since_stream_start()
    # measures from when the (post-seek) stream itself started (~0s).
    assert abs(clock.elapsed() - 10.0) < 0.5
    assert abs(clock.elapsed_since_stream_start()) < 0.5


def test_set_fixed_offset():
    clock = PlaybackClock()
    clock.set_fixed_offset(-2.0)

    assert clock.position_offset == -2.0
