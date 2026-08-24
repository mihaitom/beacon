"""core/streamer.py — FFmpeg Audio Stream Engine"""

import asyncio
import logging
import os
import re
import time
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field

logger = logging.getLogger("connect.streamer")

# How far ahead of real playback time a stream is allowed to run before
# ffmpeg throttles itself back to real time. Long enough to smooth over an
# ordinary network/disk hiccup fetching the next stretch of the source
# without an audible stall; short enough that a device connection dropping
# mid-track only ever has to recover this many seconds of already-sent-but-
# unplayed audio, not the rest of a multi-hour file.
LOOKAHEAD_SECONDS = 15.0

# -readrate 1 tells ffmpeg to read its *input* at 1x real time, judged by
# the input's own timestamps; -readrate_initial_burst lets it run flat out
# for the first LOOKAHEAD_SECONDS to fill the device's buffer before that
# throttle engages. Both are input options, so they sit before -i.
#
# This replaced a hand-rolled throttle in stream_tracks() that estimated
# produced-audio-seconds as bytes*8/bitrate, with `bitrate` read off
# ffmpeg's "Duration: ..., bitrate: N kb/s" summary line. That line is the
# *container* bitrate, which includes any embedded cover art, while the
# bytes actually being counted are audio-only (-vn strips the attached
# picture). For a track with a large embedded cover the two diverge badly
# and the throttle silently over-delivers by that ratio. Measured live on
# beacon-dev 2026-08-22 against OVERWERK — Toccata (a ~4MB PNG cover:
# container 397 kb/s vs. 320 kb/s of actual audio): the real lead grew
# ~0.24s per second instead of holding at 15s, so ffmpeg finished a 411s
# track after 316s and left the device's connection sitting completely
# idle for the remaining 95s — the exact condition the pacing was added to
# eliminate. Confirmed in production, not just in a harness: the device
# really does swallow the whole overshoot, TCP backpressure does not
# absorb it ("FFmpeg done early — waiting 95.1s", routes/stream.py).
#
# Letting ffmpeg pace itself against real timestamps removes the estimate
# entirely, so there is no bitrate to get wrong. It also covers the tiers
# the old throttle could not: FLAC's "Stream #0:0: Audio: flac, 44100 Hz,
# stereo, s16" line carries no bitrate at all, and the lossless-reencode
# tier opted out of pacing altogether by setting bitrate_bps=None.
_READRATE_ARGS = [
    "-readrate",
    "1",
    "-readrate_initial_burst",
    f"{LOOKAHEAD_SECONDS:.0f}",
    # Without this, "1" is a ceiling with no floor: ffmpeg reads at exactly
    # real time and therefore never regains a lead it has lost. Anything
    # that stalls the pipeline once — a slow stretch fetching from the
    # media server, or this process's own event loop blocking (see
    # core/loop_health.py) — permanently shortens the device's buffer for
    # the rest of that track, and a few such events in a row leave it
    # playing at the live edge with nothing in hand. Observed on beacon-dev
    # 2026-08-22: a 2.53s loop stall early in an 80-minute mix, then a
    # device drop four minutes later with the lead down from 15s to
    # roughly nothing.
    #
    # The hand-rolled throttle this replaced did catch up, incidentally
    # rather than by design: it slept only while already more than
    # LOOKAHEAD_SECONDS ahead, so falling behind simply meant it stopped
    # sleeping and ran flat out until the lead was restored. Losing that
    # was a regression in the switch to -readrate; 2x is the explicit
    # version of the same behaviour, fast enough to refill a 15s buffer in
    # 15s without dumping the whole remaining file at the device.
    "-readrate_catchup",
    "2",
]

_FFMPEG_BASE_CMD = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "warning",  # warning so codec/format issues surface in logs
    *_READRATE_ARGS,
    "-i",
    "{url}",
    "-vn",
]

