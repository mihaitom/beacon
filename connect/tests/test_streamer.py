"""Tests for core/streamer.py — source-codec detection and the resulting
ffmpeg command selection (stream-copy vs. lossless re-encode vs. the mp3
192k fallback). See resolve_output_format()'s docstring for the tiers."""

import asyncio
import logging
from unittest.mock import AsyncMock, patch

import pytest

from core.streamer import (
    FALLBACK_FORMAT,
    OutputFormat,
    _probe_source_codec,
    demuxer_for,
    resolve_output_format,
    stream_tracks,
)


def _fake_probe_proc(stderr: bytes, returncode: int = 1):
    """A fake ffmpeg -i subprocess: `ffmpeg -i <url>` with no output target
    always exits non-zero after printing stream info to stderr — that's the
    expected shape _probe_source_codec() parses, not a failure."""
    proc = AsyncMock()
    proc.communicate = AsyncMock(return_value=(b"", stderr))
    proc.returncode = returncode
    return proc


# ── _probe_source_codec ──────────────────────────────────────────────────────


def test_probe_source_codec_parses_flac_stream_line():
    stderr = b"Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)"
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        codec = asyncio.run(_probe_source_codec("http://nav/stream"))
    assert codec == "flac"


def test_probe_source_codec_parses_mp3_stream_line():
    stderr = b"Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s"
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        codec = asyncio.run(_probe_source_codec("http://nav/stream"))
    assert codec == "mp3"


def test_probe_source_codec_returns_none_when_no_audio_stream_line():
    stderr = b"Some unrelated ffmpeg banner output, no Stream line at all"
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=_fake_probe_proc(stderr))):
        codec = asyncio.run(_probe_source_codec("http://nav/stream"))
    assert codec is None


def test_probe_source_codec_returns_none_on_subprocess_failure():
    with patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=OSError("boom"))):
        codec = asyncio.run(_probe_source_codec("http://nav/stream"))
    assert codec is None


def test_probe_source_codec_returns_none_on_timeout():
    proc = AsyncMock()
    proc.communicate = AsyncMock(side_effect=asyncio.TimeoutError)
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        codec = asyncio.run(_probe_source_codec("http://nav/stream"))
    assert codec is None


# ── resolve_output_format tiers ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "codec,expected_muxer,expected_content_type",
    [
        ("flac", "flac", "audio/flac"),
        ("mp3", "mp3", "audio/mpeg"),
        ("aac", "adts", "audio/aac"),
        ("vorbis", "ogg", "audio/ogg"),
    ],
)
def test_resolve_output_format_copy_tier(codec, expected_muxer, expected_content_type):
    with patch("core.streamer._probe_source_codec", AsyncMock(return_value=codec)):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.ffmpeg_args == ["-acodec", "copy", "-f", expected_muxer]
    assert fmt.content_type == expected_content_type
    assert "-ar" not in fmt.ffmpeg_args


@pytest.mark.parametrize("codec", ["alac", "pcm_s16le", "pcm_s24le", "pcm_s16be", "ape"])
def test_resolve_output_format_lossless_reencode_tier(codec):
    with patch("core.streamer._probe_source_codec", AsyncMock(return_value=codec)):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt.ffmpeg_args == ["-acodec", "flac", "-f", "flac"]
    assert fmt.content_type == "audio/flac"
    assert "-ar" not in fmt.ffmpeg_args


def test_resolve_output_format_falls_back_when_detection_fails():
    with patch("core.streamer._probe_source_codec", AsyncMock(return_value=None)):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt is FALLBACK_FORMAT
    assert fmt.content_type == "audio/mpeg"
    assert "-ar" in fmt.ffmpeg_args


def test_resolve_output_format_falls_back_for_unrecognized_codec():
    with patch("core.streamer._probe_source_codec", AsyncMock(return_value="wmav2")):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt is FALLBACK_FORMAT


def test_resolve_output_format_falls_back_for_opus():
    """Regression test: confirmed live (2026-08-19) that a real Sonos speaker
    accepts an opus-in-ogg stream-copy URI but produces no audio for it —
    Sonos' own published format list has no Opus entry (only Ogg Vorbis).
    Opus must stay out of the copy tier and fall through to the mp3
    fallback instead of risking silent playback on real hardware."""
    with patch("core.streamer._probe_source_codec", AsyncMock(return_value="opus")):
        fmt = asyncio.run(resolve_output_format("http://nav/stream"))
    assert fmt is FALLBACK_FORMAT


# ── demuxer_for() ─────────────────────────────────────────────────────────────
# Regression tests: core/audio_analysis.py's AudioAnalyzer used to hardcode
# "-f mp3" for its own decode-only ffmpeg process regardless of what
# resolve_output_format() actually chose — GET /visualizer silently never
# produced a single real frame for any track that resolved to flac/aac/ogg
# copy-through or the lossless-reencode-to-flac tier (confirmed live: mp3
# worked, flac didn't). demuxer_for() is what routes/stream.py now feeds
# AudioAnalyzer instead of assuming mp3.


