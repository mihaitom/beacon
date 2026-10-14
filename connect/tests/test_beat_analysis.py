"""Tests for core/beat_analysis.py, on synthetic material whose beats are
known exactly: a kick on the downbeat, hats on the other three beats."""

import shutil
import wave

import numpy as np
import pytest

import core.beat_analysis as ba
from core import streamer
from core.beat_analysis import (
    ANALYSIS_RATE,
    analyse_region,
    analyse_samples,
    beat_grid,
    sound_bounds,
)

SR = ANALYSIS_RATE


def track(bpm: float, seconds: float, phase: float, downbeat: int = 0, noise=0.02, seed=0):
    rng = np.random.default_rng(seed)
    x = np.zeros(int(seconds * SR), dtype=np.float32)
    n = np.arange(int(0.08 * SR))
    for k in range(int((seconds - phase) * bpm / 60)):
        t = phase + k * 60 / bpm
        if (k - downbeat) % 4 == 0:
            burst = 0.9 * np.sin(2 * np.pi * 55 * n / SR) * np.exp(-n / (0.03 * SR))
        else:
            burst = 0.3 * rng.standard_normal(len(n)) * np.exp(-n / (0.005 * SR))
        i = int(t * SR)
        x[i : i + len(n)] += burst[: len(x) - i]
    return x + noise * rng.standard_normal(len(x)).astype(np.float32)


def phase_error(grid, phase: float) -> float:
    return ((grid.phase - phase + grid.period / 2) % grid.period) - grid.period / 2


@pytest.mark.parametrize("bpm", [90, 120, 128, 140])
@pytest.mark.parametrize("phase", [0.0, 0.123, 0.31])
def test_tempo_and_beats_are_found(bpm, phase):
    grid = beat_grid(track(bpm, 30, phase))
    assert grid.bpm == pytest.approx(bpm, abs=0.1)
    assert abs(phase_error(grid, phase)) < 0.005
    assert grid.confidence > 0.8


@pytest.mark.parametrize("downbeat", [0, 1, 3])
def test_the_downbeat_is_the_beat_with_the_kick(downbeat):
    bpm, phase = 124, 0.2
    grid = beat_grid(track(bpm, 30, phase, downbeat=downbeat))
    expected = phase + downbeat * 60 / bpm
    bar = 4 * grid.period
    off = ((grid.downbeat - expected + bar / 2) % bar) - bar / 2
    assert abs(off) < 0.01
    assert grid.downbeat_confidence > 0.3


def test_the_servers_bpm_settles_which_octave():
    x = track(174, 30, 0.1)
    assert beat_grid(x).bpm == pytest.approx(87, abs=0.2)  # without: the half
    assert beat_grid(x, bpm_hint=174).bpm == pytest.approx(174, abs=0.2)


def test_noise_has_no_trustworthy_grid():
    noise = np.random.default_rng(1).standard_normal(30 * SR).astype(np.float32) * 0.2
    grid = beat_grid(noise)
    assert grid is None or grid.confidence < 0.5


def test_too_little_to_go_on_is_no_grid():
    assert beat_grid(track(120, 3, 0.0)) is None
    assert beat_grid(np.zeros(30 * SR, dtype=np.float32)) is None


def test_grid_helpers_list_beats_and_downbeats_in_a_span():
    grid = ba.BeatGrid(0.5, 0.1, 0.6, 1.0, 1.0)
    assert grid.beats(0, 1.2).tolist() == pytest.approx([0.1, 0.6, 1.1])
    assert grid.downbeats(0, 5).tolist() == pytest.approx([0.6, 2.6, 4.6])


