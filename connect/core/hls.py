"""core/hls.py - a transcode for Beacon's own player, cut into HLS segments.

Why this exists at all: WebKit cannot play a transcode served the way
routes/local_stream.py serves it to every other browser, as one response
with no length. Safari fetches media in blocks of about 1 MiB, and on a
response that declares no length (or answers its `bytes=0-1` probe with
`bytes 0-1/*`) it fetches each next block with a plain GET from byte 0 and
appends it - so a song jumps back to its start every ~45 seconds. Only a
known total length made it play through, and nothing knows that length for
aac, opus or flac before the encode has finished. The whole investigation,
including what was ruled out, is docs/investigations/safari-transcode-jumps.md.

HLS is WebKit's own answer: a playlist whose length is known up front (the
track's duration) and segments whose sizes nobody has to predict.

One ffmpeg per stream, its fragmented-MP4 output split at the fragment
boundaries, rather than one ffmpeg per segment: independent encodes of
neighbouring segments do not join without a click, a single encode joins
by construction. mp3 is the exception to the container - iOS refuses mp3 in
fMP4 ("Media failed to decode", measured on iOS 18.7), so it is sent as
Apple's "packed audio": raw frames per segment, behind an ID3 tag carrying
the segment's timestamp.

Segments are spooled to a temporary file rather than kept in memory: Safari
fetches the whole track as fast as it is encoded (measured on a LAN), and a
lossless rescue of a long hi-res source is hundreds of MB.
"""

import asyncio
import logging
import math
import struct
import tempfile
import time
from collections.abc import Callable, Hashable
from dataclasses import dataclass

logger = logging.getLogger("connect.streamer")

# About the segment length Apple recommends. Rounded up to whole encoder
# frames (see SegmentLayout), so every segment but the last holds exactly
# the same number of samples and its duration is known before it exists.
SEGMENT_TARGET_SECONDS = 6.0

# How long an encode nobody asks for anything stays around. Safari has
# usually fetched every segment long before; a request after this simply
# encodes again, into the same bytes.
IDLE_SECONDS = 300.0

# Samples per frame of each encoder this module cuts. flac's is set on the
# command line (core/streamer.py's FLAC_FRAME_SAMPLES), the others are the
# encoders' fixed frame sizes.
_FRAME_SAMPLES = {"aac": 1024, "mp3": 1152, "opus": 960}

# Where mp3's frame size and packed-audio segments come from. Only MPEG-1
# Layer III, which is all core/streamer.py's mp3 sample rates produce.
_MP3_BITRATES_KBPS = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
_MP3_SAMPLE_RATES = (44100, 48000, 32000)


def frame_samples(fmt: str, flac_frame_samples: int) -> int:
    return flac_frame_samples if fmt == "flac" else _FRAME_SAMPLES[fmt]


def is_packed(fmt: str) -> bool:
    return fmt == "mp3"


@dataclass(frozen=True)
class SegmentLayout:
    """How a stream of `remaining` seconds is cut into segments."""

    frames_per_segment: int
    segment_seconds: float
    count: int
    last_seconds: float

    @property
    def target_duration(self) -> int:
        return math.ceil(max(self.segment_seconds, self.last_seconds))


def segment_layout(remaining: float, sample_rate: int, frame_samples: int) -> SegmentLayout:
    """Whole frames per segment, and a count that tolerates a source a little
    shorter than its reported duration.

    The last listed segment is everything the encode produces from its start
    on (see Encode.segment()), so the playlist may list one segment fewer
    than the encode makes but never one more: rounding the count half a
    segment down leaves that much slack for a duration that was reported
    long. Without it, a source a frame shorter than its duration said would
    end on a segment that never comes."""
    frames = math.ceil(SEGMENT_TARGET_SECONDS * sample_rate / frame_samples)
    seconds = frames * frame_samples / sample_rate
    count = max(1, math.ceil(remaining / seconds - 0.5))
    last = max(0.0, remaining - (count - 1) * seconds)
    return SegmentLayout(frames, seconds, count, last)


def playlist(layout: SegmentLayout, packed: bool, query: str) -> str:
    """The media playlist. `query` is appended to every URI, because the
    token and session travel as query parameters (see streamUrl() in
    services/subsonic/client.ts) and a relative URI does not inherit them."""
    suffix = f"?{query}" if query else ""
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        f"#EXT-X-TARGETDURATION:{layout.target_duration}",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-INDEPENDENT-SEGMENTS",
    ]
    if not packed:
        lines.append(f'#EXT-X-MAP:URI="init.mp4{suffix}"')
    extension = segment_extension(packed)
    for index in range(layout.count):
        seconds = layout.last_seconds if index == layout.count - 1 else layout.segment_seconds
        lines += [f"#EXTINF:{seconds:.6f},", f"{index}.{extension}{suffix}"]
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