@pytest.mark.parametrize(
    "muxer,expected_demuxer",
    [
        ("mp3", "mp3"),
        ("flac", "flac"),
        ("ogg", "ogg"),
        # The one name that *isn't* symmetric: ffmpeg's muxer for raw ADTS
        # AAC is "adts", but it has no "adts" demuxer — reading it back
        # needs "aac" instead.
        ("adts", "aac"),
    ],
)
def test_demuxer_for_known_muxers(muxer, expected_demuxer):
    fmt = OutputFormat(ffmpeg_args=["-acodec", "copy", "-f", muxer], content_type="x", label="x")
    assert demuxer_for(fmt) == expected_demuxer


def test_demuxer_for_unknown_muxer_falls_back_to_mp3():
    fmt = OutputFormat(ffmpeg_args=["-acodec", "copy", "-f", "wav"], content_type="x", label="x")
    assert demuxer_for(fmt) == "mp3"


def test_demuxer_for_fallback_format_is_mp3():
    assert demuxer_for(FALLBACK_FORMAT) == "mp3"


# ── stream_tracks() command building ─────────────────────────────────────────


class _FakeProc:
    """Fake ffmpeg subprocess for stream_tracks() — yields no audio bytes,
    just lets the command that would have been run be inspected."""

    def __init__(self):
        self.returncode = 0
        self.stdout = AsyncMock()
        self.stdout.read = AsyncMock(side_effect=[b"", b""])
        self.stderr = AsyncMock()
        self.stderr.read = AsyncMock(return_value=b"")

    async def wait(self):
        return None


async def _drain(url, output_format):
    captured_cmd = {}

    async def _fake_exec(*cmd, **kwargs):
        captured_cmd["cmd"] = cmd
        return _FakeProc()

    with patch("asyncio.create_subprocess_exec", _fake_exec):
        async for _ in stream_tracks([url], output_format=output_format):
            pass
    return captured_cmd["cmd"]


def test_stream_tracks_copy_tier_omits_forced_resample():
    fmt = OutputFormat(ffmpeg_args=["-acodec", "copy", "-f", "flac"], content_type="audio/flac")
    cmd = asyncio.run(_drain("http://nav/stream", fmt))
    assert "-ar" not in cmd
    assert "-acodec" in cmd and cmd[cmd.index("-acodec") + 1] == "copy"
    assert "-f" in cmd and cmd[cmd.index("-f") + 1] == "flac"


def test_stream_tracks_lossless_reencode_tier_omits_forced_resample():
    fmt = OutputFormat(ffmpeg_args=["-acodec", "flac", "-f", "flac"], content_type="audio/flac")
    cmd = asyncio.run(_drain("http://nav/stream", fmt))
    assert "-ar" not in cmd


def test_stream_tracks_fallback_keeps_forced_resample():
    cmd = asyncio.run(_drain("http://nav/stream", FALLBACK_FORMAT))
    assert "-ar" in cmd and cmd[cmd.index("-ar") + 1] == "44100"
    assert "-acodec" in cmd and cmd[cmd.index("-acodec") + 1] == "libmp3lame"


def test_stream_tracks_defaults_to_fallback_when_no_format_given():
    cmd = asyncio.run(_drain("http://nav/stream", None))
    assert "-ar" in cmd and cmd[cmd.index("-ar") + 1] == "44100"


async def _drain_kwargs(url, **kwargs):
    captured_cmd = {}

    async def _fake_exec(*cmd, **_kwargs):
        captured_cmd["cmd"] = cmd
        return _FakeProc()

    with patch("asyncio.create_subprocess_exec", _fake_exec):
        async for _ in stream_tracks([url], **kwargs):
            pass
    return captured_cmd["cmd"]


def test_stream_tracks_empty_url_list_yields_nothing():
    async def _collect():
        return [chunk async for chunk in stream_tracks([])]

    assert asyncio.run(_collect()) == []


def test_stream_tracks_calls_on_track_start_for_each_track_with_its_index():
    calls = []

    async def _fake_exec(*cmd, **kwargs):
        return _FakeProc()

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(
                ["http://a", "http://b"], on_track_start=lambda i: calls.append(i)
            ):
                pass

    asyncio.run(_run())
    assert calls == [0, 1]


def test_stream_tracks_seeks_the_first_track_when_start_offset_is_set():
    cmd = asyncio.run(_drain_kwargs("http://nav/stream", start_offset=12.5))
    assert cmd[cmd.index("-ss") + 1] == "12.500"
    # Before -i, for fast input-side seeking — see the function's own comment.
    assert cmd.index("-ss") < cmd.index("-i")


