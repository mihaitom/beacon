"""Tests for core/party_broadcast.py — listening along.

The broadcaster's decisions (following the host, catching up, song changes,
the timeline) are driven through produce() with hand-fed sources and a clock
that only moves when the test says so. One test at the end runs the real
thing against a real ffmpeg.
"""

import asyncio
import shutil
import struct
import wave

import pytest

import core.party_broadcast as pb
from core.party_broadcast import Broadcaster, Hearing, Source, split_adts

SR = pb.SAMPLE_RATE
TICK = 2205  # 50ms of sample frames


def _pcm(frames: int, value: int) -> bytes:
    """`frames` stereo s16le sample frames, all of them `value`."""
    return struct.pack("<hh", value, value) * frames


class Host:
    """What the host hears, changed by the test."""

    def __init__(self, **kwargs):
        self.hearing: Hearing | None = Hearing(**kwargs) if kwargs else None

    def set(self, **kwargs):
        self.hearing = Hearing(**kwargs)

    def __call__(self):
        return self.hearing


class Rig:
    """A broadcaster whose sources are fed by hand, and a clock in step
    with what it has written - so a sample written now airs now."""

    def __init__(self, host: Host):
        self.host = host
        self.opened: list[Source] = []
        self.timeline_calls = 0

        async def url(song_id):
            return f"http://nav/{song_id}"

        def count():
            self.timeline_calls += 1

        self.b = Broadcaster(192, host, url, on_timeline=count, clock=lambda: 0.0)
        self.b._t0 = 0.0

        def fake_open(song_id, start, gain):
            source = Source(song_id, start, url, gain)
            self.opened.append(source)
            return source

        self.b._open = fake_open

    def now(self) -> float:
        return self.b._written / SR

    def produce(self, frames: int = TICK) -> bytes:
        return self.b.produce(frames, self.now())

    @property
    def source(self) -> Source | None:
        return self.b._source


def feed(source: Source, data: bytes, eof: bool = False) -> None:
    source._buf += data
    if data:
        source.produced = True
    source.eof = eof


# ── Following the host ──────────────────────────────────────────────────────


def test_it_plays_the_hosts_song_from_where_the_host_is():
    rig = Rig(Host(song_id="a", position=42.0, playing=True, duration=200))
    rig.produce()
    assert rig.source.song_id == "a"
    assert rig.source.start == pytest.approx(42.0)
    assert rig.b.timeline[-1] == pb.TimelineEntry(0.0, "a", 42.0, True)


def test_the_decoder_starts_where_the_host_will_be_when_it_airs():
    """The writes run ahead of the wall clock, so the song has to start
    that much further in, or the stream would be behind the host by it."""
    rig = Rig(Host(song_id="a", position=10.0, playing=True))
    rig.b.produce(TICK, now=-0.5)  # this sample airs half a second from now
    assert rig.source.start == pytest.approx(10.5)


def test_silence_while_the_host_pauses():
    host = Host(song_id="a", position=10.0, playing=True)
    rig = Rig(host)
    rig.produce()
    feed(rig.source, _pcm(TICK, 7))
    host.set(song_id="a", position=10.05, playing=False)
    out = rig.produce()
    assert out == bytes(TICK * 4)
    assert rig.source is None
    assert rig.b.timeline[-1].playing is False
    assert rig.b.timeline[-1].song_id == "a"


def test_a_pause_is_marked_once_not_on_every_tick():
    host = Host(song_id="a", position=10.0, playing=False)
    rig = Rig(host)
    for _ in range(20):
        rig.produce()
    assert len(rig.b.timeline) == 1
    assert rig.timeline_calls == 1


def test_resuming_restarts_where_the_host_is():
    host = Host(song_id="a", position=10.0, playing=True)
    rig = Rig(host)
    rig.produce()
    host.set(song_id="a", position=10.0, playing=False)
    rig.produce()
    host.set(song_id="a", position=10.0, playing=True)
    rig.produce()
    assert len(rig.opened) == 2
    assert rig.source.start == pytest.approx(10.0)


