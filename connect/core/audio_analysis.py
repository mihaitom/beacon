"""core/audio_analysis.py — Real-time frequency-band analysis for casting.

Decodes the casting track a second time — straight from the media server,
seeked to wherever playback actually is — runs a small FFT over the decoded
PCM, and publishes normalized band-energy frames for the fullscreen
visualizer (AudioVisualizer.vue's 'cast' mode) via a per-session queue
exposed over GET /visualizer.

Only ever runs while someone actually has that visualizer open —
core/visualizer_feed.py owns that lifecycle; this module knows nothing about
it beyond being started and stopped at arbitrary moments. Which is also why
this decodes the source itself instead of tapping the bytes already on their
way to the device (what it used to do, via a feed() called from
routes/stream.py's streaming loop): such a tap can only ever be joined at
the stream's very start. The track position of a byte arriving mid-stream
isn't knowable without either having buffered the whole stream from its
beginning or parsing container timestamps back out of it, and a frame
tagged with the wrong position gets released at the wrong moment — visibly
out of sync with the music, which is the one thing this has to get right.
Seeking a fresh decoder to clock.elapsed() makes the position exact by
construction at *any* moment instead, so analysis can start and stop
whenever its audience does.

The tradeoff is one extra read of the track from the media server for as
long as the visualizer stays open — from the current position onward, not
the track's beginning, and paced at roughly 1x real time (see _decode_cmd()).

Still skipped for AirPlay and radio (see should_analyze(), which
core/visualizer_feed.py gates on): AirPlay pushes a whole track into the
device ahead of time and has no position feedback, so its playback clock is
a fixed estimate rather than something calibrated against the device (see
PlaybackClock.set_fixed_offset()), and radio has no track — its station URL
goes straight to the device, with no position to seek to at all.
"""
import asyncio
import logging
import math
from collections import deque
from collections.abc import Callable

import numpy as np

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


def _decode_cmd(source_url: str, start_offset: float, gain: float) -> list[str]:
    """Decode-only ffmpeg over the media server's own copy of the track,
    seeked to `start_offset` — the track position this analysis run starts
    at, which for a visualizer opened mid-track is simply wherever playback
    already is.

    Deliberately carries no -readrate pacing of its own (unlike
    core/streamer.py's command, see _READRATE_ARGS there): _read_pcm() stops
    reading stdout once it's _MAX_LOOKAHEAD_SECONDS ahead of playback,
    ffmpeg blocks on its own write as soon as the pipe buffer fills, and the
    whole pipeline behind it — the HTTP fetch from the media server included
    — stalls with it. So the extra read averages ~1x real time on its own,
    without a second pacing mechanism that would then have to be kept in
    agreement with that one.

    `gain` is the same ReplayGain multiplier the real stream is encoded with
    (see core/streamer.py's stream_tracks()), applied here too so band
    levels match what the device is actually playing rather than the
    untouched file.
    """
    # -ss before -i, same as stream_tracks() — input-side seeking, which
    # skips straight to the right point instead of decoding everything
    # before it. The 0.5s threshold matches that function's too: below it,
    # seeking isn't worth its own imprecision.
    seek = ["-ss", f"{start_offset:.3f}"] if start_offset > 0.5 else []
    volume = ["-af", f"volume={gain}"] if gain != 1.0 else []
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        *seek,
        "-i",
        source_url,
        "-vn",
        *volume,
        "-ac",
        "1",
        "-ar",
        str(_SAMPLE_RATE),
        "-f",
        "s16le",
        "pipe:1",
    ]