# Codecs ffmpeg can copy straight through to a compatible output container
# without re-encoding, for source codecs these devices broadly support —
# whatever bitrate/quality the source already has is exactly what gets
# streamed (a 320kbps MP3 stays 320kbps; a FLAC stays exactly that FLAC).
# Requires the matching muxer to be built into ffmpeg — see the Dockerfile's
# ffmpeg-builder stage for the custom minimal build used in the Docker image.
#
# opus deliberately excluded despite ffmpeg supporting an opus-in-ogg copy —
# confirmed live (2026-08-19) that a real Sonos speaker accepts the URI but
# produces no audio for it. Sonos' own published format list covers MP3,
# AAC, FLAC, ALAC, WMA, Ogg **Vorbis**, AIFF and WAV — Opus isn't on it,
# unlike Chromecast's Default Media Receiver, which does support Opus. Opus
# sources fall through to the mp3 fallback tier instead (see
# resolve_output_format()) rather than risking silent playback on Sonos.
_COPY_MUXER_FOR_CODEC = {
    "flac": "flac",
    "mp3": "mp3",
    "aac": "adts",
    "vorbis": "ogg",
}

_CONTENT_TYPE_FOR_MUXER = {
    "flac": "audio/flac",
    "mp3": "audio/mpeg",
    "adts": "audio/aac",
    "ogg": "audio/ogg",
}

# Lossless source codecs that aren't good copy-tier targets for these devices
# (wrong container, or not a format cast devices are expected to accept) —
# re-encoded losslessly to FLAC instead, so there's still no quality loss
# even though the bytes on the wire change.
_LOSSLESS_REENCODE_CODECS = {"alac", "pcm_s16le", "pcm_s24le", "pcm_s16be", "ape"}

_FALLBACK_ARGS = ["-acodec", "libmp3lame", "-ab", "192k", "-ar", "44100", "-f", "mp3"]
_FALLBACK_CONTENT_TYPE = "audio/mpeg"

# Diagnostic switch for the recurring cast-drop investigation (see
# docs/playback-bugs/mid-track-drop-symptom.md). Set FORCE_FALLBACK_FORMAT=1
# to make every track go through the MP3 192k re-encode, i.e. exactly what
# this backend did before the stream-copy tiers were added — the shape the
# simpler upstream it grew out of still uses, and which has never shown the
# bug.
#
# Read per call rather than captured at import so it can be flipped with a
# container restart instead of a rebuild, which is what makes an A/B over
# hours of listening practical at all.
def _fallback_forced() -> bool:
    return os.getenv("FORCE_FALLBACK_FORMAT", "").strip().lower() in {"1", "true", "yes"}


_PROBE_TIMEOUT = 10.0
_AUDIO_STREAM_RE = re.compile(rb"Stream #\d+:\d+.*?Audio:\s*([a-zA-Z0-9_]+)")
# Both searched only within the matched Audio line itself (see _probe_source),
# never the whole stderr blob — a source with embedded cover art gets a
# second, video/attached-pic Stream line from ffmpeg that has no "Hz" of its
# own to false-match, but there's no reason to rely on that alone.
_SAMPLE_RATE_RE = re.compile(rb",\s*(\d+)\s*Hz")
# ffmpeg reports the *real* bit depth this way only for formats where the
# sample format alone doesn't already say it (FLAC/ALAC's internal 32-bit
# buffer isn't the source's own depth) — e.g. "s32 (24 bit)". Formats that
# don't carry this (raw PCM's "s16"/"s24" already *is* the real depth) are
# simply reported as None here; nothing in this module currently needs a
# depth cap for those (_LOSSLESS_REENCODE_CODECS' own real-world sources are
# overwhelmingly ALAC/FLAC-adjacent, where this pattern applies).
_BIT_DEPTH_RE = re.compile(rb"\((\d+)\s*bit\)")
# The Audio stream's *own* line carries its bitrate for lossy codecs (e.g.
# "mp3, 44100 Hz, stereo, fltp, 320 kb/s") — deliberately not the same
# thing the pacing bug this backend already fixed once read (the container
# summary line's "Duration: ..., bitrate: N kb/s", which includes embedded
# cover art and is *not* the audio's own bitrate; see
# docs/playback-bugs/fixed-pacing-used-container-bitrate.md). Bound to the
# same per-line search as sample rate/bit depth above, for the same reason.
# Absent for lossless codecs (FLAC/ALAC/PCM never report one here) — never
# guessed at, same convention as sample_rate/bit_depth being None.
_BITRATE_RE = re.compile(rb",\s*(\d+)\s*kb/s")