def test_a_seek_restarts_the_decoder():
    host = Host(song_id="a", position=10.0, playing=True, duration=200)
    rig = Rig(host)
    rig.produce()
    feed(rig.source, _pcm(TICK, 1))
    host.set(song_id="a", position=95.0, playing=True, duration=200)
    rig.produce()
    assert len(rig.opened) == 2
    assert rig.source.start == pytest.approx(95.0)
    assert rig.b.timeline[-1].position == pytest.approx(95.0)


def test_a_small_drift_is_left_alone():
    """A snapshot's arrival jitter must not restart a song that plays fine."""
    host = Host(song_id="a", position=10.0, playing=True)
    rig = Rig(host)
    rig.produce()
    host.set(song_id="a", position=11.5, playing=True)
    rig.produce()
    assert len(rig.opened) == 1


def test_a_different_song_from_the_host_is_followed():
    host = Host(song_id="a", position=10.0, playing=True)
    rig = Rig(host)
    rig.produce()
    host.set(song_id="b", position=0.2, playing=True)
    rig.produce()
    assert rig.source.song_id == "b"
    assert rig.b.timeline[-1].song_id == "b"


def test_nothing_playing_is_silence():
    rig = Rig(Host())
    assert rig.produce() == bytes(TICK * 4)
    assert rig.source is None


# ── Audio that arrives late ─────────────────────────────────────────────────


def test_a_slow_decoder_costs_silence_not_sync():
    """Whatever the decoder could not deliver in time is played as silence
    and then skipped once it arrives, so the stream stays with the host."""
    rig = Rig(Host(song_id="a", position=0.0, playing=True))
    out = rig.produce()
    assert out == bytes(TICK * 4)
    source = rig.source
    assert source.position == pytest.approx(TICK / SR)
    # The first 50ms arrive late and are dropped; the next 50ms play.
    feed(source, _pcm(TICK, 1) + _pcm(TICK, 2))
    out = rig.produce()
    assert out == _pcm(TICK, 2)


def test_part_of_a_tick_from_the_decoder_and_the_rest_silence():
    rig = Rig(Host(song_id="a", position=0.0, playing=True))
    rig.produce(0)
    feed(rig.source, _pcm(100, 3))
    out = rig.produce()
    assert out == _pcm(100, 3) + bytes((TICK - 100) * 4)
    assert rig.source.position == pytest.approx(TICK / SR)


# ── Song changes ────────────────────────────────────────────────────────────


def _near_the_end():
    host = Host(song_id="a", position=195.0, playing=True, duration=200, next_song_id="b")
    rig = Rig(host)
    rig.produce(0)
    return host, rig


def test_the_next_song_is_opened_before_the_end():
    _host, rig = _near_the_end()
    assert [s.song_id for s in rig.opened] == ["a", "b"]
    assert rig.b._next.start == 0.0


def test_the_next_song_follows_seamlessly():
    _host, rig = _near_the_end()
    a, b = rig.opened
    feed(a, _pcm(1000, 1), eof=True)
    feed(b, _pcm(5000, 2))
    written_before = rig.b._written
    out = rig.produce()
    assert out == _pcm(1000, 1) + _pcm(TICK - 1000, 2)
    assert rig.source is b
    entry = rig.b.timeline[-1]
    assert entry.song_id == "b"
    assert entry.stream_time == pytest.approx((written_before + 1000) / SR)


def test_the_host_still_reporting_the_old_song_does_not_bring_it_back():
    """The host window reports the change a moment after the stream made
    it; that moment must not restart the song that just ended."""
    host, rig = _near_the_end()
    a, b = rig.opened
    feed(a, b"", eof=True)
    feed(b, _pcm(50000, 2))
    rig.produce()
    host.set(song_id="a", position=199.9, playing=True, duration=200, next_song_id="b")
    rig.produce()
    assert rig.source is b
    assert len(rig.opened) == 2


def test_the_host_moving_on_first_takes_the_song_already_opened():
    host, rig = _near_the_end()
    a, b = rig.opened
    feed(a, _pcm(100000, 1))
    host.set(song_id="b", position=0.3, playing=True, duration=180)
    rig.produce()
    assert rig.source is b
    assert len(rig.opened) == 2