# Analysis window — same size as 'local' mode's Web Audio AnalyserNode
# (see audioEngine.ts's setupAnalyser()). An FFT's window length IS the
# time slice each analyzed frame's spectrum represents — 4096/44100 ≈
# 93ms here, already a real tradeoff against pure time resolution (a
# larger window smears short transients like a kick drum or hi-hat across
# its whole span, which read as measurably less dynamic when this was
# tried at 16384/~372ms). Not smaller either: enough raw bins are still
# needed to resolve distinct bands down near _MIN_FREQ_HZ, where each
# 1/6-octave-ish band only spans a few Hz. 93ms alone would also mean a
# sluggish ~10.8Hz update rate — see _HOP_SIZE below for how this stays at
# the same ~43Hz cadence tuned previously (see git history) regardless of
# window size: each analyzed window overlaps almost entirely with the
# last one, only ever advancing by one hop's worth of *new* audio. Cheap
# to recompute in full every hop with numpy's C-implemented FFT (replacing
# the previous pure-Python recursive one, which was sized for a much
# smaller window specifically because recomputing *this* size at real-time
# rate in pure Python isn't feasible — see numpy's addition to
# pyproject.toml).
_FFT_SIZE = 4096
# How far the analysis window advances between frames — independent of
# _FFT_SIZE now (see above). 1024/44100 = ~23.2ms, preserving the exact
# ~43Hz update rate already tuned for: an earlier, sparser rate (~93ms,
# ~11Hz) was slow enough that the visualizer's own smoothing was still
# catching up to one update when the next arrived, reading as a
# persistent, hard-to-pin-down "slightly behind" softness — not something
# to reintroduce just because the window itself changed size.
_HOP_SIZE = 1024
# 60 logarithmically-spaced bands from _MIN_FREQ_HZ to _MAX_FREQ_HZ (the
# latter being Nyquist for 44.1kHz) — same range/spacing as 'local' mode's
# own band mapping (see AudioVisualizer.vue's sampleFrequencies(), which
# this must visually match). Works out to roughly 1/6-octave bands
# (log2(22050/20)/60 ≈ 0.168 octaves/band).
_BAND_COUNT = 60
_MIN_FREQ_HZ = 20.0
_MAX_FREQ_HZ = 22050.0
_FRAME_SECONDS = _HOP_SIZE / _SAMPLE_RATE
# Precomputed once — Hann window shaped for the fixed _FFT_SIZE (reduces
# spectral leakage from the window's hard edges), and each band's raw-bin
# index range within the FFT's output. Both are pure functions of the
# module's own constants, recomputing either per-call would be wasted
# work at ~43 calls/sec.
_HANN_WINDOW = np.hanning(_FFT_SIZE)
_BIN_HZ = _SAMPLE_RATE / _FFT_SIZE
_FREQ_RATIO = _MAX_FREQ_HZ / _MIN_FREQ_HZ
_NYQUIST_BIN = _FFT_SIZE // 2


def _band_bin_range(band: int) -> tuple[int, int]:
    lo_freq = _MIN_FREQ_HZ * _FREQ_RATIO ** (band / _BAND_COUNT)
    hi_freq = _MIN_FREQ_HZ * _FREQ_RATIO ** ((band + 1) / _BAND_COUNT)
    lo_bin = max(0, int(lo_freq / _BIN_HZ))
    hi_bin = min(_NYQUIST_BIN, max(lo_bin + 1, math.ceil(hi_freq / _BIN_HZ)))
    return lo_bin, hi_bin


