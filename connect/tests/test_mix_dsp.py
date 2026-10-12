"""Tests for core/mix_dsp.py — band splitting, fade curves, limiting."""

import numpy as np
import pytest

from core.mix_dsp import (
    DELAY_FRAMES,
    BandSplitter,
    Dither,
    equal_power_in,
    equal_power_out,
    pcm_to_float,
    soft_limit,
)
from core.mix_timeline import SAMPLE_RATE

SR = SAMPLE_RATE


def _noise(frames: int, seed: int = 1) -> np.ndarray:
    return (np.random.default_rng(seed).standard_normal((frames, 2)) * 0.2).astype(np.float32)


def _tone(hz: float, frames: int) -> np.ndarray:
    mono = 0.5 * np.sin(2 * np.pi * hz * np.arange(frames) / SR)
    return np.repeat(mono[:, None], 2, axis=1).astype(np.float32)


def _split(x: np.ndarray, blocks: list[int]) -> list[np.ndarray]:
    splitter = BandSplitter()
    parts = [[], [], []]
    start = 0
    for size in blocks:
        for band, out in zip(parts, splitter.process(x[start : start + size]), strict=True):
            band.append(out)
        start += size
    return [np.concatenate(band) for band in parts]


def test_the_bands_add_up_to_the_input_delayed():
    x = _noise(SR)
    low, mid, high = _split(x, [SR])
    total = low + mid + high
    np.testing.assert_allclose(total[DELAY_FRAMES:], x[: SR - DELAY_FRAMES], atol=1e-5)


def test_the_result_does_not_depend_on_the_block_size():
    x = _noise(SR)
    whole = _split(x, [SR])
    rng = np.random.default_rng(3)
    cuts = np.diff(np.concatenate([[0], np.sort(rng.choice(SR, 20, replace=False)), [SR]]))
    pieces = _split(x, [int(c) for c in cuts])
    for a, b in zip(whole, pieces, strict=True):
        np.testing.assert_allclose(a, b, atol=1e-5)


@pytest.mark.parametrize(("hz", "band"), [(60, 0), (800, 1), (8000, 2)])
def test_each_tone_lands_in_its_band(hz, band):
    bands = _split(_tone(hz, SR), [SR])
    steady = slice(SR // 4, SR)
    energy = [float(np.sqrt(np.mean(b[steady] ** 2))) for b in bands]
    assert energy[band] > 0.3
    assert all(e < 0.03 for i, e in enumerate(energy) if i != band)


def test_unsplit_is_the_same_delayed_input_from_the_same_history():
    x = _noise(SR // 2)
    splitter = BandSplitter()
    first = splitter.process(x[:1000], split=False)[0]
    rest = sum(splitter.process(x[1000:]))
    out = np.concatenate([first, rest])
    np.testing.assert_allclose(out[DELAY_FRAMES:], x[: len(x) - DELAY_FRAMES], atol=1e-5)


def test_equal_power_keeps_the_sum_of_squares():
    x = np.linspace(-0.2, 1.2, 101)
    np.testing.assert_allclose(equal_power_in(x) ** 2 + equal_power_out(x) ** 2, 1.0)
    assert equal_power_in(np.array([0.0, 1.0])).tolist() == pytest.approx([0.0, 1.0])


def test_the_limiter_leaves_ordinary_levels_alone_and_bends_peaks():
    quiet = np.array([[0.5, -0.8]], dtype=np.float32)
    assert soft_limit(quiet) is quiet
    loud = soft_limit(np.array([[1.6, -2.4]], dtype=np.float32))
    assert np.all(np.abs(loud) <= 1.0) and np.all(np.abs(loud) > 0.9)


def test_dither_round_trips_within_a_step():
    pcm = np.array([[1000, -2000], [32767, -32768]], dtype="<i2").tobytes()
    back = np.frombuffer(Dither(seed=1).to_int16(pcm_to_float(pcm)), dtype="<i2")
    assert np.all(np.abs(back.astype(int) - np.frombuffer(pcm, dtype="<i2")) <= 1)
