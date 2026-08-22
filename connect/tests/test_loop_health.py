"""Tests for core/loop_health.py — the event-loop stall detector added
2026-08-22 to tell "this process starved the cast device's socket" apart
from "the speaker or the network dropped us", which the logs at the time
of the beacon-dev drops could not distinguish."""

import asyncio
import logging
from unittest.mock import patch

import pytest

from core import loop_health


@pytest.fixture(autouse=True)
def _clean_history():
    loop_health.reset()
    yield
    loop_health.reset()


def test_peak_lag_is_zero_before_anything_is_recorded():
    """The monitor task not running at all (tests, or any code path that
    never started lifespan) must read as a healthy loop rather than
    blowing up in the log line that annotates itself with this."""
    assert loop_health.peak_lag() == 0.0


def test_peak_lag_reports_the_worst_stall_in_the_window():
    now = 1000.0
    with patch("core.loop_health.time.monotonic", return_value=now):
        loop_health._record(now - 5, 0.2)
        loop_health._record(now - 3, 1.7)
        loop_health._record(now - 1, 0.4)
        assert loop_health.peak_lag(10.0) == 1.7


def test_peak_lag_ignores_stalls_older_than_the_window():
    now = 1000.0
    with patch("core.loop_health.time.monotonic", return_value=now):
        loop_health._record(now - 50, 3.0)
        loop_health._record(now - 2, 0.1)
        # The 3.0s stall is real history, just not relevant to a drop that
        # happened seconds ago — that's the whole point of the window.
        assert loop_health.peak_lag(10.0) == 0.1


def test_peak_lag_is_zero_when_every_sample_is_outside_the_window():
    now = 1000.0
    with patch("core.loop_health.time.monotonic", return_value=now):
        loop_health._record(now - 500, 2.0)
        assert loop_health.peak_lag(10.0) == 0.0


def test_record_evicts_samples_past_the_history_horizon():
    loop_health._record(0.0, 0.5)
    loop_health._record(loop_health._HISTORY_SECONDS + 1.0, 0.1)
    assert len(loop_health._history) == 1


def test_reset_drops_all_history():
    loop_health._record(1.0, 0.5)
    loop_health.reset()
    assert loop_health.peak_lag() == 0.0


def test_observe_records_a_stall_and_warns_about_it(caplog):
    """A tick overshooting by more than _STALL_WARN_SECONDS means the loop
    ran nothing at all for that long — including the socket feeding a cast
    device, which is exactly the failure this exists to catch."""
    with caplog.at_level(logging.WARNING, logger="connect.loop"):
        lag = loop_health.observe(100.0, 102.5)

    assert lag == pytest.approx(2.5 - loop_health._TICK_SECONDS)
    assert any("Event loop blocked for 2.00s" in r.message for r in caplog.records)
    assert loop_health._history[-1][1] == lag


def test_observe_stays_quiet_for_an_ordinary_tick(caplog):
    """Normal scheduling jitter is recorded but must not warn — otherwise
    the signal drowns in noise exactly when it is being read."""
    with caplog.at_level(logging.WARNING, logger="connect.loop"):
        lag = loop_health.observe(100.0, 100.0 + loop_health._TICK_SECONDS + 0.01)

    assert lag == pytest.approx(0.01)
    assert not caplog.records


def test_observe_clamps_a_negative_overshoot_to_zero():
    """asyncio.sleep can return a hair early; that must record as 0.0
    rather than a negative "stall" that would poison peak_lag()."""
    assert loop_health.observe(100.0, 100.0) == 0.0
    assert loop_health._history[-1][1] == 0.0


def test_monitor_loop_lag_ticks_and_records_until_cancelled():
    """The task itself, against the real clock — deliberately not faking
    time here (see observe()'s docstring for why that is not an option),
    so this only asserts that the loop actually runs and feeds observe()."""

    async def _run():
        with patch("core.loop_health._TICK_SECONDS", 0.001):
            task = asyncio.create_task(loop_health.monitor_loop_lag())
            await asyncio.sleep(0.05)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(_run())

    assert loop_health._history
    assert all(lag >= 0.0 for _, lag in loop_health._history)
