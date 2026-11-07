"""Tests for the streams and dispatches in routes/debug.py: what goes over
the wire, that an encoder dies with its listener, and what the device is
told. ffmpeg is a fake that hands out fixed chunks - its encoding is not
the question here (test_debug_station.py checks the command lines)."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from core.icy_metadata import DEVICE_METAINT
from routes import debug

CHUNKS = [bytes([i]) * 5000 for i in range(1, 5)]


class FakeProc:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)
        self.returncode: int | None = None
        self.killed = False
        self.stdout = self

    async def read(self, n: int) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    async def wait(self) -> int:
        return self.returncode


@pytest.fixture
def ffmpeg(monkeypatch):
    """Every spawned 'ffmpeg', in spawn order, each with CHUNKS to give."""
    spawned: list[FakeProc] = []

    async def fake_exec(*cmd, **kwargs):
        proc = FakeProc(CHUNKS)
        proc.cmd = cmd
        spawned.append(proc)
        return proc

    monkeypatch.setattr(debug.asyncio, "create_subprocess_exec", fake_exec)
    return spawned


async def _body(response) -> bytes:
    return b"".join([chunk async for chunk in response.body_iterator])


async def _first_chunk_then_hang_up(response) -> None:
    body = response.body_iterator
    await anext(body)
    await body.aclose()


# ── The test station ────────────────────────────────────────────────────────


async def test_the_station_answers_icy_metadata_like_a_real_one(ffmpeg):
    response = await debug.test_radio(MagicMock(headers={"icy-metadata": "1"}))
    assert response.headers["icy-metaint"] == str(DEVICE_METAINT)
    body = await _body(response)
    audio, blocks, i = b"", [], 0
    while i < len(body):
        audio += body[i : i + DEVICE_METAINT]
        i += DEVICE_METAINT
        if i < len(body):
            length = body[i] * 16
            blocks.append(body[i + 1 : i + 1 + length])
            i += 1 + length
    assert audio == b"".join(CHUNKS)
    assert blocks[0].startswith(b"StreamTitle='BEACON TEST 0000'")


async def test_without_icy_metadata_the_station_is_pure_audio(ffmpeg):
    response = await debug.test_radio(MagicMock(headers={}))
    assert "icy-metaint" not in response.headers
    assert await _body(response) == b"".join(CHUNKS)


@pytest.mark.parametrize("icy", ["1", None])
async def test_a_listener_hanging_up_takes_the_station_encoder_with_it(ffmpeg, icy):
    headers = {"icy-metadata": icy} if icy else {}
    await _first_chunk_then_hang_up(await debug.test_radio(MagicMock(headers=headers)))
    assert ffmpeg[0].killed


async def test_a_station_from_a_listed_file_encodes_that_file(ffmpeg, monkeypatch, tmp_path):
    (tmp_path / "music.flac").write_bytes(b"fLaC")
    monkeypatch.setenv(debug._TEST_AUDIO_ENV, str(tmp_path))
    response = await debug.test_radio(MagicMock(headers={}), file="music.flac")
    await _body(response)
    cmd = list(ffmpeg[0].cmd)
    assert cmd[cmd.index("-i") + 1] == str(tmp_path / "music.flac")


async def test_an_unknown_station_file_names_the_ones_there_are(ffmpeg, monkeypatch, tmp_path):
    (tmp_path / "music.flac").write_bytes(b"fLaC")
    monkeypatch.setenv(debug._TEST_AUDIO_ENV, str(tmp_path))
    response = await debug.test_radio(MagicMock(headers={}), file="other.flac")
    assert response.status_code == 404
    assert b"music.flac" in response.body
    assert not ffmpeg


async def test_an_unknown_station_file_without_a_directory_says_how_to_set_one(ffmpeg, monkeypatch):
    monkeypatch.delenv(debug._TEST_AUDIO_ENV, raising=False)
    response = await debug.test_radio(MagicMock(headers={}), file="music.flac")
    assert response.status_code == 404
    assert debug._TEST_AUDIO_ENV.encode() in response.body


async def test_lists_the_test_audio_directory_and_its_files(monkeypatch, tmp_path):
    (tmp_path / "music.flac").write_bytes(b"fLaC")
    monkeypatch.setenv(debug._TEST_AUDIO_ENV, str(tmp_path))
    listed = await debug.list_test_audio()
    assert listed["directory"] == str(tmp_path)
    assert "music.flac" in listed["files"]


# ── The endless stream ──────────────────────────────────────────────────────


async def test_the_endless_stream_is_the_encoders_output(ffmpeg):
    assert await _body(await debug.test_endless("flac")) == b"".join(CHUNKS)


async def test_a_listener_hanging_up_takes_the_endless_encoder_with_it(ffmpeg):
    await _first_chunk_then_hang_up(await debug.test_endless("mp3"))
    assert ffmpeg[0].killed


async def test_the_endless_stream_from_a_listed_file_encodes_that_file(
    ffmpeg, monkeypatch, tmp_path
):
    (tmp_path / "music.flac").write_bytes(b"fLaC")
    monkeypatch.setenv(debug._TEST_AUDIO_ENV, str(tmp_path))
    await _body(await debug.test_endless("mp3", file="music.flac"))
    cmd = list(ffmpeg[0].cmd)
    assert cmd[cmd.index("-i") + 1] == str(tmp_path / "music.flac")


@pytest.mark.parametrize(("fmt", "file"), [("wav", None), ("mp3", "missing.flac")])
async def test_an_endless_stream_of_an_unknown_format_or_file_is_not_found(
    ffmpeg, monkeypatch, tmp_path, fmt, file
):
    monkeypatch.setenv(debug._TEST_AUDIO_ENV, str(tmp_path))
    response = await debug.test_endless(fmt, file=file)
    assert response.status_code == 404
    assert not ffmpeg


# ── Dispatching to the device ───────────────────────────────────────────────


def _session(target=None):
    session = MagicMock()
    session.session_id = "s1"
    session.state.active_delivery = target
    session.state.clock.play_generation = 1
    session.event_bus.broadcast = AsyncMock()
    return session


def _target(name="room A"):
    target = MagicMock()
    target.target = name
    target.play = AsyncMock()
    target.get_position = AsyncMock(return_value=1.0)
    return target


@pytest.fixture
def quiet_dispatch(monkeypatch):
    monkeypatch.setattr(debug, "build_status_dict", lambda s: {})
    monkeypatch.setattr(debug, "_apply_position_offset", AsyncMock())
    monkeypatch.setattr(debug, "_sample_endless", AsyncMock())
    monkeypatch.setattr(debug, "get_local_ip", lambda: "10.0.0.1")


async def test_the_test_tone_plays_on_the_device_already_in_use(quiet_dispatch):
    target = _target()
    session = _session(target)
    result = await debug.play_test_tone(session=session)
    assert result["status"] == "playing"
    st = session.state
    assert st.current_track.id == debug.TEST_TONE_TRACK_ID
    assert st.current_output_format == debug.FALLBACK_FORMAT
    url = target.play.await_args.args[0]
    assert url == debug.stream_url("s1", debug.FALLBACK_FORMAT.content_type)
    session.event_bus.broadcast.assert_awaited_once()


@pytest.mark.parametrize("dispatch", [debug.play_test_tone, debug.play_endless])
async def test_without_a_device_in_use_nothing_is_dispatched(quiet_dispatch, dispatch):
    session = _session(None)
    kwargs = {"fmt": "mp3", "duration": "none"} if dispatch is debug.play_endless else {}
    result = await dispatch(session=session, **kwargs)
    assert "error" in result
    session.event_bus.broadcast.assert_not_called()


@pytest.mark.parametrize("dispatch", [debug.play_test_tone, debug.play_endless])
async def test_a_device_refusing_the_dispatch_is_reported(quiet_dispatch, dispatch):
    target = _target()
    target.play.side_effect = RuntimeError("speaker said no")
    session = _session(target)
    kwargs = {"fmt": "mp3", "duration": "none"} if dispatch is debug.play_endless else {}
    result = await dispatch(session=session, **kwargs)
    assert result == {"error": "speaker said no"}
    session.event_bus.broadcast.assert_not_called()


async def test_endless_positions_are_logged_per_device_until_something_else_plays(
    monkeypatch, caplog
):
    monkeypatch.setattr(debug, "_ENDLESS_SAMPLE_SECONDS", 0)
    a, b = _target("room A"), _target("room B")
    b.get_position.side_effect = RuntimeError("timed out")
    group = MagicMock(deliveries=[a, b])
    session = _session(group)
    polls = 0

    async def position():
        nonlocal polls
        polls += 1
        if polls == 3:
            session.state.clock.play_generation = 2  # something else played
        return 12.5

    a.get_position.side_effect = position
    with caplog.at_level("INFO", logger=debug.logger.name):
        async with asyncio.timeout(2):
            await debug._sample_endless(session, 1, 0.0)
    assert polls == 3
    assert "room A: wall=" in caplog.text and "device=12.50s" in caplog.text
    assert "room B: position failed" in caplog.text


async def test_endless_sampling_stops_when_the_device_is_let_go(monkeypatch):
    monkeypatch.setattr(debug, "_ENDLESS_SAMPLE_SECONDS", 0)
    target = _target()
    session = _session(target)
    session.state.active_delivery = None
    async with asyncio.timeout(2):
        await debug._sample_endless(session, 1, 0.0)
    target.get_position.assert_not_called()