@dataclass
class OutputFormat:
    """What ffmpeg should do with a source, and what the result actually is —
    the single source of truth both `/stream`'s Content-Type header and each
    delivery's device-facing metadata (DIDL protocolInfo, Cast content_type)
    read from, so they can never disagree with what stream_tracks() sends.

    `source_codec`/`source_sample_rate`/`source_bit_depth`/`source_bitrate_kbps`
    are the probed source's own numbers (see SourceInfo) — carried along
    purely for core/session.py's build_status_dict() to surface in the
    frontend's stream-info overlay ("FLAC 96kHz/24bit, resampled to 48kHz
    for this device"). None on the fallback/default instance and on the
    ReplayGain-forced-fallback path in resolve_output_format(): both discard
    whatever the probe found rather than acting on it, so there is nothing
    accurate to report."""

    ffmpeg_args: list[str] = field(default_factory=lambda: list(_FALLBACK_ARGS))
    content_type: str = _FALLBACK_CONTENT_TYPE
    label: str = "mp3-192k (fallback)"
    source_codec: str | None = None
    source_sample_rate: int | None = None
    source_bit_depth: int | None = None
    source_bitrate_kbps: int | None = None


FALLBACK_FORMAT = OutputFormat()


@dataclass
class SourceInfo:
    """What _probe_source() actually found. sample_rate/bit_depth are None
    when ffmpeg's own line didn't carry them (see _BIT_DEPTH_RE's comment) —
    resolve_output_format() then simply can't judge this source against a
    device's declared limit and leaves it untouched, the same as a device
    with no declared limit at all. bitrate_kbps is None for lossless codecs
    (see _BITRATE_RE's comment) — informational only, nothing in
    resolve_output_format() judges a source against it. No field is ever
    guessed."""

    codec: str
    sample_rate: int | None
    bit_depth: int | None
    bitrate_kbps: int | None


