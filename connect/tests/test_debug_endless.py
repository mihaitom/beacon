"""Tests for routes/debug.py's endless track stream - the measuring aid for
whether a speaker plays a mix that never ends (see the section comment
there). No test runs ffmpeg; what matters is that the stream is paced and
looped like a cast track, and what the device is told."""

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from routes import debug


@pytest.mark.parametrize("fmt", debug._ENDLESS_FORMATS)
def test_the_stream_is_paced_like_a_cast_track_and_never_ends(fmt):
    cmd = debug._endless_cmd("tone.wav", fmt)
    assert cmd[cmd.index("-readrate") + 1] == "1"
    assert cmd[cmd.index("-readrate_initial_burst") + 1] == "15"
    assert cmd[cmd.index("-stream_loop") + 1] == "-1"
    assert cmd[cmd.index("-i") + 1] == "tone.wav"
    assert cmd[-1] == "pipe:1"


def test_each_format_is_announced_as_what_it_is():
    assert debug._endless_content_type("mp3") == "audio/mpeg"
    assert debug._endless_content_type("aac") == "audio/aac"
    assert debug._endless_content_type("flac") == "audio/flac"


def _session_with_target():
    session = MagicMock()
    st = session.state
    st.clock.play_generation = 1
    target = MagicMock()
    target.play = AsyncMock()
    st.active_delivery = target
    session.event_bus.broadcast = AsyncMock()
    return session, target


@pytest.mark.parametrize(("duration", "announced"), [("none", None), ("long", 36000.0)])
def test_dispatches_as_a_track_with_the_chosen_length(monkeypatch, duration, announced):
    monkeypatch.setattr(debug, "get_local_ip", lambda: "10.0.0.1")
    monkeypatch.setattr(debug, "build_status_dict", lambda s: {})
    monkeypatch.setattr(debug, "_sample_endless", AsyncMock())
    session, target = _session_with_target()

    result = asyncio.run(debug.play_endless(fmt="flac", duration=duration, session=session))

    assert result["status"] == "playing"
    args = target.play.await_args.args
    assert args[0] == f"http://10.0.0.1:{debug.PORT}/debug/test-endless.flac"
    assert args[4] == announced
    assert args[6] == "audio/flac"
    session.state.clock.start.assert_called_once_with(0.0)


def test_refuses_an_unknown_format_without_touching_the_device():
    session, target = _session_with_target()
    result = asyncio.run(debug.play_endless(fmt="wav", duration="none", session=session))
    assert "error" in result
    target.play.assert_not_called()


def _source_ffmpeg_is_given(response) -> str:
    """Starts the response body just far enough to see which input ffmpeg
    would be pointed at."""
    seen = {}

    async def fake_exec(*cmd, **kwargs):
        seen["source"] = cmd[list(cmd).index("-i") + 1]
        raise RuntimeError("stop here")

    async def first_chunk():
        with pytest.raises(RuntimeError, match="stop here"):
            await anext(response.body_iterator)

    with patch.object(debug.asyncio, "create_subprocess_exec", fake_exec):
        asyncio.run(first_chunk())
    return seen["source"]


def test_the_beep_is_looped_from_a_file_not_over_http():
    """-stream_loop rewinds by seeking, and /test-tone.wav serves no byte
    ranges: looped from its URL, every "endless" stream ended after the
    tone's ten minutes, which read as the speaker giving up."""
    endless = _source_ffmpeg_is_given(asyncio.run(debug.test_endless("mp3")))
    station = _source_ffmpeg_is_given(asyncio.run(debug.test_radio(MagicMock(headers={}))))

    for source in (endless, station):
        assert Path(source).read_bytes() == debug._test_tone_bytes()
