"""lights/beats.py: the lights' beats land where they are heard - on the
kick, through a tempo that wanders - for songs the beatmix grid turns
down or misplaces."""

import itertools

import numpy as np
import pytest

from core.beat_analysis import _FPS, ANALYSIS_RATE, onset_envelopes
from lights import beats as light_beats
from lights.beats import find_beats, punch_envelope

_RNG = np.random.default_rng(3)


def _kick(n: int) -> np.ndarray:
    t = np.arange(n) / ANALYSIS_RATE
    return np.sin(2 * np.pi * 55 * t) * np.exp(-t / 0.04)


def _hat(n: int) -> np.ndarray:
    t = np.arange(n) / ANALYSIS_RATE
    return _RNG.standard_normal(n) * np.exp(-t / 0.015)


def _song(kicks: np.ndarray, seconds: float, hats_between: bool = False) -> np.ndarray:
    out = np.zeros(int(seconds * ANALYSIS_RATE), dtype=np.float32)
    n = int(0.15 * ANALYSIS_RATE)

    def put(at: float, sound: np.ndarray) -> None:
        start = int(at * ANALYSIS_RATE)
        end = min(start + len(sound), len(out))
        out[start:end] += sound[: end - start]

    for at in kicks:
        put(at, _kick(n))
    if hats_between:
        for a, b in itertools.pairwise(kicks):
            put((a + b) / 2, 1.5 * _hat(n))
    return out


def _beats_of(samples: np.ndarray) -> light_beats.Beats | None:
    full, kick = onset_envelopes(samples)
    return find_beats(full, kick, punch_envelope(samples, len(full)))


def _off_by(found: np.ndarray, kicks: np.ndarray) -> np.ndarray:
    """For each kick, how far the nearest beat found is from it (s)."""
    return np.abs(found[None, :] - kicks[:, None]).min(axis=1)


def test_the_beats_land_on_the_kick_not_on_louder_hats_between():
    kicks = np.arange(0.5, 40, 60 / 128)
    found = _beats_of(_song(kicks, 40, hats_between=True))
    assert found is not None
    assert np.median(_off_by(found.times, kicks[4:-4])) < 0.03


def test_a_tempo_that_wanders_is_followed_beat_by_beat():
    # A drummer from 116 to 124 BPM over a minute.
    gaps = 60 / np.linspace(116, 124, 120)
    kicks = 0.5 + np.concatenate([[0.0], np.cumsum(gaps)])
    song = _song(kicks, kicks[-1] + 1)
    found = _beats_of(song)
    assert found is not None
    assert np.percentile(_off_by(found.times, kicks[4:-4]), 95) < 0.03


def _bass_note(n: int, level: float) -> np.ndarray:
    t = np.arange(n) / ANALYSIS_RATE
    return level * np.sin(2 * np.pi * 70 * t) * np.minimum(t / 0.005, 1.0)


def test_a_bass_riff_ahead_of_the_kick_does_not_take_the_beats_over():
    # Alternating sections: kick alone, then a riff a sixteenth ahead of each
    # kick. On a log spectrum the riff's rise reads like the kick's own.
    period = 60 / 128
    kicks = np.arange(0.5, 90, period)
    out = _song(kicks, 90)
    n = int(0.09 * ANALYSIS_RATE)
    riff_sections = ((kicks > 15) & (kicks < 45)) | ((kicks > 60) & (kicks < 80))
    for at in kicks[riff_sections] - period / 4:
        start = int(at * ANALYSIS_RATE)
        out[start : start + n] += _bass_note(n, 0.2)
    found = _beats_of(out)
    assert found is not None
    assert np.percentile(_off_by(found.times, kicks[4:-4]), 95) < 0.03


def test_a_bassline_between_the_kicks_is_not_taken_for_kicks():
    period = 60 / 128
    kicks = np.arange(0.5, 39, period)
    out = _song(kicks, 40)
    n = int(0.15 * ANALYSIS_RATE)
    for at in kicks[:-1] + period / 2:
        start = int(at * ANALYSIS_RATE)
        out[start : start + n] += _bass_note(n, 0.3)
    punch = punch_envelope(out, int(40 * _FPS) - 200)
    frames = (kicks[4:-8] - light_beats._ENVELOPE_OFFSET) * _FPS
    assert not light_beats._kicks_between(punch, frames)


def test_a_tempo_half_the_kicks_is_doubled(monkeypatch):
    # Two kicks to every beat the tempo finder settled on.
    kicks = np.arange(0.5, 40, 60 / 134)
    samples = _song(kicks, 40)
    half_tempo = light_beats._tempo
    monkeypatch.setattr(
        light_beats, "_tempo", lambda envelope, period: half_tempo(envelope, period) * 2
    )
    full, kick = onset_envelopes(samples)
    grid = light_beats.grid_from_envelopes(full, kick)
    assert grid is not None and grid.bpm == pytest.approx(134, rel=0.02)
    found = _beats_of(samples)
    assert found is not None
    assert found.bpm == pytest.approx(134, rel=0.02)
    assert np.median(_off_by(found.times, kicks[4:-4])) < 0.03


def test_kicks_on_the_eighths_of_a_mid_tempo_song_are_not_a_doubled_tempo(monkeypatch):
    kicks = np.arange(0.5, 40, 30 / 110)
    samples = _song(kicks, 40)
    monkeypatch.setattr(light_beats, "_tempo", lambda envelope, period: _FPS * 60 / 110)
    found = _beats_of(samples)
    assert found is not None
    assert found.bpm == pytest.approx(110, rel=0.02)


def test_a_tempo_a_third_off_is_put_right():
    period = 0.6 * _FPS
    envelope = np.zeros(int(60 * _FPS))
    envelope[np.arange(0, len(envelope), period).astype(int)] = 1.0
    assert light_beats._tempo(envelope, period * 3 / 4) == pytest.approx(period)
    assert light_beats._tempo(envelope, period) == pytest.approx(period)


def test_only_onsets_that_repeat_at_the_tempo_count_as_a_beat():
    # What lets a song the grid is unsure of have beats after all.
    period = 0.5 * _FPS
    steady = np.zeros(int(40 * _FPS))
    steady[np.arange(0, len(steady), period).astype(int)] = 1.0
    scattered = np.zeros(len(steady))
    scattered[_RNG.integers(0, len(steady), 80)] = 1.0
    assert light_beats._repeats(steady, period) >= light_beats._MIN_PERIODICITY
    assert light_beats._repeats(scattered, period) < light_beats._MIN_PERIODICITY


def test_a_half_time_groove_counts_as_a_beat():
    # A kick on every other beat, and something else between them.
    period = 0.5 * _FPS
    groove = np.zeros(int(40 * _FPS))
    groove[np.arange(0, len(groove), 2 * period).astype(int)] = 1.0
    groove[_RNG.integers(0, len(groove), 80)] = 0.8
    assert light_beats._periodicity(groove, period) < light_beats._MIN_PERIODICITY
    assert light_beats._repeats(groove, period) >= light_beats._MIN_PERIODICITY
