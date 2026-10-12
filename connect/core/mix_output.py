"""core/mix_output.py — the rendered mix, and every listener's encode of it.

The mix engine renders raw PCM into a `PcmRing`, indexed by stream time.
Each listener - a speaker, a browser tab - gets a `MixConnection`: its own
encoder, fed from the ring from whatever stream time it starts at. One
encoder per listener rather than one per mix, so each device gets the codec
it can play, and a device that reconnects (or joins a room later) is served
from the ring rather than restarting anything.

The ring holds what is rendered ahead of the wall clock plus a stretch
behind it; the engine paces it (see core/mix_engine.py), so a connection
can simply write whatever the ring holds the moment it has it. What it
writes up front is the device's head start, the same 15 seconds a cast
track's -readrate_initial_burst gives (core/streamer.py).
"""

import asyncio
import logging
from collections.abc import AsyncIterator

from .ffmpeg import FFMPEG_BIN
from .mix_timeline import SAMPLE_RATE

logger = logging.getLogger("connect.mix")

# s16le, stereo.
FRAME_BYTES = 4
# Frames handed to an encoder per write: small enough that a slow encoder
# is noticed early, large enough not to cost a wakeup per few milliseconds.
_WRITE_FRAMES = SAMPLE_RATE // 10
_READ_BYTES = 8192


class PcmRing:
    """Rendered PCM by stream frame. `base` is the frame of the oldest byte
    still held, `head` one past the newest."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self.base = 0
        self.head = 0
        self.closed = False
        self._changed = asyncio.Event()

    def append(self, pcm: bytes) -> None:
        if self.closed:
            raise RuntimeError("append to a closed ring")
        self._buf += pcm
        self.head += len(pcm) // FRAME_BYTES
        self._notify()

    def close(self) -> None:
        """No more audio is coming: the mix has ended (or was stopped)."""
        self.closed = True
        self._notify()

    def read(self, frame: int, max_frames: int) -> bytes:
        """Up to `max_frames` from `frame` on. A frame already dropped from
        the ring reads as the oldest one held, see clamp()."""
        frame = self.clamp(frame)
        start = (frame - self.base) * FRAME_BYTES
        end = min(len(self._buf), start + max_frames * FRAME_BYTES)
        return bytes(self._buf[start:end])

    def clamp(self, frame: int) -> int:
        return min(max(frame, self.base), self.head)

    def trim(self, keep_from: int) -> None:
        """Drop everything before `keep_from`."""
        keep_from = min(keep_from, self.head)
        if keep_from <= self.base:
            return
        del self._buf[: (keep_from - self.base) * FRAME_BYTES]
        self.base = keep_from

    async def wait_beyond(self, frame: int) -> None:
        """Until something past `frame` is held, or the ring closes."""
        while self.head <= frame and not self.closed:
            await self._changed.wait()

    def _notify(self) -> None:
        changed, self._changed = self._changed, asyncio.Event()
        changed.set()


def encoder_cmd(output_args: list[str]) -> list[str]:
    """One listener's encoder: the ring's PCM in, `output_args` (a codec and
    a container, see core/streamer.py's resolve_mix_format()) out."""
    return [
        FFMPEG_BIN,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-f",
        "s16le",
        "-ar",
        str(SAMPLE_RATE),
        "-ac",
        "2",
        "-i",
        "pipe:0",
        *output_args,
        "-flush_packets",
        "1",
        "pipe:1",
    ]


class MixConnection:
    """One listener's encode of the ring from `start_frame` on. Iterate it
    for the encoded bytes; it ends when the mix has ended and everything
    was encoded, or when closed."""

    def __init__(self, ring: PcmRing, start_frame: int, output_args: list[str]) -> None:
        self._ring = ring
        self.start_frame = ring.clamp(start_frame)
        self.fed_frame = self.start_frame
        self._output_args = output_args
        self._proc: asyncio.subprocess.Process | None = None
        self._feeder: asyncio.Task | None = None
        self.closed = False
        # Whether it counts as somebody listening (MixEngine.listeners).
        self.counted = True

    async def open(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            *encoder_cmd(self._output_args),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._feeder = asyncio.create_task(self._feed())

    async def _feed(self) -> None:
        assert self._proc is not None and self._proc.stdin is not None
        stdin = self._proc.stdin
        try:
            while not self.closed:
                pcm = self._ring.read(self.fed_frame, _WRITE_FRAMES)
                if pcm:
                    stdin.write(pcm)
                    await stdin.drain()
                    self.fed_frame += len(pcm) // FRAME_BYTES
                    continue
                if self._ring.closed:
                    break
                await self._ring.wait_beyond(self.fed_frame)
        except (BrokenPipeError, ConnectionResetError):
            return
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"[mix] feeding an encoder failed: {e}")
            return
        finally:
            if not stdin.is_closing():
                stdin.close()

    async def chunks(self) -> AsyncIterator[bytes]:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            while True:
                chunk = await self._proc.stdout.read(_READ_BYTES)
                if not chunk:
                    return
                yield chunk
        finally:
            self.close()

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self._feeder is not None and not self._feeder.done():
            self._feeder.cancel()
        if self._proc is not None and self._proc.returncode is None:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass
