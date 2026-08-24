"""Tests for PlaybackClock — the wall-clock position math in isolation,
without going through the HTTP routes. See core/playback_clock.py."""

import time

import pytest

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


# ── seconds_until ─────────────────────────────────────────────────────────────


def test_seconds_until_with_no_offset():
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 30
    assert abs(clock.seconds_until(180.0) - 150.0) < 1.0


def test_seconds_until_applies_position_offset():
    # A device lagging the wall clock (the normal startup-buffering case,
    # position_offset negative) needs *longer* to reach the track's
    # duration than the uncorrected wall clock alone would suggest — this
    # is exactly the correction the auto-advance timing bug was missing.
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 30
    clock.position_offset = -2.0
    assert abs(clock.seconds_until(180.0) - 152.0) < 1.0


def test_seconds_until_clamps_to_zero():
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 200
    assert clock.seconds_until(180.0) == 0.0


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


def test_resume_re_zeroes_track_start_position_to_resume_offset():
    """Regression test (real prod bug, found live 2026-08-20): /resume's
    route handler reconnects to a *fresh* stream (FFmpeg restarts near 0
    again, same -ss reconnect /seek does) — without re-zeroing
    track_start_position here the same way seek_to() already does (see its
    own comment for the identical bug class), elapsed_since_stream_start()
    stayed anchored to the track's pre-pause position instead of this
    reconnect's own stream start. A Sonos device resets its own reported
    position on exactly this kind of reconnect too, so periodic resync's
    device_pos-vs-wall_elapsed comparison drifted by the *entire* pre-resume
    elapsed time, corrupting position_offset by roughly that whole amount
    on the very next check — read live as playback/lyrics/the visualizer
    all jumping minutes out of sync after enough resumes."""
    clock = PlaybackClock()
    clock.start()
    clock.pause(145.6)

    clock.resume()

    assert clock.track_start_position == clock.resume_offset
    assert abs(clock.elapsed_since_stream_start()) < 0.5


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


# ── calibrate() blending elapsed() instead of jumping it ───────────────────
# Regression coverage for a real prod symptom (2026-08-20): repeated real
# device reconnects (from mashing play/pause) accumulate real buffering lag
# that position-resync legitimately needs to correct — but applying that
# correction to elapsed()'s output in one instant step read live as lyrics
# and the audio visualizer (both paced directly off elapsed(), see
# _OFFSET_SLEW_SECONDS' own comment) suddenly snapping backward.
# position_offset itself (and calibrate()'s return value) must still update
# immediately regardless — see test_calibrate_from_track_start etc. above,
# unaffected by any of this.


def test_calibrate_does_not_jump_elapsed_immediately():
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 30.0
    before = clock.elapsed()

    offset = clock.calibrate(10.0)  # a big correction: -20.0

    assert clock.position_offset == offset
    # elapsed() itself hasn't caught up yet — nowhere near where the new
    # offset alone would put it (~10s).
    assert abs(clock.elapsed() - before) < 1.0


def test_calibrate_blend_converges_to_the_true_offset_after_the_slew_window():
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 30.0

    clock.calibrate(10.0)
    clock._slew_start_time = time.time() - 999  # fast-forward past the blend window

    assert abs(clock.elapsed() - 10.0) < 1.0


def test_calibrate_blend_starts_from_the_current_blended_value_not_from_zero():
    """A second calibrate() landing while an earlier one is still blending
    in must start its own blend from wherever elapsed() actually was at that
    moment, not from 0.0 or the earlier call's *target* — otherwise a second
    correction landing mid-blend would itself cause a visible jump."""
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 30.0

    clock.calibrate(10.0)  # position_offset -> -20.0
    clock._slew_start_time = time.time() - 1.0  # 1s into the 2s blend window
    mid_blend_offset = clock._effective_offset()
    assert -20.0 < mid_blend_offset < 0.0  # partway between 0.0 and -20.0

    clock.calibrate(5.0)  # a second correction landing mid-blend

    assert abs(clock._slew_start_offset - mid_blend_offset) < 0.5


def test_resume_cancels_any_slew_still_in_progress_from_before_the_pause():
    clock = PlaybackClock()
    clock.position_offset = -4.0
    clock.pause(26.0)  # resume_offset = 26.0 - (-4.0) = 30.0, per pause()'s own contract
    clock._slew_start_time = time.time()  # a blend "in progress" from before the pause

    clock.resume()

    assert clock._slew_start_time is None
    # resume_offset(30.0) + position_offset(-4.0), fully unblended, not
    # partway toward it from some earlier blend state.
    assert abs(clock.elapsed() - 26.0) < 0.5


def test_seek_to_cancels_any_slew_in_progress():
    clock = PlaybackClock()
    clock.start()
    clock._slew_start_time = time.time()

    clock.seek_to(50.0)

    assert clock._slew_start_time is None


def test_start_cancels_any_slew_in_progress():
    clock = PlaybackClock()
    clock._slew_start_time = time.time()

    clock.start()

    assert clock._slew_start_time is None


def test_set_fixed_offset_applies_immediately_without_blending():
    clock = PlaybackClock()
    clock.play_start_time = time.time() - 10.0
    clock._slew_start_time = time.time()  # pretend a blend was in progress

    clock.set_fixed_offset(-2.0)

    assert clock._slew_start_time is None
    assert abs(clock.elapsed() - 8.0) < 0.5


# ── stream_restart_position / restream_from ─────────────────────────────────
# A device that reopens the stream by itself (no /play, /seek or /resume) has
# to be served from where playback actually is, and its own position counter
# restarts with that stream — see routes/stream.py's `reconnecting` branch
# and docs/playback-bugs/fixed-reconnect-restarted-track-poisoned-clock.md.


def test_stream_restart_position_is_the_raw_wall_position():
    """Without position_offset, same convention pause() uses: the device is
    about to re-incur its own startup buffering, so it must not be handed a
    position that already accounts for it."""
    clock = PlaybackClock()
    clock.start(0.0)
    clock.play_start_time -= 59.0
    clock.position_offset = -1.5

    assert clock.stream_restart_position() == pytest.approx(59.0, abs=0.5)


def test_stream_restart_position_while_paused_is_the_resume_offset():
    clock = PlaybackClock()
    clock.start(0.0)
    clock.play_start_time -= 30.0
    clock.pause(30.0)

    assert clock.stream_restart_position() == pytest.approx(clock.resume_offset)


def test_restream_from_rebases_the_stream_timeline_only():
    clock = PlaybackClock()
    clock.start(0.0)
    clock.play_start_time -= 59.0
    before_elapsed = clock.elapsed()
    before_generation = clock.play_generation

    clock.restream_from(59.0)

    # The track timeline is untouched - nobody seeked anywhere.
    assert clock.elapsed() == pytest.approx(before_elapsed, abs=0.5)
    assert clock.play_generation == before_generation
    # The stream timeline starts here, which is what a device's own freshly
    # restarted position gets compared against.
    assert clock.elapsed_since_stream_start() == pytest.approx(0.0, abs=0.5)


def test_restream_from_keeps_a_later_calibration_sane():
    """The whole point: after a reconnect the device reports ~0 again. With
    the stream timeline re-based, calibrating against that yields a small
    offset instead of dragging it by the entire track position (-60s live on
    2026-08-23)."""
    clock = PlaybackClock()
    clock.start(0.0)
    clock.play_start_time -= 59.0
    clock.restream_from(59.0)

    offset = clock.calibrate(0.0)

    assert offset == pytest.approx(0.0, abs=0.5)
