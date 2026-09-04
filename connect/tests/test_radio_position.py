"""Tests for core/radio_position.py's RadioPositionTracker."""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.radio_position import RadioPositionTracker
from delivery import ChromecastDelivery


def _tracker(session, target=None, started_at=None):
    delivery = target or ChromecastDelivery("Wohnzimmer")
    session.state.active_delivery = delivery
    session.state.is_streaming = True
    session.state.clock.start(0.0)
    generation = session.state.clock.play_generation
    return (
        RadioPositionTracker(session, delivery, generation, started_at=started_at),
        delivery,
    )


def test_first_reading_sets_baseline_without_becoming_ready(default_session):
    tracker, delivery = _tracker(default_session)
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=0.0)):
        assert asyncio.run(tracker._poll_once()) is True
    assert tracker.ready is False
    assert tracker.elapsed_fn() == 0.0


def test_small_drift_from_baseline_does_not_flip_ready(default_session):
    """Regression for the exact bug DLNA's whole-second RelTime resolution
    could cause — two adjacent integer readings differing by rounding alone
    must not read as "the device started playing"."""
    tracker, delivery = _tracker(default_session)
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=0.0)):
        asyncio.run(tracker._poll_once())
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=1.0)):
        asyncio.run(tracker._poll_once())
    assert tracker.ready is False
    assert tracker.elapsed_fn() == 1.0


def test_real_movement_past_the_threshold_flips_ready(default_session):
    tracker, delivery = _tracker(default_session)
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=0.0)):
        asyncio.run(tracker._poll_once())
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=1.6)):
        asyncio.run(tracker._poll_once())
    assert tracker.ready is True
    assert tracker.elapsed_fn() == 1.6


def test_ready_does_not_reset_once_set(default_session):
    """Once real movement is confirmed, a later reading that's merely close
    to the (now stale) baseline must not un-flip ready — it only ever
    checks distance-from-baseline while not yet ready."""
    tracker, delivery = _tracker(default_session)
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=0.0)):
        asyncio.run(tracker._poll_once())
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=5.0)):
        asyncio.run(tracker._poll_once())
    assert tracker.ready is True
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=5.2)):
        asyncio.run(tracker._poll_once())
    assert tracker.ready is True


def test_none_reading_is_ignored_and_keeps_polling(default_session):
    tracker, delivery = _tracker(default_session)
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=None)):
        assert asyncio.run(tracker._poll_once()) is True
    assert tracker.elapsed_fn() == 0.0
    assert tracker._baseline is None


def test_negative_reading_is_ignored(default_session):
    tracker, delivery = _tracker(default_session)
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=-1.0)):
        assert asyncio.run(tracker._poll_once()) is True
    assert tracker._baseline is None


def test_get_position_exception_keeps_polling(default_session):
    tracker, delivery = _tracker(default_session)
    with patch.object(delivery, "get_position", new=AsyncMock(side_effect=RuntimeError("boom"))):
        assert asyncio.run(tracker._poll_once()) is True
    assert tracker._baseline is None


def test_stops_when_generation_changes(default_session):
    tracker, delivery = _tracker(default_session)
    default_session.state.clock.play_generation += 1
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=5.0)):
        assert asyncio.run(tracker._poll_once()) is False
    assert tracker.elapsed_fn() == 0.0


def test_skips_the_round_trip_while_paused(default_session):
    """A Sonos get_position() is two real HTTP round trips
    (delivery/sonos.py's own comment) — polling a frozen position for as
    long as a pause lasts is pure waste, same reasoning as
    _resync_position_periodically's identical check."""
    tracker, delivery = _tracker(default_session)
    default_session.state.clock.is_paused = True
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=5.0)) as get_position:
        assert asyncio.run(tracker._poll_once()) is True
    get_position.assert_not_called()
    assert tracker._baseline is None


def test_stops_when_streaming_ends(default_session):
    tracker, delivery = _tracker(default_session)
    default_session.state.is_streaming = False
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=5.0)):
        assert asyncio.run(tracker._poll_once()) is False


def test_stops_when_device_stop_drops_the_target(default_session):
    """The gap is_still_targeted() (core/state.py) exists for: /device-stop
    can swap active_delivery for something that no longer includes this
    tracker's own delivery, without touching play_generation at all — see
    that function's own docstring for the prod incident this mirrors for
    _resync_position_periodically."""
    tracker, delivery = _tracker(default_session)
    default_session.state.active_delivery = ChromecastDelivery("Different room")
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=5.0)):
        assert asyncio.run(tracker._poll_once()) is False


