"""core/streamer.py — FFmpeg Audio Stream Engine"""

import asyncio
import logging
from collections.abc import AsyncGenerator, Callable

logger = logging.getLogger("connect.streamer")

_FFMPEG_CMD = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "warning",  # warning so codec/format issues surface in logs
    "-i",
    "{url}",
    "-vn",
    "-acodec",
    "libmp3lame",
    "-ab",
    "192k",
    "-ar",
    "44100",
    "-f",
    "mp3",
    "pipe:1",
]


async def stream_tracks(
    track_urls: list[str],
    on_track_start: Callable[[int], None] | None = None,
    start_offset: float = 0.0,
    gain: float = 1.0,
) -> AsyncGenerator[bytes, None]:
    """Yield continuous MP3 bytes for all tracks in sequence.

    Calls on_track_start(relative_index) before each track begins.
    start_offset seeks the first track to that many seconds in (e.g. after pause/resume).
    gain is a linear amplitude multiplier (ReplayGain), applied via ffmpeg's
    `volume` filter — 1.0 (the default) leaves the audio unchanged.
    """
    if not track_urls:
        return

    for i, url in enumerate(track_urls):
        if on_track_start:
            on_track_start(i)

        cmd = [arg if arg != "{url}" else url for arg in _FFMPEG_CMD]
        if i == 0 and start_offset > 0.5:
            # Insert -ss before -i for fast input-side seeking on the resumed track
            i_pos = cmd.index("-i")
            cmd = cmd[:i_pos] + ["-ss", f"{start_offset:.3f}"] + cmd[i_pos:]
        if gain != 1.0:
            i_pos = cmd.index("-vn")
            cmd = cmd[:i_pos] + ["-af", f"volume={gain}"] + cmd[i_pos:]
        logger.info(f"[ffmpeg] Track {i + 1}/{len(track_urls)}: {url[:80]}")
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