_BAND_BIN_RANGES = [_band_bin_range(b) for b in range(_BAND_COUNT)]
# 'local' mode's Web Audio AnalyserNode uses this same range for its own
# linear-magnitude -> dB -> 0..1 mapping (see audioEngine.ts's
# minDecibels/maxDecibels — not that API's own default, which is wider
# and compresses typical program material into a narrower, flatter-
# looking slice of the 0..1 output than this). Matched here so 'cast'
# reads at the same visual scale as 'local'. A *linear* ratio against the
# theoretical per-bin maximum (tried first) made real music look much
# quieter than either mode does now: actual audio's energy is spread
# thinly across many bins rather than concentrated the way a single test
# tone's is, so its linear magnitude per band is small relative to that
# theoretical max even at normal listening volume — dB compresses that
# the same way loudness perception already does.
_MIN_DB = -85.0
_MAX_DB = -25.0
# Exponential moving average applied across consecutive frames (see
# AudioAnalyzer._read_pcm()) — the backend-side counterpart to the Web
# Audio API's own AnalyserNode.smoothingTimeConstant (see audioEngine.ts's
# getAnalyser()). NOT the same value as that one, on purpose, even though
# it plays the same conceptual role: _HOP_SIZE being far smaller than
# _FFT_SIZE means consecutive analyzed windows here already share 75% of
# their raw samples (_HOP_SIZE=1024 of _FFT_SIZE=4096) — real, unavoidable
# correlation between one frame and the next that exists purely from the
# windowing, before this EMA does anything at all. Reusing 'local' mode's
# own smoothingTimeConstant on top compounded with that inherent overlap
# into visibly more damping than 'local' has, since the browser's own
# analyser doesn't carry that same extra correlation — measurably less
# dynamic-looking as a result. Kept low to let the (still real, still
# useful for frame-to-frame jitter) EMA add only a little on top of what
# the overlap already provides, rather than doubling up on it.
_SMOOTHING_TIME_CONSTANT = 0.25
# How much of a content_position lookahead must be sitting in `_pending`
# before _release_frames() starts releasing anything at all. ffmpeg takes a
# moment to spin up, fetch its first bytes from the media server and get
# decoding — during that startup window `_pending` swings between empty
# (release finds nothing to send) and suddenly holding several already-
# releasable frames at once (which then go out back-to-back with no pacing
# between them, since each already satisfies `remaining <= 0`), reading as a
# stuttery/staccato start before decode settles into comfortably outrunning
# real time. Waiting for this small a cushion first means decode already has
# its lead by the time delivery begins, instead of visibly building it live.
_PREBUFFER_SECONDS = 0.3
# Caps how far ahead of real playback _read_pcm() is allowed to decode+FFT
# before pausing (see its own use of this below). Without a cap, decode
# happily races through an entire track in a matter of seconds (ffmpeg's
# transcode is CPU-bound, not real-time — see the class docstring) — great
# for `_pending` never running dry, but it means analyze_pcm() runs
# back-to-back at whatever rate decode can sustain (measured around 500/s,
# not the ~43/s it's actually sized for) for as long as that race lasts.
# Each call is fast (numpy's FFT; ~0.4ms measured at _FFT_SIZE=16384 — see
# its own comment), but synchronous and un-awaited all the same — for
# however many seconds the race lasts, everything else sharing this loop
# (notably GET /visualizer's own SSE delivery) gets starved of scheduling
# time between calls, which is what actually caused the "choppy for the
# first N seconds, then suddenly smooth" symptom, not anything about
# delivery pacing itself (release already paces correctly — see
# _release_frames()). A few seconds of lookahead is more than enough
# cushion against real hiccups while keeping the steady-state FFT rate
# close to the ~43/s it's sized for.
_MAX_LOOKAHEAD_SECONDS = 3.0
# How far past its own moment a frame may still be released, before
# _release_frames() drops it instead. Decode normally runs comfortably ahead
# of playback (see _MAX_LOOKAHEAD_SECONDS), so this only ever comes up at
# start-up: an analyzer started mid-track spends a moment spawning ffmpeg
# and fetching the first bytes from the media server, and by the time its
# first frames exist, playback has already moved past the position they
# describe. Sending them anyway means opening the visualizer starts by
# flushing that backlog as fast as the SSE consumer will take it — none of
# it paced, since every frame is already due — a visible stutter that then
# settles into sync. Dropping them instead simply starts at the first frame
# that is actually current.
_MAX_LATENESS_SECONDS = 0.15


