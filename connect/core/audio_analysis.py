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

should_analyze() (which core/visualizer_feed.py gates *track* analysis on)
still excludes radio — a station has no track and nothing to seek a fresh
decoder to. Radio gets analyzed too, since 2026-09-02/03, but through a
separate path (VisualizerFeed._start_radio_analyzer()) that also lands
here, and unlike a track it *is* tapped: `source_queue` (not `source_url`)
is a subscription to core/radio_relay.py's own device-audio fan-out — the
same bytes the cast target is being sent, not a second independent fetch
of the station. What's still true of a track applies here too, just one
level down: this class never taps the relay's *ffmpeg process itself* (see
core/radio_relay.py's own docstring for why sharing one used to stall
device audio too) — only the bytes already flowing out of it, decoded by
a private ffmpeg of this analyzer's own. `elapsed_fn` is the cast device's
own reported position
(core/radio_position.py's RadioPositionTracker) rather than a session
clock, since a live stream has no track-relative position for a session
clock to track in the first place. `start_offset` is always 0 for radio:
there's nothing to seek to, only "start decoding from here, now". AirPlay
used to be excluded here too, on two grounds that both turned out not to
hold up: it
was believed to push a whole track into the device ahead of time (fixed
2026-08-26 — see docs/playback-bugs/fixed-airplay-silent-death.md, the
_ResponseReader half — AirPlay streams incrementally like everything else
now), and its playback clock was a fixed estimate rather than something
calibrated against playback. The second stopped being true as well when
AirPlayDelivery grew a get_position(), but it never mattered here anyway:
this module does not tap the bytes on their way to the device (see above),
it decodes the source itself and seeks to clock.elapsed() regardless of
which delivery is playing, so the clock only has to be good enough to seek
a fresh decoder to roughly the right spot — whatever carries AirPlay's
lyrics sync (routes/playback.py, "[lyrics-sync]") is more than good enough
for that, a frequency band tolerating drift far better than a highlighted
lyric line does.
"""

import asyncio
import logging
import math
import time
from collections import deque
from collections.abc import Callable
from contextlib import suppress

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
    """Decode-only ffmpeg over `source_url` — the media server's own copy of
    a track, seeked to `start_offset` (the track position this analysis run
    starts at, which for a visualizer opened mid-track is simply wherever
    playback already is), or "pipe:0" for radio, whose bytes are written to
    this process's stdin from the relay's own fan-out instead of fetched
    (see AudioAnalyzer's `source_queue`). `start_offset` is always 0 for
    that case — there is nothing to seek to on a live stream.

    Deliberately carries no -readrate pacing of its own (unlike
    core/streamer.py's command, see _READRATE_ARGS there): _read_pcm() stops
    reading stdout once it's _MAX_LOOKAHEAD_SECONDS ahead of playback,
    ffmpeg blocks on its own write as soon as the pipe buffer fills, and the
    whole pipeline behind it — the HTTP fetch from the media server or
    station included — stalls with it. So the extra read averages ~1x real
    time on its own, without a second pacing mechanism that would then have
    to be kept in agreement with that one.

    `gain` is the same ReplayGain multiplier the real stream is encoded with
    (see core/streamer.py's stream_tracks()), applied here too so band
    levels match what the device is actually playing rather than the
    untouched file — always 1.0 (no filter added) for radio, which has no
    such concept.
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
# its own comment), but synchronous all the same — for however many seconds
# the race lasts, everything else sharing this loop gets starved of
# scheduling time between calls unless something explicitly yields (see
# _read_pcm()'s own sleep(0), added after this starved a real AirPlay
# target's RTSP handshake on 2026-08-26, not just GET /visualizer's SSE
# delivery as originally thought — a synchronous stretch is a lot more
# forgiving of an SSE consumer than of a device mid-connect). Not anything
# about delivery pacing itself (release already paces correctly — see
# _release_frames()). A few seconds of lookahead is more than enough
# cushion against real hiccups while keeping the steady-state FFT rate
# close to the ~43/s it's sized for.
_MAX_LOOKAHEAD_SECONDS = 3.0
# How far *behind* the clock a live source may fall before this run gives
# up on the backlog and rejoins at the current moment instead.
#
# Only for a piped (live) source. A track is a file: decode outruns real
# time by a wide margin, so a backlog is genuinely temporary and working
# through it is both possible and correct. A live station is the opposite
# — nothing arrives faster than real time, so a run that falls behind can
# never catch up by decoding, and every frame it computes on the way is
# already too late to release (_MAX_LATENESS_SECONDS). It would spend that
# whole stretch running analyze_pcm() at full speed on audio destined to
# be dropped, starving the loop device audio is paced on. Reported live
# 2026-09-03 as speaker dropouts plus a permanently frozen visualizer,
# after a 10s device scan was enough to open the gap in the first place.
#
# Comfortably above ordinary jitter (_MAX_LATENESS_SECONDS is 0.15s, and a
# poll-driven clock steps in ~0.5s increments), so this only fires on a
# real stall, not on the usual unevenness.
_LIVE_RESYNC_BEHIND_SECONDS = 2.0
# How long a single hold-off may last on a live source before the loop
# re-checks the clock — see _wait_out_lookahead().
_STALL_RECHECK_SECONDS = 1.0
# How long decode has to be held before saying so. Comfortably longer than
# an ordinary hold-off (which is bounded by _MAX_LOOKAHEAD_SECONDS worth of
# lead), so this only fires when the clock behind it really has stopped.
_STALL_REPORT_AFTER_SECONDS = 5.0
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
    for a track (track-relative seconds, corrected for the device's real
    startup-buffering delay — see core/playback_clock.py) or, for radio,
    core/radio_position.py's RadioPositionTracker-derived clock — not a
    fixed bitrate timeline either way: it's both what `start_offset` is
    read from at construction and what every frame is then released
    against. `source_url` is the media server's own URL for a track
    (MediaClient.get_stream_url()), decoded here independently of whatever
    is being sent to the device. `source_queue` is radio's own path
    instead: a subscription to core/radio_relay.py's device-audio fan-out
    (the same bytes the cast target gets), fed into this analyzer's own
    separate ffmpeg via stdin rather than decoded from a URL — see the
    module docstring's radio paragraph for why. `gain` mirrors the
    ReplayGain applied to a track's real stream; unused (default 1.0) for
    radio, which has no such concept.

    `on_first_byte`, when given, is called once the first PCM bytes have
    actually been decoded. Used only by core/visualizer_feed.py's radio
    fallback clock (_FirstByteClock, for a target with no
    RadioPositionTracker) — a station fetch's own connection/first-response
    latency varies enough that a wall clock zeroed at construction instead
    of first byte would permanently misjudge every frame as late, past
    _MAX_LATENESS_SECONDS, for good. Unused by the track case and by
    radio's normal (RadioPositionTracker-backed) clock, both of which
    already tolerate arbitrary decode startup latency some other way — see
    _PREBUFFER_SECONDS/_MAX_LATENESS_SECONDS for the track case.

    `debug_cast_elapsed_fn`, when given, is a *second* clock — core/
    session.py's `SessionState.state.clock.elapsed()`, the same one driving
    the ordinary "running since" position display — read alongside
    `elapsed_fn` on every released frame purely for GET /visualizer's own
    debug overlay (see last_release_debug). Both VisualizerFeed call sites
    pass one, since 2026-09-05 (originally radio-only — the listener asked
    for it everywhere, not just Sonos radio, after the radio-only version
    proved useful): for a track, elapsed_fn already *is* the same function
    (VisualizerFeed._start_track_analyzer() uses st.clock.elapsed()
    directly for both), so it isn't independent there the way it is for
    radio — see last_release_debug's own comment for why the comparison is
    still meaningful anyway (a pipeline backlog, not a calibration gap, is
    what it can reveal in that case). For radio, elapsed_fn is instead
    core/visualizer_feed.py's own _OffsetTrackerClock/_FirstByteClock —
    correct by construction to keep this analyzer's own delivery smooth,
    but never independently checked against what the rest of the app
    believes playback position is until this existed. Reported live
    2026-09-04: the listener suspecting exactly that kind of gap
    ("visualizer zeigt sofort an, während audio dann um paar sekunden
    später kommt") but having no way to confirm it beyond ear and eye.

    `debug_lead_fn`, when given, is core/visualizer_feed.py's own
    _FirstByteClock.debug_lead() — only that clock has a fixed/measured
    device lead worth reporting at all (see last_release_lead). Added
    2026-09-05, the same day as debug_cast_elapsed_fn above: comparing
    `visualizer` against `cast` for a relayed Sonos always reads close to
    `-lead` by construction (both ultimately trace back to the same wall
    clock once RadioPositionTracker is excluded for that case — see core/
    state.py's first_radio_position_delivery()), so the delta alone cannot
    tell "the fixed guess is being echoed back, nothing measured yet" apart
    from "a real ICY round-trip measurement happens to agree with it" —
    the exact question live 2026-09-05, after seeing a delta of exactly
    -4.7s (ASSUMED_DEVICE_LEAD_SECONDS' own value) and no way to tell
    which of those two it was without reading server logs."""

    def __init__(
        self,
        elapsed_fn: Callable[[], float],
        source_url: str = "",
        start_offset: float = 0.0,
        gain: float = 1.0,
        on_first_byte: Callable[[], None] | None = None,
        source_queue: "asyncio.Queue[bytes | None] | None" = None,
        debug_cast_elapsed_fn: Callable[[], float] | None = None,
        debug_lead_fn: Callable[[], tuple[float, bool]] | None = None,
    ) -> None:
        self.frames: asyncio.Queue[list[float]] = asyncio.Queue(maxsize=8)
        # (content_position, bands) pairs already computed but not yet
        # released — see _release_frames(). A handful of KB even for a
        # whole track's worth (each entry is _BAND_COUNT floats).
        self._pending: deque[tuple[float, list[float]]] = deque()
        self._source_url = source_url
        self._source_queue = source_queue
        self._input_task: asyncio.Task | None = None
        self._start_offset = start_offset
        self._gain = gain
        self._on_first_byte = on_first_byte
        self._first_byte_seen = False
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._release_task: asyncio.Task | None = None
        self._pcm_buffer = bytearray()
        # Running state for _smooth_bands() — carries across frames within
        # this one run, reset naturally for the next one since each gets a
        # fresh AudioAnalyzer instance.
        self._smoothed_bands: list[float] | None = None
        self._elapsed_fn = elapsed_fn
        # Optional second, *independent* clock — see last_release_debug's
        # own comment for what this is for and why it's a separate function
        # from elapsed_fn rather than reusing that one's own value.
        self._debug_cast_elapsed_fn = debug_cast_elapsed_fn
        # The cast clock's reading at this run's *first decoded byte*, which
        # is where content_position's own zero sits for radio. Captured in
        # _read_pcm() right after on_first_byte(), so both clocks are read
        # at the same instant. Stays 0.0 for a track, which has no
        # on_first_byte and is what _read_pcm() gates this on: content_
        # position is track-absolute there and needs no re-basing. See
        # _release_frames() for why this must NOT be taken at the first
        # released frame instead.
        self._debug_baseline: float = 0.0
        # (visualizer_position, cast_position) for the most recently
        # released frame, in a common reference frame — see
        # _release_frames()'s own comment for how, and GET /visualizer
        # (routes/stream.py) for the only reader. None whenever
        # debug_cast_elapsed_fn wasn't given at all (nothing currently
        # constructs an AudioAnalyzer that way — both VisualizerFeed call
        # sites pass one — but the parameter stays optional rather than
        # required, since a future caller with genuinely nothing to compare
        # against shouldn't be forced to invent one).
        self.last_release_debug: tuple[float, float] | None = None
        # Optional third callable — core/visualizer_feed.py's
        # _FirstByteClock.debug_lead(), the only clock with a fixed/measured
        # lead worth reporting at all (a real device position, from either
        # RadioPositionTracker or the general track clock, has nothing like
        # it — see that method's own docstring). None for everything else.
        self._debug_lead_fn = debug_lead_fn
        # (lead in use, whether it's a live ICY measurement) as of the most
        # recently released frame — see debug_lead_fn's own comment and
        # GET /visualizer (routes/stream.py) for the only reader. None
        # whenever debug_lead_fn wasn't given.
        self.last_release_lead: tuple[float, bool] | None = None
        self._pcm_position = start_offset
        self._reading_done = False
        # When the current decode hold-off began, and whether it has
        # already been reported — see _wait_out_lookahead().
        self._stalled_since: float | None = None
        self._stall_reported = False
        # Whether start() actually got as far as a running process — checked
        # by core/visualizer_feed.py to tell a working analyzer apart from
        # one that swallowed a spawn failure below, since both look the same
        # from the outside (an AudioAnalyzer instance) otherwise.
        self.started = False

    async def start(self) -> None:
        piped = self._source_queue is not None
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *_decode_cmd(
                    "pipe:0" if piped else self._source_url, self._start_offset, self._gain
                ),
                stdin=asyncio.subprocess.PIPE if piped else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError as e:
            # Not just FileNotFoundError (ffmpeg missing): fd/process-limit
            # exhaustion and permission errors raise other OSError subclasses
            # here too, and letting those propagate used to escape
            # visualizer_feed.py's supervisor loop uncaught, leaking the
            # subscription it had already taken out and thrashing the
            # supervisor task. Handling every spawn failure the same way
            # keeps that loop in control regardless of which one happened;
            # FileNotFoundError keeps its own specific message since "not
            # installed" and "spawn failed" call for different fixes.
            if isinstance(e, FileNotFoundError):
                logger.warning("[audio-analysis] ffmpeg not found — visualizer data disabled")
            else:
                logger.warning(f"[audio-analysis] Failed to start ffmpeg: {e}")
            return
        self.started = True
        if piped:
            self._input_task = asyncio.create_task(self._write_input())
        self._reader_task = asyncio.create_task(self._read_pcm())
        self._release_task = asyncio.create_task(self._release_frames())

    async def _write_input(self) -> None:
        """Feeds `source_queue` into this process's own ffmpeg stdin — the
        radio path, where the bytes come from core/radio_relay.py's
        device-audio fan-out rather than from a fetch of this analyzer's
        own.

        That fan-out is the whole point: it is the *same* byte stream the
        cast device is being sent, so a given moment of audio means the
        same thing to both. Fetching the station a second time instead
        (which this used to do) looks equivalent and is not — a station
        hands every new client a burst of already-elapsed audio to fill
        its buffer with, seconds' worth and station-dependent, so the
        second fetch's "first byte" is not the same moment as the relay's
        current one and nothing downstream can tell by how much.

        Still a separate ffmpeg from the relay's own, which is what keeps
        the stall this replaced from coming back: the queue is bounded and
        the fan-out drops into a full one rather than blocking (see
        _fan_out()), so however slowly this reads, it can only ever cost
        itself frames — never the device's audio."""
        queue = self._source_queue
        stdin = self._proc.stdin if self._proc else None
        if queue is None or stdin is None:
            return
        try:
            while True:
                chunk = await queue.get()
                if chunk is None:  # relay stopped for good
                    break
                stdin.write(chunk)
                await stdin.drain()
        except (asyncio.CancelledError, BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            # Same reasoning as _read_pcm()'s own warning below: once this
            # stops, ffmpeg sees EOF and the visualizer goes dark for the
            # rest of the station with no other trace of why.
            logger.warning(f"[audio-analysis] input writer stopped: {e}")
        finally:
            with suppress(Exception):
                stdin.close()

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
        pcm = self._proc.stdout if self._proc else None
        assert pcm is not None
        window_bytes = _FFT_SIZE * 2  # 16-bit samples
        hop_bytes = _HOP_SIZE * 2
        try:
            while True:
                data = await pcm.read(4096)
                if not data:
                    break
                if not self._first_byte_seen:
                    self._first_byte_seen = True
                    if self._on_first_byte is not None:
                        self._on_first_byte()
                    # Right after on_first_byte(), not before: the radio
                    # clocks zero themselves in there (core/visualizer_
                    # feed.py's _FirstByteClock.mark()/_OffsetTrackerClock.
                    # mark()), and this baseline has to be the cast clock's
                    # reading at the same instant those do. See
                    # _debug_baseline's own comment for why the baseline
                    # moved here from the first *released* frame.
                    #
                    # Only where there is an on_first_byte to be alongside,
                    # i.e. radio: that is the case whose content_position is
                    # relative to this decode and needs the cast side pulled
                    # to the same zero. A track's is already track-absolute,
                    # so a baseline there re-bases one side of the
                    # comparison and not the other. Missing that guard is
                    # what made the overlay read a constant Δ of exactly the
                    # seek distance after skipping forward in a track
                    # (+97.59s at 103.98/6.39, reported live 2026-09-05) —
                    # a track opened at 0 hides it, because the baseline is
                    # then ~0 either way.
                    if self._on_first_byte is not None and self._debug_cast_elapsed_fn is not None:
                        self._debug_baseline = self._debug_cast_elapsed_fn()
                self._pcm_buffer.extend(data)
                while len(self._pcm_buffer) >= window_bytes:
                    window = bytes(self._pcm_buffer[-window_bytes:])
                    bands = analyze_pcm(window)
                    bands = _smooth_bands(self._smoothed_bands, bands, _SMOOTHING_TIME_CONSTANT)
                    self._smoothed_bands = bands
                    self._pending.append((self._pcm_position, bands))
                    self._pcm_position += _FRAME_SECONDS
                    del self._pcm_buffer[:hop_bytes]
                    # Yield after every frame — see _MAX_LOOKAHEAD_SECONDS's
                    # comment for the starvation this loop causes while
                    # racing to build its lookahead: neither this inner loop
                    # nor stdout.read() above suspends on its own when the
                    # decoder already has bytes ready, so without this the
                    # loop can go the whole race without giving anything
                    # else sharing it a turn. Confirmed 2026-08-26 to be more
                    # than cosmetic once AirPlay joined LIVE_ANALYSIS_TARGET_TYPES:
                    # a track change starts this analyzer and a fresh
                    # AirPlayDelivery.play() at the same moment, and that
                    # target's RTSP handshake is fragile enough that the
                    # starvation dropped it outright on a real Apple TV.
                    # sleep(0) only re-queues this task behind whatever else
                    # is ready, not a real delay, so the race still finishes
                    # in essentially the same wall-clock time.
                    await asyncio.sleep(0)
                # Pause once far enough ahead — see _MAX_LOOKAHEAD_SECONDS.
                # Not reading further just leaves bytes sitting in the
                # decoder's own stdout pipe; once that (small, kernel-sized)
                # buffer fills, ffmpeg's own write() blocks and it stops
                # burning CPU too, rather than continuing to decode+FFT
                # content nobody's close to needing yet. Applies to radio's
                # own ffmpeg exactly the same as a track's: a live station's
                # own server can burst too (see core/radio_relay.py's
                # docstring), and this is what turns that burst back into a
                # steady decode rate here as well — this analyzer's ffmpeg
                # has no pipe in common with anything else any more (see
                # this class's own module-level docstring history), so
                # pausing it can no longer stall device audio the way it
                # once could when radio shared the relay's own ffmpeg.
                lookahead = self._pcm_position - self._elapsed_fn()
                if lookahead > _MAX_LOOKAHEAD_SECONDS:
                    await self._wait_out_lookahead(lookahead)
                else:
                    self._stalled_since = None
                    # Own the reset, not just the flag mark above — without
                    # this a second, later stall in the same run stayed
                    # silent forever, contradicting this warning's own
                    # "once per stall, not once per check" comment.
                    self._stall_reported = False
                    self._resync_if_behind()
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

    async def _wait_out_lookahead(self, lookahead: float) -> None:
        """Hold off decoding while far enough ahead — see
        _MAX_LOOKAHEAD_SECONDS.

        Capped for a live source rather than sleeping off the whole excess
        in one go. The excess is measured against a clock this analyzer
        doesn't control, and a clock that stops (a device that stops
        reporting its position, a poll that hangs behind some other
        request to the same speaker) makes that excess arbitrarily large.
        Sleeping it out wholesale means not reading stdout for that long
        either, so ffmpeg blocks on its own write, _write_input() blocks in
        drain() behind it, and the run is wedged well past the moment the
        clock recovers. Re-checking every _STALL_RECHECK_SECONDS costs one
        comparison and lets it resume the moment there is something to
        resume to.

        A file source keeps the old behaviour: its clock is the session's
        own calibrated one, and its decode genuinely does run far enough
        ahead for a single long sleep to be the right call."""
        live = self._source_queue is not None
        delay = lookahead - _MAX_LOOKAHEAD_SECONDS
        if not live:
            await asyncio.sleep(delay)
            return
        now = time.monotonic()
        if self._stalled_since is None:
            self._stalled_since = now
        elif now - self._stalled_since > _STALL_REPORT_AFTER_SECONDS and not self._stall_reported:
            # Once per stall, not once per check — this is a diagnosis for a
            # clock that isn't advancing, and repeating it every second
            # would bury the rest of the log while it lasts.
            self._stall_reported = True
            logger.warning(
                f"[audio-analysis] decode held for "
                f"{now - self._stalled_since:.1f}s: content_position="
                f"{self._pcm_position:.2f}s but the playback clock reads "
                f"{self._elapsed_fn():.2f}s and is not advancing — frames cannot be "
                "released until it does"
            )
        await asyncio.sleep(min(delay, _STALL_RECHECK_SECONDS))

    def _resync_if_behind(self) -> None:
        """Rejoin a live source at the clock's current moment when this run
        has fallen too far behind it — see _LIVE_RESYNC_BEHIND_SECONDS. A
        no-op for a file source, and for anything within ordinary jitter.

        Whatever is already queued goes with it: those frames describe
        audio the device played while this was stalled, so releasing them
        now would be showing the past."""
        if self._source_queue is None:
            return
        behind = self._elapsed_fn() - self._pcm_position
        if behind <= _LIVE_RESYNC_BEHIND_SECONDS:
            return
        logger.info(
            f"[audio-analysis] {behind:.1f}s behind on a live source — "
            "skipping the backlog and rejoining now"
        )
        self._pending.clear()
        self._pcm_position = self._elapsed_fn()

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
                not self._pending or self._pending[-1][0] - self._pending[0][0] < _PREBUFFER_SECONDS
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
                    # Yields even though there's real work queued right
                    # behind it — a `continue` straight back to the top
                    # with `_pending` still non-empty and every entry
                    # equally "too late" (the exact shape a permanently
                    # mis-calibrated elapsed_fn produces, not just an
                    # ordinary catch-up burst) would otherwise spin this
                    # whole loop synchronously, popping and dropping with
                    # no await between iterations at all, for as long as
                    # that holds — starving every *other* task sharing this
                    # event loop, device audio streaming included. Reported
                    # live 2026-09-02 as stuttering device audio traced to
                    # core/visualizer_feed.py's own elapsed_fn/
                    # content_position mismatch bug; this is defense in
                    # depth against that class of bug recurring, not a fix
                    # for a specific one.
                    await asyncio.sleep(0)
                    continue
                if self._debug_cast_elapsed_fn is not None:
                    # content_position raw on the left, cast clock re-based
                    # to first byte on the right — the two are then in the
                    # same reference frame and their difference is the real,
                    # *absolute* lag this overlay exists to show.
                    #
                    # Both sides used to be re-based here instead, at the
                    # first frame this run ever released. That made the
                    # overlay structurally incapable of showing the one
                    # number it was built for: frame one reads (0.00, 0.00)
                    # by construction, and everything after it is pure
                    # relative drift. A radio visualizer running the full
                    # device lead ahead of the audio — the exact complaint
                    # this was added for on 2026-09-04 — still displayed
                    # Δ +0.00s, because the lead had already been absorbed
                    # into the baseline before the first frame came out.
                    # It contradicted last_release_lead's own docstring too,
                    # which asserts the delta "always reads close to -lead
                    # by construction"; that was true only before the
                    # content baseline was added.
                    #
                    # The cast clock still needs its baseline, and taking it
                    # at first byte is what makes it honest: for radio,
                    # content_position is relative to *this* analyzer's own
                    # decode (0 at first byte, since a station has no
                    # absolute position to seek to) while the cast clock has
                    # been running since /play-url, so without it a
                    # visualizer opened ten minutes into a station would
                    # read a -600s "delta" that means nothing. For a track
                    # both sides are already track-absolute and there is no
                    # on_first_byte at all, so _debug_baseline stays 0.0 and
                    # this reduces to the plain content-vs-cast comparison —
                    # which is exactly right, and also fixes the 2026-09-05
                    # report of a large constant delta on a track opened
                    # mid-playback (that one came from re-basing only the
                    # cast side, comparing an absolute number against a
                    # re-based one).
                    self.last_release_debug = (
                        round(content_position, 2),
                        round(self._debug_cast_elapsed_fn() - self._debug_baseline, 2),
                    )
                if self._debug_lead_fn is not None:
                    lead, measured = self._debug_lead_fn()
                    self.last_release_lead = (round(lead, 2), measured)
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
        if self._input_task:
            self._input_task.cancel()
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
# core/visualizer_feed.py and tests reference the exact same set — "every
# delivery type with a track behind it" is the actual intent, not "these
# four specifically", but spelling it out explicitly is safer than an
# exclusion list silently covering some future delivery type nobody's
# decided is actually safe to analyze yet. AirPlay joined this set
# 2026-08-26 — see the module docstring for why its two original reasons for
# exclusion no longer hold. Radio is the only thing still excluded, and it
# isn't a delivery type at all: should_analyze() never sees it show up here,
# since it has no track for a target to be "playing" in the first place.
LIVE_ANALYSIS_TARGET_TYPES = frozenset({"sonos", "dlna", "chromecast", "airplay"})


def should_analyze(target_pairs: list[tuple[str, str]]) -> bool:
    """Whether at least one currently-active delivery target can plausibly
    have its playback analyzed — see the module docstring for why radio
    can't. `target_pairs` is core.state.list_target_pairs()'s
    output, kept as a plain parameter (not importing SessionState here) to
    avoid a session <-> audio_analysis import cycle."""
    return any(target_type in LIVE_ANALYSIS_TARGET_TYPES for target_type, _ in target_pairs)
