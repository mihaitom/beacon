"""core/timestretch.py — playing a song faster or slower at the same pitch.

What lets a beatmix line up two songs at different tempos: the outgoing one
eases into the incoming one's tempo and holds it through the overlap
(core/transition_planner.py's `out_rate`).

Rubber Band's R3 engine in realtime mode does the stretching. It replaced a
WSOLA of our own, which gave every frame a single time offset matched on
the bass: voices and chords then half-cancelled at each splice and pumped
at the hop rate, heard as a fan even at -0.7 %. In a blind test against
WSOLA and Signalsmith Stretch, Rubber Band was best in 6 of 8 pairs and
never worst (docs/investigations/beatmix-pop-rock.md, listening 4).

The input is fed in blocks worth BLOCK output frames at the current rate.
The ratio is set to exactly 1/rate and only when the rate changes: set
anew every block (as each block's own input/output length), Rubber Band's
output strayed from the engine's rate integral by ~6 ms over a 40 s hold
and kept going. What remains is the input it holds buffered (~4000
frames) being played at the ratio set after it arrived - ~2 ms, bounded,
far below a flam.

Stereo is stretched with the channels together, so the image does not
wander.
"""

import numpy as np
import pylibrb

# Frames played just before the stretch starts, handed to prime(). Rubber
# Band's window reaches this far back; with less, its first output fades in.
HISTORY = 16384
# Output frames per ratio step.
BLOCK = 512
# Largest chunk handed to Rubber Band at once (prime() has the most).
_MAX_PROCESS = 4096
_OPTIONS = (
    pylibrb.Option.PROCESS_REALTIME | pylibrb.Option.ENGINE_FINER | pylibrb.Option.CHANNELS_TOGETHER
)

pylibrb.set_default_logging_level(0)


class Stretcher:
    """Feed it input with push(), take output with pull()."""

    def __init__(self, sample_rate: int) -> None:
        self._rb = pylibrb.RubberBandStretcher(sample_rate, 2, _OPTIONS, 1.0)
        self._rb.set_max_process_size(_MAX_PROCESS)
        self._input = np.zeros((0, 2), dtype=np.float32)
        self._ready = np.zeros((0, 2), dtype=np.float32)
        # Output still owed to the history passed to prime(), dropped as it comes.
        self._skip = 0
        # Fraction of an input frame carried between blocks.
        self._carry = 0.0
        self.input_consumed = 0  # input frames handed to Rubber Band since prime()

    def prime(self, history: np.ndarray) -> None:
        """Start mid-song: `history` is what played just before what is
        pushed next. Rubber Band takes it at rate 1; what comes out for it
        is already played and dropped, so the first frame pulled continues
        the history without a seam."""
        history = np.asarray(history, dtype=np.float32)
        self._skip = len(history) - len(self._process(history))

    def push(self, x: np.ndarray) -> None:
        self._input = np.concatenate([self._input, np.asarray(x, dtype=np.float32)])

    def needed(self, rate: float) -> int:
        """Input frames still missing before pull() can return anything."""
        # While the history's output is still being dropped, a block gives none.
        blocks = 1 + -(-self._skip // BLOCK)
        want = self._block_input(rate) + (blocks - 1) * round(BLOCK * rate) + 1
        return max(0, want - len(self._input))

    def pull(self, frames: int, rate_at) -> np.ndarray:
        """Up to `frames` output frames; `rate_at(n)` is the rate for the
        output frame `n` frames from now. Fewer when input runs short."""
        while len(self._ready) < frames:
            rate = float(rate_at(len(self._ready)))
            take = self._block_input(rate)
            if len(self._input) < take:
                break
            self._carry += BLOCK * rate - take
            block, self._input = self._input[:take], self._input[take:]
            if self._rb.time_ratio != 1.0 / rate:
                self._rb.time_ratio = 1.0 / rate
            out = self._process(block)
            self.input_consumed += take
            if self._skip:
                dropped = min(self._skip, len(out))
                out, self._skip = out[dropped:], self._skip - dropped
            self._ready = np.concatenate([self._ready, out])
        out, self._ready = self._ready[:frames], self._ready[frames:]
        return out

    def _block_input(self, rate: float) -> int:
        return int(self._carry + BLOCK * rate)

    def _process(self, x: np.ndarray) -> np.ndarray:
        outs = []
        for i in range(0, len(x), _MAX_PROCESS):
            self._rb.process(np.ascontiguousarray(x[i : i + _MAX_PROCESS].T))
            available = self._rb.available()
            if available > 0:
                outs.append(self._rb.retrieve(available).T)
        return np.concatenate(outs) if outs else np.zeros((0, 2), dtype=np.float32)
