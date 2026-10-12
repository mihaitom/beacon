"""core/mix_dsp.py — the signal processing a crossfade needs.

A DJ does not fade one song into the next as a whole. The incoming song's
mids and highs come up first while its bass stays out, the basses are
swapped on a downbeat - two kick drums at once is mud - and only then does
the outgoing song's top end go. That needs each song split into bands:

- **BandSplitter** cuts a stream into low, mid and high with linear-phase
  FIR filters, run by FFT so it stays cheap in numpy. The three bands add
  up to the input exactly, delayed by the filters' half length, so a song
  at unity gain comes out unchanged and switching between "split" and "not
  split" costs nothing: when no band is touched the splitter hands back
  the plain delayed input from the same history. IIR filters (what a
  mixer's EQ usually is) cannot be vectorised in numpy without scipy, and a
  per-sample Python loop costs a third of real time.
- **equal_power_in/out** are the fade curves: their squares add to one, so
  two uncorrelated songs keep their loudness through the fade.
- **soft_limit** catches what equal power cannot: two beat-matched kicks are
  correlated, and their peaks add.
- **to_int16** quantises with TPDF dither, the textbook way to go from float
  to 16 bit without leaving distortion behind in quiet passages.

All of it works on float32 arrays of shape (frames, 2), at any block size,
with state carried from one call to the next.
"""

import numpy as np

from .mix_timeline import SAMPLE_RATE

# Where the bands split. 180 Hz keeps the kick and bass line in "low" and
# most of a vocal out of it; 2.5 kHz separates the body of a mix from its
# hats and air, which is the part a DJ rides out last.
LOW_CROSSOVER_HZ = 180.0
HIGH_CROSSOVER_HZ = 2500.0
# Filter length: steep enough at 180 Hz (~50 Hz wide, -60 dB), short enough
# that the delay it costs (TAPS // 2 samples, 23 ms) goes unnoticed.
TAPS = 2047
DELAY_FRAMES = TAPS // 2
_KAISER_BETA = 6.0

# Above this the limiter starts bending peaks down: -1 dBFS.
_LIMIT_KNEE = 0.891


def lowpass_taps(cutoff_hz: float, taps: int = TAPS) -> np.ndarray:
    """A linear-phase lowpass (windowed sinc), unity gain at DC."""
    n = np.arange(taps) - (taps - 1) / 2
    fc = cutoff_hz / SAMPLE_RATE
    h = 2 * fc * np.sinc(2 * fc * n) * np.kaiser(taps, _KAISER_BETA)
    return (h / h.sum()).astype(np.float64)


class BandSplitter:
    """Low/mid/high of a stereo stream, delayed by DELAY_FRAMES."""

    def __init__(self) -> None:
        self._low = lowpass_taps(LOW_CROSSOVER_HZ)
        self._high_edge = lowpass_taps(HIGH_CROSSOVER_HZ)
        # The last TAPS - 1 input frames: what the next block's filters
        # still reach back into.
        self._history = np.zeros((TAPS - 1, 2), dtype=np.float64)
        self._spectra: dict[int, tuple[np.ndarray, np.ndarray]] = {}

    def process(self, x: np.ndarray, split: bool = True) -> list[np.ndarray]:
        """[low, mid, high] for `x`, or with `split` False just [x delayed]
        - the same thing summed, without the filtering."""
        frames = len(x)
        full = np.concatenate([self._history, x.astype(np.float64)])
        self._history = full[-(TAPS - 1) :]
        delayed = full[TAPS - 1 - DELAY_FRAMES : TAPS - 1 - DELAY_FRAMES + frames]
        if not split or frames == 0:
            return [delayed.astype(np.float32)]
        size = 1 << int(np.ceil(np.log2(len(full))))
        low_spec, edge_spec = self._filter_spectra(size)
        spectrum = np.fft.rfft(full, size, axis=0)
        low = np.fft.irfft(spectrum * low_spec, size, axis=0)[TAPS - 1 : TAPS - 1 + frames]
        edge = np.fft.irfft(spectrum * edge_spec, size, axis=0)[TAPS - 1 : TAPS - 1 + frames]
        return [
            low.astype(np.float32),
            (edge - low).astype(np.float32),
            (delayed - edge).astype(np.float32),
        ]

    def _filter_spectra(self, size: int) -> tuple[np.ndarray, np.ndarray]:
        cached = self._spectra.get(size)
        if cached is None:
            cached = (
                np.fft.rfft(self._low, size)[:, None],
                np.fft.rfft(self._high_edge, size)[:, None],
            )
            self._spectra[size] = cached
        return cached


def equal_power_in(x: np.ndarray) -> np.ndarray:
    """0 → 1 over x in [0, 1]."""
    return np.sin(np.clip(x, 0.0, 1.0) * np.pi / 2)


def equal_power_out(x: np.ndarray) -> np.ndarray:
    """1 → 0 over x in [0, 1]; equal_power_in² + equal_power_out² = 1."""
    return np.cos(np.clip(x, 0.0, 1.0) * np.pi / 2)


def soft_limit(x: np.ndarray) -> np.ndarray:
    """Unchanged below the knee, bent smoothly towards full scale above."""
    magnitude = np.abs(x)
    over = magnitude > _LIMIT_KNEE
    if not over.any():
        return x
    headroom = 1.0 - _LIMIT_KNEE
    bent = _LIMIT_KNEE + headroom * np.tanh((magnitude - _LIMIT_KNEE) / headroom)
    return np.where(over, np.sign(x) * bent, x).astype(np.float32)


class Dither:
    """Float in [-1, 1] to s16le, with triangular dither of one step."""

    def __init__(self, seed: int | None = None) -> None:
        self._rng = np.random.default_rng(seed)

    def to_int16(self, x: np.ndarray) -> bytes:
        noise = self._rng.random(x.shape, dtype=np.float32) - self._rng.random(
            x.shape, dtype=np.float32
        )
        scaled = x * 32768.0 + noise
        return np.clip(np.rint(scaled), -32768, 32767).astype("<i2").tobytes()


def pcm_to_float(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype="<i2").reshape(-1, 2).astype(np.float32) / 32768.0
