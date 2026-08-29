"""Tests for routes/local_stream.py — transcoding for Beacon's own player.

The thing worth testing here is not that ffmpeg runs; it's the byte
arithmetic around it. A transcode has no natural length and no natural byte
offsets, and this route invents both so that a browser's `<audio>` element
can seek in it (see the module docstring). Get that wrong and playback works
perfectly right up until someone drags the scrub bar.
"""

import asyncio
import logging
from unittest.mock import AsyncMock, patch

import pytest

from core.streamer import SourceInfo
from routes import local_stream
from routes.local_stream import _parse_range, _probe_cached, reset_probe_cache

# 192 kbps = 24000 bytes per second. A 180s track is 4,320,000 bytes, and
# every expectation below is derived from those two numbers rather than
# copied, so a changed bitrate can't quietly invalidate them.
_BR = 192
_BYTES_PER_SECOND = _BR * 1000 / 8
_DURATION = 180.0
_TOTAL = int(_BYTES_PER_SECOND * _DURATION)


@pytest.fixture(autouse=True)
def _clean_probe_cache():
    reset_probe_cache()
    yield
    reset_probe_cache()


def _info(duration: float | None = _DURATION, sample_rate: int | None = 44100):
    return SourceInfo(
        codec="flac",
        sample_rate=sample_rate,
        bit_depth=16,
        bitrate_kbps=None,
        duration=duration,
    )


class _FakeProc:
    """An ffmpeg that produces `chunks` and then EOF."""

    def __init__(self, chunks: list[bytes]):
        self._chunks = list(chunks)
        self.returncode = None
        self.killed = False
        self.stdout = self
        self.stderr = AsyncMock()
        self.stderr.read = AsyncMock(return_value=b"")

    async def read(self, _n: int) -> bytes:
        if self._chunks:
            return self._chunks.pop(0)
        return b""

    async def wait(self):
        self.returncode = 0
        return 0

    def kill(self):
        self.killed = True
        self.returncode = -9


def _request(client, default_session, url: str, headers: dict | None = None):
    """Issue `url` against a configured session with the probe and ffmpeg
    both faked, and hand back (response, ffmpeg argv)."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    default_session.authenticated = True
    captured: dict = {}

    async def _fake_exec(*cmd, **kwargs):
        captured["cmd"] = list(cmd)
        return _FakeProc([b"audio-bytes"])

    with (
        patch("routes.local_stream._probe_source", AsyncMock(return_value=_info())),
        patch(
            "media.SubsonicClient.get_stream_url",
            lambda self, track_id: f"http://nav:4533/rest/stream.view?id={track_id}",
        ),
        patch("asyncio.create_subprocess_exec", _fake_exec),
    ):
        response = client.get(url, headers=headers or {})
    return response, captured.get("cmd", [])


# ── Format/bitrate validation ────────────────────────────────────────────────


def test_unknown_format_is_rejected(client, default_session):
    response, _ = _request(client, default_session, "/stream/local/1?fmt=wma&br=192")

    assert response.status_code == 400
    assert "wma" in response.json()["error"]


def test_a_bitrate_the_format_does_not_offer_is_rejected(client, default_session):
    """`br` arrives from a query string — an unbounded integer there would
    let a caller ask for an encode nobody wanted and no encoder produces."""
    response, _ = _request(client, default_session, "/stream/local/1?fmt=mp3&br=3000")

    assert response.status_code == 400
    assert "3000" in response.json()["error"]


def test_only_mp3_is_offered_here(client, default_session):
    """aac and opus are real encoders this app uses for casting, and are
    deliberately absent here: neither holds the bitrate it is given, so the
    length this route declares — and therefore every seek made against it —
    would be wrong. See ALLOWED_BITRATES for the measured numbers."""
    assert set(local_stream.ALLOWED_BITRATES) == {"mp3"}


@pytest.mark.parametrize("fmt", ["aac", "opus"])
def test_a_cast_only_format_is_rejected_here(fmt, client, default_session):
    response, _ = _request(client, default_session, f"/stream/local/1?fmt={fmt}&br=128")

    assert response.status_code == 400


def test_original_is_not_a_format_this_route_serves(client, default_session):
    """Untouched playback keeps going through /rest/stream.view instead, so
    that path never grows a second implementation to keep in step."""
    response, _ = _request(client, default_session, "/stream/local/1?fmt=original&br=192")

    assert response.status_code == 400


# ── A plain request ──────────────────────────────────────────────────────────


def test_plain_request_declares_length_and_range_support(client, default_session):
    response, cmd = _request(client, default_session, f"/stream/local/1?fmt=mp3&br={_BR}")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mpeg")
    assert response.headers["content-length"] == str(_TOTAL)
    assert response.headers["accept-ranges"] == "bytes"
    # No -ss: this is the start of the track.
    assert "-ss" not in cmd
    assert response.content == b"audio-bytes"


def test_the_encode_is_not_paced(client, default_session):
    """core/streamer.py's -readrate arguments exist to stop a *cast device*
    being handed an hour of audio at once. A browser fills its own buffer
    and waiting on it would just stall playback."""
    _, cmd = _request(client, default_session, f"/stream/local/1?fmt=mp3&br={_BR}")

    assert "-readrate" not in cmd


def test_a_source_of_unknown_duration_still_plays(client, default_session):
    """No duration means no length and therefore no seeking — but refusing
    to play at all would be a much worse answer than a stuck scrub bar."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})

    async def _fake_exec(*cmd, **kwargs):
        return _FakeProc([b"audio-bytes"])

    with (
        patch(
            "routes.local_stream._probe_source",
            AsyncMock(return_value=_info(duration=None)),
        ),
        patch(
            "media.SubsonicClient.get_stream_url",
            lambda self, track_id: "http://nav/x",
        ),
        patch("asyncio.create_subprocess_exec", _fake_exec),
    ):
        response = client.get(f"/stream/local/1?fmt=mp3&br={_BR}")

    assert response.status_code == 200
    assert "content-length" not in response.headers
    assert "accept-ranges" not in response.headers


