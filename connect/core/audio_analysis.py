"""core/audio_analysis.py — Real-time frequency-band analysis for casting.

Taps the same MP3 bytes already being streamed to a Sonos/DLNA/Chromecast
device (see routes/stream.py's stream_with_completion()) through a second,
decode-only ffmpeg process, runs a small FFT over the decoded PCM, and
publishes normalized band-energy frames for the fullscreen visualizer
(AudioVisualizer.vue's 'cast' mode) via a per-session queue exposed over
GET /visualizer.

Deliberately not wired up for AirPlay (delivery/airplay.py downloads a whole
track into memory *ahead* of pushing it to the device, to dodge a pyatv
decoder-detection timeout — "live" analysis there would run well ahead of
what's actually audible) or radio (its raw station URL goes straight to the
device, bypassing this pipeline entirely — see routes/playback.py). See
_should_analyze() in routes/stream.py, which gates this off before it's ever
started for those cases.
"""

import asyncio
import logging
import math
from cmath import exp, pi
from collections import deque
from collections.abc import Callable

logger = logging.getLogger("connect.audio_analysis")

# Mono PCM at a low rate — plenty for a bar-visualizer's worth of bands
# (Nyquist 7.68kHz comfortably covers the musically dense range) and cheap
# to decode/FFT many times a second. Paired with _FFT_SIZE below to land on
# an exact update rate — see its comment.
_SAMPLE_RATE = 15360
_DECODE_CMD = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "mp3",
    "-i",
    "pipe:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    str(_SAMPLE_RATE),
    "-f",
    "s16le",
    "pipe:1",
]

# Power-of-two FFT window — 512/15360 = exactly 1/30s of audio per frame,
# i.e. a new real band frame every ~33ms (30Hz update rate). Originally
# 1024 samples at 11025Hz (~93ms, ~11Hz) — plenty accurate (a real test
# tone confirmed the *pacing* itself was exactly on schedule) but sparse
# enough that the visualizer's own smoothing was still catching up to one
# update when the next arrived, reading as a persistent, hard-to-pin-down
# "slightly behind" softness. There's an inherent tradeoff here — shorter
# frames mean coarser frequency resolution (bin width = _SAMPLE_RATE /
# _FFT_SIZE, unavoidably 1 / frame duration) — but going from ~10.8Hz to
# 30Hz-wide bins is immaterial for a _BAND_COUNT-bucket bar visualizer,
# nowhere near the point of running out of bins to group from (still ~217
# usable raw bins for 56 bands, see `usable` below). Also how far apart
# consecutive frames' content_position values are (see
# AudioAnalyzer._read_pcm()).
_FFT_SIZE = 512
# >= AudioVisualizer.vue's BAR_COUNT (56) — fewer bands than visual bars
# meant several adjacent bars necessarily read the exact same value
# (nearest-neighbor resampling duplicating each band across ~1.75 bars on
# average), which is what read as "bars moving in groups". The frontend
# also linearly interpolates between bands now (see resampleCastBands()),
# so this doesn't have to match BAR_COUNT exactly — just be high enough
# that duplication isn't visually obvious.
_BAND_COUNT = 56
_FRAME_SECONDS = _FFT_SIZE / _SAMPLE_RATE
# Same default range the Web Audio API's AnalyserNode.getByteFrequencyData
# uses (minDecibels/maxDecibels) for its own linear-magnitude -> dB -> 0..1
# mapping — matched here so the 'cast' visualizer reads at roughly the same
# scale as 'local' mode (see AudioVisualizer.vue), which is driven by that
# API directly. A *linear* ratio against the theoretical per-bin maximum
# (tried first) made real music look much quieter than local playback does:
# actual audio's energy is spread thinly across many bins rather than
# concentrated the way a single test tone's is, so its linear magnitude per
# band is small relative to that theoretical max even at normal listening
# volume — dB compresses that the same way loudness perception (and the
# browser's own analyser) already does.
_MIN_DB = -100.0
_MAX_DB = -30.0
# Exponential moving average applied across consecutive frames (see
# AudioAnalyzer._read_pcm()) — the backend-side counterpart to the Web
# Audio API's own AnalyserNode.smoothingTimeConstant, which 'local' mode
# gets automatically just by using that API (see audioEngine.ts's
# getAnalyser(), set to 0.8 there). Every frame here was previously sent
# raw and independent of the last, which read as noticeably more jittery
# than 'local' once the frontend's own smoothing was tightened enough to
# stop masking it. Not 0.8 — that value assumes whatever (much higher)
# internal rate the browser's own implementation re-evaluates it at, and
# applied per update at this pipeline's ~30Hz would smooth away far more
# real signal than intended; tuned for *this* update rate instead.
_SMOOTHING_TIME_CONSTANT = 0.5


