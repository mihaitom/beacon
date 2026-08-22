"""core/loop_health.py — event-loop stall detection.

Diagnostic instrumentation for the cast-drop investigation (2026-08-22).

A cast device's GET /stream connection is fed from this process's single
asyncio event loop. If the loop is blocked — by CPU work that should have
been handed to a thread, by a slow synchronous call, by GC pressure — no
bytes reach the device for however long the block lasts. The device
underruns, and the symptom that surfaces is the device dropping the
connection mid-track, which looks identical to a network problem from the
logs alone.

That distinction is exactly what the existing logs could not make. The
2026-08-22 02:06 drop on beacon-dev left one line ("Stream cancelled")
and no way to tell a stalled server apart from a flaky speaker. This
module measures the loop's own responsiveness continuously, so the next
occurrence can be attributed rather than guessed at.

Worth measuring here specifically because beacon does real CPU work on
the loop that the simpler upstream (feishin-connect) never did: the live
FFT visualizer (core/audio_analysis.py's analyze_pcm(), ~43 numpy
transforms/sec, called synchronously from _read_pcm()) has no
asyncio.to_thread() around it, unlike core/waveform.py's peak
computation, which does.
"""

import asyncio
import logging
import time
from collections import deque

logger = logging.getLogger("connect.loop")

# How often to probe. Short enough to catch a stall while it still
# overlaps a stream's read/write cadence, long enough to cost nothing.
_TICK_SECONDS = 0.5

# A sleep overshooting by this much means the loop had no chance to run
# this task for that long — i.e. nothing else got serviced either,
# including the socket feeding a cast device.
_STALL_WARN_SECONDS = 1.0

# Rolling window kept for snapshot_lag(), so a drop can be correlated with
# a stall that happened slightly before it rather than exactly at it.
_HISTORY_SECONDS = 120.0

_history: deque[tuple[float, float]] = deque()


def _record(now: float, lag: float) -> None:
    _history.append((now, lag))
    cutoff = now - _HISTORY_SECONDS
    while _history and _history[0][0] < cutoff:
        _history.popleft()


def peak_lag(window_seconds: float = _HISTORY_SECONDS) -> float:
    """Worst loop stall observed in the last `window_seconds`, in seconds.

    0.0 when nothing has been recorded yet — the monitor task not running
    (tests, or a build where lifespan never started) reads the same as a
    perfectly healthy loop, which is the right default for something that
    only ever annotates a log line.
    """
    if not _history:
        return 0.0
    cutoff = time.monotonic() - window_seconds
    return max((lag for ts, lag in _history if ts >= cutoff), default=0.0)


def reset() -> None:
    """Drop all recorded history (tests)."""
    _history.clear()


def observe(before: float, after: float) -> float:
    """Record one tick's overshoot and warn if it was a real stall.

    Split out of monitor_loop_lag() below purely so it's directly
    testable: faking the clock for the loop itself is not possible here,
    because `core.loop_health.time` *is* the global time module and
    asyncio's own event loop reads time.monotonic() to schedule — patching
    it would break the loop running the test rather than just this task's
    view of it. Same reasoning as routes/playback.py's _resync_position_once().
    """
    lag = after - before - _TICK_SECONDS
    if lag <= 0:
        lag = 0.0
    _record(after, lag)
    if lag >= _STALL_WARN_SECONDS:
        logger.warning(
            f"[loop] Event loop blocked for {lag:.2f}s — nothing was "
            "serviced during that window, including any cast device's "
            "open /stream socket"
        )
    return lag


async def monitor_loop_lag() -> None:
    """Background task (see main.py's lifespan): records how far each tick
    overshoots its scheduled wake-up, which is the loop's blocked time."""
    while True:
        before = time.monotonic()
        await asyncio.sleep(_TICK_SECONDS)
        observe(before, time.monotonic())
