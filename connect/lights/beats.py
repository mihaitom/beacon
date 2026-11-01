"""lights/beats.py — where a song's beats fall, for the lights.

Beatmixing needs one steady grid for a whole song and rather none than a
doubtful one (core/beat_analysis.py). The lights need the opposite: every
beat where it is heard, for as many songs as possible. Measured
2026-11-01 on 120 songs picked at random from a library, against their BPM
tags: the grid's tempo was right for 117, but it took only 90 - played
songs whose tempo wanders a little fail its check that both halves agree -
and for 16 of those 90 it sat half a beat off the kick, on the hi-hats.

So the lights take the grid's tempo and then place each beat on its own
(dynamic programming over the onsets, the textbook beat tracker): the best
chain of onsets about one beat apart, the kick weighted over the rest of
the band. It follows a tempo that wanders and a section that leans
elsewhere, and lands on the kick. 119 of the 120 songs get beats this way;
the one left out is a ballad without drums.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from core.beat_analysis import (
    _ENVELOPE_OFFSET,
    _FPS,
    _fold,
    beat_strengths,
    grid_from_envelopes,
)
from core.transition_planner import MIN_CONFIDENCE

# The kick's share of the envelope the beats are placed on: house puts its
# hi-hats between the beats, and the full band alone lands on them.
_KICK_SHARE = 0.6
# The grid's one tempo mistake that matters is 4/3 or 3/4 of the true
# tempo (double or half still lights on the beat). The other is taken
# when its fold is clearly sharper: on the 120 songs every
# margin from 1.1 to 1.2 got all tempos right, none outside it did.
_TEMPO_ALTERNATIVES = (4 / 3, 3 / 4)
_TEMPO_SWITCH_MARGIN = 1.15
_MIN_BPM, _MAX_BPM = 50.0, 200.0
# How hard a beat-to-beat gap off the tempo is penalised (on a log scale,
# per beat): loose enough for a drummer, tight enough not to wander onto
# every offbeat.
_TIGHTNESS = 100.0
# A song the grid is unsure of still gets beats where its onsets repeat at
# the tempo: the median over 8 s stretches of the envelope's correlation
# with itself a beat or two later (two for a half-time groove, which
# measured 0.12 at one and 0.46 at two). Of the 120 songs the ballad
# without drums measured 0.14, everything else from 0.17 up.
_PERIODICITY_WINDOW_SECONDS = 8.0
_MIN_PERIODICITY = 0.15


@dataclass(frozen=True)
class Beats:
    # Seconds into the song, rising.
    times: np.ndarray
    # The beat a bar starts on is every fourth from this one (0-3).
    downbeat: int
    # Seconds: the typical gap, for counting on before the first beat and
    # after the last.
    period: float

    @property
    def bpm(self) -> float:
        return 60.0 / self.period


def find_beats(full: np.ndarray, kick: np.ndarray) -> Beats | None:
    """The beats of a song from its onset envelopes (onset_envelopes()),
    or None where it has no beat worth following."""
    grid = grid_from_envelopes(full, kick)
    if grid is None:
        return None
    envelope = _KICK_SHARE * _standardised(kick) + (1 - _KICK_SHARE) * _standardised(full)
    period = _tempo(envelope, grid.period * _FPS)
    if grid.confidence < MIN_CONFIDENCE and _repeats(envelope, period) < _MIN_PERIODICITY:
        return None
    frames = _track(envelope, period)
    if len(frames) < 8:
        return None
    times = frames / _FPS + _ENVELOPE_OFFSET
    return Beats(
        times=times,
        downbeat=_downbeat(kick, times),
        period=float(np.median(np.diff(times))),
    )


def _standardised(envelope: np.ndarray) -> np.ndarray:
    spread = envelope.std()
    return envelope / spread if spread > 0 else envelope


def _sharpness(envelope: np.ndarray, period: float) -> float:
    hist = _fold(envelope - envelope.min(), np.array([period]))[0]
    return float(hist.max() / hist.mean()) if hist.mean() > 0 else 0.0


def _tempo(envelope: np.ndarray, period: float) -> float:
    """`period` (hops), or a third off it where that folds clearly sharper."""
    base = _sharpness(envelope, period)
    best, best_sharpness = period, base
    for factor in _TEMPO_ALTERNATIVES:
        other = period * factor
        if not _FPS * 60 / _MAX_BPM <= other <= _FPS * 60 / _MIN_BPM:
            continue
        sharpness = _sharpness(envelope, other)
        if sharpness > _TEMPO_SWITCH_MARGIN * max(base, best_sharpness):
            best, best_sharpness = other, sharpness
    return best


def _repeats(envelope: np.ndarray, period: float) -> float:
    return max(_periodicity(envelope, period), _periodicity(envelope, 2 * period))


def _periodicity(envelope: np.ndarray, period: float) -> float:
    window = int(_PERIODICITY_WINDOW_SECONDS * _FPS)
    lags = range(int(period * 0.94), int(period * 1.06) + 1)
    values = []
    for start in range(0, len(envelope) - window + 1, window):
        part = envelope[start : start + window] - envelope[start : start + window].mean()
        variance = part.var()
        if variance <= 0:
            continue
        values.append(max(float((part[:-lag] * part[lag:]).mean() / variance) for lag in lags))
    return float(np.median(values)) if values else 0.0


def _track(envelope: np.ndarray, period: float) -> np.ndarray:
    """The frames of the strongest chain of onsets about `period` apart."""
    n = len(envelope)
    gaps = np.arange(max(1, round(period / 2)), round(period * 2) + 1)
    penalty = -_TIGHTNESS * np.log(gaps / period) ** 2
    score = envelope.astype(float).copy()
    previous = np.full(n, -1)
    for t in range(int(gaps[0]), n):
        before = t - gaps
        valid = before >= 0
        candidates = score[before[valid]] + penalty[valid]
        best = int(np.argmax(candidates))
        if candidates[best] > 0:
            score[t] += candidates[best]
            previous[t] = before[valid][best]
    tail = max(1, int(period))
    t = n - tail + int(np.argmax(score[n - tail :]))
    chain = []
    while t >= 0:
        chain.append(t)
        t = int(previous[t])
    return np.array(chain[::-1], dtype=float)


def _downbeat(kick: np.ndarray, times: np.ndarray) -> int:
    """Of the four beats in a bar (4/4 assumed), the one with most kick."""
    strength = beat_strengths(kick, times)
    return int(np.argmax([strength[j::4].sum() for j in range(4)]))
