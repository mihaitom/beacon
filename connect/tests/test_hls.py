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


def test_a_playlist_beginning_partway_still_lists_the_whole_track():
    """The element's clock is the playlist's, and the lock screen shows that
    clock - so a position to begin at goes in as a start point, never as a
    shorter playlist (see the module docstring)."""
    layout = hls.segment_layout(200.0, 44100, 1024)

    text = hls.playlist(layout, packed=False, query="", start=93.25)

    assert "#EXT-X-START:TIME-OFFSET=93.250,PRECISE=YES" in text
    assert text.count("#EXTINF:") == layout.count


def test_a_playlist_from_the_top_has_no_start_point():
    text = hls.playlist(hls.segment_layout(20.0, 44100, 1024), packed=False, query="")

    assert "EXT-X-START" not in text


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


def _moof_with_tfdt(ticks: int, version: int = 1) -> bytes:
    value = struct.pack(">q" if version == 1 else ">I", ticks)
    return _box(b"moof", _box(b"tfdt", bytes([version, 0, 0, 0]) + value) + b"trailer")


@pytest.mark.parametrize("version", [0, 1])
def test_the_fragment_timeline_is_moved_onto_the_tracks_own(version):
    """ffmpeg's fragmented output starts the media timeline at 0 whatever it
    skipped (no flag moves it), so the splitter restores the track's own -
    segments of one playlist from different encodes have to line up."""
    start_ticks = round(5.0 * 44100)
    init = _box(b"ftyp") + _box(b"moov")
    split = hls.Fmp4Splitter(start_ticks=start_ticks)

    got_init, segments = split.feed(
        init + _moof_with_tfdt(265216, version) + _box(b"mdat", b"x" * 8)
    )

    assert got_init == init
    at = segments[0].find(b"tfdt") + 8
    width = 8 if version == 1 else 4
    moved = int.from_bytes(segments[0][at : at + width], "big", signed=version == 1)
    assert moved == 265216 + start_ticks


def test_a_splitter_with_no_offset_leaves_the_tfdt_alone():
    init = _box(b"ftyp") + _box(b"moov")
    split = hls.Fmp4Splitter()

    _, segments = split.feed(init + _moof_with_tfdt(1234) + _box(b"mdat", b"x" * 8))

    assert segments[0] == _moof_with_tfdt(1234) + _box(b"mdat", b"x" * 8)


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


def test_the_packed_timestamp_is_counted_from_the_tracks_first_frame():
    """The same shift as the fMP4 path, on the ID3 timestamp a packed-audio
    segment carries instead."""
    frames = [_mp3_frame(i) for i in range(4)]
    packer = hls.Mp3Packer(frames_per_segment=3, sample_rate=44100, first_frame=6)

    segments = packer.feed(b"".join(frames))[1] + packer.flush()

    frame = 1152 * 90000 / 44100
    assert [_id3_pts(s) for s in segments] == [round(6 * frame), round(9 * frame)]


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


def _encode(count_seconds: float = 18.0, first: int = 0) -> hls.Encode:
    layout = hls.segment_layout(count_seconds, 44100, 1024)
    return hls.Encode(["ffmpeg"], layout, packed=False, sample_rate=44100, first=first)


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


async def test_a_packed_last_segment_carries_one_timestamp_however_much_it_holds():
    """The source ran a segment longer than reported: the frames of that
    extra segment go on the end of the last listed one, without the
    timestamp tag that would otherwise sit in the middle of the audio."""
    spawner = _Spawner()
    seconds = 3 * 1152 / 44100
    layout = hls.SegmentLayout(
        frames_per_segment=3, segment_seconds=seconds, count=2, last_seconds=seconds
    )
    encode = hls.Encode(["ffmpeg"], layout, packed=True, sample_rate=44100)
    frames = [_mp3_frame(i) for i in range(9)]
    with patch("asyncio.create_subprocess_exec", spawner):
        pending = asyncio.create_task(encode.segment(1))
        await _settle()
        spawner.procs[0].queue.put_nowait(b"".join(frames))
        spawner.procs[0].queue.put_nowait(b"")

        last = await _within(pending)

    assert last.count(b"ID3") == 1
    assert last[len(hls.id3_timestamp(0)) :] == b"".join(frames[3:])
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


async def test_an_encode_from_a_later_segment_answers_by_the_tracks_numbering():
    spawner = _Spawner()
    encode = _encode(60.0, first=4)
    chunks = _fmp4(2)
    with patch("asyncio.create_subprocess_exec", spawner):
        pending = asyncio.create_task(encode.segment(5))
        await _settle()
        spawner.procs[0].queue.put_nowait(b"".join(chunks))

        assert await _within(pending) == chunks[2]
        assert await encode.segment(4) == chunks[1]
        assert await encode.segment(3) is None
    encode.close()