def segment_extension(packed: bool) -> str:
    return "mp3" if packed else "m4s"


def container_args(layout: SegmentLayout, packed: bool) -> list[str]:
    """ffmpeg output arguments for the stream Encode splits."""
    if packed:
        # Nothing but frames: a Xing frame or an ID3 tag would land in the
        # first segment as bytes that are not audio.
        return ["-f", "mp3", "-write_xing", "0", "-id3v2_version", "0", "-write_id3v1", "0"]
    return [
        "-f",
        "mp4",
        "-movflags",
        "+empty_moov+default_base_moof+skip_trailer",
        # A fragment is closed once it reaches this duration, so a value just
        # under a whole-frame segment closes each one after exactly
        # frames_per_segment frames.
        "-frag_duration",
        str(math.floor(layout.segment_seconds * 1_000_000)),
    ]


def id3_timestamp(pts_90khz: int) -> bytes:
    """The ID3 tag a packed-audio segment starts with: its first sample's
    time, as the 33-bit MPEG-TS timestamp Apple's HLS spec asks for."""
    owner = b"com.apple.streaming.transportStreamTimestamp\x00"
    data = owner + struct.pack(">Q", pts_90khz & ((1 << 33) - 1))
    # Sizes below 128 read the same as ID3's syncsafe integers.
    frame = b"PRIV" + struct.pack(">I", len(data)) + b"\x00\x00" + data
    return b"ID3\x04\x00\x00" + struct.pack(">I", len(frame)) + frame


