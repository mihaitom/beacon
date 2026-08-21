"""core/streamer.py — FFmpeg Audio Stream Engine"""

import asyncio
import logging
import re
import time
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field

logger = logging.getLogger("connect.streamer")

_FFMPEG_BASE_CMD = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "warning",  # warning so codec/format issues surface in logs
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

# How far ahead of real playback time stream_tracks() lets itself get before
# throttling further reads — see its own pacing comment for the full
# reasoning. Long enough to smooth over an ordinary network/disk hiccup
# fetching the next stretch of the source without an audible stall; short
# enough that a device connection dropping mid-track only ever has to
# recover this many seconds of already-sent-but-unplayed audio, not the
# rest of a multi-hour file.
LOOKAHEAD_SECONDS = 15.0

_PROBE_TIMEOUT = 10.0
_AUDIO_STREAM_RE = re.compile(rb"Stream #\d+:\d+.*?Audio:\s*([a-zA-Z0-9_]+)")
# ffmpeg's own input-summary line: "Duration: 00:04:32.10, start: 0.000000,
# bitrate: 705 kb/s" — the container's overall bitrate, which for a pure
# audio source is the audio bitrate. Used to pace stream_tracks()'s output
# for the copy tier below, where (unlike the fallback's fixed -ab 192k)
# there's no bitrate ffmpeg_args itself declares — it is whatever the
# source already is.
_BITRATE_RE = re.compile(rb"bitrate:\s*(\d+)\s*kb/s")


@dataclass
class OutputFormat:
    """What ffmpeg should do with a source, and what the result actually is —
    the single source of truth both `/stream`'s Content-Type header and each
    delivery's device-facing metadata (DIDL protocolInfo, Cast content_type)
    read from, so they can never disagree with what stream_tracks() sends."""

    ffmpeg_args: list[str] = field(default_factory=lambda: list(_FALLBACK_ARGS))
    content_type: str = _FALLBACK_CONTENT_TYPE
    label: str = "mp3-192k (fallback)"
    # Expected output bits/second, when known — see stream_tracks()'s own
    # pacing comment for why this exists and what None means for a given
    # tier.
    bitrate_bps: int | None = 192_000


FALLBACK_FORMAT = OutputFormat()

# ffmpeg's *demuxer* name for reading back a stream in a given muxed format —
# not always identical to the muxer name used to produce it (every
# ffmpeg_args above ends in ["-f", <muxer>]). Raw ADTS AAC in particular:
# written with the "adts" muxer, but ffmpeg has no "adts" *demuxer* at all —
# reading it back needs "aac" instead. See core/audio_analysis.py's
# AudioAnalyzer, which needs to tell its own decode-only ffmpeg process what
# it's about to receive on stdin (a pipe, unlike a file ffmpeg could sniff an
# extension from) — it used to hardcode "-f mp3" unconditionally there, so
# GET /visualizer only ever produced real frames for a track whose resolved
# output format actually was mp3 (i.e. the fallback tier) and silently
# never produced any for flac/aac/ogg copy-through or the lossless-reencode-
# to-flac tier — this mapping (used via demuxer_for() below) is what makes
# that decode step match whatever stream_tracks() is actually sending.
_DEMUXER_FOR_MUXER = {
    "mp3": "mp3",
    "flac": "flac",
    "adts": "aac",
    "ogg": "ogg",
}


def demuxer_for(output_format: OutputFormat) -> str:
    """The ffmpeg -f value to *read back* the bytes stream_tracks() is
    producing for `output_format` — see _DEMUXER_FOR_MUXER's own comment."""
    muxer = output_format.ffmpeg_args[-1]
    return _DEMUXER_FOR_MUXER.get(muxer, "mp3")