async def test_an_encode_covers_what_it_has_and_what_it_is_about_to_make():
    spawner = _Spawner()
    encode = _encode(120.0, first=4)
    with patch("asyncio.create_subprocess_exec", spawner):
        encode.start()
        await _settle()
        spawner.procs[0].queue.put_nowait(b"".join(_fmp4(2)))
        await _settle()

        assert not encode.covers(3)
        assert encode.covers(5)
        assert encode.covers(5 + hls.REUSE_AHEAD_SEGMENTS)
        assert not encode.covers(6 + hls.REUSE_AHEAD_SEGMENTS)
    encode.close()


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


# ── Transcode ───────────────────────────────────────────────────────────────


class _Commands:
    """The command factory a Transcode is given, recording each start."""

    def __init__(self):
        self.starts: list[float] = []

    def __call__(self, start: float) -> list[str]:
        self.starts.append(start)
        return ["ffmpeg", "-ss", str(start)]


def _transcode(seconds: float = 120.0) -> tuple[hls.Transcode, _Commands]:
    commands = _Commands()
    layout = hls.segment_layout(seconds, 44100, 1024)
    return hls.Transcode(layout, False, 44100, commands), commands


async def test_playback_beginning_partway_is_encoded_from_its_segment():
    spawner = _Spawner()
    transcode, commands = _transcode()
    seg = transcode.layout.segment_seconds
    with patch("asyncio.create_subprocess_exec", spawner):
        transcode.begin_at(3.5 * seg)
        await _settle()

        assert commands.starts == [3 * seg]
        assert len(spawner.procs) == 1
    transcode.close()


async def test_the_next_segments_wait_for_the_encode_already_running():
    spawner = _Spawner()
    transcode, commands = _transcode()
    chunks = _fmp4(3)
    with patch("asyncio.create_subprocess_exec", spawner):
        first = asyncio.create_task(transcode.segment(0))
        second = asyncio.create_task(transcode.segment(1))
        await _settle()
        spawner.procs[0].queue.put_nowait(b"".join(chunks))

        assert await _within(first) == chunks[1]
        assert await _within(second) == chunks[2]
        assert commands.starts == [0.0]
    transcode.close()


async def test_a_seek_past_what_is_coming_starts_an_encode_from_there():
    spawner = _Spawner()
    transcode, commands = _transcode()
    seg = transcode.layout.segment_seconds
    far = 1 + hls.REUSE_AHEAD_SEGMENTS + 5
    with patch("asyncio.create_subprocess_exec", spawner):
        asyncio.create_task(transcode.segment(0))
        await _settle()
        pending = asyncio.create_task(transcode.segment(far))
        await _settle()
        spawner.procs[1].queue.put_nowait(b"".join(_fmp4(1)))

        assert commands.starts == [0.0, far * seg]
        assert await _within(pending) == _fmp4(1)[1]
        assert not spawner.procs[0].killed
    transcode.close()


async def test_a_seek_back_starts_an_encode_from_there_too():
    spawner = _Spawner()
    transcode, commands = _transcode()
    seg = transcode.layout.segment_seconds
    with patch("asyncio.create_subprocess_exec", spawner):
        transcode.begin_at(10 * seg)
        await _settle()
        asyncio.create_task(transcode.segment(2))
        await _settle()

        assert commands.starts == [10 * seg, 2 * seg]
    transcode.close()


async def test_the_encode_used_longest_ago_is_closed_beyond_the_limit():
    """A stale request from before a seek may start an encode of its own; it
    must not close the one the player is waiting on now."""
    spawner = _Spawner()
    transcode, _ = _transcode(600.0)
    with patch("asyncio.create_subprocess_exec", spawner):
        for index in (0, 40, 80):
            transcode.begin_at(index * transcode.layout.segment_seconds)
            await _settle()

        assert [proc.killed for proc in spawner.procs] == [True, False, False]
        transcode.close()
        await _settle()
        assert all(proc.killed for proc in spawner.procs)


async def test_an_encode_still_being_asked_for_is_not_the_one_closed():
    spawner = _Spawner()
    transcode, _ = _transcode(600.0)
    seg = transcode.layout.segment_seconds
    with patch("asyncio.create_subprocess_exec", spawner):
        transcode.begin_at(0)
        transcode.begin_at(40 * seg)
        await _settle()
        asyncio.create_task(transcode.segment(1))
        await _settle()

        transcode.begin_at(80 * seg)
        await _settle()

        assert [proc.killed for proc in spawner.procs] == [False, True, False]
        transcode.close()
        await _settle()