class Fmp4Splitter:
    """Cuts a fragmented MP4 byte stream into its init segment (ftyp + moov)
    and one media segment per moof + mdat pair."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._ftyp = b""
        self._moof = b""

    def feed(self, data: bytes) -> tuple[bytes | None, list[bytes]]:
        self._buffer += data
        init = None
        segments = []
        while len(self._buffer) >= 8:
            size, kind = struct.unpack(">I4s", self._buffer[:8])
            if size == 1:
                if len(self._buffer) < 16:
                    break
                size = struct.unpack(">Q", self._buffer[8:16])[0]
            if size < 8:
                raise ValueError(f"malformed MP4 box {kind!r} of size {size}")
            if len(self._buffer) < size:
                break
            box = bytes(self._buffer[:size])
            del self._buffer[:size]
            if kind == b"ftyp":
                self._ftyp = box
            elif kind == b"moov":
                init = self._ftyp + box
            elif kind == b"moof":
                self._moof = box
            elif kind == b"mdat":
                segments.append(self._moof + box)
                self._moof = b""
        return init, segments

    def flush(self) -> list[bytes]:
        return []


class Mp3Packer:
    """Groups an MPEG-1 Layer III byte stream into packed-audio segments of
    `frames_per_segment` frames each."""

    def __init__(self, frames_per_segment: int, sample_rate: int) -> None:
        self._frames_per_segment = frames_per_segment
        self._sample_rate = sample_rate
        self._buffer = bytearray()
        self._frames: list[bytes] = []
        self._frames_before = 0

    def feed(self, data: bytes) -> tuple[None, list[bytes]]:
        self._buffer += data
        segments = []
        while len(self._buffer) >= 4:
            length = self._frame_length(struct.unpack(">I", self._buffer[:4])[0])
            if length is None:
                raise ValueError("mp3 stream lost frame sync")
            if len(self._buffer) < length:
                break
            self._frames.append(bytes(self._buffer[:length]))
            del self._buffer[:length]
            if len(self._frames) == self._frames_per_segment:
                segments.append(self._segment())
        return None, segments

    def flush(self) -> list[bytes]:
        return [self._segment()] if self._frames else []

    def _segment(self) -> bytes:
        pts = round(self._frames_before * _FRAME_SAMPLES["mp3"] * 90000 / self._sample_rate)
        body = b"".join(self._frames)
        self._frames_before += len(self._frames)
        self._frames = []
        return id3_timestamp(pts) + body

    @staticmethod
    def _frame_length(header: int) -> int | None:
        version, layer = (header >> 19) & 0b11, (header >> 17) & 0b11
        bitrate_index, rate_index = (header >> 12) & 0xF, (header >> 10) & 0b11
        if header >> 21 != 0x7FF or version != 0b11 or layer != 0b01:
            return None
        if bitrate_index in (0, 15) or rate_index == 3:
            return None
        bitrate = _MP3_BITRATES_KBPS[bitrate_index] * 1000
        return 144 * bitrate // _MP3_SAMPLE_RATES[rate_index] + ((header >> 9) & 1)


class Encode:
    """One running (or finished) transcode and the segments it has produced."""

    def __init__(self, cmd: list[str], layout: SegmentLayout, packed: bool, sample_rate: int):
        self.cmd = cmd
        self.layout = layout
        self.packed = packed
        self._sample_rate = sample_rate
        self._init: bytes | None = None
        # Lives as long as the encode and is closed by close(); deleted by the
        # OS even if the process dies first.
        self._spool = tempfile.TemporaryFile()  # noqa: SIM115
        self._offsets: list[tuple[int, int]] = []
        self._size = 0
        self._task: asyncio.Task | None = None
        self._finished = False
        self.failed = False
        self._closed = False
        self._changed = asyncio.Event()
        self.touched_at = time.monotonic()

    def touch(self) -> None:
        self.touched_at = time.monotonic()

    async def init_segment(self) -> bytes | None:
        """The fMP4 init segment, once the encoder has written it."""
        while self._init is None:
            if not await self._wait():
                return None
        return self._init

    async def segment(self, index: int) -> bytes | None:
        """Segment `index`, waiting for the encoder to reach it. None when
        the encode ended without producing it."""
        if not 0 <= index < self.layout.count:
            return None
        last = index == self.layout.count - 1
        while True:
            self.touch()
            if last and self._finished:
                return self._read(index, len(self._offsets)) or None
            if not last and index < len(self._offsets):
                return self._read(index, index + 1)
            if not await self._wait():
                return None

    def start(self) -> None:
        """Starts encoding ahead of the first request for a segment."""
        if self._task is None and not (self._finished or self.failed or self._closed):
            self._task = asyncio.create_task(self._run())

    def close(self) -> None:
        """Stops the encoder and deletes the spool. A request still waiting
        is answered with nothing."""
        self._closed = True
        if self._task is not None:
            self._task.cancel()
            self._task = None
        self._spool.close()
        self._notify()

    async def _wait(self) -> bool:
        """Starts the encoder if nothing is producing, then waits for its
        next segment. False once there is nothing more to wait for."""
        if self._finished or self.failed or self._closed:
            return False
        self.start()
        changed = self._changed
        await changed.wait()
        return True

    def _notify(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    def _read(self, first: int, end: int) -> bytes:
        parts = []
        for offset, length in self._offsets[first:end]:
            self._spool.seek(offset)
            parts.append(self._spool.read(length))
        return b"".join(parts)

    def _append(self, segment: bytes) -> None:
        self._spool.seek(self._size)
        self._spool.write(segment)
        self._offsets.append((self._size, len(segment)))
        self._size += len(segment)

    async def _run(self) -> None:
        splitter = (
            Mp3Packer(self.layout.frames_per_segment, self._sample_rate)
            if self.packed
            else Fmp4Splitter()
        )
        proc = None
        stderr_task = None

        def take(init: bytes | None, segments: list[bytes]) -> None:
            if init is not None:
                self._init = init
            for segment in segments:
                self._append(segment)
            if init is not None or segments:
                self._notify()

        try:
            proc = await asyncio.create_subprocess_exec(
                *self.cmd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            # Drained alongside, or a full stderr pipe stalls the encode.
            stderr_task = asyncio.create_task(proc.stderr.read())
            while chunk := await proc.stdout.read(65536):
                take(*splitter.feed(chunk))
            take(None, splitter.flush())
            returncode = await proc.wait()
            stderr = await stderr_task
            if returncode == 0:
                self._finished = True
            else:
                self.failed = True
                logger.warning(
                    f"[local-hls] ffmpeg exit {returncode}: {stderr.decode(errors='replace')[:400]}"
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            self.failed = True
            logger.exception("[local-hls] encode failed")
        finally:
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            if stderr_task is not None and not stderr_task.done():
                stderr_task.cancel()
            self._task = None
            self._notify()


class EncodeRegistry:
    """The encodes currently kept, by whatever identifies a stream."""

    def __init__(self) -> None:
        self._encodes: dict[Hashable, Encode] = {}

    def get(self, key: Hashable) -> Encode | None:
        self._sweep()
        encode = self._encodes.get(key)
        if encode is None or encode.failed:
            return None
        encode.touch()
        return encode

    def add(self, key: Hashable, encode: Encode, supersedes: Callable[[Hashable], bool]) -> Encode:
        """Keeps `encode` under `key`, closing every encode whose key
        `supersedes` matches - the same track from another position, after a
        seek. A player that did still want one gets it encoded again: the
        same command produces the same bytes."""
        self._sweep()
        for other_key in [k for k in self._encodes if k == key or supersedes(k)]:
            self._encodes.pop(other_key).close()
        self._encodes[key] = encode
        return encode

    def clear(self) -> None:
        for encode in self._encodes.values():
            encode.close()
        self._encodes.clear()

    def _sweep(self) -> None:
        now = time.monotonic()
        for key, encode in list(self._encodes.items()):
            if now - encode.touched_at > IDLE_SECONDS:
                encode.close()
                del self._encodes[key]
