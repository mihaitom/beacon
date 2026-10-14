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