async def test_a_segment_outside_the_track_is_none():
    transcode, commands = _transcode(18.0)

    assert await transcode.segment(transcode.layout.count) is None
    assert await transcode.segment(-1) is None
    assert commands.starts == []


async def test_the_init_segment_comes_from_the_encode_playback_began_with():
    spawner = _Spawner()
    transcode, commands = _transcode()
    seg = transcode.layout.segment_seconds
    chunks = _fmp4(1)
    with patch("asyncio.create_subprocess_exec", spawner):
        transcode.begin_at(5 * seg)
        pending = asyncio.create_task(transcode.init_segment())
        await _settle()
        spawner.procs[0].queue.put_nowait(b"".join(chunks))

        assert await _within(pending) == chunks[0]
        assert commands.starts == [5 * seg]
    transcode.close()


# ── Registry ────────────────────────────────────────────────────────────────


async def test_a_new_transcode_closes_the_ones_it_supersedes():
    spawner = _Spawner()
    registry = hls.TranscodeRegistry()
    with patch("asyncio.create_subprocess_exec", spawner):
        old = registry.add(("s", "track", "aac"), _transcode()[0], supersedes=lambda key: False)
        other = registry.add(("s", "other", "aac"), _transcode()[0], supersedes=lambda key: False)
        old.begin_at(0)
        other.begin_at(0)
        await _settle()

        registry.add(
            ("s", "track", "opus"),
            _transcode()[0],
            supersedes=lambda key: key[:2] == ("s", "track"),
        )
        await _settle()

        assert spawner.procs[0].killed
        assert not spawner.procs[1].killed
        assert registry.get(("s", "track", "aac")) is None
        assert registry.get(("s", "other", "aac")) is other
    registry.clear()


async def test_a_failed_transcode_is_not_handed_out_again():
    spawner = _Spawner(returncode=1)
    registry = hls.TranscodeRegistry()
    transcode = registry.add("key", _transcode()[0], supersedes=lambda key: False)
    with patch("asyncio.create_subprocess_exec", spawner):
        pending = asyncio.create_task(transcode.segment(0))
        await _settle()
        spawner.procs[0].queue.put_nowait(b"")
        await _within(pending)

    assert registry.get("key") is None
    registry.clear()


async def test_an_idle_transcode_is_closed():
    spawner = _Spawner()
    registry = hls.TranscodeRegistry()
    transcode = registry.add("key", _transcode()[0], supersedes=lambda key: False)
    with patch("asyncio.create_subprocess_exec", spawner):
        transcode.begin_at(0)
        await _settle()
        transcode.touched_at -= hls.IDLE_SECONDS + 1

        assert registry.get("key") is None
        await _settle()
        assert spawner.procs[0].killed


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


def _tfdt(segment: bytes) -> int:
    index = segment.index(b"tfdt")
    width = 8 if segment[index + 4] == 1 else 4
    return int.from_bytes(segment[index + 8 : index + 8 + width], "big")


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")
@pytest.mark.parametrize("fmt", ["aac", "opus", "flac", "mp3"])
async def test_an_encode_begun_at_a_later_segment_lines_up_with_one_from_the_top(fmt, tmp_path):
    """What lets one playlist hand out segments of two encodes: the one begun
    after a seek carries the timestamps and the frame count the encode from
    the top has for the same segment."""
    source = tmp_path / "source.wav"
    _write_noise_wav(source, 31.0)
    args, rate = _args_for(fmt)
    layout = hls.segment_layout(31.0, rate, hls.frame_samples(fmt, FLAC_FRAME_SAMPLES))
    packed = hls.is_packed(fmt)

    def encode_from(first: int) -> hls.Encode:
        cmd = [shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error"]
        if first:
            cmd += ["-ss", f"{first * layout.segment_seconds:.6f}"]
        cmd += ["-i", str(source), "-vn", *args, *hls.container_args(layout, packed), "pipe:1"]
        return hls.Encode(cmd, layout, packed, rate, first)

    whole, seeked = encode_from(0), encode_from(2)
    expected, got = await whole.segment(2), await seeked.segment(2)
    following = await seeked.segment(3)

    if packed:
        assert _id3_pts(got) == _id3_pts(expected)
        assert _id3_pts(following) == _id3_pts(await whole.segment(3))
    else:
        assert _tfdt(got) == _tfdt(expected)
        assert _trun_sample_count(got) == layout.frames_per_segment
        assert _tfdt(following) == _tfdt(await whole.segment(3))
    whole.close()
    seeked.close()


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
