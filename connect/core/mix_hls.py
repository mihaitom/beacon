"""core/mix_hls.py - a mix for WebKit's own player, as a live HLS playlist.

WebKit cannot play a stream that declares no length: it fetches 1 MiB
blocks, each with a plain GET from byte 0, and appends them (see
core/hls.py and docs/investigations/phone-and-browser/safari-transcode-jumps-to-start.md). A single
song gets a VOD playlist of its known duration instead. A mix has no
duration at all - its end is only known once it is reached - so it gets
the other kind Apple's own live audio uses: an EVENT playlist, which lists
the run's segments from its first one on, grows by each segment as it is
made, and is closed with EXT-X-ENDLIST when the mix ends. The player seeks
anywhere in what is listed, and the element's clock is the mix's stream
time, which is what the tab's timeline maps to songs.

One encoder per run and quality, fed from the mix's ring from stream time 0
like any listener (core/mix_output.py), its output cut by core/hls.py's
splitters: fragmented MP4, or for mp3 Apple's packed audio.

The playlist keeps listing every segment, as EVENT requires, but only the
ones near the listener are kept: a run can go on for hours, and the tab
never asks for one it has played - every seek, the lock screen's included,
starts a new run (services/playback/localMix.ts). Kept in memory, since
what is held is a few minutes at most.
"""

import asyncio
import contextlib
import logging
import math
from typing import TYPE_CHECKING

from . import hls
from .mix_timeline import SAMPLE_RATE
from .streamer import FLAC_FRAME_SAMPLES

if TYPE_CHECKING:
    from .mix_engine import MixEngine
    from .mix_output import MixConnection

logger = logging.getLogger("connect.mix")

# How far behind the listener segments are still held. The player only
# reads ahead; this is margin for a reconnect that re-reads a little.
_KEEP_BEHIND_SECONDS = 120.0


class MixHls:
    """One run of a mix (`engine`) as HLS, in one encode (`codec_args`)."""

    def __init__(self, engine: "MixEngine", fmt: str, codec_args: list[str]) -> None:
        self.engine = engine
        self.fmt = fmt
        self.codec_args = codec_args
        self.packed = hls.is_packed(fmt)
        # What the encoder outputs, which for opus is not the mix's own rate.
        self._rate = (
            int(codec_args[codec_args.index("-ar") + 1]) if "-ar" in codec_args else SAMPLE_RATE
        )
        frame_samples = hls.frame_samples(fmt, FLAC_FRAME_SAMPLES)
        frames = math.ceil(hls.SEGMENT_TARGET_SECONDS * self._rate / frame_samples)
        self.segment_seconds = frames * frame_samples / self._rate
        self._frames_per_segment = frames
        # Only the segment length is read from it (container_args()).
        layout = hls.SegmentLayout(frames, self.segment_seconds, 0, 0.0)
        self._output_args = [*codec_args, *hls.container_args(layout, self.packed)]
        self._init: bytes | None = None
        self._held: dict[int, bytes] = {}
        self._count = 0
        # Segments before this one have been let go (_let_go_behind()).
        self._first_held = 0
        self.finished = False
        self.failed = False
        self.closed = False
        self._changed = asyncio.Event()
        self._connection: MixConnection | None = None
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    def close(self) -> None:
        self.closed = True
        if self._task is not None:
            self._task.cancel()
        if self._connection is not None:
            self._connection.close()
        self._held.clear()
        self._notify()

    @property
    def segments(self) -> int:
        return self._count

    async def wait_for_segments(self, count: int, timeout: float) -> None:
        """Until `count` segments are made, the encode is over, or `timeout`
        has passed - a playlist with nothing in it yet is no use to hand out."""
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(timeout):
                while self.segments < count and self._running:
                    await self._wait()

    def playlist(self, query: str) -> str:
        """The playlist as far as the mix has got. `query` is appended to
        every URI: the token and session travel as query parameters, which a
        relative URI does not inherit."""
        suffix = f"?{query}" if query else ""
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            f"#EXT-X-TARGETDURATION:{math.ceil(self.segment_seconds)}",
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXT-X-PLAYLIST-TYPE:EVENT",
            "#EXT-X-INDEPENDENT-SEGMENTS",
        ]
        if not self.packed:
            lines.append(f'#EXT-X-MAP:URI="init.mp4{suffix}"')
        extension = hls.segment_extension(self.packed)
        for index in range(self.segments):
            lines += [f"#EXTINF:{self._duration(index):.6f},", f"{index}.{extension}{suffix}"]
        if self.finished:
            lines.append("#EXT-X-ENDLIST")
        return "\n".join(lines) + "\n"

    async def init_segment(self) -> bytes | None:
        while self._init is None:
            if not self._running:
                return None
            await self._wait()
        return self._init

    async def segment(self, index: int) -> bytes | None:
        """Segment `index`, waiting for the encoder to reach it. None for one
        the run never produces, or one let go long behind the listener."""
        while index >= self.segments:
            if not self._running or index < 0:
                return None
            await self._wait()
        if index < 0 or self.closed:
            return None
        self._let_go_behind()
        return self._held.get(index)

    @property
    def _running(self) -> bool:
        return not (self.finished or self.failed or self.closed)

    def _duration(self, index: int) -> float:
        """Every segment holds the same whole frames but the last of a mix
        that has ended, which holds what was left."""
        if self.finished and index == self.segments - 1:
            end = self.engine.end_stream_time
            if end is not None:
                rest = end - index * self.segment_seconds
                if 0 < rest < self.segment_seconds:
                    return rest
        return self.segment_seconds

    async def _wait(self) -> None:
        changed = self._changed
        await changed.wait()

    def _notify(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    def _take(self, init: bytes | None, segments: list[bytes]) -> None:
        if init is not None:
            self._init = init
        for segment in segments:
            self._held[self._count] = segment
            self._count += 1
        self._let_go_behind()
        if init is not None or segments:
            self._notify()

    def _let_go_behind(self) -> None:
        heard = self.engine.wall_time
        if heard is None:
            return
        keep_from = int(max(heard - _KEEP_BEHIND_SECONDS, 0.0) // self.segment_seconds)
        while self._first_held < min(keep_from, self._count):
            self._held.pop(self._first_held, None)
            self._first_held += 1

    async def _run(self) -> None:
        splitter = (
            hls.Mp3Packer(self._frames_per_segment, self._rate)
            if self.packed
            else hls.Fmp4Splitter()
        )
        try:
            # Not a listener a tab is waiting on: the run is kept alive by
            # the tab asking about it, not by this encode (core/local_mixes.py).
            self._connection = await self.engine.connect(0.0, self._output_args, counted=False)
            async for chunk in self._connection.chunks():
                self._take(*splitter.feed(chunk))
            self._take(None, splitter.flush())
            if self.engine.ended:
                self.finished = True
            elif not self.closed:
                self.failed = True
                logger.warning(f"[mix-hls] {self.engine.epoch} encode ended before the mix")
        except asyncio.CancelledError:
            raise
        except Exception:
            self.failed = True
            logger.exception(f"[mix-hls] {self.engine.epoch} encode failed")
        finally:
            self._notify()