# ── The info endpoint ────────────────────────────────────────────────────────


def _info_request(client, default_session, probe_result):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    with (
        patch("routes.local_stream._probe_source", AsyncMock(return_value=probe_result)),
        patch("media.SubsonicClient.get_stream_url", lambda self, track_id: "http://nav/x"),
    ):
        return client.get("/stream/local/track-1/info")


def test_info_reports_what_the_probe_found(client, default_session):
    """The media server's metadata carries neither sample rate nor bit
    depth, which is the whole reason this exists rather than the frontend
    reading what it already has."""
    response = _info_request(
        client,
        default_session,
        SourceInfo(
            codec="flac",
            sample_rate=96000,
            bit_depth=24,
            bitrate_kbps=None,
            duration=180.0,
        ),
    )

    assert response.status_code == 200
    assert response.json() == {
        "source_codec": "flac",
        "source_sample_rate": 96000,
        "source_bit_depth": 24,
        "source_bitrate_kbps": None,
    }


def test_info_says_unknown_rather_than_guessing_when_the_probe_fails(client, default_session):
    """Deriving a codec from the file extension would fill the panel with
    something that looks like a measurement and isn't."""
    response = _info_request(client, default_session, None)

    assert response.status_code == 200
    assert response.json() == {
        "source_codec": None,
        "source_sample_rate": None,
        "source_bit_depth": None,
        "source_bitrate_kbps": None,
    }


def test_info_says_nothing_about_the_output_format(client, default_session):
    """Which format is being served is the caller's own setting — answering
    it here too would put the same decision in two places."""
    response = _info_request(
        client,
        default_session,
        SourceInfo(codec="flac", sample_rate=44100, bit_depth=16, bitrate_kbps=None, duration=1.0),
    )

    assert not any(key.startswith("target") for key in response.json())
    assert "transcoding" not in response.json()


