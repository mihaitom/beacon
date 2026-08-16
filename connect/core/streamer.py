"""core/streamer.py — FFmpeg Audio Stream Engine"""

import asyncio
import logging
import re
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

_PROBE_TIMEOUT = 10.0
_AUDIO_STREAM_RE = re.compile(rb"Stream #\d+:\d+.*?Audio:\s*([a-zA-Z0-9_]+)")


@dataclass
class OutputFormat:
    """What ffmpeg should do with a source, and what the result actually is —
    the single source of truth both `/stream`'s Content-Type header and each
    delivery's device-facing metadata (DIDL protocolInfo, Cast content_type)
    read from, so they can never disagree with what stream_tracks() sends."""

    ffmpeg_args: list[str] = field(default_factory=lambda: list(_FALLBACK_ARGS))
    content_type: str = _FALLBACK_CONTENT_TYPE
    label: str = "mp3-192k (fallback)"


FALLBACK_FORMAT = OutputFormat()


async def _probe_source_codec(url: str) -> str | None:
    """Return the source's audio codec name, or None if detection fails.

    Uses `ffmpeg -i <url>` itself rather than a separate `ffprobe` call —
    ffmpeg -i with no output target still fully parses and prints the
    input's stream info (`Stream #0:0: Audio: flac, 96000 Hz, ...`) to
    stderr before exiting non-zero, which is enough to read the codec name
    off of. The Docker image's custom minimal ffmpeg build only ships the
    one `ffmpeg` binary (see Dockerfile) — adding a second, similarly-sized
    static ffprobe binary just for this lookup isn't worth it.
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
    return match.group(1).decode()


async def resolve_output_format(url: str) -> OutputFormat:
    """Detect the real source codec and decide how ffmpeg should handle it —
    stream-copy when the source is already device-compatible (preserving its
    exact quality/bitrate), lossless re-encode to FLAC for other lossless
    sources, or the existing MP3 192k re-encode as the universal fallback
    when detection fails or the source is something else entirely (never a
    new failure mode, only ever an upgrade when detection succeeds)."""
    codec = await _probe_source_codec(url)
    if codec is None:
        return FALLBACK_FORMAT

    muxer = _COPY_MUXER_FOR_CODEC.get(codec)
    if muxer:
        return OutputFormat(
            ffmpeg_args=["-acodec", "copy", "-f", muxer],
            content_type=_CONTENT_TYPE_FOR_MUXER[muxer],
            label=f"{codec} (copy)",
        )

    if codec in _LOSSLESS_REENCODE_CODECS:
        return OutputFormat(
            ffmpeg_args=["-acodec", "flac", "-f", "flac"],
            content_type="audio/flac",
            label=f"{codec} → flac",
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
) -> AsyncGenerator[bytes, None]:
    """Yield continuous audio bytes for all tracks in sequence, encoded per
    `output_format` (defaults to the MP3 192k fallback — see resolve_output_format()).

    Calls on_track_start(relative_index) before each track begins.
    start_offset seeks the first track to that many seconds in (e.g. after pause/resume).
    gain is a linear amplitude multiplier (ReplayGain), applied via ffmpeg's
    `volume` filter — 1.0 (the default) leaves the audio unchanged.
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
        logger.info(
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

            while True:
                chunk = await proc.stdout.read(8192)
                if not chunk:
                    break
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