def test_stops_when_superseded_while_get_position_in_flight(default_session):
    """Same race _resync_position_once() guards against: the generation
    bump has to be re-checked *after* the await, not just before it."""
    tracker, delivery = _tracker(default_session)
    generation_at_start = default_session.state.clock.play_generation

    async def _slow_get_position():
        default_session.state.clock.play_generation = generation_at_start + 1
        return 5.0

    with patch.object(delivery, "get_position", new=_slow_get_position):
        assert asyncio.run(tracker._poll_once()) is False
    assert tracker.elapsed_fn() == 0.0


def test_rebaselines_after_a_stall_instead_of_staying_stuck_forever(default_session):
    """Regression for a poisoned first reading: Chromecast's get_position()
    reads a cached, socket-pushed status object (delivery/chromecast.py)
    that can carry leftover data from a previous dispatch on the same
    reused connection (_chromecast_cache). If the very first poll catches
    that instead of the new stream's own position, the old "wait for
    +1.5s over the *first ever* reading" design could then never fire —
    reported live 2026-09-02 as the buffering indicator staying on forever
    for an actual, audibly-playing Chromecast radio cast."""
    tracker, delivery = _tracker(default_session)
    with patch("core.radio_position.time.monotonic", return_value=1000.0):
        with patch.object(delivery, "get_position", new=AsyncMock(return_value=50.0)):
            asyncio.run(tracker._poll_once())  # poisoned baseline
    with patch("core.radio_position.time.monotonic", return_value=1000.3):
        with patch.object(delivery, "get_position", new=AsyncMock(return_value=0.2)):
            asyncio.run(tracker._poll_once())
    assert tracker.ready is False
    # Still inside the re-baseline window (< 3s since the poisoned
    # baseline was set) — must not have re-baselined yet.
    with patch("core.radio_position.time.monotonic", return_value=1002.9):
        with patch.object(delivery, "get_position", new=AsyncMock(return_value=2.7)):
            asyncio.run(tracker._poll_once())
    assert tracker.ready is False
    # Past the window now — this reading becomes the new baseline instead
    # of continuing to chase the poisoned one.
    with patch("core.radio_position.time.monotonic", return_value=1003.1):
        with patch.object(delivery, "get_position", new=AsyncMock(return_value=2.9)):
            asyncio.run(tracker._poll_once())
    assert tracker.ready is False
    # Real movement from the fresh baseline flips ready.
    with patch("core.radio_position.time.monotonic", return_value=1003.6):
        with patch.object(delivery, "get_position", new=AsyncMock(return_value=4.5)):
            asyncio.run(tracker._poll_once())
    assert tracker.ready is True


def test_does_not_rebaseline_while_still_inside_the_window(default_session):
    """The mirror case: real, if slow, movement from the original baseline
    reaching the threshold before the re-baseline window elapses must
    still work exactly as before — this is only a fallback for when that
    doesn't happen."""
    tracker, delivery = _tracker(default_session)
    with patch("core.radio_position.time.monotonic", return_value=2000.0):
        with patch.object(delivery, "get_position", new=AsyncMock(return_value=0.0)):
            asyncio.run(tracker._poll_once())
    with patch("core.radio_position.time.monotonic", return_value=2001.0):
        with patch.object(delivery, "get_position", new=AsyncMock(return_value=1.6)):
            asyncio.run(tracker._poll_once())
    assert tracker.ready is True


def test_poll_interval_is_fast_before_ready(default_session):
    """Buffering detection must stay responsive regardless of whether
    anyone has the visualizer open — the flag needs to clear promptly."""
    tracker, _ = _tracker(default_session)
    assert tracker.ready is False
    assert tracker._poll_interval() == pytest.approx(0.5)


def test_poll_interval_backs_off_once_ready_with_nobody_watching(default_session):
    """The regression this guards against: before this existed, a
    RadioPositionTracker polled every 0.5s for a radio session's entire
    lifetime, whether or not the visualizer was ever opened — for Sonos,
    two real HTTP round trips per poll, sustained for as long as radio
    played. Once ready (radio_buffering has already latched False for
    good) and nobody is watching the visualizer, this should back off to
    the same cadence as _resync_position_periodically."""
    tracker, _ = _tracker(default_session)
    tracker.ready = True
    assert default_session.visualizer.is_watching_radio() is False
    assert tracker._poll_interval() == pytest.approx(8.0)


