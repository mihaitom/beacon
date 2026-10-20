"""core/beat_analysis.py — where a song's beats and bars fall.

A transition is planned from the last stretch of the song going out and the
first stretch of the one coming in (core/transition_planner.py). For each
of them this answers two questions:

- **Where the sound is.** A song that ends in four seconds of silence, or
  starts after two, would otherwise be faded through nothing.
- **Where the beat starts and stops.** Many songs end on an ambient tail -
  a pad, a reverb, no drums - well above silence, and some take a minute
  of intro before the drums and the bass come in. A grid runs on through
  either, so a beatmix would line its overlap up on beats nobody plays.
  A song that fades out stops counting where its fade begins: a DJ mixes
  out before the record does.
- **Where the beats are** - tempo, the time of one beat, and which beats
  are downbeats (the "one" of a bar), with how sure it is of each. A
  beatmatched transition lines two grids up; one built on a wrong grid is
  worse than none, so a low confidence makes the planner fall back to an
  ordinary crossfade.

numpy only, on mono audio at 11025 Hz (all a kick drum needs), decoded by
its own ffmpeg like core/waveform.py does. Nothing is cached, for the
waveform's reason: decoding a minute takes well under a second, and a
cache would be one more thing that can go stale.

The method is the textbook one, kept small:

1. **Onset envelope**: how much the log spectrum rises from one 11.6 ms
   frame to the next (spectral flux), and the same for the bass bins alone
   - the kick.
2. **Tempo**: the envelope's autocorrelation over lags for 60-200 BPM,
   scored with its multiples (a real period repeats at 2x and 3x too) and
   weighted towards the tempo the media server reports, or towards 120.
3. **Beat phase**: the envelope folded modulo candidate periods round that
   tempo. A true grid piles the onsets into one narrow peak; the sharpest
   fold gives period and phase at once. Confidence is how sharp that peak
   is, and whether the two halves of the stretch agree on the phase.
4. **Downbeat**: 4/4 assumed; of the four beats in a bar, the one with the
   most kick energy.
"""

import asyncio
import logging
from dataclasses import dataclass

import numpy as np

from .streamer import pcm_decode_cmd

logger = logging.getLogger("connect.mix")

ANALYSIS_RATE = 11025
_FRAME = 1024
_HOP = 64
_FPS = ANALYSIS_RATE / _HOP
# Bass bins for the kick envelope: up to ~150 Hz.
_KICK_BINS = int(150 * _FRAME / ANALYSIS_RATE) + 1
_MIN_BPM, _MAX_BPM = 60.0, 200.0
_PHASE_BINS = 128
# Below this RMS a 50 ms window counts as silence: -60 dBFS.
_SILENCE_RMS = 10 ** (-60 / 20)
_SILENCE_WINDOW = int(0.05 * ANALYSIS_RATE)
# How far behind a frame's centre the flux registers a sharp onset: 24 ms
# on average over synthetic click tracks at 90-174 BPM. Two songs analysed
# alike share it, so it only matters for absolute times.
_ONSET_LAG_SECONDS = 0.024
# Envelope time t is the rise into frame t+1, whose centre is
# (t + 1) * hop + frame/2 samples in. The log spectrum notices a click a
# little after that; _ONSET_LAG_SECONDS is that lag, measured.
_ENVELOPE_OFFSET = (_HOP + _FRAME / 2) / ANALYSIS_RATE + _ONSET_LAG_SECONDS
# A bar carries the beat with at least this share of the onset strength on
# its beats that the stretch's typical bar has - a lone hit in an ambient
# tail is a quarter of a bar's beats, and stays below - and its bass no
# further below the typical bar's than this. Both: an intro can be
# rhythmic without bass, a breakdown hold its bass without drums.
_BEAT_BAR_SHARE = 0.35
_BEAT_BAR_BASS_DB = 12.0
_BASS_HZ = 150.0
# How many bars in a row make the beat's start; fewer are a fill or a hit.
_BEAT_START_BARS = 4
# A fade-out mastered onto the record: at least _FADE_MIN_BARS bars at the
# end of the stretch, none more than _FADE_JITTER_DB louder than the one
# before, _FADE_DROP_DB down by the last audible one. A musical
# decrescendo rarely drops that far. Mixed inside the fade, the old song
# was up to 10 dB down by the bass swap
# (docs/investigations/beatmix-pop-rock.md).
_FADE_MIN_BARS = 4
_FADE_DROP_DB = 10.0
_FADE_JITTER_DB = 1.5
# Bars further below the stretch's typical one than this are its silence.
_AUDIBLE_DB = 40.0
# How long an analysis decode may take before the transition goes ahead
# without it.
_DECODE_TIMEOUT_SECONDS = 20.0