def test_info_shares_the_probe_cache_with_playback(client, default_session):
    """Opening the panel during playback must not re-probe: the track being
    played has already been probed by the streaming route."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    probe = AsyncMock(return_value=_info())

    async def _fake_exec(*cmd, **kwargs):
        return _FakeProc([b"audio-bytes"])

    with (
        patch("routes.local_stream._probe_source", probe),
        patch("media.SubsonicClient.get_stream_url", lambda self, track_id: "http://nav/x"),
        patch("asyncio.create_subprocess_exec", _fake_exec),
    ):
        client.get(f"/stream/local/track-1?fmt=mp3&br={_BR}")
        client.get("/stream/local/track-1/info")

    probe.assert_awaited_once()


def test_info_for_an_unresolvable_track_is_a_502(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})

    def _boom(self, track_id):
        raise RuntimeError("no such track")

    with patch("media.SubsonicClient.get_stream_url", _boom):
        response = client.get("/stream/local/track-1/info")

    assert response.status_code == 502


# ── Range handling — where seeking actually lives ────────────────────────────


def test_range_request_seeks_ffmpeg_to_the_matching_second(client, default_session):
    """The byte offset the browser asks for and the second ffmpeg is given
    are the same number in two units. 60 seconds in at 192kbps is
    1,440,000 bytes."""
    start = int(_BYTES_PER_SECOND * 60)
    response, cmd = _request(
        client,
        default_session,
        f"/stream/local/1?fmt=mp3&br={_BR}",
        headers={"Range": f"bytes={start}-"},
    )

    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes {start}-{_TOTAL - 1}/{_TOTAL}"
    assert cmd[cmd.index("-ss") + 1] == "60.000"
    # -ss must sit before -i to seek on the input side, same as
    # core/streamer.py's stream_tracks().
    assert cmd.index("-ss") < cmd.index("-i")


def test_an_explicit_range_window_is_not_overrun(client, default_session):
    """Safari opens a media element with `bytes=0-1`. ffmpeg has no idea
    only two bytes were asked for and would encode the whole track into a
    pipe nobody reads."""
    response, _ = _request(
        client,
        default_session,
        f"/stream/local/1?fmt=mp3&br={_BR}",
        headers={"Range": "bytes=0-1"},
    )

    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes 0-1/{_TOTAL}"
    assert response.headers["content-length"] == "2"
    assert response.content == b"au"


def test_a_malformed_range_is_answered_as_a_plain_request(client, default_session):
    response, cmd = _request(
        client,
        default_session,
        f"/stream/local/1?fmt=mp3&br={_BR}",
        headers={"Range": "bytes=0-10, 20-30"},
    )

    assert response.status_code == 200
    assert "-ss" not in cmd


def test_ffmpeg_is_killed_once_the_range_window_is_full(client, default_session):
    """The break out of the read loop leaves ffmpeg running with nothing
    reading it — one orphaned process per Safari probe, otherwise."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    proc = _FakeProc([b"audio-bytes"])

    async def _fake_exec(*cmd, **kwargs):
        return proc

    with (
        patch("routes.local_stream._probe_source", AsyncMock(return_value=_info())),
        patch("media.SubsonicClient.get_stream_url", lambda self, track_id: "http://nav/x"),
        patch("asyncio.create_subprocess_exec", _fake_exec),
    ):
        client.get(f"/stream/local/1?fmt=mp3&br={_BR}", headers={"Range": "bytes=0-1"})

    assert proc.killed is True


def test_an_ffmpeg_that_exited_between_the_check_and_the_kill_is_not_an_error(
    client, default_session
):
    """`returncode is None` is checked a moment before kill() runs, and the
    process can end in between — a real race, not a hypothetical one, since
    the byte-limit break happens exactly when ffmpeg is still writing."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})

    class _VanishingProc(_FakeProc):
        def kill(self):
            raise ProcessLookupError

    async def _fake_exec(*cmd, **kwargs):
        return _VanishingProc([b"audio-bytes"])

    with (
        patch("routes.local_stream._probe_source", AsyncMock(return_value=_info())),
        patch("media.SubsonicClient.get_stream_url", lambda self, track_id: "http://nav/x"),
        patch("asyncio.create_subprocess_exec", _fake_exec),
    ):
        response = client.get(f"/stream/local/1?fmt=mp3&br={_BR}", headers={"Range": "bytes=0-1"})

    assert response.status_code == 206
    assert response.content == b"au"


def test_a_failing_ffmpeg_is_logged_rather_than_swallowed(client, default_session, caplog):
    """A decode failure produces an empty body and a 200 either way — the
    log line is the only thing that says why."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})

    class _FailingProc(_FakeProc):
        async def wait(self):
            self.returncode = 1
            return 1

    proc = _FailingProc([])
    proc.stderr.read = AsyncMock(return_value=b"Invalid data found")

    async def _fake_exec(*cmd, **kwargs):
        return proc

    with (
        patch("routes.local_stream._probe_source", AsyncMock(return_value=_info())),
        patch("media.SubsonicClient.get_stream_url", lambda self, track_id: "http://nav/x"),
        patch("asyncio.create_subprocess_exec", _fake_exec),
        caplog.at_level(logging.WARNING, logger="connect.streamer"),
    ):
        response = client.get(f"/stream/local/1?fmt=mp3&br={_BR}")

    assert response.status_code == 200
    assert any("Invalid data found" in r.message for r in caplog.records)


def test_a_missing_ffmpeg_says_so(client, default_session, caplog):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})

    async def _fake_exec(*cmd, **kwargs):
        raise FileNotFoundError("ffmpeg")

    with (
        patch("routes.local_stream._probe_source", AsyncMock(return_value=_info())),
        patch("media.SubsonicClient.get_stream_url", lambda self, track_id: "http://nav/x"),
        patch("asyncio.create_subprocess_exec", _fake_exec),
        caplog.at_level(logging.ERROR, logger="connect.streamer"),
        pytest.raises(FileNotFoundError),
    ):
        client.get(f"/stream/local/1?fmt=mp3&br={_BR}")

    assert any("ffmpeg not found" in r.message for r in caplog.records)