def test_the_end_of_the_queue_is_silence():
    host = Host(song_id="a", position=199.0, playing=True, duration=200)
    rig = Rig(host)
    rig.produce(0)
    feed(rig.source, _pcm(100, 1), eof=True)
    out = rig.produce()
    assert out == _pcm(100, 1) + bytes((TICK - 100) * 4)
    assert rig.source is None
    assert rig.b.timeline[-1].playing is False


def test_a_seek_to_the_very_end_has_nothing_to_play():
    rig = Rig(Host(song_id="a", position=199.8, playing=True, duration=200))
    rig.produce()
    assert rig.opened == []
    assert rig.b.timeline[-1].playing is False


def test_a_song_that_cannot_be_decoded_is_not_retried_on_every_tick():
    rig = Rig(Host(song_id="a", position=10.0, playing=True))
    rig.produce()
    feed(rig.source, b"", eof=True)
    for _ in range(int(pb._ADVANCE_GRACE_SECONDS * 20) + 40):
        rig.produce()
    assert len(rig.opened) == 1


# ── Timeline ────────────────────────────────────────────────────────────────


def test_old_timeline_entries_are_dropped():
    """Only what nobody can still be hearing: an entry stays for as long
    as the one after it started within the window."""
    host = Host(song_id="a", position=0.0, playing=True)
    rig = Rig(host)
    rig.produce()
    rig.b._written = 5 * SR
    host.set(song_id="b", position=0.0, playing=True)
    rig.produce()
    rig.b._written = int((pb._TIMELINE_KEEP_SECONDS + 10) * SR)
    host.set(song_id="c", position=0.0, playing=True)
    rig.produce()
    assert [entry.song_id for entry in rig.b.timeline] == ["b", "c"]


# ── Sources ─────────────────────────────────────────────────────────────────


def test_a_source_hands_out_whole_sample_frames():
    source = Source("a", 0.0, None, 1.0)
    source._buf += b"\x01\x02\x03\x04\x05\x06"
    assert source.take(10) == b"\x01\x02\x03\x04"
    assert source.position == pytest.approx(1 / SR)


def test_skipped_audio_is_dropped_when_it_arrives():
    source = Source("a", 5.0, None, 1.0)
    source.skip(3)
    feed(source, _pcm(5, 9))
    assert source.take(10) == _pcm(2, 9)
    assert source.position == pytest.approx(5.0 + 5 / SR)


def test_a_full_source_stops_reading_until_there_is_room():
    source = Source("a", 0.0, None, 1.0)
    source._buf += bytes(int(pb._SOURCE_BUFFER_SECONDS * SR) * 4)
    source._room.clear()
    source.take(1)
    assert source._room.is_set()


# ── ADTS framing ────────────────────────────────────────────────────────────


def _adts(payload: int, blocks: int = 1) -> bytes:
    length = 7 + payload
    header = bytes(
        [
            0xFF,
            0xF1,
            0x50,
            0x80 | ((length >> 11) & 0x03),
            (length >> 3) & 0xFF,
            ((length & 0x07) << 5) | 0x1F,
            0xFC | (blocks - 1),
        ]
    )
    return header + bytes(payload)


def test_whole_adts_frames_are_split_off():
    buf = bytearray(_adts(10) + _adts(20) + _adts(30)[:15])
    size, frames = split_adts(buf)
    assert (size, frames) == (17 + 27, 2)


def test_a_frame_with_several_blocks_counts_each():
    assert split_adts(bytearray(_adts(10, blocks=3))) == (17, 3)


def test_garbage_ahead_of_a_frame_is_skipped():
    assert split_adts(bytearray(b"\x00\x01" + _adts(10))) == (19, 1)


# ── The real thing ──────────────────────────────────────────────────────────