@dataclass(frozen=True)
class BeatGrid:
    """Times in the song's own seconds."""

    period: float
    phase: float
    downbeat: float
    confidence: float
    downbeat_confidence: float

    @property
    def bpm(self) -> float:
        return 60.0 / self.period

    def beats(self, start: float, end: float) -> np.ndarray:
        first = np.ceil((start - self.phase) / self.period)
        last = np.floor((end - self.phase) / self.period)
        return self.phase + np.arange(first, last + 1) * self.period

    def downbeats(self, start: float, end: float) -> np.ndarray:
        bar = 4 * self.period
        first = np.ceil((start - self.downbeat) / bar)
        last = np.floor((end - self.downbeat) / bar)
        return self.downbeat + np.arange(first, last + 1) * bar


@dataclass(frozen=True)
class RegionAnalysis:
    """One stretch of a song, `start` to `end` in its own seconds."""

    start: float
    end: float
    sound_start: float
    sound_end: float
    grid: BeatGrid | None
    # Where the grid has one: the first bar of the first few in a row with
    # the beat, and the end of the last bar with it - or, where the song
    # fades out, the bar its fade begins on. Before and after is sound (an
    # intro, an ambient tail, a fade), but nothing to mix on.
    beat_start: float | None = None
    beat_end: float | None = None


# ── The envelope ───────────────────────────────────────────────────────────


