"""Tests for core/hls.py - a transcode cut into HLS segments for WebKit.

What has to hold: the playlist promises durations before a single byte is
encoded, so every segment but the last must contain exactly the samples it
was promised, and the last one must exist however the encode ends. And an
encode made again for the same stream must hand out the same bytes.
"""

import asyncio
import shutil
import struct
import subprocess
import wave
from unittest.mock import AsyncMock, patch

import pytest

from core import hls
from core.streamer import FLAC_FRAME_SAMPLES, lossless_codec_args, lossy_codec_args


def _box(kind: bytes, payload: bytes = b"") -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


# ── Layout and playlist ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("rate", "frame"), [(44100, 1024), (48000, 1024), (44100, 1152), (48000, 960), (96000, 4096)]
)
def test_a_segment_is_a_whole_number_of_frames(rate, frame):
    layout = hls.segment_layout(200.0, rate, frame)

    assert layout.segment_seconds == layout.frames_per_segment * frame / rate
    assert layout.segment_seconds >= hls.SEGMENT_TARGET_SECONDS


@pytest.mark.parametrize("remaining", [0.5, 5.9, 6.1, 9.0, 12.03, 180.0, 283.956, 3600.0])
def test_the_listed_durations_add_up_to_the_stream(remaining):
    layout = hls.segment_layout(remaining, 44100, 1024)

    total = (layout.count - 1) * layout.segment_seconds + layout.last_seconds
    assert total == pytest.approx(remaining)
    assert layout.last_seconds <= layout.target_duration