def analyze_pcm(pcm: bytes) -> list[float]:
    """16-bit little-endian mono PCM -> _BAND_COUNT logarithmically-spaced
    band values in [0, 1], covering _MIN_FREQ_HZ.._MAX_FREQ_HZ. Expects
    (but doesn't require) exactly _FFT_SIZE samples — the caller
    (AudioAnalyzer._read_pcm()) is what maintains the sliding, overlapping
    window this actually gets called with; shorter input is zero-padded,
    longer is truncated, so this stays a pure, directly-testable function
    over a single already-sized window rather than owning any of that
    windowing/pacing state itself."""
    n = len(pcm) // 2
    if n == 0:
        return [0.0] * _BAND_COUNT

    samples = np.frombuffer(pcm[: n * 2], dtype="<i2").astype(np.float64) / 32768.0
    if n < _FFT_SIZE:
        samples = np.pad(samples, (0, _FFT_SIZE - n))
    else:
        samples = samples[:_FFT_SIZE]

    # Divided by _FFT_SIZE (not, say, the window's own coherent gain,
    # sum(window)/2, tried first): the Web Audio API spec's own Fourier
    # transform step for AnalyserNode is explicitly defined as X[k] =
    # (1/N) * sum(...) — N being fftSize — with the dB conversion then
    # applied directly to that, no further reference-level division at
    # all. The sum(window)/2 version measured ~12dB hotter than this for
    # the same audio at _FFT_SIZE=4096 (confirmed against the spec text),
    # which is exactly why 'cast' mode's bars were pinning to the ceiling
    # far more often than 'local' mode's for the same track.
    magnitudes = np.abs(np.fft.rfft(samples * _HANN_WINDOW)) / _FFT_SIZE

    bands = []
    for lo_bin, hi_bin in _BAND_BIN_RANGES:
        # Mean, not max, of the raw bins this band covers — a single
        # sinusoid's energy concentrates in only a few bins even within a
        # wide band, and max() over the rest (mostly noise floor) reads
        # systematically louder than the band's real average energy,
        # including a noise-floor bin occasionally spiking on its own.
        energy = float(magnitudes[lo_bin:hi_bin].mean()) if hi_bin > lo_bin else 0.0
        db = 20 * math.log10(energy) if energy > 1e-6 else _MIN_DB
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
    """One decode+analysis run, for one track from one starting position.
    Created by core/visualizer_feed.py whenever there is both something
    analyzable playing and somebody watching it, and torn down again
    (stop()) as soon as either stops being true — a track change, a seek, or
    the last /visualizer subscriber going away.

    Decoding and FFT (_read_pcm) run flat out, pausing only once far enough
    ahead of playback (_MAX_LOOKAHEAD_SECONDS) — ffmpeg's decode is
    CPU-bound, not real-time, so it would otherwise race through the rest of
    the track in seconds. Pacing happens at the very end instead
    (_release_frames): finished band frames sit in `_pending` until their own
    moment actually arrives, then get drip-fed to `frames` (what GET
    /visualizer reads) one at a time, so a burst of quickly-computed frames
    doesn't also arrive at the frontend in a burst.

    `elapsed_fn` should be the session's calibrated PlaybackClock.elapsed()
    (track-relative seconds, corrected for the device's real startup-
    buffering delay — see core/playback_clock.py), not a fixed bitrate
    timeline: it's both what `start_offset` is read from at construction and
    what every frame is then released against. `source_url` is the media
    server's own URL for the track (MediaClient.get_stream_url()), decoded
    here independently of whatever is being sent to the device — see the
    module docstring for why. `gain` mirrors the ReplayGain applied to that
    real stream."""

    def __init__(
        self,
        elapsed_fn: Callable[[], float],
        source_url: str,
        start_offset: float = 0.0,
        gain: float = 1.0,
    ) -> None:
        self.frames: asyncio.Queue[list[float]] = asyncio.Queue(maxsize=8)
        # (content_position, bands) pairs already computed but not yet
        # released — see _release_frames(). A handful of KB even for a
        # whole track's worth (each entry is _BAND_COUNT floats).
        self._pending: deque[tuple[float, list[float]]] = deque()
        self._source_url = source_url
        self._start_offset = start_offset
        self._gain = gain
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._release_task: asyncio.Task | None = None
        self._pcm_buffer = bytearray()
        # Running state for _smooth_bands() — carries across frames within
        # this one run, reset naturally for the next one since each gets a
        # fresh AudioAnalyzer instance.
        self._smoothed_bands: list[float] | None = None
        self._elapsed_fn = elapsed_fn
        self._pcm_position = start_offset
        self._reading_done = False

    async def start(self) -> None:
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *_decode_cmd(self._source_url, self._start_offset, self._gain),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError:
            logger.warning("[audio-analysis] ffmpeg not found — visualizer data disabled")
            return
        self._reader_task = asyncio.create_task(self._read_pcm())
        self._release_task = asyncio.create_task(self._release_frames())

    async def _read_pcm(self) -> None:
        """Decodes and FFTs as fast as the decoder produces PCM, up to
        _MAX_LOOKAHEAD_SECONDS ahead of real playback — frames land in
        `_pending` (each tagged with its track position), not `frames`
        directly; _release_frames() is what actually paces delivery.

        _pcm_buffer holds a sliding window, not a queue of fresh frames:
        each analyzed window is the *last* _FFT_SIZE samples seen so far,
        overlapping almost entirely with the previous one — only the front
        _HOP_SIZE samples get dropped after each analysis, not the whole
        window. This is what keeps the emission rate at _HOP_SIZE's cadence
        regardless of how large _FFT_SIZE (the frequency resolution) is —
        see both constants' own comments."""
        assert self._proc and self._proc.stdout
        window_bytes = _FFT_SIZE * 2  # 16-bit samples
        hop_bytes = _HOP_SIZE * 2
        try:
            while True:
                data = await self._proc.stdout.read(4096)
                if not data:
                    break
                self._pcm_buffer.extend(data)
                while len(self._pcm_buffer) >= window_bytes:
                    window = bytes(self._pcm_buffer[-window_bytes:])
                    bands = analyze_pcm(window)
                    bands = _smooth_bands(
                        self._smoothed_bands, bands, _SMOOTHING_TIME_CONSTANT
                    )
                    self._smoothed_bands = bands
                    self._pending.append((self._pcm_position, bands))
                    self._pcm_position += _FRAME_SECONDS
                    del self._pcm_buffer[:hop_bytes]
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
            # Was logger.debug — see _write_input()'s identical change above
            # for why that hid this. This one matters more: once this task
            # dies for any reason, `_reading_done` below goes True and stays
            # there for the rest of this analyzer's life, so _release_frames()
            # drains whatever's left in `_pending` and then exits — the
            # visualizer goes dark for the rest of the track with, until now,
            # no trace of why in a normal INFO-level log.
            logger.warning(f"[audio-analysis] reader stopped: {e}")
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
                # Already past its moment by more than a blink — see
                # _MAX_LATENESS_SECONDS. Dropped rather than sent, so
                # catching up costs nothing visible.
                if remaining < -_MAX_LATENESS_SECONDS:
                    continue
                if self.frames.full():
                    self.frames.get_nowait()  # drop oldest — always show freshest
                self.frames.put_nowait(bands)
        except asyncio.CancelledError:
            pass

    async def stop(self) -> None:
        """Immediate teardown — everything this run owns goes away at once.
        Called by core/visualizer_feed.py for every reason a run ends:
        nobody is watching any more, or what's playing has changed and a
        fresh run at the new position supersedes this one. Safe to call on
        an analyzer whose start() never got as far as a process (ffmpeg
        missing), and safe to call twice."""
        if self._reader_task:
            self._reader_task.cancel()
        if self._release_task:
            self._release_task.cancel()
        if self._proc:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass


# Kept here (rather than only in a docstring) so both
# core/visualizer_feed.py and tests reference the exact same set —
# "everything except AirPlay" is the actual intent, not "these three specifically", but spelling it out
# explicitly is safer than an exclusion list silently covering some future
# delivery type nobody's decided is actually safe to analyze yet.
LIVE_ANALYSIS_TARGET_TYPES = frozenset({"sonos", "dlna", "chromecast"})


def should_analyze(target_pairs: list[tuple[str, str]]) -> bool:
    """Whether at least one currently-active delivery target can plausibly
    have its playback analyzed — see the module docstring for why
    AirPlay/radio can't. `target_pairs` is core.state.list_target_pairs()'s
    output, kept as a plain parameter (not importing SessionState here) to
    avoid a session <-> audio_analysis import cycle."""
    return any(target_type in LIVE_ANALYSIS_TARGET_TYPES for target_type, _ in target_pairs)