def onset_envelopes(samples: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(full-band, bass) onset strength, one value per hop."""
    if len(samples) < _FRAME * 2:
        return np.zeros(0), np.zeros(0)
    frames = np.lib.stride_tricks.sliding_window_view(samples, _FRAME)[::_HOP]
    spectrum = np.abs(np.fft.rfft(frames * np.hanning(_FRAME), axis=1))
    logspec = np.log1p(1000.0 * spectrum)
    rise = np.maximum(np.diff(logspec, axis=0), 0.0)
    full = _normalise(rise.sum(axis=1))
    kick = _normalise(rise[:, :_KICK_BINS].sum(axis=1))
    return full, kick


def _normalise(envelope: np.ndarray) -> np.ndarray:
    """Minus its local mean (half a second), so a crescendo is not an onset."""
    width = max(1, int(0.5 * _FPS))
    local = np.convolve(envelope, np.ones(width) / width, mode="same")
    out = np.maximum(envelope - local, 0.0)
    scale = out.std()
    return out / scale if scale > 0 else out


# ── Tempo, phase, downbeat ─────────────────────────────────────────────────


def _tempo_period(envelope: np.ndarray, bpm_hint: float | None) -> float | None:
    """The beat period in hops, coarsely."""
    n = len(envelope)
    size = 1 << int(np.ceil(np.log2(2 * n)))
    spectrum = np.fft.rfft(envelope - envelope.mean(), size)
    ac = np.fft.irfft(np.abs(spectrum) ** 2, size)[:n]
    if ac[0] <= 0:
        return None
    ac = ac / ac[0]
    lags = np.arange(int(_FPS * 60 / _MAX_BPM), int(_FPS * 60 / _MIN_BPM) + 1)
    lags = lags[lags * 3 < n]
    if len(lags) == 0:
        return None
    score = (
        ac[lags] + 0.5 * ac[np.minimum(2 * lags, n - 1)] + 0.33 * ac[np.minimum(3 * lags, n - 1)]
    )
    bpm = 60 * _FPS / lags
    centre, width = (bpm_hint, 0.08) if bpm_hint else (120.0, 1.0)
    prior = np.exp(-0.5 * (np.log2(bpm / centre) / width) ** 2)
    if bpm_hint:
        # The server's number is often off by an octave; its double and half
        # stay possible, just less likely.
        for factor in (2.0, 0.5):
            prior += 0.3 * np.exp(-0.5 * (np.log2(bpm / (centre * factor)) / width) ** 2)
    best = int(np.argmax(score * (0.2 + prior)))
    lag = float(lags[best])
    if 0 < best < len(lags) - 1:
        a, b, c = score[best - 1], score[best], score[best + 1]
        denom = a - 2 * b + c
        if denom != 0:
            lag += 0.5 * (a - c) / denom
    return lag


def _fold(envelope: np.ndarray, periods: np.ndarray) -> np.ndarray:
    """Envelope energy per phase bin, one row per candidate period (hops)."""
    t = np.arange(len(envelope))
    phase = (t[None, :] / periods[:, None]) % 1.0
    bins = np.minimum((phase * _PHASE_BINS).astype(int), _PHASE_BINS - 1)
    rows = np.repeat(np.arange(len(periods)), len(envelope))
    hist = np.zeros((len(periods), _PHASE_BINS))
    np.add.at(hist, (rows, bins.ravel()), np.tile(envelope, len(periods)))
    # A little smoothing, circularly, so a peak split across two bins counts.
    return (hist + np.roll(hist, 1, axis=1) + np.roll(hist, -1, axis=1)) / 3


def _peak(hist: np.ndarray) -> float:
    """The histogram's peak, between bins (parabolic, circular)."""
    i = int(np.argmax(hist))
    a, b, c = hist[i - 1], hist[i], hist[(i + 1) % len(hist)]
    denom = a - 2 * b + c
    return i + (0.5 * (a - c) / denom if denom != 0 else 0.0)


def _sharpness(hist: np.ndarray) -> np.ndarray:
    mean = hist.mean(axis=-1)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(mean > 0, hist.max(axis=-1) / mean, 0.0)


def beat_grid(samples: np.ndarray, bpm_hint: float | None = None) -> BeatGrid | None:
    """The beat grid of `samples` (mono float, ANALYSIS_RATE), in seconds
    from its own start; None where there is nothing beat-like at all."""
    return _grid_from(*onset_envelopes(samples), bpm_hint)


def _grid_from(full: np.ndarray, kick: np.ndarray, bpm_hint: float | None) -> BeatGrid | None:
    if len(full) < _FPS * 8 or not full.any():
        return None
    coarse = _tempo_period(full, bpm_hint)
    if coarse is None:
        return None
    periods = coarse * np.linspace(0.98, 1.02, 161)
    sharpness = _sharpness(_fold(full, periods))
    best = int(np.argmax(sharpness))
    # Once more around the best, finer: a period off by a tenth of a
    # millisecond is off by several at the far end of a minute.
    fine = periods[best] * np.linspace(0.9997, 1.0003, 61)
    fine_sharpness = _sharpness(_fold(full, fine))
    period = float(fine[int(np.argmax(fine_sharpness))])
    peak_ratio = float(fine_sharpness.max())
    hist = _fold(full, np.array([period]))[0]
    phase_hops = (_peak(hist) + 0.5) / _PHASE_BINS * period

    # How sure: the fold's peak against its floor, and whether each half of
    # the onsets puts the beat in the same place. Halved by onsets, not by
    # time: a stretch that is half ambient tail would otherwise check the
    # beat against a half with none in it.
    half = int(np.searchsorted(np.cumsum(full), full.sum() / 2))
    half = int(np.clip(half, 4 * period, len(full) - 4 * period))
    first = _fold(full[:half], np.array([period]))[0]
    # The second half's phase is in its own time; shift it back.
    shift = round((half % period) / period * _PHASE_BINS)
    second = np.roll(_fold(full[half:], np.array([period]))[0], shift)
    drift_bins = abs(int(np.argmax(first)) - int(np.argmax(second)))
    drift_bins = min(drift_bins, _PHASE_BINS - drift_bins)
    drift = drift_bins / _PHASE_BINS * period / _FPS
    confidence = float(np.clip((peak_ratio - 1.5) / 2.5, 0.0, 1.0)) * (
        1.0 if drift < 0.025 else 0.3
    )

    # Downbeat: which of the four beat classes carries the most kick.
    beat_frames = phase_hops + np.arange(int((len(kick) - phase_hops) // period) + 1) * period
    beat_frames = beat_frames[beat_frames < len(kick) - 1].astype(int)
    strength = np.zeros(4)
    for j in range(4):
        picked = beat_frames[j::4]
        window = np.add.outer(picked, np.arange(-2, 3))
        window = window[(window >= 0).all(axis=1) & (window < len(kick)).all(axis=1)]
        strength[j] = kick[window].max(axis=1).sum() if len(window) else 0.0
    order = np.argsort(strength)[::-1]
    downbeat_class = int(order[0])
    db_conf = (
        float(1.0 - strength[order[1]] / strength[order[0]]) if strength[order[0]] > 0 else 0.0
    )

    to_seconds = 1.0 / _FPS
    phase = phase_hops * to_seconds + _ENVELOPE_OFFSET
    beat = period * to_seconds
    return BeatGrid(
        period=beat,
        phase=phase,
        downbeat=phase + downbeat_class * beat,
        confidence=confidence,
        downbeat_confidence=db_conf,
    )


def beat_bounds(
    samples: np.ndarray, full: np.ndarray, grid: BeatGrid
) -> tuple[float | None, float | None]:
    """(beat_start, beat_end) in the same seconds as `grid`, either None
    where no whole bar qualifies; see RegionAnalysis. beat_end comes no
    later than where a fade-out begins."""
    bar = 4 * grid.period
    length = len(full) / _FPS
    starts = grid.downbeats(0.0, length - bar)
    if len(starts) == 0:
        return None, None
    beats = starts[:, None] + np.arange(4) * grid.period
    hops = np.round((beats - _ENVELOPE_OFFSET) * _FPS).astype(int)
    window = hops[..., None] + np.arange(-2, 3)
    strength = full[np.clip(window, 0, len(full) - 1)].max(axis=-1).sum(axis=-1)
    bass = _bar_db(_low_passed(samples), starts, bar)
    typical = np.percentile(strength, 75)
    if typical <= 0:
        return None, None
    carried = (strength >= _BEAT_BAR_SHARE * typical) & (
        bass >= np.percentile(bass, 75) - _BEAT_BAR_BASS_DB
    )
    if not carried.any():
        return None, None
    end = float(starts[np.flatnonzero(carried)[-1]] + bar)
    fade = _fade_start(starts, _bar_db(samples, starts, bar))
    if fade is not None:
        end = min(end, fade)
    runs = np.convolve(carried, np.ones(_BEAT_START_BARS), mode="valid")
    first = np.flatnonzero(runs == _BEAT_START_BARS)
    return (float(starts[first[0]]) if len(first) else None), end


def _low_passed(samples: np.ndarray) -> np.ndarray:
    """`samples` below _BASS_HZ."""
    spectrum = np.fft.rfft(samples)
    spectrum[np.fft.rfftfreq(len(samples), 1 / ANALYSIS_RATE) > _BASS_HZ] = 0
    return np.fft.irfft(spectrum, len(samples))


def _bar_db(signal: np.ndarray, starts: np.ndarray, bar: float) -> np.ndarray:
    """The level of each bar from `starts`, in dB."""
    edges = np.round(np.add.outer(starts, [0.0, bar]) * ANALYSIS_RATE).astype(int)
    power = np.array([np.mean(signal[a:b] ** 2) if b > a else 0.0 for a, b in edges])
    return 10 * np.log10(power + 1e-12)


def _fade_start(starts: np.ndarray, level: np.ndarray) -> float | None:
    """Where a fade-out at the end of the stretch begins: the first of the
    last audible bars that sit below the song's own level and only ever get
    quieter. None where the stretch does not end in one."""
    typical = np.percentile(level, 75)
    audible = np.flatnonzero(level > typical - _AUDIBLE_DB)
    if len(audible) == 0:
        return None
    last = first = audible[-1]
    while (
        first > 0
        and level[first - 1] >= level[first] - _FADE_JITTER_DB
        and level[first - 1] < typical - _FADE_JITTER_DB
    ):
        first -= 1
    if last - first + 1 < _FADE_MIN_BARS or level[first] - level[last] < _FADE_DROP_DB:
        return None
    return float(starts[first])


def sound_bounds(samples: np.ndarray) -> tuple[float, float] | None:
    """(first, last) second with sound in `samples`, or None if silent."""
    windows = len(samples) // _SILENCE_WINDOW
    if windows == 0:
        return None
    rms = np.sqrt((samples[: windows * _SILENCE_WINDOW].reshape(windows, -1) ** 2).mean(axis=1))
    loud = np.flatnonzero(rms > _SILENCE_RMS)
    if len(loud) == 0:
        return None
    window = _SILENCE_WINDOW / ANALYSIS_RATE
    return float(loud[0] * window), float((loud[-1] + 1) * window)


def analyse_samples(
    samples: np.ndarray, start: float, bpm_hint: float | None = None
) -> RegionAnalysis:
    """Everything above for a stretch beginning at `start` in its song."""
    end = start + len(samples) / ANALYSIS_RATE
    bounds = sound_bounds(samples)
    sound_start, sound_end = (
        (start, end) if bounds is None else (start + bounds[0], start + bounds[1])
    )
    full, kick = onset_envelopes(samples)
    grid = _grid_from(full, kick, bpm_hint)
    beat_start = beat_end = None
    if grid is not None:
        bounds = beat_bounds(samples, full, grid)
        beat_start, beat_end = (None if b is None else start + b for b in bounds)
        grid = BeatGrid(
            period=grid.period,
            phase=grid.phase + start,
            downbeat=grid.downbeat + start,
            confidence=grid.confidence,
            downbeat_confidence=grid.downbeat_confidence,
        )
    return RegionAnalysis(start, end, sound_start, sound_end, grid, beat_start, beat_end)


async def analyse_region(
    url: str, start: float, duration: float, bpm_hint: float | None = None
) -> RegionAnalysis | None:
    """Decode `duration` seconds of `url` from `start` and analyse them;
    None if the decode fails or takes too long."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *pcm_decode_cmd(url, max(start, 0.0), duration, channels=1, rate=ANALYSIS_RATE),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            data, _ = await asyncio.wait_for(proc.communicate(), _DECODE_TIMEOUT_SECONDS)
        finally:
            if proc.returncode is None:
                proc.kill()
    except (OSError, TimeoutError) as e:
        logger.info(f"[mix] analysing {url[:60]} failed: {e}")
        return None
    if not data:
        return None
    samples = np.frombuffer(data[: len(data) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0
    return await asyncio.to_thread(analyse_samples, samples, max(start, 0.0), bpm_hint)
