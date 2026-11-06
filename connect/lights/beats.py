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
chain of kicks about one beat apart. It follows a tempo that wanders and
lands on the kick. 119 of the 120 songs get beats this way; the one left
out is a ballad without drums.

The chain runs mostly on how far the bass band's level jumps
(punch_envelope), not on the onset envelopes alone: those work on a log
spectrum, where a quiet bass note rises about as far as a loud kick, so a
chain on them moved onto the bassline for whole sections. In the bass band
the kick is usually the loudest thing
(docs/investigations/lights/lights-switch-between-kick-and-bass.md).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from core.beat_analysis import (
    _ENVELOPE_OFFSET,
    _FPS,
    _HOP,
    ANALYSIS_RATE,
    _fold,
    beat_strengths,
    grid_from_envelopes,
    low_passed,
)
from core.transition_planner import MIN_CONFIDENCE

# The kick's share of the envelope that checks a song's tempo and whether it
# has a beat at all: house puts its hi-hats between the beats, and the full
# band alone folds on them.
_KICK_SHARE = 0.6
# Level windows: 25 ms holds a whole period of a 40 Hz kick, and its attack
# is over within 30. A snare or clap is shorter and needs no more than this.
_PUNCH_WINDOW_SECONDS, _PUNCH_RISE_SECONDS = 0.025, 0.03
_SNAP_WINDOW_SECONDS, _SNAP_RISE_SECONDS = 0.012, 0.015
_SNAP_HZ = (300.0, 3000.0)
# A kick's level rises steepest this long after its start, so the chain would
# land that much late: measured on 19 songs against their separated kicks.
_PUNCH_LAG_SECONDS = 0.015
# The punch's share of what the chain follows. Where the kick is not the
# loudest thing in the bass, the onsets keep it on the beat: on 59 songs a
# share of 1 left one at 35 % of its beats on the kick and 0.7 at 69 %, while
# the bassline only took a section over again at 0.5.
_PUNCH_SHARE = 0.7
# As much punch halfway between the beats as on them means the tempo found is
# half the real one: the four such songs (60-68 BPM) measured 0.74 to 0.98,
# the next slow one 0.56. Only up to _MAX_DOUBLED_BPM, since a song at 110
# with kicks on the eighths measures the same and is at the right tempo.
_KICKS_BETWEEN_BEATS = 0.65
_MAX_DOUBLED_BPM = 160.0
# The grid's tempo can be 4/3 or 3/4 of the true one (half of it is
# _kicks_between's). The other is taken when its fold is clearly sharper: on the 120 songs every
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


def _level_rise(
    signal: np.ndarray, frames: int, window: float, rise: float, lag: float = 0.0
) -> np.ndarray:
    """How far `signal`'s level jumps, one value per onset envelope frame and
    in the same time (frame t is t / _FPS + _ENVELOPE_OFFSET into the song)."""
    w, r = int(window * ANALYSIS_RATE), int(rise * ANALYSIS_RATE)
    power = np.concatenate([[0.0], np.cumsum(signal.astype(np.float64) ** 2)])
    level = np.sqrt(np.maximum(power[w:] - power[:-w], 0.0) / w)
    rising = np.concatenate([[0.0], np.cumsum(np.maximum(level[r:] - level[:-r], 0.0))])
    seconds = np.arange(frames) / _FPS + _ENVELOPE_OFFSET + lag
    centres = seconds * ANALYSIS_RATE - (w + r) / 2
    start = np.clip((centres - _HOP / 2).astype(int), 0, len(rising) - 1)
    end = np.clip(start + _HOP, 0, len(rising) - 1)
    return (rising[end] - rising[start]) / _HOP


def punch_envelope(samples: np.ndarray, frames: int) -> np.ndarray:
    """The kick: how far the level below 150 Hz jumps."""
    return _level_rise(
        low_passed(samples), frames, _PUNCH_WINDOW_SECONDS, _PUNCH_RISE_SECONDS, _PUNCH_LAG_SECONDS
    )


def band_passed(samples: np.ndarray, low: float, high: float) -> np.ndarray:
    spectrum = np.fft.rfft(samples)
    hz = np.fft.rfftfreq(len(samples), 1 / ANALYSIS_RATE)
    spectrum[(hz < low) | (hz > high)] = 0
    return np.fft.irfft(spectrum, len(samples))


def snap_envelope(samples: np.ndarray, frames: int) -> np.ndarray:
    """A snare or clap: how far the level of the band it cracks in jumps."""
    band = band_passed(samples, *_SNAP_HZ)
    return _level_rise(band, frames, _SNAP_WINDOW_SECONDS, _SNAP_RISE_SECONDS)


def find_beats(full: np.ndarray, kick: np.ndarray, punch: np.ndarray) -> Beats | None:
    """The beats of a song from its onset envelopes (onset_envelopes()) and
    punch_envelope(), or None where it has no beat worth following."""
    grid = grid_from_envelopes(full, kick)
    if grid is None:
        return None
    envelope = _KICK_SHARE * _standardised(kick) + (1 - _KICK_SHARE) * _standardised(full)
    period = _tempo(envelope, grid.period * _FPS)
    if grid.confidence < MIN_CONFIDENCE and _repeats(envelope, period) < _MIN_PERIODICITY:
        return None
    chain = _PUNCH_SHARE * _standardised(punch) + (1 - _PUNCH_SHARE) * envelope
    frames = _track(chain, period)
    if len(frames) < 8:
        return None
    if period / 2 >= _FPS * 60 / _MAX_DOUBLED_BPM and _kicks_between(punch, frames):
        frames = _track(chain, period / 2)
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


def _kicks_between(punch: np.ndarray, frames: np.ndarray) -> bool:
    """Whether as much punch falls halfway between the beats as on them. The
    louder half of each only: a song's kick may leave out every other beat."""
    times = frames / _FPS + _ENVELOPE_OFFSET
    on = np.sort(beat_strengths(punch, times))
    between = np.sort(beat_strengths(punch, (times[:-1] + times[1:]) / 2))
    on_top = on[len(on) // 2 :].mean()
    return on_top > 0 and between[len(between) // 2 :].mean() >= _KICKS_BETWEEN_BEATS * on_top


def _downbeat(kick: np.ndarray, times: np.ndarray) -> int:
    """Of the four beats in a bar (4/4 assumed), the one with most kick."""
    strength = beat_strengths(kick, times)
    return int(np.argmax([strength[j::4].sum() for j in range(4)]))