def _tone(path, seconds=3.0):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(_pcm(int(seconds * SR), 1000))


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")
async def test_a_real_broadcast_is_tagged_aac(tmp_path, monkeypatch):
    monkeypatch.setattr(pb, "FFMPEG_BIN", "ffmpeg")
    _tone(tmp_path / "a.wav")

    async def url(song_id):
        return str(tmp_path / f"{song_id}.wav")

    host = Host(song_id="a", position=0.0, playing=True, duration=3.0)
    b = Broadcaster(128, host, url)
    await b.start()
    q = b.subscribe()
    try:
        received = bytearray()
        async with asyncio.timeout(10):
            while len(received) < 8000:
                chunk = await q.get()
                assert chunk is not None
                received += chunk
        assert b.start_time(q) is not None
        size, frames = split_adts(received)
        assert frames > 10
        assert size > 0
        assert b.timeline[-1].song_id == "a"
    finally:
        b.stop()
    assert await q.get() is None


# ── Visualizer ──────────────────────────────────────────────────────────────


def _sine(frames: int, start: int = 0) -> bytes:
    import math

    return b"".join(
        struct.pack("<hh", v, v)
        for v in (int(8000 * math.sin(2 * math.pi * 440 * (start + i) / SR)) for i in range(frames))
    )


def test_bands_carry_the_stream_time_of_what_they_analysed():
    from core.audio_analysis import _FFT_SIZE, _HOP_SIZE

    rig = Rig(Host(song_id="a", position=0.0, playing=True))
    rig.produce(0)
    rig.b._written = 10 * SR  # ten seconds into the broadcast
    q = rig.b.watch_bands()
    feed(rig.source, _sine(_FFT_SIZE + _HOP_SIZE * 3))
    rig.b.produce(_FFT_SIZE + _HOP_SIZE * 3, rig.now())
    frames = q.get_nowait()
    times = [t for t, _ in frames]
    assert times[0] == pytest.approx(10.0)
    assert times[1] - times[0] == pytest.approx(_HOP_SIZE / SR)
    assert len(frames) == 4
    assert max(frames[-1][1]) > 0.3  # the tone shows up


def test_nothing_is_analysed_while_nobody_watches():
    rig = Rig(Host(song_id="a", position=0.0, playing=True))
    q = rig.b.watch_bands()
    rig.b.unwatch_bands(q)
    rig.produce(SR)
    assert q.empty()
    assert rig.b._analysis == bytearray()


async def test_watchers_hear_the_end_of_the_broadcast():
    rig = Rig(Host())
    q = rig.b.watch_bands()
    rig.b.stop()
    assert q.get_nowait() is None
    late = rig.b.watch_bands()
    assert late.get_nowait() is None


# ── Radio ───────────────────────────────────────────────────────────────────


def test_a_station_is_decoded_live_and_marked_without_a_song(monkeypatch):
    opened = []
    monkeypatch.setattr(Source, "open", lambda self: opened.append(self))
    host = Host(song_id=None, position=0.0, playing=True, radio_url="http://station/live")
    rig = Rig(host)
    rig.produce(0)
    assert rig.source.radio and rig.source.song_id == "radio:http://station/live"
    assert rig.b.timeline[-1] == pb.TimelineEntry(0.0, None, 0.0, True)
    rig.produce()
    assert len(opened) == 1  # left running, no position to catch up with


def test_a_station_that_drops_is_tried_again_later(monkeypatch):
    opened = []
    monkeypatch.setattr(Source, "open", lambda self: opened.append(self))
    host = Host(song_id=None, position=0.0, playing=True, radio_url="http://station/live")
    rig = Rig(host)
    rig.produce(0)
    feed(rig.source, b"", eof=True)
    rig.produce()
    assert rig.b.timeline[-1].playing is False
    for _ in range(20):
        rig.produce()
    assert len(opened) == 1
    rig.b._failed.clear()
    rig.produce()
    assert len(opened) == 2


def test_from_a_station_back_to_a_song(monkeypatch):
    monkeypatch.setattr(Source, "open", lambda self: None)
    host = Host(song_id=None, position=0.0, playing=True, radio_url="http://station/live")
    rig = Rig(host)
    rig.produce(0)
    host.set(song_id="a", position=3.0, playing=True)
    rig.produce(0)
    assert rig.source.song_id == "a" and not rig.source.radio