def test_poll_interval_stays_fast_once_ready_if_the_visualizer_is_watching(default_session):
    tracker, _ = _tracker(default_session)
    tracker.ready = True
    default_session.visualizer.analyzer = MagicMock()
    default_session.state.current_track = None
    assert default_session.visualizer.is_watching_radio() is True
    assert tracker._poll_interval() == pytest.approx(0.5)


def test_elapsed_fn_holds_last_value_without_extrapolating(default_session):
    """No time-based extrapolation between polls — elapsed_fn() is a plain
    read of the last polled value, not `last_value + elapsed_since_poll`.
    Extrapolating during the device's own startup buffering would grow a
    number with nothing real behind it, which is the whole reason this
    tracker exists instead of core/visualizer_feed.py's _FirstByteClock."""
    tracker, delivery = _tracker(default_session)
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=3.0)):
        asyncio.run(tracker._poll_once())
    before = tracker.elapsed_fn()
    time.sleep(0.05)
    after = tracker.elapsed_fn()
    assert before == after == 3.0


# ── buffer_lag() — measuring the device's own startup-buffering delay ──────
# For core/visualizer_feed.py's _OffsetTrackerClock to fold into its
# baseline instead of, as before this method existed, silently cancelling
# it back out of the result — see that class's own docstring and
# _apply_measured_lag() for the bug this replaces (reported live
# 2026-09-03/04: the radio visualizer running seconds ahead of the actual
# audio, worst on Chromecast's own ~10-11s startup buffer).


def test_buffer_lag_is_none_until_ready(default_session):
    """Before `ready`, the device is still sitting in its own startup
    stall — "wall time since dispatch minus position" isn't a stable
    buffering delay yet at that point, just however far into the stall the
    device happens to be."""
    tracker, delivery = _tracker(default_session)
    with patch.object(delivery, "get_position", new=AsyncMock(return_value=0.0)):
        asyncio.run(tracker._poll_once())
    assert tracker.ready is False
    assert tracker.buffer_lag() is None


def test_buffer_lag_measures_wall_time_since_dispatch_minus_position(default_session):
    """Not run through _poll_once()/asyncio.run(): patching time.monotonic
    globally (this module imports the `time` module itself, not individual
    names from it, so the patch reaches every caller process-wide) would
    also patch asyncio's own event-loop clock out from under it. Setting
    the polled state directly is equivalent here — buffer_lag() only reads
    `ready`/`_position`, it doesn't care how they got there."""
    tracker, _ = _tracker(default_session)  # _started_at set here, unpatched
    tracker._position = 2.0
    tracker.ready = True
    with patch("core.radio_position.time.monotonic", return_value=tracker._started_at + 12.0):
        # 12s of wall time since dispatch, the device reports only 2.0s
        # actually played by then: a 10.0s buffering delay, right in the
        # Chromecast range measured live (see this module's own docstring).
        assert tracker.buffer_lag() == pytest.approx(10.0)


def test_buffer_lag_is_none_when_it_would_come_out_negative(default_session):
    """A negative result means `_started_at` is simply wrong for this
    tracker, not that the device has no buffering delay — so this reports
    "no measurement", not zero.

    The difference matters downstream: _OffsetTrackerClock._apply_measured_
    lag() folds the first value it gets in and latches it permanently, so a
    0.0 here would discard the correction for the whole session, while None
    just leaves it to be retried."""
    tracker, _ = _tracker(default_session)
    tracker._position = 5.0
    tracker.ready = True
    with patch("core.radio_position.time.monotonic", return_value=tracker._started_at + 0.5):
        assert tracker.buffer_lag() is None


def test_buffer_lag_uses_a_handed_over_started_at(default_session):
    """routes/devices.py's /device-stop builds a replacement tracker for a
    device that has been playing all along and is never re-dispatched.
    Defaulting `_started_at` to now there would make buffer_lag() negative
    forever (position already minutes in, reference just created), so that
    call site passes the outgoing tracker's own reference through."""
    original, _ = _tracker(default_session)
    handover, _ = _tracker(default_session, started_at=original.started_at)
    handover._position = 300.0
    handover.ready = True
    with patch("core.radio_position.time.monotonic", return_value=original.started_at + 304.7):
        assert handover.buffer_lag() == pytest.approx(4.7)