async def _probe_source(url: str) -> tuple[str, int | None] | None:
    """Return (codec name, bitrate in bits/second or None), or None if
    detection fails entirely.

    Uses `ffmpeg -i <url>` itself rather than a separate `ffprobe` call —
    ffmpeg -i with no output target still fully parses and prints the
    input's stream info (`Stream #0:0: Audio: flac, 96000 Hz, ...`, and a
    `Duration: ..., bitrate: NNN kb/s` summary line) to stderr before
    exiting non-zero, which is enough to read both off of. The Docker
    image's custom minimal ffmpeg build only ships the one `ffmpeg` binary
    (see Dockerfile) — adding a second, similarly-sized static ffprobe
    binary just for this lookup isn't worth it.
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

    bitrate_match = _BITRATE_RE.search(stderr)
    bitrate_bps = int(bitrate_match.group(1)) * 1000 if bitrate_match else None
    return codec, bitrate_bps


async def resolve_output_format(url: str, gain: float = 1.0) -> OutputFormat:
    """Detect the real source codec and decide how ffmpeg should handle it —
    stream-copy when the source is already device-compatible (preserving its
    exact quality/bitrate), lossless re-encode to FLAC for other lossless
    sources, or the existing MP3 192k re-encode as the universal fallback
    when detection fails or the source is something else entirely (never a
    new failure mode, only ever an upgrade when detection succeeds).

    `gain` (ReplayGain, see stream_tracks()'s own docstring) rules out the
    copy tier specifically: stream-copy means ffmpeg never decodes the
    audio at all, and applying a volume adjustment requires exactly that —
    `ffmpeg -af volume=X -acodec copy` fails outright ("Filtering and
    streamcopy cannot be used together"), which meant a ReplayGain-enabled
    track that also happened to qualify for stream-copy never played at
    all. The lossless-reencode tier below is unaffected either way — it
    already decodes+re-encodes to FLAC, so a volume filter fits into that
    same pipeline for free."""
    probed = await _probe_source(url)
    if probed is None:
        return FALLBACK_FORMAT
    codec, bitrate_bps = probed

    muxer = _COPY_MUXER_FOR_CODEC.get(codec)
    if muxer and gain == 1.0:
        return OutputFormat(
            ffmpeg_args=["-acodec", "copy", "-f", muxer],
            content_type=_CONTENT_TYPE_FOR_MUXER[muxer],
            label=f"{codec} (copy)",
            # The source's own bitrate (copy means the output *is* the
            # source) — None if the probe couldn't read one, which
            # stream_tracks() takes as "don't pace this connection" rather
            # than guessing. See that function's own comment for why
            # pacing matters at all for this tier specifically.
            bitrate_bps=bitrate_bps,
        )
    if muxer:
        logger.info(
            f"[ffmpeg] format probe: '{codec}' would copy, but ReplayGain is active "
            "(gain != 1.0) — using mp3 fallback instead, since streamcopy and a volume "
            "filter can't be combined"
        )
        return FALLBACK_FORMAT

    if codec in _LOSSLESS_REENCODE_CODECS:
        return OutputFormat(
            ffmpeg_args=["-acodec", "flac", "-f", "flac"],
            content_type="audio/flac",
            label=f"{codec} → flac",
            # No fixed bitrate to pace against (FLAC is variable, and the
            # real re-encode work below still costs actual CPU time per
            # frame, unlike the copy tier above) — see stream_tracks()'s
            # own comment on why that tier doesn't strictly need this.
            bitrate_bps=None,
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

    Paced to at most LOOKAHEAD_SECONDS ahead of real playback time whenever
    `output_format.bitrate_bps` is known (see that field's own comment for
    which tiers do/don't set it) — without this, ffmpeg (and this loop's own
    unthrottled `read()`) happily produce output as fast as the source can
    be fetched and decoded, not at anything close to real time. That was
    never a problem for the old always-re-encode pipeline this one
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

            # See stream_tracks()'s own pacing comment. Reset per track —
            # each is its own ffmpeg invocation with its own timeline.
            # bytes_produced is tracked regardless of whether bitrate_bps is
            # known, so a mid-track OutputFormat never applies (there isn't
            # one — output_format is fixed for the whole call), keeping
            # this simple; only the throttle decision itself is skippable.
            track_start = time.monotonic()
            bytes_produced = 0
            while True:
                chunk = await proc.stdout.read(8192)
                if not chunk:
                    break
                bytes_produced += len(chunk)
                if fmt.bitrate_bps:
                    produced_seconds = bytes_produced * 8 / fmt.bitrate_bps
                    ahead_by = produced_seconds - (time.monotonic() - track_start)
                    if ahead_by > LOOKAHEAD_SECONDS:
                        await asyncio.sleep(ahead_by - LOOKAHEAD_SECONDS)
                yield chunk

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

        except Exception as e:
            logger.error(f"[ffmpeg] Error on track {i + 1}: {e}", exc_info=True)
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
