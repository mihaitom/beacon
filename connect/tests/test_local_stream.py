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


def test_every_lossy_format_is_offered_here(client, default_session):
    """aac and opus were both absent for as long as seeking meant the
    caller dividing a declared length by the nominal bitrate - an encode is
    only that size when the music happens to need the bits, which only
    mp3's padded CBR guarantees. With `start` doing the seeking instead,
    nothing depends on that any more. See ALLOWED_BITRATES for the measured
    numbers, and the Dockerfile for the libopus that has to be in the image
    for the third one to run."""
    assert set(local_stream.ALLOWED_BITRATES) == {"mp3", "aac", "opus"}


def test_the_lossless_format_is_offered_without_a_bitrate(client, default_session):
    """Original's answer for a source the browser cannot decode. A bitrate
    for it would be a number with nothing to mean — see LOSSLESS_FORMAT."""
    response, cmd = _request(client, default_session, "/stream/local/1?fmt=flac")

    assert response.status_code == 200
    assert cmd[cmd.index("-acodec") + 1] == "flac"
    assert "-b:a" not in cmd
    # Not resampled either: a device's sample-rate limit is what that is
    # for, and a browser has none.
    assert "-ar" not in cmd


def test_a_bitrate_alongside_the_lossless_format_is_rejected(client, default_session):
    """Rejected rather than ignored: a caller sending one has misunderstood
    something, and answering anyway hides it."""
    response, _ = _request(client, default_session, "/stream/local/1?fmt=flac&br=192")

    assert response.status_code == 400


def test_a_missing_bitrate_is_still_rejected_for_a_lossy_format(client, default_session):
    """br only became optional so flac could do without it. Leaving it off
    an mp3 request is still a caller that has not said what it wants."""
    response, _ = _request(client, default_session, "/stream/local/1?fmt=mp3")

    assert response.status_code == 400


def test_the_lossless_format_declares_no_length_to_seek_against(client, default_session):
    """FLAC's output size is unknowable ahead of the encode, so there is no
    `bitrate x duration` to declare and nothing for a media element to seek
    against. The one thing that must never happen is a plausible-looking
    number here."""
    response, _ = _request(client, default_session, "/stream/local/1?fmt=flac")

    assert response.headers.get("content-length") is None
    assert "accept-ranges" not in response.headers
    assert response.headers["content-type"].startswith("audio/flac")


@pytest.mark.parametrize("fmt", ["mp3", "aac", "opus"])
def test_each_format_reaches_ffmpeg_with_its_own_encoder(fmt, client, default_session):
    """The bitrates differ per format, so each one is asked for at a value
    it actually offers - a shared number would silently test only the
    formats that happen to list it."""
    br = min(local_stream.ALLOWED_BITRATES[fmt])
    response, cmd = _request(client, default_session, f"/stream/local/1?fmt={fmt}&br={br}")

    assert response.status_code == 200
    assert cmd[cmd.index("-acodec") + 1] in {"libmp3lame", "aac", "libopus"}


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


def test_a_dropped_source_connection_is_picked_back_up_inside_ffmpeg(client, default_session):
    """Without this, one dropped TCP connection to the media server ends the
    encode, and the browser sees a stream that simply finished — recoverable
    (the frontend's endedEarly() does it) but audible, and audible in the
    one place that has no buffer to hide it: the start of a track."""
    _, cmd = _request(client, default_session, f"/stream/local/1?fmt=mp3&br={_BR}")

    assert cmd[cmd.index("-reconnect") + 1] == "1"
    assert cmd[cmd.index("-reconnect_on_network_error") + 1] == "1"
    assert cmd[cmd.index("-reconnect_delay_max") + 1] == "5"
    # Input options — after -i they would be output options and ffmpeg
    # would reject the command outright.
    assert cmd.index("-reconnect") < cmd.index("-i")
    # Never -reconnect_streamed: on a source that cannot resume at an
    # offset it reconnects without a Range and replays from the top, into
    # the middle of an encode that was already minutes in.
    assert "-reconnect_streamed" not in cmd


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


