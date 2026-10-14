"""Tests for core/mix_hls.py - a mix as a live HLS playlist, for WebKit.

A real mix engine over stand-in decks, and a real ffmpeg: what is checked
is what Safari would get - a playlist that grows and is closed only when
the mix ends, and segments that join up into the whole mix."""

import asyncio
import shutil
import subprocess

import numpy as np
import pytest

from core import mix_hls
from core.mix_engine import MixEngine, MixItem
from core.mix_hls import MixHls
from core.streamer import lossless_codec_args, lossy_codec_args

from .test_mix_engine import FakeClock, FakeDeck

SR = 44100

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")


def _tone(seconds: float) -> bytes:
    t = np.arange(int(seconds * SR)) / SR
    mono = (0.3 * np.sin(2 * np.pi * 440 * t) * 32767).astype("<i2")
    return np.repeat(mono, 2).tobytes()


def _engine(seconds: float) -> tuple[MixEngine, FakeClock]:
    clock = FakeClock()
    pcm = _tone(seconds)

    async def url(item):
        return item.song_id

    async def nothing_next(item):
        return None

    engine = MixEngine(
        MixItem("a", 0, duration=seconds),
        0.0,
        url,
        nothing_next,
        lead_seconds=2.0,
        clock=clock,
        deck_factory=lambda item, start: FakeDeck(item, start, pcm, True),
    )
    return engine, clock


async def _play(engine: MixEngine, clock: FakeClock, stream: MixHls, until=None) -> None:
    """Runs the mix on the fake clock until it has ended (or `until` says so)
    and the HLS encode has caught up with it."""
    for _ in range(400):
        engine.step()
        await asyncio.sleep(0.01)
        if until is not None and until():
            return
        clock.now += 0.5
        if engine.ended and (stream.finished or stream.failed):
            return
    raise AssertionError("the mix or its encode never finished")


def _decoded_seconds(data: bytes) -> float:
    out = subprocess.run(
        [shutil.which("ffmpeg"), "-v", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "2", "-"],
        input=data,
        capture_output=True,
        check=True,
    ).stdout
    return len(out) / 4 / SR


async def _whole(stream: MixHls) -> bytes:
    parts = [] if stream.packed else [await stream.init_segment()]
    for i in range(stream.segments):
        parts.append(await stream.segment(i))
    return b"".join(parts)


@pytest.mark.parametrize(
    ("fmt", "args"),
    [("aac", lossy_codec_args("aac", 128)), ("mp3", lossy_codec_args("mp3", 128))],
)
async def test_the_playlist_grows_and_closes_when_the_mix_ends(fmt, args):
    engine, clock = _engine(14.0)
    engine.start()
    stream = MixHls(engine, fmt, args)
    stream.start()
    try:
        await _play(engine, clock, stream, until=lambda: stream.segments >= 1)
        early = stream.playlist("token=t")
        assert "#EXT-X-PLAYLIST-TYPE:EVENT" in early
        assert "#EXT-X-ENDLIST" not in early
        await _play(engine, clock, stream)
        assert stream.finished
        final = stream.playlist("token=t")
        assert final.rstrip().endswith("#EXT-X-ENDLIST")
        durations = [float(line[8:-1]) for line in final.splitlines() if line.startswith("#EXTINF")]
        assert len(durations) == stream.segments == 3
        assert sum(durations) == pytest.approx(14.0, abs=0.05)
        assert all("?token=t" in line for line in final.splitlines() if line.endswith("t"))
        # The segments join up into the whole mix.
        assert _decoded_seconds(await _whole(stream)) == pytest.approx(14.0, abs=0.1)
    finally:
        stream.close()
        engine.stop()


async def test_the_encode_does_not_count_as_somebody_listening():
    """The run is kept alive by the tab asking about it; an encode that
    never stops reading would otherwise keep a closed tab's mix forever."""
    engine, clock = _engine(14.0)
    engine.start()
    stream = MixHls(engine, "flac", lossless_codec_args())
    stream.start()
    try:
        await _play(engine, clock, stream, until=lambda: stream.segments >= 1)
        assert engine.listeners == 0
    finally:
        stream.close()
        engine.stop()


async def test_a_segment_past_the_end_is_none_once_the_mix_is_over():
    engine, clock = _engine(8.0)
    engine.start()
    stream = MixHls(engine, "aac", lossy_codec_args("aac", 128))
    stream.start()
    try:
        await _play(engine, clock, stream)
        assert await stream.segment(stream.segments) is None
    finally:
        stream.close()
        engine.stop()


def test_opus_segments_are_counted_at_its_own_rate():
    engine, _ = _engine(1.0)
    stream = MixHls(engine, "opus", lossy_codec_args("opus", 128))
    assert stream.segment_seconds == pytest.approx(6.0)  # 300 frames of 960 at 48 kHz
    stream.close()


class _Listener:
    """Just the engine's clock, for what MixHls keeps."""

    epoch = "e"
    end_stream_time = None
    ended = False

    def __init__(self):
        self.wall_time: float | None = None


def test_only_segments_near_the_listener_are_kept():
    """A run can last hours; the playlist lists everything, but what lies
    long behind the listener is not held any more."""
    listener = _Listener()
    stream = MixHls(listener, "aac", lossy_codec_args("aac", 128))
    seconds = stream.segment_seconds
    stream._take(b"init", [b"s%d" % i for i in range(100)])
    assert len(stream._held) == 100  # nothing heard yet: nothing let go
    listener.wall_time = 60 * seconds
    stream._take(None, [b"s100"])
    assert stream.segments == 101
    behind = mix_hls._KEEP_BEHIND_SECONDS / seconds
    assert min(stream._held) == int(60 - behind)
    assert stream.playlist("").count("#EXTINF") == 101
    stream.close()


async def test_a_segment_let_go_is_none_and_one_still_held_is_served():
    listener = _Listener()
    stream = MixHls(listener, "aac", lossy_codec_args("aac", 128))
    stream._take(b"init", [b"s%d" % i for i in range(100)])
    listener.wall_time = 90 * stream.segment_seconds
    assert await stream.segment(0) is None
    assert await stream.segment(95) == b"s95"
    stream.close()
