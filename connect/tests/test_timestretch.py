"""Tests for core/timestretch.py — WSOLA time stretching."""

import numpy as np
import pytest

from core.mix_timeline import SAMPLE_RATE
from core.timestretch import FRAME, HOP, Wsola

SR = SAMPLE_RATE


def _music(frames: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(frames) / SR
    mono = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.1 * rng.standard_normal(frames)
    return np.stack([mono, 0.8 * mono], axis=1).astype(np.float32)


def _clicks(period_s: float, seconds: float) -> np.ndarray:
    x = np.zeros((int(seconds * SR), 2), dtype=np.float32)
    n = np.arange(200)
    burst = (np.sin(2 * np.pi * 1000 * n / SR) * np.exp(-n / 40)).astype(np.float32)
    for k in range(int(seconds / period_s)):
        i = int(k * period_s * SR)
        x[i : i + 200, 0] += burst[: len(x) - i]
        x[i : i + 200, 1] += burst[: len(x) - i]
    return x


def _stretch(x: np.ndarray, rate_at, frames: int, chunk: int = 4000) -> np.ndarray:
    w = Wsola()
    out, fed = [], 0
    while sum(len(o) for o in out) < frames:
        got = w.pull(frames - sum(len(o) for o in out), rate_at)
        if len(got):
            out.append(got)
            continue
        if fed >= len(x):
            break
        w.push(x[fed : fed + chunk])
        fed += chunk
    return np.concatenate(out), w


def test_at_rate_one_the_output_is_the_input():
    x = _music(SR)
    out, _ = _stretch(x, lambda n: 1.0, SR - FRAME)
    # Past the first half frame, which fades in.
    np.testing.assert_allclose(out[HOP:], x[HOP : len(out)], atol=1e-6)


@pytest.mark.parametrize("rate", [0.93, 1.05, 1.08])
def test_the_input_advances_by_the_rate(rate):
    out, w = _stretch(_music(3 * SR), lambda n: rate, SR)
    assert len(out) == SR
    # Whole steps only: within one hop of exactly rate x output.
    assert abs(w.input_consumed - rate * len(out)) <= HOP * rate


def test_beats_come_closer_together_when_sped_up():
    period = 0.5
    out, _ = _stretch(_clicks(period, 12), lambda n: 1.05, int(10 * SR))
    envelope = np.abs(out[:, 0])
    onsets = []
    i = 0
    while i < len(envelope):
        if envelope[i] > 0.3:
            onsets.append(i)
            i += int(0.2 * SR)
        else:
            i += 1
    spacing = np.diff(onsets[2:]) / SR
    assert np.median(spacing) == pytest.approx(period / 1.05, abs=0.006)
    assert np.all(np.abs(spacing - period / 1.05) < 0.012)


def test_handing_back_continues_exactly_where_the_stretch_left_off():
    x = _music(4 * SR, seed=5)
    w = Wsola()
    w.push(x[: 3 * SR])
    rates = iter([1.04] * 40 + [1.0] * 4)
    made = []
    for rate in rates:
        made.append(w.pull(HOP, lambda n, r=rate: r))
    ready, rest = w.handover()
    # The last stretch was played at rate 1: it is the input itself, so the
    # input left over has to follow on from the last output sample.
    last = np.concatenate(made)[-HOP:]
    start = np.flatnonzero(
        np.all(
            np.isclose(
                np.lib.stride_tricks.sliding_window_view(x[:, 0], HOP), last[:, 0], atol=1e-6
            ),
            axis=1,
        )
    )
    assert len(start) == 1
    assert len(ready) == 0
    np.testing.assert_allclose(rest[:1000], x[start[0] + HOP : start[0] + HOP + 1000], atol=1e-6)


def test_nothing_comes_out_until_enough_has_gone_in():
    w = Wsola()
    w.push(_music(100))
    assert len(w.pull(HOP, lambda n: 1.0)) == 0
    assert w.needed(1.0) == FRAME - 100