def test_stream_tracks_ignores_a_negligible_start_offset():
    cmd = asyncio.run(_drain_kwargs("http://nav/stream", start_offset=0.2))
    assert "-ss" not in cmd


def test_stream_tracks_applies_a_gain_filter_when_not_unity():
    cmd = asyncio.run(_drain_kwargs("http://nav/stream", gain=0.5))
    assert cmd[cmd.index("-af") + 1] == "volume=0.5"
    assert cmd.index("-af") < cmd.index("-vn")


def test_stream_tracks_omits_the_gain_filter_at_unity():
    cmd = asyncio.run(_drain_kwargs("http://nav/stream", gain=1.0))
    assert "-af" not in cmd


# ── stream_tracks() process I/O and failure handling ─────────────────────────


class _ConfigurableFakeProc:
    """Like _FakeProc above, but stdout.read()'s sequence, stderr, returncode
    and kill() are all configurable — for exercising the actual byte-yielding
    and failure-handling paths below, not just the command that got built."""

    def __init__(self, stdout_chunks=(b"",), stderr: bytes = b"", returncode: int = 0, kill_error=None):
        self.returncode = returncode
        self.stdout = AsyncMock()
        self.stdout.read = AsyncMock(side_effect=list(stdout_chunks))
        self.stderr = AsyncMock()
        self.stderr.read = AsyncMock(return_value=stderr)
        self.killed = False
        self._kill_error = kill_error

    def kill(self) -> None:  # real Process.kill() is synchronous, not awaited
        self.killed = True
        if self._kill_error:
            raise self._kill_error

    async def wait(self):
        return None


def test_stream_tracks_yields_the_process_stdout_chunks():
    proc = _ConfigurableFakeProc(stdout_chunks=[b"abc", b"def", b""])

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _collect():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            return [chunk async for chunk in stream_tracks(["http://nav/stream"])]

    assert asyncio.run(_collect()) == [b"abc", b"def"]


def test_stream_tracks_logs_a_warning_on_a_nonzero_ffmpeg_exit(caplog):
    proc = _ConfigurableFakeProc(stderr=b"unsupported codec", returncode=1)

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with caplog.at_level(logging.WARNING, logger="connect.streamer"):
        asyncio.run(_run())

    assert "exit 1" in caplog.text
    assert "unsupported codec" in caplog.text


def test_stream_tracks_logs_stray_stderr_output_at_debug_even_on_success(caplog):
    proc = _ConfigurableFakeProc(stderr=b"a warning ffmpeg printed anyway", returncode=0)

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with caplog.at_level(logging.DEBUG, logger="connect.streamer"):
        asyncio.run(_run())

    assert "a warning ffmpeg printed anyway" in caplog.text


def test_stream_tracks_propagates_and_logs_when_ffmpeg_binary_is_missing(caplog):
    """Propagates (not a silent early return) so stream_with_completion()
    doesn't mistake a missing ffmpeg binary for a normal end-of-stream and
    fire a track-end broadcast — see the function's own comment."""

    async def _fake_exec(*cmd, **kwargs):
        raise FileNotFoundError()

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with (
        caplog.at_level(logging.ERROR, logger="connect.streamer"),
        pytest.raises(FileNotFoundError),
    ):
        asyncio.run(_run())

    assert "ffmpeg not found" in caplog.text


def test_stream_tracks_kills_the_process_and_reraises_on_cancellation():
    proc = _ConfigurableFakeProc(stdout_chunks=[b"chunk", asyncio.CancelledError()])

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(_run())

    assert proc.killed is True


def test_stream_tracks_swallows_a_kill_error_during_cancellation():
    proc = _ConfigurableFakeProc(
        stdout_chunks=[asyncio.CancelledError()], kill_error=RuntimeError("already dead")
    )

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with pytest.raises(asyncio.CancelledError):  # not the kill() error instead
        asyncio.run(_run())


def test_stream_tracks_kills_the_process_and_reraises_on_an_unexpected_error():
    """Propagates rather than silently ending the generator — a genuine
    ffmpeg failure (crash, decode error) is not a natural end either, same
    reasoning as the missing-binary case above."""
    proc = _ConfigurableFakeProc(stdout_chunks=[RuntimeError("pipe broke")])

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with pytest.raises(RuntimeError):
        asyncio.run(_run())

    assert proc.killed is True


def test_stream_tracks_swallows_a_kill_error_after_an_unexpected_error():
    proc = _ConfigurableFakeProc(
        stdout_chunks=[RuntimeError("pipe broke")], kill_error=RuntimeError("already dead")
    )

    async def _fake_exec(*cmd, **kwargs):
        return proc

    async def _run():
        with patch("asyncio.create_subprocess_exec", _fake_exec):
            async for _ in stream_tracks(["http://nav/stream"]):
                pass

    with pytest.raises(RuntimeError, match="pipe broke"):  # not the kill() error instead
        asyncio.run(_run())
