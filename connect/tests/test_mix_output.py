"""Tests for core/mix_output.py — the rendered mix and each listener's
encode of it."""

import asyncio
import shutil
from unittest.mock import AsyncMock, patch

import numpy as np
import pytest

import core.mix_output as mo
from core.mix_engine import MixEngine, MixItem
from core.mix_output import FRAME_BYTES, MixConnection, PcmRing

SR = mo.SAMPLE_RATE


def _frames(n: int, value: int = 1) -> bytes:
    return bytes([value, 0]) * 2 * n


def test_reads_by_stream_frame_across_appends():
    ring = PcmRing()
    ring.append(_frames(10, 1))
    ring.append(_frames(10, 2))
    assert ring.head == 20
    assert ring.read(8, 4) == _frames(2, 1) + _frames(2, 2)


def test_trimmed_audio_reads_as_the_oldest_still_held():
    ring = PcmRing()
    ring.append(_frames(10, 1) + _frames(10, 2))
    ring.trim(10)
    assert ring.base == 10
    assert ring.read(0, 3) == _frames(3, 2)
    assert ring.clamp(0) == 10


def test_trim_never_passes_the_head():
    ring = PcmRing()
    ring.append(_frames(5))
    ring.trim(100)
    assert ring.base == 5
    assert ring.read(5, 10) == b""


async def test_a_waiting_reader_wakes_for_new_audio_and_for_the_end():
    ring = PcmRing()
    waiter = asyncio.create_task(ring.wait_beyond(0))
    await asyncio.sleep(0)
    assert not waiter.done()
    ring.append(_frames(1))
    await asyncio.wait_for(waiter, 1)

    ender = asyncio.create_task(ring.wait_beyond(ring.head))
    await asyncio.sleep(0)
    ring.close()
    await asyncio.wait_for(ender, 1)


class _Stdin:
    def __init__(self):
        self.written = bytearray()

    def write(self, data):
        self.written += data

    async def drain(self):
        pass

    def is_closing(self):
        return False

    def close(self):
        pass


async def test_a_connection_left_behind_by_a_trim_skips_ahead_without_repeating():
    ring = PcmRing()
    ring.append(b"".join(_frames(1, v) for v in range(20)))
    connection = MixConnection(ring, 0, [])
    ring.trim(10)
    stdin = _Stdin()
    connection._proc = type("Proc", (), {"stdin": stdin})()
    ring.close()
    await connection._feed()
    assert bytes(stdin.written) == b"".join(_frames(1, v) for v in range(10, 20))
    assert connection.fed_frame == 20


async def test_a_listeners_curve_is_asked_for_every_block_it_is_fed():
    """A curve changed while the mix plays reaches the next block - the
    encoder itself is never restarted for it."""
    ring = PcmRing()
    ring.append(bytes(mo._WRITE_FRAMES * FRAME_BYTES * 3))
    ring.close()
    asked = []

    def curve():
        asked.append(len(asked))
        return []

    connection = MixConnection(ring, 0, [], curve)
    stdin = _Stdin()
    connection._proc = type("Proc", (), {"stdin": stdin})()
    with patch.object(mo.LiveEqualizer, "process", side_effect=lambda pcm, bands: pcm) as process:
        await connection._feed()
    assert asked == [0, 1, 2]
    assert process.call_count == 3
    assert len(stdin.written) == mo._WRITE_FRAMES * FRAME_BYTES * 3


async def test_a_listener_with_a_curve_is_fed_the_filtered_mix():
    t = np.arange(mo._WRITE_FRAMES) / SR
    tone = np.repeat((0.5 * np.sin(2 * np.pi * 1000 * t) * 32767).astype("<i2"), 2)
    ring = PcmRing()
    ring.append(tone.tobytes())
    ring.close()
    connection = MixConnection(ring, 0, [], lambda: [{"frequency": 1000, "gain": -12, "q": 1.41}])
    stdin = _Stdin()
    connection._proc = type("Proc", (), {"stdin": stdin})()
    await connection._feed()
    fed = np.frombuffer(bytes(stdin.written), dtype="<i2").astype(np.float64)
    assert len(fed) == len(tone)
    # Well past the filter's settling: about a quarter of the level.
    tail = slice(len(fed) // 2, None)
    assert np.std(fed[tail]) / np.std(tone[tail].astype(np.float64)) < 0.3
    assert connection.fed_frame == mo._WRITE_FRAMES


async def test_the_mix_hands_a_listener_its_curve():
    engine = MixEngine(MixItem("1", 0), 10.0, AsyncMock(), AsyncMock())

    def curve():
        return []

    with patch.object(MixConnection, "open", new=AsyncMock()):
        connection = await engine.connect(0.0, [], curve=curve)
    assert connection._curve is curve
    engine.stop()


def test_the_encoder_reads_pcm_and_writes_what_it_is_told():
    cmd = mo.encoder_cmd(["-acodec", "flac", "-f", "flac"])
    assert cmd[cmd.index("-f") + 1] == "s16le"
    assert cmd[cmd.index("-i") + 1] == "pipe:0"
    assert cmd[-7:] == ["-acodec", "flac", "-f", "flac", "-flush_packets", "1", "pipe:1"]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")
async def test_a_connection_encodes_from_its_start_and_ends_with_the_mix(monkeypatch):
    monkeypatch.setattr(mo, "FFMPEG_BIN", "ffmpeg")
    ring = PcmRing()
    ring.append(bytes(SR * 4))  # one second
    connection = MixConnection(ring, SR // 2, ["-acodec", "flac", "-f", "flac"])
    assert connection.start_frame == SR // 2
    await connection.open()
    ring.append(bytes(SR * 4))
    ring.close()
    received = bytearray()
    async with asyncio.timeout(10):
        async for chunk in connection.chunks():
            received += chunk
    assert received[:4] == b"fLaC"
    assert connection.fed_frame == 2 * SR
    assert connection.closed


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")
async def test_a_closed_connection_takes_its_encoder_with_it(monkeypatch):
    monkeypatch.setattr(mo, "FFMPEG_BIN", "ffmpeg")
    ring = PcmRing()
    ring.append(bytes(SR * 4))
    connection = MixConnection(ring, 0, ["-acodec", "pcm_s16le", "-f", "s16le"])
    await connection.open()
    proc = connection._proc
    connection.close()
    async with asyncio.timeout(5):
        await proc.wait()
    assert proc.returncode is not None