async def _probe_source(url: str) -> SourceInfo | None:
    """Return the source's audio codec/sample rate/bit depth, or None if
    detection fails.

    Uses `ffmpeg -i <url>` itself rather than a separate `ffprobe` call —
    ffmpeg -i with no output target still fully parses and prints the
    input's stream info (`Stream #0:0: Audio: flac, 96000 Hz, ...`) to
    stderr before exiting non-zero, which is enough to read this off of.
    The Docker image's custom minimal ffmpeg build only ships the one
    `ffmpeg` binary (see Dockerfile) — adding a second, similarly-sized
    static ffprobe binary just for this lookup isn't worth it.

    Deliberately does *not* also read the "Duration: ..., bitrate: N kb/s"
    summary line. Nothing needs it now that ffmpeg paces itself (see
    _READRATE_ARGS), and what it reports is the container bitrate, cover
    art included — a number that looks like the audio bitrate, isn't, and
    silently broke pacing for every track with a large embedded cover.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-hide_banner",
            "-i",
            url,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=_PROBE_TIMEOUT)
    except Exception as e:
        logger.warning(f"[ffmpeg] format probe failed for {url[:80]}: {e}")
        return None

    match = _AUDIO_STREAM_RE.search(stderr)
    if not match:
        logger.warning(f"[ffmpeg] format probe: no audio stream detected for {url[:80]}")
        return None
    codec = match.group(1).decode()

    # Bounded to the rest of the Audio stream's own line — see
    # _SAMPLE_RATE_RE/_BIT_DEPTH_RE's own comments for why a later,
    # unrelated line (embedded cover art's own video Stream line) must
    # never be what these end up matching.
    line_end = stderr.find(b"\n", match.end())
    line = stderr[match.end() : line_end if line_end != -1 else len(stderr)]
    rate_match = _SAMPLE_RATE_RE.search(line)
    depth_match = _BIT_DEPTH_RE.search(line)
    bitrate_match = _BITRATE_RE.search(line)
    return SourceInfo(
        codec=codec,
        sample_rate=int(rate_match.group(1)) if rate_match else None,
        bit_depth=int(depth_match.group(1)) if depth_match else None,
        bitrate_kbps=int(bitrate_match.group(1)) if bitrate_match else None,
    )


def _resample_args(
    info: SourceInfo, max_sample_rate: int | None, max_bit_depth: int | None
) -> list[str]:
    """ffmpeg args to bring `info` down to a device's declared limits, or []
    if nothing needs to change. Never upsamples or upgrades: a cap higher
    than the source's own rate/depth (or a source whose rate/depth couldn't
    be detected at all) leaves it alone rather than "helpfully" changing
    anything not actually required to make the device happy."""
    args = []
    if (
        max_sample_rate is not None
        and info.sample_rate is not None
        and info.sample_rate > max_sample_rate
    ):
        args += ["-ar", str(max_sample_rate)]
    if (
        max_bit_depth is not None
        and info.bit_depth is not None
        and info.bit_depth > max_bit_depth
    ):
        # FLAC/ALAC sources in practice are 16- or 24-bit; s16 is the only
        # meaningful "smaller" target once 24 itself isn't allowed.
        args += ["-sample_fmt", "s16"]
    return args


async def resolve_output_format(
    url: str,
    gain: float = 1.0,
    max_sample_rate: int | None = None,
    max_bit_depth: int | None = None,
) -> OutputFormat:
    """Detect the real source codec/sample rate/bit depth and decide how
    ffmpeg should handle it — stream-copy when the source is already
    device-compatible (preserving its exact quality/bitrate), lossless
    re-encode to FLAC (resampled down to a device's limit when it has one
    and the source exceeds it) for other lossless sources, or the existing
    MP3 192k re-encode as the universal fallback when detection fails or the
    source is something else entirely (never a new failure mode, only ever
    an upgrade when detection succeeds).

    `max_sample_rate`/`max_bit_depth` are the casting target's own declared
    ceiling — see delivery/base.py's BaseDelivery.MAX_SAMPLE_RATE_HZ/
    MAX_BIT_DEPTH and core/state.py's audio_capability_limits(), which every
    caller here is expected to have already reduced a (possibly multi-
    target) dispatch down to the single most restrictive pair. None (the
    default) means no known limit — every caller from before these
    parameters existed keeps behaving exactly as it did.

    A source that exceeds either is never stream-copied, even when its
    codec would otherwise qualify: copying means the device gets the
    file's own bytes untouched, and there's no such thing as a device-
    compatible copy of a stream whose sample rate the device can't decode
    at all — confirmed live (see
    docs/playback-bugs/copy-tier-device-limits.md): a 24-bit/96kHz FLAC
    copied straight to a Sonos reported ERROR_UNSUPPORTED_FREQ and stopped
    1.1s in. It's re-encoded losslessly to FLAC instead, resampled down to
    the limit — the same tier _LOSSLESS_REENCODE_CODECS below already
    uses, just also reached from a codec that would otherwise have
    qualified for copy.

    `gain` (ReplayGain, see stream_tracks()'s own docstring) rules out the
    copy tier specifically: stream-copy means ffmpeg never decodes the
    audio at all, and applying a volume adjustment requires exactly that —
    `ffmpeg -af volume=X -acodec copy` fails outright ("Filtering and
    streamcopy cannot be used together"), which meant a ReplayGain-enabled
    track that also happened to qualify for stream-copy never played at
    all. Every FLAC re-encode tier below is unaffected either way — it
    already decodes+re-encodes, so stream_tracks() fits a volume filter
    into that same pipeline for free (see its own handling of `gain`)."""
    if _fallback_forced():
        # No probe either: the point is to reproduce the pre-copy-tier
        # pipeline exactly, and that never inspected the source.
        logger.info("[ffmpeg] FORCE_FALLBACK_FORMAT set — re-encoding to mp3 192k")
        return FALLBACK_FORMAT

    info = await _probe_source(url)
    if info is None:
        return FALLBACK_FORMAT
    codec = info.codec
    resample_args = _resample_args(info, max_sample_rate, max_bit_depth)

    muxer = _COPY_MUXER_FOR_CODEC.get(codec)
    if muxer and resample_args:
        logger.info(
            f"[ffmpeg] format probe: '{codec}' would copy, but source "
            f"{info.sample_rate}Hz/{info.bit_depth}bit exceeds this target's limit "
            f"({max_sample_rate}Hz/{max_bit_depth}bit) — re-encoding to flac, resampled"
        )
        return OutputFormat(
            ffmpeg_args=["-acodec", "flac", "-f", "flac", *resample_args],
            content_type="audio/flac",
            label=f"{codec} → flac (resampled for device limit)",
            source_codec=info.codec,
            source_sample_rate=info.sample_rate,
            source_bit_depth=info.bit_depth,
            source_bitrate_kbps=info.bitrate_kbps,
        )
    if muxer and gain == 1.0:
        return OutputFormat(
            ffmpeg_args=["-acodec", "copy", "-f", muxer],
            content_type=_CONTENT_TYPE_FOR_MUXER[muxer],
            label=f"{codec} (copy)",
            source_codec=info.codec,
            source_sample_rate=info.sample_rate,
            source_bit_depth=info.bit_depth,
            source_bitrate_kbps=info.bitrate_kbps,
        )
    if muxer:
        logger.info(
            f"[ffmpeg] format probe: '{codec}' would copy, but ReplayGain is active "
            "(gain != 1.0) — using mp3 fallback instead, since streamcopy and a volume "
            "filter can't be combined"
        )
        return FALLBACK_FORMAT

    if codec in _LOSSLESS_REENCODE_CODECS:
        label = f"{codec} → flac" + (" (resampled for device limit)" if resample_args else "")
        return OutputFormat(
            ffmpeg_args=["-acodec", "flac", "-f", "flac", *resample_args],
            content_type="audio/flac",
            label=label,
            source_codec=info.codec,
            source_sample_rate=info.sample_rate,
            source_bit_depth=info.bit_depth,
            source_bitrate_kbps=info.bitrate_kbps,
        )

    reason = (
        "not broadly device-compatible (see _COPY_MUXER_FOR_CODEC's comment)"
        if codec == "opus"
        else "unrecognized codec"
    )
    logger.info(f"[ffmpeg] format probe: {reason} '{codec}', using mp3 fallback")
    return FALLBACK_FORMAT


async def stream_tracks(
    track_urls: list[str],
    on_track_start: Callable[[int], None] | None = None,
    start_offset: float = 0.0,
    gain: float = 1.0,
    output_format: OutputFormat | None = None,
) -> AsyncGenerator[bytes]:
    """Yield continuous audio bytes for all tracks in sequence, encoded per
    `output_format` (defaults to the MP3 192k fallback — see resolve_output_format()).

    Calls on_track_start(relative_index) before each track begins.
    start_offset seeks the first track to that many seconds in (e.g. after pause/resume).
    gain is a linear amplitude multiplier (ReplayGain), applied via ffmpeg's
    `volume` filter — 1.0 (the default) leaves the audio unchanged.

    Paced to at most LOOKAHEAD_SECONDS ahead of real playback by ffmpeg
    itself — see _READRATE_ARGS, which every tier's command carries.
    Without pacing, ffmpeg happily produces output as fast as the source
    can be fetched and decoded, not at anything close to real time. That
    was never a problem for the old always-re-encode pipeline this one
    replaced — actual decode+encode CPU work incidentally kept it roughly
    real-time-ish on its own — but the `-acodec copy` tier this one added
    (real quality win: zero re-encode loss, see resolve_output_format())
    does essentially no CPU work at all, so a long track gets fully
    produced and handed off to the device in seconds. Observed live
    2026-08-22: several-minutes-long stretches of a cast device's GET
    /stream connection sitting completely idle (everything already sent
    long before actual playback caught up) ending in the device dropping
    it outright — some idle-connection timeout somewhere between here and
    the device, not this app's own code, but avoidable either way by
    simply not producing that far ahead of real consumption in the first
    place. A device reconnecting after a drop only ever has to recover
    this many seconds of buffer, not the rest of a multi-hour file either.
    """
    if not track_urls:
        return

    fmt = output_format or FALLBACK_FORMAT
    # -ar 44100 (the fallback's forced resample) must never leak onto the
    # copy/lossless-flac branches — that would silently defeat the point for
    # any source above 44.1kHz/16-bit. Those branches simply don't carry it.
    fmt_args = fmt.ffmpeg_args

    for i, url in enumerate(track_urls):
        if on_track_start:
            on_track_start(i)

        cmd = [arg if arg != "{url}" else url for arg in _FFMPEG_BASE_CMD]
        cmd = cmd + fmt_args + ["pipe:1"]
        if i == 0 and start_offset > 0.5:
            # Insert -ss before -i for fast input-side seeking on the resumed track
            i_pos = cmd.index("-i")
            cmd = cmd[:i_pos] + ["-ss", f"{start_offset:.3f}"] + cmd[i_pos:]
        if gain != 1.0:
            i_pos = cmd.index("-vn")
            cmd = cmd[:i_pos] + ["-af", f"volume={gain}"] + cmd[i_pos:]
        logger.debug(
            f"[ffmpeg] Track {i + 1}/{len(track_urls)} ({fmt.label}): {url[:80]}"
        )
        logger.debug(f"[ffmpeg] Command: {' '.join(cmd)}")

        proc = None
        stderr_task: asyncio.Task | None = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # Read stderr concurrently to prevent pipe buffer deadlock
            stderr_task = asyncio.create_task(proc.stderr.read())

            # Pacing itself is ffmpeg's job now (see _READRATE_ARGS), so
            # this loop just moves bytes. Reset per track — each is its own
            # ffmpeg invocation with its own timeline. Kept only to log the
            # summary below, which is the cheapest way to notice pacing
            # having regressed again: for a paced stream, wall time to
            # produce a track lands within ~LOOKAHEAD_SECONDS of that
            # track's real duration, not a fraction of it.
            track_start = time.monotonic()
            bytes_produced = 0
            while True:
                chunk = await proc.stdout.read(8192)
                if not chunk:
                    break
                bytes_produced += len(chunk)
                yield chunk

            logger.debug(
                f"[ffmpeg] Track {i + 1} produced {bytes_produced} bytes in "
                f"{time.monotonic() - track_start:.1f}s wall"
            )
            await proc.wait()
            stderr = await stderr_task

            if proc.returncode != 0:
                logger.warning(
                    f"[ffmpeg] Track {i + 1} exit {proc.returncode}: "
                    f"{stderr.decode(errors='replace')[:400]}"
                )
            elif stderr:
                logger.debug(
                    f"[ffmpeg] Track {i + 1} stderr: {stderr.decode(errors='replace')[:200]}"
                )

        except FileNotFoundError:
            logger.error(
                "[ffmpeg] ❌ ffmpeg not found — please install (apk add ffmpeg)"
            )
            # Propagate (not a silent `return`) so stream_with_completion()
            # doesn't mistake this for a normal, successful end-of-stream and
            # fire a track-end broadcast — see its matching except clause.
            raise

        except asyncio.CancelledError:
            logger.info(f"[ffmpeg] Stream cancelled (Track {i + 1})")
            if proc:
                try:
                    proc.kill()
                except Exception:
                    pass
            if stderr_task:
                stderr_task.cancel()
            raise  # propagate so stream_with_completion skips the track-end broadcast

        except Exception:
            logger.exception(f"[ffmpeg] Error on track {i + 1}")
            if proc:
                try:
                    proc.kill()
                except Exception:
                    pass
            # Propagate rather than `continue` — a genuine ffmpeg failure
            # (crash, decode error) is not a natural end either; see the
            # FileNotFoundError branch above for why this matters.
            raise

    logger.info("[ffmpeg] All tracks streamed")
