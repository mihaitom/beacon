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


def _bass_under_a_mix(seconds: float, seed: int) -> np.ndarray:
    """A loud bass under many unrelated partials - the mix that defeats a
    match too narrow to line the bass up."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * SR)) / SR
    mono = 0.5 * np.sin(2 * np.pi * 55 * t)
    for f in rng.uniform(300, 4000, 40):
        mono += 0.05 * np.sin(2 * np.pi * f * t + rng.uniform(0, 2 * np.pi))
    return np.stack([mono, mono], axis=1).astype(np.float32)


def _hop_rate_pumping_db(y: np.ndarray) -> float:
    """How far the mids' and highs' envelope stands out at the hop rate
    over the rates around it."""
    mono = y[SR // 2 : -SR // 2, 0].astype(np.float64)
    spectrum = np.fft.rfft(mono)
    spectrum[np.fft.rfftfreq(len(mono), 1 / SR) < 300] = 0
    envelope = np.abs(np.fft.irfft(spectrum, len(mono)))
    envelope = envelope[: len(envelope) // 44 * 44].reshape(-1, 44).mean(axis=1)
    power = np.abs(np.fft.rfft(envelope - envelope.mean())) ** 2
    distance = np.abs(np.fft.rfftfreq(len(envelope), 44 / SR) - SR / HOP)
    return 10 * np.log10(
        power[distance < 0.3].max() / np.median(power[(distance > 1) & (distance < 6)])
    )


@pytest.mark.parametrize("rate", [0.95, 1.04])
def test_a_stretched_mix_does_not_pump_at_the_hop_rate(rate):
    """Frames that half-cancel in every overlap make the mids and highs
    pump 43 times a second - a voice heard through a fan. That was the
    first ~30 s of every beatmixed song while it eased back to its tempo."""
    pumping = [
        _hop_rate_pumping_db(_stretch(_bass_under_a_mix(4, seed), lambda n: rate, 3 * SR)[0])
        for seed in range(4)
    ]
    assert np.mean(pumping) < 20


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
