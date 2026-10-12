"""core/timestretch.py — playing a song faster or slower at the same pitch.

What lets a beatmix line up two songs at different tempos: the outgoing one
eases into the incoming one's tempo and holds it through the overlap
(core/transition_planner.py's `out_rate`). Changes of a few percent, which
is where WSOLA - waveform-similarity overlap-add - sounds clean:

- The output is built from frames of the input, overlap-added with a Hann
  window every HOP samples. Playing at `rate`, each next frame is taken
  HOP * rate further on in the input rather than HOP.
- Taken exactly there, neighbouring frames would no longer line up in
  phase and the result would warble. So each frame is moved by up to
  TOLERANCE samples to where it best continues the previous one (a cross-
  correlation); the offset never accumulates, because the nominal position
  keeps advancing by HOP * rate regardless.
- At rate 1 the frame is placed exactly where the previous one continues,
  and Hann windows at half overlap add up to exactly one: the output is
  then the input, sample for sample. That is what lets a stretch start in
  the middle of a song without a seam (see prime()).

Stereo is stretched with one offset for both channels, from their sum, so
the image does not wander.
"""

import numpy as np

FRAME = 2048
HOP = FRAME // 2
# How far a frame may move to fit (~9 ms), a trade measured on real music.
# At 5 ms the bass, which dominates the match, could not be lined up: frames
# half-cancelled in every overlap and the mids and highs pumped at the hop
# rate (43 Hz), heard as a voice through a fan. At 12 ms that is gone, but
# kicks land far enough off the outgoing song's to be heard as a flam
# (tests/test_mix_crossfade.py). Here the pumping is at ffmpeg atempo's level.
TOLERANCE = 384
# Periodic Hann: at 50% overlap, consecutive windows add to exactly 1.
_WINDOW = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(FRAME) / FRAME)).astype(np.float64)[:, None]


class Wsola:
    """Feed it input with push(), take output with pull()."""

    def __init__(self) -> None:
        self._input = np.zeros((0, 2), dtype=np.float64)
        self._base = 0  # input index of _input[0]
        self._nominal = 0.0  # where the next frame would be taken at rate 1 drift
        self._chosen: int | None = None  # where the last frame was taken
        self._acc = np.zeros((FRAME, 2), dtype=np.float64)
        self._ready = np.zeros((0, 2), dtype=np.float32)
        self.input_consumed = 0.0  # nominal input frames advanced so far
        self._primed = False

    def prime(self, history: np.ndarray) -> None:
        """Start mid-song: `history` is the HOP frames played just before
        what is pushed next. A first frame has nothing to overlap with and
        would fade in; one step at rate 1 over the history fills the
        overlap instead, and its output - already played - is dropped."""
        assert self._chosen is None and len(history) == HOP
        self.push(history)
        self._primed = True

    def push(self, x: np.ndarray) -> None:
        self._input = np.concatenate([self._input, x.astype(np.float64)])

    def needed(self, rate: float) -> int:
        """Input frames still missing before the next step can run."""
        nominal = round(self._nominal)
        if self._chosen is None:
            end = nominal + FRAME
        elif rate == 1.0:
            end = self._chosen + HOP + FRAME
        else:
            end = max(nominal + FRAME + TOLERANCE, self._chosen + HOP + FRAME)
        return max(0, end - (self._base + len(self._input)))

    def pull(self, frames: int, rate_at) -> np.ndarray:
        """Up to `frames` output frames; `rate_at(n)` is the rate for the
        output frame `n` frames from now. Fewer when input runs short."""
        while len(self._ready) < frames:
            rate = float(rate_at(len(self._ready)))
            if self.needed(rate) > 0:
                break
            self._step(rate)
        out, self._ready = self._ready[:frames], self._ready[frames:]
        return out

    def _step(self, rate: float) -> None:
        priming = self._primed and self._chosen is None
        if priming:
            rate = 1.0
        if self._chosen is None:
            start = round(self._nominal)
        elif rate == 1.0:
            start = self._chosen + HOP
        else:
            start = self._best_fit(round(self._nominal))
        frame = self._take(start, FRAME)
        self._acc += frame * _WINDOW
        if not priming:
            self._ready = np.concatenate([self._ready, self._acc[:HOP].astype(np.float32)])
        self._acc = np.concatenate([self._acc[HOP:], np.zeros((HOP, 2))])
        self._chosen = start
        self._nominal += HOP * rate
        self.input_consumed += HOP * rate
        self._trim()

    def _best_fit(self, nominal: int) -> int:
        """Where around `nominal` a frame best continues the last one. Only
        the half that is overlap-added has to match, weighted the way the
        last frame fades out there; each candidate's correlation is divided
        by its level so a loud spot does not win on loudness alone."""
        assert self._chosen is not None
        natural = self._take(self._chosen + HOP, HOP).sum(axis=1) * _WINDOW[HOP:, 0]
        region = self._take(nominal - TOLERANCE, HOP + 2 * TOLERANCE).sum(axis=1)
        size = 1 << int(np.ceil(np.log2(len(region) + HOP)))
        corr = np.fft.irfft(np.fft.rfft(region, size) * np.conj(np.fft.rfft(natural, size)), size)[
            : 2 * TOLERANCE + 1
        ]
        level = np.convolve(region**2, np.ones(HOP), "valid")
        return nominal - TOLERANCE + int(np.argmax(corr / np.sqrt(level + 1e-9)))

    def _take(self, start: int, length: int) -> np.ndarray:
        i = start - self._base
        out = self._input[max(i, 0) : i + length]
        if i < 0:
            out = np.concatenate([np.zeros((-i, 2)), out])
        if len(out) < length:
            out = np.concatenate([out, np.zeros((length - len(out), 2))])
        return out

    def _trim(self) -> None:
        keep_from = min(int(self._nominal), (self._chosen or 0)) - TOLERANCE - FRAME
        drop = keep_from - self._base
        if drop > 0:
            self._input = self._input[drop:]
            self._base += drop
