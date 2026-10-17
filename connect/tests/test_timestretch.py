"""Tests for core/timestretch.py — Rubber Band time stretching."""

import numpy as np
import pytest

from core.mix_timeline import SAMPLE_RATE
from core.timestretch import BLOCK, HISTORY, Stretcher

SR = SAMPLE_RATE


def _music(frames: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(frames) / SR
    mono = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.1 * rng.standard_normal(frames)
    return np.stack([mono, 0.8 * mono], axis=1).astype(np.float32)


def _clicks_over_a_tone(period_s: float, seconds: float) -> tuple[np.ndarray, np.ndarray]:
    """Short bursts every `period_s` over a quiet tone bed; (audio, where
    each burst starts)."""
    frames = int(seconds * SR)
    t = np.arange(frames) / SR
    bed = 0.08 * np.sin(2 * np.pi * 110 * t) + 0.04 * np.sin(2 * np.pi * 277 * t)
    x = np.stack([bed, bed], axis=1)
    n = np.arange(300)
    burst = 0.8 * np.sin(2 * np.pi * 2000 * n / SR) * np.exp(-n / 30)
    starts = np.arange(HISTORY + 1000, frames - SR, int(period_s * SR))
    for i in starts:
        x[i : i + 300] += burst[:, None]
    return x.astype(np.float32), starts


def _stretch(x: np.ndarray, rate_at, frames: int, history: int = HISTORY, chunk: int = 4000):
    """Runs a stretcher the way the engine does: primed with the first
    `history` frames, then fed whatever needed() asks for."""
    s = Stretcher(SR)
    s.prime(x[:history])
    out, fed, made = [], history, 0
    while made < frames:

        def rate(n: int, base: int = made) -> float:
            return rate_at(base + n)

        missing = s.needed(rate(0))
        if missing > 0:
            if fed >= len(x):
                break
            s.push(x[fed : fed + missing + chunk])
            fed += missing + chunk
            continue
        got = s.pull(min(chunk, frames - made), rate)
        # The engine stops filling on an empty pull: needed() saying "enough"
        # has to mean something comes out.
        assert len(got) > 0
        out.append(got)
        made += len(got)
    return np.concatenate(out), s


def _onsets(y: np.ndarray, threshold: float = 0.3) -> np.ndarray:
    envelope = np.abs(y[:, 0])
    onsets, i = [], 0
    while i < len(envelope):
        if envelope[i] > threshold:
            onsets.append(i)
            i += SR // 5
        else:
            i += 1
    return np.array(onsets)


def _timing_errors_ms(rate_at, seconds: float) -> np.ndarray:
    """Per burst, how far from where the rate integral puts it it came out."""
    x, starts = _clicks_over_a_tone(0.5, seconds + 10)
    y, _ = _stretch(x, rate_at, int(seconds * SR))
    consumed = np.cumsum([rate_at(k) for k in range(len(y))])
    expected = np.searchsorted(consumed, starts - HISTORY)
    expected = expected[(expected > SR) & (expected < len(y) - SR)]
    onsets = _onsets(y)
    errors = np.array([onsets[np.argmin(np.abs(onsets - e))] - e for e in expected])
    return errors / SR * 1000


@pytest.mark.parametrize("rate", [0.95, 1.04])
def test_the_input_advances_by_the_rate(rate):
    out, s = _stretch(_music(4 * SR), lambda n: rate, SR)
    assert len(out) == SR
    assert abs(s.input_consumed - rate * len(out)) <= 2 * BLOCK * rate + 4096


@pytest.mark.parametrize(
    "name,rate_at",
    [
        ("steady", lambda k: 0.97),
        ("easing down", lambda k: 1 - 0.03 * min(1.0, k / (4 * SR))),
        ("easing up", lambda k: 1 + 0.04 * min(1.0, k / (4 * SR))),
    ],
)
def test_beats_land_where_the_rate_says_without_drifting(name, rate_at):
    """The engine marks the outgoing song by the rate's integral and lines
    the incoming one up against that; a stretcher whose output strays from
    it puts the two kicks apart - heard as a flam from ~12 ms. Measured
    over a 40 s hold, longer than any overlap, so slow drift shows."""
    errors = _timing_errors_ms(rate_at, 40)
    assert len(errors) > 60
    assert np.max(np.abs(errors)) < 5
    # No drift: the last bursts sit no further off than the first ones.
    assert abs(np.median(errors[-10:]) - np.median(errors[:10])) < 1.5


def test_primed_with_what_was_just_played_it_carries_on_without_a_seam():
    """Started mid-song, the first frames have nothing before them and would
    fade in. Primed with the frames before, the output at rate 1 is the
    input from the first frame, and a stretch from there starts at full
    level."""
    x = _music(3 * SR, seed=5)
    out, _ = _stretch(x, lambda n: 1.0, 2048)
    ref = x[HISTORY : HISTORY + 2048]
    assert np.sqrt(np.mean((out - ref) ** 2)) < 0.05 * np.sqrt(np.mean(ref**2))

    out, _ = _stretch(x, lambda n: 1.03, 512)
    level_db = 20 * np.log10(np.sqrt(np.mean(out**2)) / np.sqrt(np.mean(ref[:512] ** 2)))
    assert abs(level_db) < 1


@pytest.mark.parametrize("rate", [0.95, 1.0, 1.04])
def test_the_level_stays_the_same(rate):
    x = _music(8 * SR, seed=2)
    out, _ = _stretch(x, lambda n: rate, 5 * SR)
    ref = x[HISTORY : HISTORY + int(5 * SR * rate)]
    level_db = 20 * np.log10(np.sqrt(np.mean(out[SR:] ** 2)) / np.sqrt(np.mean(ref[SR:] ** 2)))
    assert abs(level_db) < 0.5


def _bass_under_a_mix(seconds: float, seed: int) -> np.ndarray:
    """A loud bass under many unrelated partials - what a stretcher that
    lines frames up on the bass alone cannot keep together."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * SR)) / SR
    mono = 0.5 * np.sin(2 * np.pi * 55 * t)
    for f in rng.uniform(300, 4000, 40):
        mono += 0.05 * np.sin(2 * np.pi * f * t + rng.uniform(0, 2 * np.pi))
    return np.stack([mono, mono], axis=1).astype(np.float32)


def _pumping_db(y: np.ndarray, hz: float) -> float:
    """How far the mids' and highs' envelope stands out at `hz` over the
    rates around it."""
    mono = y[SR // 2 : -SR // 2, 0].astype(np.float64)
    spectrum = np.fft.rfft(mono)
    spectrum[np.fft.rfftfreq(len(mono), 1 / SR) < 300] = 0
    envelope = np.abs(np.fft.irfft(spectrum, len(mono)))
    envelope = envelope[: len(envelope) // 44 * 44].reshape(-1, 44).mean(axis=1)
    power = np.abs(np.fft.rfft(envelope - envelope.mean())) ** 2
    distance = np.abs(np.fft.rfftfreq(len(envelope), 44 / SR) - hz)
    return 10 * np.log10(
        power[distance < 0.3].max() / np.median(power[(distance > 1) & (distance < 6)])
    )


@pytest.mark.parametrize("rate", [0.95, 1.04])
def test_a_stretched_mix_does_not_pump(rate):
    """The WSOLA this replaced made the mids and highs pump 43 times a
    second (its hop rate) - a voice heard through a fan, at any rate."""
    for seed in range(3):
        y, _ = _stretch(_bass_under_a_mix(5, seed), lambda n: rate, 3 * SR)
        assert _pumping_db(y, SR / 1024) < 12


def test_nothing_comes_out_until_enough_has_gone_in():
    s = Stretcher(SR)
    s.prime(_music(HISTORY))
    s.push(_music(100))
    assert len(s.pull(BLOCK, lambda n: 1.0)) == 0
    missing = s.needed(1.0)
    assert missing > 0
    s.push(_music(missing, seed=1))
    assert s.needed(1.0) == 0
    assert len(s.pull(BLOCK, lambda n: 1.0)) > 0