def test_start_seeks_ffmpeg_without_declaring_a_length(client, default_session):
    """The other way to start somewhere: the caller names the second it
    wants, and gets a plain stream from there.

    No length and no Accept-Ranges with it, on purpose - a caller that
    seeks for itself has no use for either, and a declared length is
    exactly what invites the media element to seek behind its back through
    a bytes-to-seconds division that only holds while the encoder really
    hits its nominal bitrate."""
    response, cmd = _request(
        client, default_session, f"/stream/local/1?fmt=mp3&br={_BR}&start=73.5"
    )

    assert response.status_code == 200
    assert "content-length" not in response.headers
    assert "accept-ranges" not in response.headers
    assert cmd[cmd.index("-ss") + 1] == "73.500"
    assert cmd.index("-ss") < cmd.index("-i")


def test_start_wins_over_a_range_header(client, default_session):
    """Both at once is a caller contradicting itself. `start` is the one
    that means "I am doing the seeking", so it is the one that counts -
    and answering with a 206 against a length this response does not have
    would be the worse of the two ways to be wrong."""
    response, cmd = _request(
        client,
        default_session,
        f"/stream/local/1?fmt=mp3&br={_BR}&start=30",
        headers={"Range": f"bytes={int(_BYTES_PER_SECOND * 60)}-"},
    )

    assert response.status_code == 200
    assert cmd[cmd.index("-ss") + 1] == "30.000"


def test_start_zero_still_means_the_caller_does_the_seeking(client, default_session):
    """Its presence is the signal, not its value. A caller that says
    `start=0` is one that will ask for other positions later, and handing
    it a length now would let the element seek against that length in the
    meantime - the one thing the parameter exists to take away."""
    response, cmd = _request(client, default_session, f"/stream/local/1?fmt=mp3&br={_BR}&start=0")

    assert response.status_code == 200
    assert "content-length" not in response.headers
    assert "accept-ranges" not in response.headers
    # Nothing to seek to, so no -ss either.
    assert "-ss" not in cmd


def test_without_start_the_length_and_ranges_are_still_offered(client, default_session):
    """The byte-range way is still there for a caller that wants it - see
    the route's docstring."""
    response, _ = _request(client, default_session, f"/stream/local/1?fmt=mp3&br={_BR}")

    assert response.headers["content-length"] == str(_TOTAL)
    assert response.headers["accept-ranges"] == "bytes"


def test_a_negative_start_is_rejected(client, default_session):
    """`start` reaches ffmpeg's -ss, so it is bounded at the door rather
    than passed through - the same reasoning ALLOWED_BITRATES has for not
    handing `br` straight to an encoder."""
    response, _ = _request(client, default_session, f"/stream/local/1?fmt=mp3&br={_BR}&start=-5")

    assert response.status_code == 422


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


def test_only_mp3_is_offered_a_length_and_ranges(client, default_session):
    """The declared length is `bitrate x duration` and a Range's start byte
    is divided by the same number — arithmetic that is only true for an
    encoder that really produces that many bytes per second. LAME's padded
    CBR does; aac and opus miss it by whole percent (see ALLOWED_BITRATES),
    so they are answered as a plain stream rather than with a length nothing
    can seek against."""
    for fmt in ("aac", "opus"):
        response, cmd = _request(client, default_session, f"/stream/local/1?fmt={fmt}&br=128")

        assert response.status_code == 200
        assert "content-length" not in response.headers
        assert "accept-ranges" not in response.headers
        # Still the start of the track, same as the mp3 case above.
        assert "-ss" not in cmd


def test_a_range_header_on_an_aac_request_is_answered_with_the_whole_stream(
    client, default_session
):
    """A 206 against a length this response never declared would be a claim
    about bytes nobody can honour."""
    response, _ = _request(
        client,
        default_session,
        "/stream/local/1?fmt=aac&br=128",
        headers={"Range": "bytes=1000-"},
    )

    assert response.status_code == 200
    assert "content-range" not in response.headers