def _fft(samples: list[complex]) -> list[complex]:
    """Textbook recursive radix-2 Cooley-Tukey FFT — samples length must be
    a power of two. Pure Python (no numpy dependency) is plenty fast enough
    at this size and this call rate (one _FFT_SIZE=512 call every ~33ms per
    actively-analyzed stream, i.e. 30/s)."""
    n = len(samples)
    if n <= 1:
        return samples
    even = _fft(samples[0::2])
    odd = _fft(samples[1::2])
    twiddled = [exp(-2j * pi * k / n) * odd[k] for k in range(n // 2)]
    return [even[k] + twiddled[k] for k in range(n // 2)] + [
        even[k] - twiddled[k] for k in range(n // 2)
    ]


def analyze_pcm(pcm: bytes) -> list[float]:
    """16-bit little-endian mono PCM -> _BAND_COUNT values in [0, 1]. Split
    out from AudioAnalyzer (which owns the subprocess/pacing machinery
    around this) so it's directly unit-testable against synthetic PCM."""
    samples = [
        int.from_bytes(pcm[i : i + 2], "little", signed=True) / 32768.0
        for i in range(0, len(pcm) - 1, 2)
    ]
    n = len(samples)
    if n == 0:
        return [0.0] * _BAND_COUNT

    # Hann window — reduces spectral leakage from the frame's hard edges.
    windowed = [
        complex(s * (0.5 - 0.5 * math.cos(2 * math.pi * i / max(1, n - 1))))
        for i, s in enumerate(samples)
    ]
    spectrum = _fft(windowed)
    magnitudes = [abs(v) for v in spectrum[: n // 2]]
    # The top of the range is usually near-silent for typical music — spend
    # the band budget on the lower ~85% instead of a third of it on bins
    # that would just sit flat.
    usable = magnitudes[: max(1, int(len(magnitudes) * 0.85))]

    # Peak magnitude a full-scale (amplitude 1.0) single tone would produce
    # in one bin — dividing by this first gives a 0..~1-ish linear ratio
    # before the dB conversion below, the same role sample-rate/window
    # normalization plays in the Web Audio API's own implementation.
    full_scale = n / 2

    bands = []
    for b in range(_BAND_COUNT):
        lo = int(b / _BAND_COUNT * len(usable))
        hi = max(lo + 1, int((b + 1) / _BAND_COUNT * len(usable)))
        peak = max(usable[lo:hi], default=0.0)
        ratio = peak / full_scale
        db = 20 * math.log10(ratio) if ratio > 1e-6 else _MIN_DB
        scaled = (db - _MIN_DB) / (_MAX_DB - _MIN_DB)
        bands.append(min(1.0, max(0.0, scaled)))
    return bands


def _smooth_bands(
    previous: list[float] | None, current: list[float], time_constant: float
) -> list[float]:
    """Exponential moving average, one call per frame — the same shape as
    Web Audio's AnalyserNode.smoothingTimeConstant (see
    _SMOOTHING_TIME_CONSTANT's comment): `time_constant` is the weight kept
    from `previous` (closer to 1 = smoother/slower to react, closer to 0 =
    more responsive/noisier). Split out from AudioAnalyzer for the same
    reason analyze_pcm() is — directly unit-testable without the
    subprocess machinery around it. Falls back to `current` unsmoothed on
    the very first frame (`previous` is None) or after a band-count change
    (shouldn't happen in practice, _BAND_COUNT is fixed, but a length
    mismatch would otherwise raise)."""
    if previous is None or len(previous) != len(current):
        return current
    return [time_constant * p + (1 - time_constant) * c for p, c in zip(previous, current)]


class AudioAnalyzer:
    """One instance per actively-analyzed *track* (see routes/stream.py's
    stream_with_completion(), which creates and feeds one per track, and
    routes/playback.py's /stop, which is the other thing that tears one
    down — see finish_feeding()/stop() below for why those are two
    different methods). feed() is non-blocking and safe to call from the
    hot path that's also yielding chunks to the actual device — this must
    never add latency there, so all decoding/FFT/pacing work happens in
    background tasks instead.

    Decoding and FFT (_write_input/_read_pcm) run flat out, unthrottled —
    ffmpeg's transcode is CPU-bound, not real-time, so this can (and does)
    race ahead of actual playback. Pacing happens at the very end instead
    (_release_frames): finished band frames sit in `_pending` until their
    own moment actually arrives, then get drip-fed to `frames` (what GET
    /visualizer reads) one at a time. Doing it this way rather than
    pacing the decoder's *input* (an earlier version of this) means a
    burst of quickly-available frames doesn't also arrive at the frontend
    in a burst — each is released on its own schedule regardless of how
    early it was actually computed.

    `elapsed_fn` should be the session's calibrated PlaybackClock.elapsed()
    (track-relative seconds, corrected for the device's real startup-
    buffering delay — see core/playback_clock.py), not a fixed bitrate
    timeline, since a device's own startup buffering needs accounting for
    too. `start_offset` is the track position (seconds) this stream's very
    first byte represents — 0.0 unless this connection is a seek/resume
    rather than starting a track from the beginning."""

    # Sentinel telling _write_input() "no more real chunks are coming, close
    # the decoder's stdin once the queue's empty" — see finish_feeding().
    _END = object()

    def __init__(self, elapsed_fn: Callable[[], float], start_offset: float = 0.0) -> None:
        self.frames: asyncio.Queue[list[float]] = asyncio.Queue(maxsize=8)
        # Deliberately unbounded — feed() must never block (see its own
        # docstring), and since ffmpeg's transcode can run well ahead of
        # real time, this can end up briefly holding most of a track's
        # worth of MP3 (a few MB) before _write_input() gets to it. Fine
        # for one analyzed stream at a time; would want a cap if this ever
        # supported many concurrent sessions.
        self._input_queue: asyncio.Queue[bytes | object] = asyncio.Queue()
        # (content_position, bands) pairs already computed but not yet
        # released — see _release_frames(). A handful of KB even for a
        # whole track's worth (each entry is _BAND_COUNT floats), unlike
        # the MP3-bytes queue above.
        self._pending: deque[tuple[float, list[float]]] = deque()
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._writer_task: asyncio.Task | None = None
        self._release_task: asyncio.Task | None = None
        self._pcm_buffer = bytearray()
        # Running state for _smooth_bands() — carries across frames within
        # this one analyzer/track, reset naturally for the next track since
        # each gets a fresh AudioAnalyzer instance.
        self._smoothed_bands: list[float] | None = None
        self._elapsed_fn = elapsed_fn
        self._pcm_position = start_offset
        self._reading_done = False
        self._finished = False

    async def start(self) -> None:
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *_DECODE_CMD,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError:
            logger.warning("[audio-analysis] ffmpeg not found — visualizer data disabled")
            return
        self._reader_task = asyncio.create_task(self._read_pcm())
        self._writer_task = asyncio.create_task(self._write_input())
        self._release_task = asyncio.create_task(self._release_frames())

    def feed(self, chunk: bytes) -> None:
        """Queues one MP3 chunk for (backgrounded) decoding — never blocks,
        so it's safe to call inline from the actual device-streaming loop
        without risking adding latency to real playback."""
        if not self._proc or self._finished:
            return
        try:
            self._input_queue.put_nowait(chunk)
        except asyncio.QueueFull:
            pass

    def finish_feeding(self) -> None:
        """Marks that no more feed() calls are coming for this track, once
        routes/stream.py's device-streaming loop itself has finished — NOT
        the same moment as "safe to tear down". ffmpeg's own transcode can
        finish producing a whole track's MP3 in a few seconds regardless of
        the track's real length (that's the "FFmpeg done early" log line),
        so at that point there can still be most of a track's worth of
        audio not yet decoded, analyzed, and released. Calling stop() here
        instead would cut analysis off within seconds of a track starting
        rather than following it to the end — this lets the decode/FFT/
        release pipeline keep running until there's genuinely nothing left,
        then exit on its own. See stop() for the actual immediate teardown,
        used when a *different* track supersedes this one instead."""
        if self._finished or not self._proc:
            return
        self._finished = True
        self._input_queue.put_nowait(self._END)

    async def _write_input(self) -> None:
        """Feeds the decoder as fast as chunks arrive — no pacing here
        (see the class docstring for where pacing actually happens)."""
        assert self._proc and self._proc.stdin
        try:
            while True:
                chunk = await self._input_queue.get()
                if chunk is self._END:
                    break
                assert isinstance(chunk, bytes)
                self._proc.stdin.write(chunk)
                await self._proc.stdin.drain()
            # Nothing left to feed — let the decoder flush and exit on its
            # own (_read_pcm sees EOF) rather than killing it, so whatever
            # was still in flight through it still produces its last
            # real frame(s).
            if not self._proc.stdin.is_closing():
                self._proc.stdin.close()
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            pass
        except Exception as e:
            logger.debug(f"[audio-analysis] writer stopped: {e}")

    async def _read_pcm(self) -> None:
        """Decodes and FFTs as fast as the decoder produces PCM — frames
        land in `_pending` (each tagged with its track position), not
        `frames` directly; _release_frames() is what actually paces
        delivery."""
        assert self._proc and self._proc.stdout
        frame_bytes = _FFT_SIZE * 2  # 16-bit samples
        try:
            while True:
                data = await self._proc.stdout.read(4096)
                if not data:
                    break
                self._pcm_buffer.extend(data)
                while len(self._pcm_buffer) >= frame_bytes:
                    frame = bytes(self._pcm_buffer[:frame_bytes])
                    del self._pcm_buffer[:frame_bytes]
                    bands = analyze_pcm(frame)
                    bands = _smooth_bands(
                        self._smoothed_bands, bands, _SMOOTHING_TIME_CONSTANT
                    )
                    self._smoothed_bands = bands
                    self._pending.append((self._pcm_position, bands))
                    self._pcm_position += _FRAME_SECONDS
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.debug(f"[audio-analysis] reader stopped: {e}")
        finally:
            self._reading_done = True

    async def _release_frames(self) -> None:
        """Drip-feeds `_pending` into `frames` one at a time, each held
        back until the calibrated playback clock says its own
        content_position has actually arrived — this (not anything on the
        decode side) is what keeps delivery smooth regardless of how far
        ahead of real time decode+FFT get. Also means pausing (elapsed_fn
        freezing) naturally stalls this too, nothing extra needed here."""
        last_log = 0.0
        loop = asyncio.get_event_loop()
        try:
            while True:
                if not self._pending:
                    if self._reading_done:
                        break
                    await asyncio.sleep(0.05)
                    continue
                content_position, bands = self._pending[0]
                remaining = content_position - self._elapsed_fn()
                if remaining > 0:
                    await asyncio.sleep(min(remaining, 0.5))
                    continue
                # Temporary diagnostic for a reported "visualizer looks a
                # bit off, even well after the initial calibration window"
                # complaint — `lag` is how far *past* this frame's own
                # content_position we already are at release time (0 =
                # released exactly on time; growing over a session would
                # mean the pipeline can't keep up; a small but steady
                # nonzero value would point at a fixed extra latency
                # somewhere in the decode/FFT/SSE/frontend-smoothing chain
                # that isn't accounted for in content_position itself).
                # Throttled to ~1 line/2s — safe to leave in.
                now = loop.time()
                if now - last_log > 2.0:
                    last_log = now
                    logger.info(
                        f"[audio-analysis] release lag={-remaining:.3f}s pending={len(self._pending)}"
                    )
                self._pending.popleft()
                if self.frames.full():
                    self.frames.get_nowait()  # drop oldest — always show freshest
                self.frames.put_nowait(bands)
        except asyncio.CancelledError:
            pass

    async def stop(self) -> None:
        """Immediate teardown — used when a *different* track's analyzer
        supersedes this one, or playback stops entirely (routes/playback.py's
        /stop), not for a track just finishing normally (see
        finish_feeding() for that path)."""
        self._finished = True
        if self._writer_task:
            self._writer_task.cancel()
        if self._reader_task:
            self._reader_task.cancel()
        if self._release_task:
            self._release_task.cancel()
        if self._proc:
            try:
                if self._proc.stdin and not self._proc.stdin.is_closing():
                    self._proc.stdin.close()
                self._proc.kill()
            except ProcessLookupError:
                pass


# Kept here (rather than only in a docstring) so both routes/stream.py and
# tests reference the exact same set — "everything except AirPlay" is the
# actual intent, not "these three specifically", but spelling it out
# explicitly is safer than an exclusion list silently covering some future
# delivery type nobody's decided is actually safe to analyze yet.
LIVE_ANALYSIS_TARGET_TYPES = frozenset({"sonos", "dlna", "chromecast"})


def should_analyze(target_pairs: list[tuple[str, str]]) -> bool:
    """Whether at least one currently-active delivery target can plausibly
    have its stream analyzed live — see the module docstring for why
    AirPlay/radio can't. `target_pairs` is core.state.list_target_pairs()'s
    output, kept as a plain parameter (not importing SessionState here) to
    avoid a session <-> audio_analysis import cycle."""
    return any(target_type in LIVE_ANALYSIS_TARGET_TYPES for target_type, _ in target_pairs)
