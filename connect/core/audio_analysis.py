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

# Mono PCM at the same rate the Web Audio API's AnalyserNode typically sees
# in 'local' mode (the browser's default AudioContext sample rate) — Nyquist
# 22.05kHz — so the 'cast' visualizer covers the same frequency range as
# 'local' instead of a narrower slice of it. An earlier, much lower rate
# here (15360Hz, Nyquist 7.68kHz) traded range for cheaper decode/FFT, but
# read as visibly less responsive to high-frequency content (cymbals,
# air/brightness) than 'local' mode's own analyser. Paired with _FFT_SIZE
# below to land on a reasonable update rate — see its comment.
_SAMPLE_RATE = 44100
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

# Power-of-two FFT window — 1024/44100 = ~23.2ms of audio per frame, i.e. a
# new real band frame every ~23ms (~43Hz update rate, comfortably faster
# than the previous 512/15360Hz combination's 30Hz — see _SAMPLE_RATE's
# comment for why that rate went up). An earlier version at 1024 samples
# but 11025Hz (~93ms, ~11Hz) was sparse enough that the visualizer's own
# smoothing was still catching up to one update when the next arrived,
# reading as a persistent, hard-to-pin-down "slightly behind" softness —
# worth avoiding again here, hence keeping this on the faster side rather
# than reaching for 2048 (which would land nearer 21Hz). Bin width
# (_SAMPLE_RATE / _FFT_SIZE) works out to ~43Hz here — still far finer than
# a _BAND_COUNT-bucket bar visualizer needs, nowhere near the point of
# running out of bins to group from (still ~435 usable raw bins for 56
# bands, see `usable` below). Also how far apart consecutive frames'
# content_position values are (see AudioAnalyzer._read_pcm()).
_FFT_SIZE = 1024
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
# applied per update at this pipeline's rate would smooth away far more
# real signal than intended; tuned for *this* update rate instead. Raised
# from 0.5 when _FFT_SIZE/_SAMPLE_RATE moved the update rate from ~30Hz to
# ~43Hz — same real-time smoothing needs a per-frame weight closer to 1 once
# there are more frames per second contributing to it.
_SMOOTHING_TIME_CONSTANT = 0.62
# How much of a content_position lookahead must be sitting in `_pending`
# before _release_frames() starts releasing anything at all. Both ffmpeg
# processes in play here (the real encode feeding the device, and this
# module's own decode-only one) take a moment to spin up, and MP3 decoding
# itself needs a little buffered input before it starts producing output —
# during that startup window `_pending` swings between empty (release finds
# nothing to send) and suddenly holding several already-releasable frames at
# once (which then go out back-to-back with no pacing between them, since
# each already satisfies `remaining <= 0`), reading as a stuttery/staccato
# start before decode settles into comfortably outrunning real time. Waiting
# for this small a cushion first means decode already has its lead by the
# time delivery begins, instead of visibly building it live.
_PREBUFFER_SECONDS = 0.3
# Caps how far ahead of real playback _read_pcm() is allowed to decode+FFT
# before pausing (see its own use of this below). Without a cap, decode
# happily races through an entire track in a matter of seconds (ffmpeg's
# transcode is CPU-bound, not real-time — see the class docstring) — great
# for `_pending` never running dry, but it means analyze_pcm()'s pure-Python
# FFT (see _fft()'s own docstring) runs back-to-back at whatever rate decode
# can sustain (measured around 500/s, not the ~43/s it was actually sized
# for) for as long as that race lasts. That's synchronous, un-awaited CPU
# work sitting directly in the event loop with nothing to yield on — for
# however many seconds the race lasts, everything else sharing this loop
# (notably GET /visualizer's own SSE delivery) gets starved of scheduling
# time, which is what actually caused the "choppy for the first N seconds,
# then suddenly smooth" symptom, not anything about delivery pacing itself
# (release already paces correctly — see _release_frames()). A few seconds
# of lookahead is more than enough cushion against real hiccups while
# keeping the steady-state FFT rate close to the ~43/s it's sized for.
_MAX_LOOKAHEAD_SECONDS = 3.0


def _fft(samples: list[complex]) -> list[complex]:
    """Textbook recursive radix-2 Cooley-Tukey FFT — samples length must be
    a power of two. Pure Python (no numpy dependency) is plenty fast enough
    at the rate _read_pcm() actually calls this at now that it's paced by
    _MAX_LOOKAHEAD_SECONDS (close to _FFT_SIZE/_SAMPLE_RATE's ~43/s) — not
    fast enough to run unpaced at whatever rate decode itself can sustain
    (measured around 500/s), which is exactly what that pacing prevents."""
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
        bucket = usable[lo:hi]
        # Mean, not max, of the raw bins this band covers. 'local' mode
        # (AudioVisualizer.vue's sampleFrequencies()) sets the Web Audio
        # AnalyserNode's fftSize small enough (128) that it has roughly one
        # raw bin per bar already — effectively no aggregation. Here, each
        # band spans several raw bins (_FFT_SIZE=1024 gives far more of
        # them), and max() over that wider range reads systematically
        # louder than any single one of them — including a noise floor bin
        # occasionally spiking, which read as small bars appearing where
        # 'local' (with nothing to aggregate away) still showed none. Mean
        # tracks a single representative bin's magnitude much more closely
        # while still reflecting the band's real energy, not just its
        # single loudest bin.
        energy = sum(bucket) / len(bucket) if bucket else 0.0
        ratio = energy / full_scale
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
        """Decodes and FFTs as fast as the decoder produces PCM, up to
        _MAX_LOOKAHEAD_SECONDS ahead of real playback — frames land in
        `_pending` (each tagged with its track position), not `frames`
        directly; _release_frames() is what actually paces delivery."""
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
                # Pause once far enough ahead — see _MAX_LOOKAHEAD_SECONDS.
                # Not reading further just leaves bytes sitting in the
                # decoder's own stdout pipe; once that (small, kernel-sized)
                # buffer fills, ffmpeg's own write() blocks and it stops
                # burning CPU too, rather than continuing to decode+FFT
                # content nobody's close to needing yet.
                lookahead = self._pcm_position - self._elapsed_fn()
                if lookahead > _MAX_LOOKAHEAD_SECONDS:
                    await asyncio.sleep(lookahead - _MAX_LOOKAHEAD_SECONDS)
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
        try:
            # Let decode build up a small lead before releasing the very
            # first frame — see _PREBUFFER_SECONDS. Skipped once decoding's
            # already finished (a short clip, or this task starting late)
            # since there's nothing further to build a lead from anyway.
            while not self._reading_done and (
                not self._pending
                or self._pending[-1][0] - self._pending[0][0] < _PREBUFFER_SECONDS
            ):
                await asyncio.sleep(0.05)

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