def test_silence_at_either_end_is_found():
    x = np.concatenate([np.zeros(SR // 2), track(120, 4, 0.0, noise=0.0), np.zeros(2 * SR)]).astype(
        np.float32
    )
    start, end = sound_bounds(x)
    assert start == pytest.approx(0.5, abs=0.06)
    # The last hat is at 3.5s into the track and rings for a few ms.
    assert 3.95 < end < 4.15
    assert sound_bounds(np.zeros(SR, dtype=np.float32)) is None


def ambient(seconds: float, level=0.05):
    """A chord pad with a slow swell: sound, but no beat."""
    t = np.arange(int(seconds * SR)) / SR
    chord = sum(np.sin(2 * np.pi * f * t) for f in (220, 277.2, 329.6, 440))
    return (level * chord * (0.6 + 0.4 * np.sin(2 * np.pi * 0.2 * t))).astype(np.float32)


def test_the_beat_ends_where_an_ambient_tail_begins():
    bpm, bar = 128, 4 * 60 / 128
    x = np.concatenate([track(bpm, 40, 0.1) + ambient(40), ambient(25)])
    region = analyse_samples(x, start=175.0)
    # The tail is sound, but the beat stops with the last bar of drums.
    assert region.sound_end == pytest.approx(240.0, abs=0.1)
    assert 215.1 - bar <= region.beat_end <= 215.1 + 0.01
    assert region.grid.downbeats(region.beat_end - 0.01, region.beat_end + 0.01).size == 1


def test_a_tail_longer_than_the_beat_leaves_the_grid_trusted():
    x = np.concatenate([track(128, 24, 0.1) + ambient(24), ambient(36)])
    grid = analyse_samples(x, start=0.0).grid
    assert grid.bpm == pytest.approx(128, abs=0.1)
    assert grid.confidence > 0.8


def without_bass(x):
    spectrum = np.fft.rfft(x)
    spectrum[np.fft.rfftfreq(len(x), 1 / SR) < 300] = 0
    return np.fft.irfft(spectrum, len(x)).astype(np.float32)


def test_the_beat_starts_where_drums_and_bass_come_in():
    bar = 4 * 60 / 128
    # A rhythmic intro without bass, a breakdown with bass but no drums, then
    # the beat - all on one grid.
    full = track(128, 60, 0.1)
    x = without_bass(full[: 15 * SR])
    breakdown = 0.3 * np.sin(2 * np.pi * 55 * np.arange(15 * SR) / SR).astype(np.float32)
    x = np.concatenate([x, breakdown, full[30 * SR :]])
    region = analyse_samples(x, start=0.0)
    assert 30.0 <= region.beat_start <= 30.0 + bar
    assert region.beat_end > 55.0


def test_a_lone_hit_in_the_tail_does_not_carry_the_beat():
    x = np.concatenate([track(128, 40, 0.1), ambient(25)])
    x[int(55 * SR) : int(55.08 * SR)] += track(128, 1, 0.0, noise=0.0)[: int(0.08 * SR)]
    assert analyse_samples(x, start=0.0).beat_end < 41.0


def test_a_beat_from_start_to_end_spans_the_whole_bars():
    region = analyse_samples(track(128, 40, 0.1), start=0.0)
    assert region.beat_start < 0.1 + 4 * 60 / 128
    assert 40.0 - 4 * 60 / 128 <= region.beat_end <= 40.0


def test_a_region_is_reported_in_the_songs_own_seconds():
    region = analyse_samples(track(120, 30, 0.25), start=100.0)
    assert (region.start, region.end) == pytest.approx((100.0, 130.0))
    assert abs(phase_error(region.grid, 100.25)) < 0.005


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")
async def test_a_real_file_is_decoded_and_analysed(tmp_path, monkeypatch):
    monkeypatch.setattr(streamer, "FFMPEG_BIN", "ffmpeg")
    x = track(128, 40, 0.3, noise=0.01)
    path = tmp_path / "t.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    region = await analyse_region(str(path), 10.0, 25.0)
    assert region.start == 10.0 and region.end == pytest.approx(35.0, abs=0.01)
    assert region.grid.bpm == pytest.approx(128, abs=0.1)
    assert abs(phase_error(region.grid, 0.3)) < 0.006


async def test_a_source_that_cannot_be_read_is_no_analysis(monkeypatch):
    monkeypatch.setattr(streamer, "FFMPEG_BIN", "/nonexistent/ffmpeg")
    assert await analyse_region("x", 0, 10) is None