@pytest.mark.parametrize("remaining", [6.1, 30.0, 180.0, 283.956])
@pytest.mark.parametrize("short_by_segments", [0.0, 0.25, 0.49])
def test_a_source_shorter_than_reported_still_reaches_the_last_listed_segment(
    remaining, short_by_segments
):
    """The encode makes one segment per started segment length of audio it
    really has. The playlist must never list more than that."""
    layout = hls.segment_layout(remaining, 44100, 1024)
    actual = remaining - short_by_segments * layout.segment_seconds

    produced = -(-actual // layout.segment_seconds)
    assert produced >= layout.count


def test_the_playlist_carries_the_query_on_every_uri():
    layout = hls.segment_layout(20.0, 44100, 1024)

    text = hls.playlist(layout, packed=False, query="token=t&session=s&fmt=aac")

    uris = [line for line in text.splitlines() if line and not line.startswith("#EXTINF")]
    assert '#EXT-X-MAP:URI="init.mp4?token=t&session=s&fmt=aac"' in uris
    segments = [uri for uri in uris if not uri.startswith("#")]
    assert segments == [f"{i}.m4s?token=t&session=s&fmt=aac" for i in range(layout.count)]
    assert text.rstrip().endswith("#EXT-X-ENDLIST")


def test_a_packed_playlist_has_no_init_segment():
    text = hls.playlist(hls.segment_layout(20.0, 44100, 1152), packed=True, query="q=1")

    assert "EXT-X-MAP" not in text
    assert "0.mp3?q=1" in text


def test_every_listed_duration_fits_the_target_duration():
    layout = hls.segment_layout(100.0, 44100, 1024)
    text = hls.playlist(layout, packed=False, query="")

    target = int(text.split("#EXT-X-TARGETDURATION:")[1].splitlines()[0])
    durations = [
        float(line[8:].rstrip(",")) for line in text.splitlines() if line.startswith("#EXTINF:")
    ]
    assert len(durations) == layout.count
    assert max(round(d) for d in durations) <= target


# ── Splitting ffmpeg's output ───────────────────────────────────────────────


def test_fmp4_is_split_into_an_init_and_one_segment_per_fragment():
    ftyp, moov = _box(b"ftyp", b"iso6"), _box(b"moov", b"m" * 20)
    fragments = [_box(b"moof", bytes([i]) * 10) + _box(b"mdat", bytes([i]) * 30) for i in range(3)]
    stream = ftyp + moov + b"".join(fragments)
    splitter = hls.Fmp4Splitter()

    init, segments = None, []
    for i in range(0, len(stream), 7):
        got_init, got = splitter.feed(stream[i : i + 7])
        init = init or got_init
        segments += got

    assert init == ftyp + moov
    assert segments == fragments


def _mp3_frame(fill: int) -> bytes:
    # MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding: 417 bytes.
    return bytes.fromhex("fffb9064") + bytes([fill]) * 413


def _id3_pts(segment: bytes) -> int:
    assert segment[:3] == b"ID3"
    tag_size = struct.unpack(">I", segment[6:10])[0]
    return struct.unpack(">Q", segment[10 + tag_size - 8 : 10 + tag_size])[0]


def test_mp3_is_packed_into_frames_per_segment_behind_their_timestamp():
    frames = [_mp3_frame(i) for i in range(7)]
    packer = hls.Mp3Packer(frames_per_segment=3, sample_rate=44100)

    segments = []
    stream = b"".join(frames)
    for i in range(0, len(stream), 100):
        segments += packer.feed(stream[i : i + 100])[1]
    segments += packer.flush()

    assert len(segments) == 3
    assert [_id3_pts(s) for s in segments] == [
        0,
        round(3 * 1152 * 90000 / 44100),
        round(6 * 1152 * 90000 / 44100),
    ]
    tag = len(hls.id3_timestamp(0))
    assert [s[tag:] for s in segments] == [b"".join(frames[0:3]), b"".join(frames[3:6]), frames[6]]


def test_an_mp3_stream_that_loses_sync_is_an_error():
    packer = hls.Mp3Packer(frames_per_segment=3, sample_rate=44100)

    with pytest.raises(ValueError):
        packer.feed(b"\x00" * 10)


# ── Encode ──────────────────────────────────────────────────────────────────


class _Proc:
    """An ffmpeg whose stdout is fed by the test."""

    def __init__(self, returncode: int = 0):
        self.queue: asyncio.Queue[bytes] = asyncio.Queue()
        self.returncode = None
        self._exit = returncode
        self.killed = False
        self.stdout = self
        self.stderr = AsyncMock()
        self.stderr.read = AsyncMock(return_value=b"boom")

    async def read(self, _n: int) -> bytes:
        return await self.queue.get()

    async def wait(self) -> int:
        self.returncode = self._exit
        return self._exit

    def kill(self):
        self.killed = True
        self.returncode = -9


def _fmp4(fragments: int, start: int = 0) -> list[bytes]:
    chunks = [] if start else [_box(b"ftyp") + _box(b"moov")]
    return chunks + [
        _box(b"moof", bytes([i])) + _box(b"mdat", bytes([i]) * 4) for i in range(start, fragments)
    ]


class _Spawner:
    def __init__(self, returncode: int = 0):
        self.procs: list[_Proc] = []
        self.returncode = returncode

    async def __call__(self, *cmd, **kwargs):
        self.procs.append(_Proc(self.returncode))
        return self.procs[-1]


async def _within(awaitable, seconds: float = 2.0):
    """Awaits with a deadline, so an encode that never answers fails the test
    instead of hanging the suite."""
    return await asyncio.wait_for(awaitable, seconds)


async def _settle():
    for _ in range(20):
        await asyncio.sleep(0)


def _encode(count_seconds: float = 18.0) -> hls.Encode:
    layout = hls.segment_layout(count_seconds, 44100, 1024)
    return hls.Encode(["ffmpeg"], layout, packed=False, sample_rate=44100)


async def test_a_segment_is_answered_once_the_encoder_reaches_it():
    spawner = _Spawner()
    encode = _encode()
    with patch("asyncio.create_subprocess_exec", spawner):
        pending = asyncio.create_task(encode.segment(1))
        await _settle()
        assert not pending.done()

        chunks = _fmp4(2)
        spawner.procs[0].queue.put_nowait(chunks[0] + chunks[1])
        await _settle()
        assert not pending.done()
        spawner.procs[0].queue.put_nowait(chunks[2])

        assert await _within(pending) == chunks[2]
    encode.close()


async def test_the_last_segment_is_everything_the_encode_made_from_there_on():
    """A source a little longer than reported makes one fragment more than
    the playlist lists; it must not be lost."""
    spawner = _Spawner()
    encode = _encode(18.0)
    assert encode.layout.count == 3
    chunks = _fmp4(4)
    with patch("asyncio.create_subprocess_exec", spawner):
        pending = asyncio.create_task(encode.segment(2))
        await _settle()
        for chunk in [*chunks, b""]:
            spawner.procs[0].queue.put_nowait(chunk)

        assert await _within(pending) == chunks[3] + chunks[4]
        assert await _within(encode.init_segment()) == chunks[0]
    encode.close()


async def test_a_segment_the_encode_never_made_is_none():
    spawner = _Spawner()
    encode = _encode(18.0)
    chunks = _fmp4(1)
    with patch("asyncio.create_subprocess_exec", spawner):
        pending = asyncio.create_task(encode.segment(1))
        await _settle()
        for chunk in [*chunks, b""]:
            spawner.procs[0].queue.put_nowait(chunk)

        assert await _within(pending) is None
        assert await _within(encode.segment(2)) is None
        assert await encode.segment(99) is None
    encode.close()


async def test_a_closed_encode_answers_a_waiting_request_with_nothing_and_stays_closed():
    """A seek closes the encode it replaced while the old element may still
    have a request out; that request must not start the encode again."""
    spawner = _Spawner()
    encode = _encode(30.0)
    with patch("asyncio.create_subprocess_exec", spawner):
        pending = asyncio.create_task(encode.segment(2))
        await _settle()

        encode.close()

        assert await _within(pending) is None
        assert spawner.procs[0].killed
        assert await _within(encode.segment(0)) is None
        await _settle()
        assert len(spawner.procs) == 1


async def test_a_failed_encode_answers_nothing():
    spawner = _Spawner(returncode=1)
    encode = _encode()
    with patch("asyncio.create_subprocess_exec", spawner):
        pending = asyncio.create_task(encode.segment(0))
        await _settle()
        spawner.procs[0].queue.put_nowait(b"")

        assert await _within(pending) is None
        assert encode.failed
    encode.close()


# ── Registry ────────────────────────────────────────────────────────────────


async def test_a_new_encode_closes_the_ones_it_supersedes():
    spawner = _Spawner()
    registry = hls.EncodeRegistry()
    with patch("asyncio.create_subprocess_exec", spawner):
        old = registry.add(("s", "track", 0.0), _encode(), supersedes=lambda key: False)
        other = registry.add(("s", "other", 0.0), _encode(), supersedes=lambda key: False)
        old.start()
        other.start()
        await _settle()

        registry.add(
            ("s", "track", 60.0), _encode(), supersedes=lambda key: key[:2] == ("s", "track")
        )
        await _settle()

        assert spawner.procs[0].killed
        assert not spawner.procs[1].killed
        assert registry.get(("s", "track", 0.0)) is None
        assert registry.get(("s", "other", 0.0)) is other
    registry.clear()


async def test_a_failed_encode_is_not_handed_out_again():
    registry = hls.EncodeRegistry()
    encode = registry.add("key", _encode(), supersedes=lambda key: False)
    encode.failed = True

    assert registry.get("key") is None
    registry.clear()


async def test_an_idle_encode_is_closed():
    registry = hls.EncodeRegistry()
    encode = registry.add("key", _encode(), supersedes=lambda key: False)
    encode.touched_at -= hls.IDLE_SECONDS + 1

    assert registry.get("key") is None
    assert encode._spool.closed


# ── Against a real ffmpeg ───────────────────────────────────────────────────


def _write_noise_wav(path, seconds: float, rate: int = 44100) -> None:
    import random

    rng = random.Random(1234)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(bytes(rng.getrandbits(8) for _ in range(int(seconds * rate) * 4)))


def _trun_sample_count(segment: bytes) -> int:
    index = segment.index(b"trun")
    return struct.unpack(">I", segment[index + 8 : index + 12])[0]


def _args_for(fmt: str) -> tuple[list[str], int]:
    if fmt == "flac":
        return lossless_codec_args(), 44100
    args = lossy_codec_args(fmt, 128, 44100)
    return args, int(args[args.index("-ar") + 1])


def _encode_for_real(fmt: str, source, seconds: float) -> tuple[hls.Encode, list[str]]:
    args, rate = _args_for(fmt)
    layout = hls.segment_layout(seconds, rate, hls.frame_samples(fmt, FLAC_FRAME_SAMPLES))
    packed = hls.is_packed(fmt)
    cmd = [
        shutil.which("ffmpeg"),
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        "0.5",
        "-i",
        str(source),
    ]
    cmd += ["-vn", *args, *hls.container_args(layout, packed), "pipe:1"]
    return hls.Encode(cmd, layout, packed, rate), cmd


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")
@pytest.mark.parametrize("fmt", ["aac", "opus", "flac"])
async def test_every_fmp4_segment_holds_exactly_the_frames_it_was_listed_with(fmt, tmp_path):
    source = tmp_path / "source.wav"
    _write_noise_wav(source, 31.0)
    encode, _ = _encode_for_real(fmt, source, 30.5)

    segments = [await encode.segment(i) for i in range(encode.layout.count)]

    assert await encode.init_segment()
    assert all(segments)
    for segment in segments[:-1]:
        assert _trun_sample_count(segment) == encode.layout.frames_per_segment
    encode.close()


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")
async def test_every_packed_mp3_segment_holds_exactly_the_frames_it_was_listed_with(tmp_path):
    source = tmp_path / "source.wav"
    _write_noise_wav(source, 31.0)
    encode, _ = _encode_for_real("mp3", source, 30.5)

    segments = [await encode.segment(i) for i in range(encode.layout.count)]
    step = encode.layout.frames_per_segment * 1152 * 90000 / 44100

    assert [_id3_pts(s) for s in segments] == [round(i * step) for i in range(len(segments))]
    encode.close()


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")
@pytest.mark.parametrize("fmt", ["aac", "opus", "flac", "mp3"])
def test_the_same_command_encodes_to_the_same_bytes(fmt, tmp_path):
    """What encoding a closed stream again for a player that still holds
    some of its segments rests on (see EncodeRegistry.add())."""
    source = tmp_path / "source.wav"
    _write_noise_wav(source, 8.0)
    _, cmd = _encode_for_real(fmt, source, 7.5)

    outputs = {subprocess.run(cmd, capture_output=True, check=True).stdout for _ in range(2)}

    assert len(outputs) == 1