def test_a_track_the_media_server_cannot_resolve_is_a_502(client, default_session):
    """Not a 500: the failure is upstream, and the frontend distinguishes
    the two when deciding whether to retry."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})

    def _boom(self, track_id):
        raise RuntimeError("no such track")

    with patch("media.SubsonicClient.get_stream_url", _boom):
        response = client.get(f"/stream/local/1?fmt=mp3&br={_BR}")

    assert response.status_code == 502
    assert "no such track" in response.json()["error"]


# ── _parse_range() on its own ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "header,expected",
    [
        ("bytes=0-", (0, 999)),
        ("bytes=100-", (100, 999)),
        ("bytes=0-1", (0, 1)),
        ("bytes=100-199", (100, 199)),
        # Past the real end of the body — clamped, not refused.
        ("bytes=100-5000", (100, 999)),
        (None, None),
        ("", None),
        ("items=0-10", None),
        ("bytes=-500", None),
    ],
)
def test_parse_range(header, expected):
    assert _parse_range(header, 1000) == expected


def test_a_start_past_the_end_falls_back_to_the_whole_body():
    """The length here is an estimate (see transcoded_byte_length()), so a
    start past it can mean the estimate was a few hundred bytes short
    rather than that the client asked for something unreasonable. Refusing
    would stop playback over rounding."""
    assert _parse_range("bytes=1000-", 1000) is None


# ── The probe cache ──────────────────────────────────────────────────────────


def test_probe_is_reused_for_a_second_request_for_the_same_track():
    """A seek is a second request for the same track seconds after the
    first, and probing is a real ffmpeg invocation — without this, every
    scrub pays for one."""
    probe = AsyncMock(return_value=_info())

    async def _run():
        with patch("routes.local_stream._probe_source", probe):
            first = await _probe_cached("s1", "track-1", "http://nav/x")
            second = await _probe_cached("s1", "track-1", "http://nav/x")
        return first, second

    first, second = asyncio.run(_run())

    assert first is second
    probe.assert_awaited_once()


def test_two_sessions_do_not_share_a_probe_for_the_same_track_id():
    """Two sessions can be logged into two different media servers, where
    the same track id means two entirely different files."""
    probe = AsyncMock(side_effect=[_info(), _info(duration=90.0)])

    async def _run():
        with patch("routes.local_stream._probe_source", probe):
            a = await _probe_cached("s1", "track-1", "http://nav-a/x")
            b = await _probe_cached("s2", "track-1", "http://nav-b/x")
        return a, b

    a, b = asyncio.run(_run())

    assert a.duration == _DURATION
    assert b.duration == 90.0


def test_a_failed_probe_is_not_cached():
    """Caching a failure would keep a track unplayable for the whole TTL
    over one transient lookup."""
    probe = AsyncMock(side_effect=[None, _info()])

    async def _run():
        with patch("routes.local_stream._probe_source", probe):
            first = await _probe_cached("s1", "track-1", "http://nav/x")
            second = await _probe_cached("s1", "track-1", "http://nav/x")
        return first, second

    first, second = asyncio.run(_run())

    assert first is None
    assert second is not None


def test_the_cache_evicts_rather_than_growing_without_bound():
    async def _run():
        with patch("routes.local_stream._probe_source", AsyncMock(return_value=_info())):
            for i in range(local_stream._PROBE_CACHE_MAX + 10):
                await _probe_cached("s1", f"track-{i}", "http://nav/x")

    asyncio.run(_run())

    assert len(local_stream._probe_cache) <= local_stream._PROBE_CACHE_MAX


def test_a_stale_probe_is_re_taken(monkeypatch):
    """The library can change under a running session — a re-tagged or
    replaced file must not keep serving the old duration forever."""
    probe = AsyncMock(side_effect=[_info(), _info(duration=90.0)])
    clock = {"now": 1000.0}
    monkeypatch.setattr(local_stream.time, "monotonic", lambda: clock["now"])

    async def _run():
        with patch("routes.local_stream._probe_source", probe):
            first = await _probe_cached("s1", "track-1", "http://nav/x")
            clock["now"] += local_stream._PROBE_TTL_SECONDS + 1
            second = await _probe_cached("s1", "track-1", "http://nav/x")
        return first, second

    first, second = asyncio.run(_run())

    assert first.duration == _DURATION
    assert second.duration == 90.0
