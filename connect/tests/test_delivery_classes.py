"""Tests for SonosDelivery, AirPlayDelivery, ChromecastDelivery and DlnaDelivery."""

import asyncio
import io
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from pyatv.const import Protocol

import delivery.chromecast as _chromecast_mod
import delivery.dlna as _dlna_mod
from core.state import ctx
from delivery import (
    AirPlayDelivery,
    BaseDelivery,
    ChromecastDelivery,
    DlnaDelivery,
    SonosDelivery,
)
from delivery.airplay import _MAX_ARTWORK_BYTES, _fetch_artwork, _ResponseReader

# ── BaseDelivery defaults (pause/resume are no-ops, position/volume unknown) ──


class _MinimalDelivery(BaseDelivery):
    """The smallest possible concrete subclass — just enough to instantiate
    BaseDelivery (an ABC) and exercise its own default implementations,
    which every real delivery below overrides."""

    async def play(self, *args, **kwargs) -> None:
        pass

    async def stop(self) -> None:
        pass


async def test_base_delivery_get_position_defaults_to_none():
    assert await _MinimalDelivery("x").get_position() is None


async def test_base_delivery_get_volume_defaults_to_none():
    assert await _MinimalDelivery("x").get_volume() is None


async def test_base_delivery_current_uri_defaults_to_none():
    """"Can't say" is the honest default — a protocol with no transport to
    query (AirPlay) must not be mistaken for one reporting "nothing playing".
    See core/session.py's reap_once(), the only caller."""
    assert await _MinimalDelivery("x").current_uri() is None


async def test_base_delivery_pause_and_resume_default_to_noops():
    d = _MinimalDelivery("x")
    await d.pause()  # must not raise
    await d.resume()


# ── SonosDelivery ─────────────────────────────────────────────────────────────


def _mock_sonos_device(is_coordinator=True, transport_state="STOPPED"):
    dev = MagicMock()
    dev.is_coordinator = is_coordinator
    dev.get_current_transport_info.return_value = {
        "current_transport_state": transport_state
    }
    return dev


def test_sonos_play_skips_unjoin_when_coordinator():
    dev = _mock_sonos_device(is_coordinator=True)
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        asyncio.run(d.play("http://stream", "Title"))
    dev.unjoin.assert_not_called()
    dev.avTransport.SetAVTransportURI.assert_called_once()
    dev.avTransport.Play.assert_called_once()


def test_sonos_play_unjoins_when_follower():
    dev = _mock_sonos_device(is_coordinator=False)
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        asyncio.run(d.play("http://stream"))
    dev.unjoin.assert_called_once()


def test_sonos_play_stops_active_transport_before_setting_uri():
    dev = _mock_sonos_device(transport_state="PLAYING")
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        asyncio.run(d.play("http://stream"))
    dev.stop.assert_called_once()


def test_sonos_play_includes_album_in_metadata():
    dev = _mock_sonos_device()
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        asyncio.run(
            d.play("http://stream", "Title", "Artist", None, None, "The Album")
        )
    call_kwargs = dict(dev.avTransport.SetAVTransportURI.call_args.args[0])
    assert "<upnp:album>The Album</upnp:album>" in call_kwargs["CurrentURIMetaData"]


def test_sonos_play_omits_album_when_not_given():
    dev = _mock_sonos_device()
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        asyncio.run(d.play("http://stream", "Title"))
    call_kwargs = dict(dev.avTransport.SetAVTransportURI.call_args.args[0])
    assert "<upnp:album>" not in call_kwargs["CurrentURIMetaData"]


def test_sonos_play_defaults_protocol_info_to_audio_mpeg():
    dev = _mock_sonos_device()
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        asyncio.run(d.play("http://stream", "Title"))
    xml = dict(dev.avTransport.SetAVTransportURI.call_args.args[0])["CurrentURIMetaData"]
    assert 'protocolInfo="http-get:*:audio/mpeg:*"' in xml


def test_sonos_play_uses_passed_content_type_in_protocol_info():
    dev = _mock_sonos_device()
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        asyncio.run(
            d.play("http://stream", "Title", "", None, None, "", "audio/flac")
        )
    xml = dict(dev.avTransport.SetAVTransportURI.call_args.args[0])["CurrentURIMetaData"]
    assert 'protocolInfo="http-get:*:audio/flac:*"' in xml


def test_sonos_pause_resume_stop_delegate_to_device():
    dev = MagicMock()
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        asyncio.run(d.pause())
        asyncio.run(d.resume())
        asyncio.run(d.stop())
    dev.pause.assert_called_once()
    dev.play.assert_called_once()
    dev.stop.assert_called_once()


def test_sonos_play_logs_unjoin_failure_and_still_proceeds(caplog):
    dev = _mock_sonos_device(is_coordinator=False)
    dev.unjoin.side_effect = RuntimeError("network hiccup")
    d = SonosDelivery("Küche")
    with (
        patch.object(SonosDelivery, "_get_device", return_value=dev),
        caplog.at_level(logging.WARNING, logger="delivery"),
    ):
        asyncio.run(d.play("http://stream"))
    assert "unjoin" in caplog.text
    # A device that couldn't leave its old group is still worth dispatching
    # to — same resilience as DeliveryManager._play_grouped_sonos().
    dev.avTransport.SetAVTransportURI.assert_called_once()


# ── SonosDelivery._get_device ─────────────────────────────────────────────────


def test_sonos_get_device_raises_when_none_found_at_all():
    d = SonosDelivery("Küche")
    with (
        patch("soco.discover", return_value=None),
        pytest.raises(RuntimeError, match="No Sonos devices found"),
    ):
        d._get_device()


class _BrokenSonosDevice:
    """A device whose player_name access itself raises — a real device on
    the network mid-error, not just one with an unexpected name."""

    @property
    def player_name(self):
        raise RuntimeError("SOAP fault")


def test_sonos_get_device_skips_a_device_that_errors_reading_its_name():
    good = MagicMock()
    good.player_name = "Küche"
    d = SonosDelivery("Küche")
    with patch("soco.discover", return_value=[_BrokenSonosDevice(), good]):
        assert d._get_device() is good


def test_sonos_get_device_raises_with_available_names_when_target_missing():
    other = MagicMock()
    other.player_name = "Wohnzimmer"
    d = SonosDelivery("Küche")
    with (
        patch("soco.discover", return_value=[other]),
        pytest.raises(RuntimeError, match="Wohnzimmer"),
    ):
        d._get_device()


# ── SonosDelivery._get_device — der Geraete-Cache ────────────────────────────
# Regression tests: every device interaction used to run a full network-wide
# SSDP search, and the position-resync loop does one every few seconds for as
# long as a cast runs — measured at ~25 multicast searches per minute during
# ordinary playback, over 180/min with a device picker open (beacon-dev
# 2026-08-23). See _get_device()'s docstring.


def _fake_sonos(name: str):
    device = MagicMock()
    device.player_name = name
    device.get_speaker_info.return_value = {"zone_name": name}
    return device


def test_get_device_discovers_only_once_for_repeated_calls():
    kitchen = _fake_sonos("Küche")
    d = SonosDelivery("Küche")
    with patch("soco.discover", return_value=[kitchen]) as discover:
        assert d._get_device() is kitchen
        assert d._get_device() is kitchen
        assert d._get_device() is kitchen

    discover.assert_called_once()
    # The repeat calls confirmed the cached speaker against the speaker
    # itself instead — one unicast request, not a network-wide search.
    assert kitchen.get_speaker_info.call_count == 2


def test_get_device_is_shared_between_delivery_instances():
    """A delivery object is built per dispatch, so a per-instance cache would
    almost never hit."""
    kitchen = _fake_sonos("Küche")
    with patch("soco.discover", return_value=[kitchen]) as discover:
        SonosDelivery("Küche")._get_device()
        SonosDelivery("Küche")._get_device()

    discover.assert_called_once()


def test_get_device_rediscovers_when_the_cached_speaker_stops_answering():
    """It moved, was unplugged, or the address was handed to something else -
    the cache must not outlive the speaker it names."""
    gone = _fake_sonos("Küche")
    fresh = _fake_sonos("Küche")
    d = SonosDelivery("Küche")
    with patch("soco.discover", return_value=[gone]):
        assert d._get_device() is gone

    gone.get_speaker_info.side_effect = OSError("no route to host")
    with patch("soco.discover", return_value=[fresh]) as discover:
        assert d._get_device() is fresh

    discover.assert_called_once()


def test_get_device_rediscovers_when_the_cached_speaker_was_renamed():
    kitchen = _fake_sonos("Küche")
    d = SonosDelivery("Küche")
    with patch("soco.discover", return_value=[kitchen]):
        assert d._get_device() is kitchen

    kitchen.get_speaker_info.return_value = {"zone_name": "Wohnzimmer"}
    replacement = _fake_sonos("Küche")
    with patch("soco.discover", return_value=[replacement]) as discover:
        assert d._get_device() is replacement

    discover.assert_called_once()


def test_get_device_still_raises_when_the_target_is_nowhere():
    with patch("soco.discover", return_value=[_fake_sonos("Bad")]):
        with pytest.raises(RuntimeError, match="not found"):
            SonosDelivery("Küche")._get_device()


# ── SonosDelivery.get_position / get_volume / set_volume ────────────────────


def test_sonos_get_position_parses_hms():
    dev = MagicMock()
    dev.get_current_track_info.return_value = {"position": "0:02:15"}
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        assert asyncio.run(d.get_position()) == 135


def test_sonos_get_position_defaults_to_zero_when_key_missing():
    dev = MagicMock()
    dev.get_current_track_info.return_value = {}
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        assert asyncio.run(d.get_position()) == 0


def test_sonos_get_position_returns_none_on_an_unparseable_value():
    dev = MagicMock()
    dev.get_current_track_info.return_value = {"position": "NOT_IMPLEMENTED"}
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        assert asyncio.run(d.get_position()) is None


def test_sonos_current_uri_reads_the_devices_own_track_uri():
    dev = MagicMock()
    dev.get_current_track_info.return_value = {"uri": "http://host:8071/stream/abc"}
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        assert asyncio.run(d.current_uri()) == "http://host:8071/stream/abc"


def test_sonos_current_uri_is_none_when_the_device_reports_nothing():
    """An empty string is what a stopped Sonos returns — that's "nothing
    playing", not a URI, and must not be compared against ours as one."""
    dev = MagicMock()
    dev.get_current_track_info.return_value = {"uri": ""}
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        assert asyncio.run(d.current_uri()) is None


def test_sonos_get_volume_reads_device_volume():
    dev = MagicMock()
    dev.volume = 42
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        assert asyncio.run(d.get_volume()) == 42


def test_sonos_set_volume_writes_device_volume_as_int():
    dev = MagicMock()
    d = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        asyncio.run(d.set_volume(37.9))
    assert dev.volume == 37


# ── AirPlayDelivery ───────────────────────────────────────────────────────────


def test_airplay_init_state():
    d = AirPlayDelivery("HomePod")
    assert d.target == "HomePod"
    assert d._stream_task is None
    assert d._atv is None


def test_airplay_stop_is_safe_without_active_stream():
    d = AirPlayDelivery("HomePod")
    asyncio.run(d.stop())
    assert d._atv is None


def test_airplay_stop_closes_atv_when_no_task():
    d = AirPlayDelivery("HomePod")
    atv = MagicMock()
    atv.close.return_value = []
    d._atv = atv

    asyncio.run(d.stop())

    atv.close.assert_called_once()
    assert d._atv is None


def test_airplay_pause_stops_the_stream():
    """Regression test: BaseDelivery.pause() defaults to a no-op, and
    AirPlayDelivery didn't override it — so /pause (and therefore the
    player bar's Pause and Stop buttons, which route through it — see
    use-connect-controls.ts) had zero effect on an active AirPlay cast,
    the RAOP push just kept playing. RAOP has no native pause primitive
    (pyatv only exposes stop()), so pausing must stop the stream; /resume
    already reconnects via play() with the seek offset applied."""
    d = AirPlayDelivery("HomePod")
    atv = MagicMock()
    atv.close.return_value = []
    d._atv = atv

    asyncio.run(d.pause())

    atv.close.assert_called_once()
    assert d._atv is None


def test_airplay_play_streams_radio_url_directly():
    """Regression test for the 344a2540 session-management refactor, which
    removed Context.state/Context.media but left airplay.py reading them —
    every AirPlay play() raised AttributeError before ever reaching pyatv
    (see CHANGELOG). Radio (no duration) must hand stream_url straight to
    pyatv.stream.stream_file() — it's already producing bytes live."""
    d = AirPlayDelivery("HomePod")
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock()
    atv.close.return_value = []

    async def run():
        with (
            patch.object(
                AirPlayDelivery, "_find_device", new=AsyncMock(return_value=MagicMock())
            ),
            patch("pyatv.connect", new=AsyncMock(return_value=atv)),
        ):
            await d.play("http://host/radio.mp3", "Title", "Artist")
            await d._stream_task

    asyncio.run(run())
    args, kwargs = atv.stream.stream_file.call_args
    assert args[0] == "http://host/radio.mp3"
    # Metadata travels even for radio, where there is no file to read tags
    # from at all — the station name is all the device would otherwise get.
    assert kwargs["metadata"].title == "Title"
    assert kwargs["metadata"].artist == "Artist"


class _FakeStreamResponse:
    """An open httpx response yielding `chunks`."""

    def __init__(self, chunks: list[bytes]):
        self._chunks = list(chunks)
        self.closed = False

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk

    def raise_for_status(self):
        return None

    async def aclose(self):
        self.closed = True


def _fake_stream_client(response):
    """An httpx.AsyncClient stand-in whose send() returns `response`."""
    client = MagicMock()
    client.build_request = MagicMock(return_value=MagicMock())
    client.send = AsyncMock(return_value=response)
    client.aclose = AsyncMock()
    return client


def _run_airplay_track(response, atv, on_playback_error=None):
    """play() a queued track through a faked device and response, and wait
    for the background stream task to finish."""
    d = AirPlayDelivery("HomePod")
    d.on_playback_error = on_playback_error
    client = _fake_stream_client(response)

    async def run():
        with (
            patch.object(
                AirPlayDelivery, "_find_device", new=AsyncMock(return_value=MagicMock())
            ),
            patch("pyatv.connect", new=AsyncMock(return_value=atv)),
            patch("delivery.airplay.httpx.AsyncClient", return_value=client),
        ):
            await d.play("http://host/stream/session123", "Title", "Artist", None, 200.0)
            await d._stream_task

    asyncio.run(run())
    return d, client


def test_airplay_streams_a_track_instead_of_buffering_it():
    """A queued track must reach pyatv as something it reads incrementally,
    not as a fully-downloaded buffer. The download used to be deliberate —
    pyatv's URL path times out after 10s waiting for our freshly-spawned
    ffmpeg — but it cost over 100MB of RAM per target on a long mix. See
    _ResponseReader: the reader path pyatv uses for a non-file source has
    no timeout at all, so the buffer bought nothing."""
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock()
    atv.close.return_value = []
    response = _FakeStreamResponse([b"fake-mp3-bytes"])

    _, client = _run_airplay_track(response, atv)

    # stream=True, i.e. the body is not read up front.
    _, kwargs = client.send.call_args
    assert kwargs["stream"] is True
    handed_over = atv.stream.stream_file.call_args[0][0]
    assert isinstance(handed_over, _ResponseReader)
    assert not isinstance(handed_over, io.BytesIO)


def test_airplay_closes_the_stream_it_opened():
    """The response holds an open connection to our own /stream; leaving it
    dangling keeps ffmpeg producing for a target that stopped listening."""
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock()
    atv.close.return_value = []
    response = _FakeStreamResponse([b"bytes"])

    _, client = _run_airplay_track(response, atv)

    assert response.closed is True
    client.aclose.assert_awaited()


# ── _ResponseReader ──────────────────────────────────────────────────────────
# What pyatv actually calls (see StreamReaderWrapper in pyatv's
# protocols/raop/audio_source.py). Chunk boundaries from httpx carry no
# meaning, so the reader has to hand out exactly what was asked for.


def _read(reader, *sizes):
    async def run():
        return [await reader.read(n) for n in sizes]

    return asyncio.run(run())


def test_response_reader_reassembles_across_chunk_boundaries():
    reader = _ResponseReader(_FakeStreamResponse([b"abc", b"def", b"ghi"]))

    assert _read(reader, 4, 4) == [b"abcd", b"efgh"]


def test_response_reader_splits_a_chunk_larger_than_asked_for():
    reader = _ResponseReader(_FakeStreamResponse([b"abcdefgh"]))

    assert _read(reader, 3, 3) == [b"abc", b"def"]


def test_response_reader_returns_the_remainder_then_nothing():
    """Empty is how a caller learns the stream ended — it must not appear
    before then, and must appear after."""
    reader = _ResponseReader(_FakeStreamResponse([b"abcde"]))

    assert _read(reader, 10, 10) == [b"abcde", b""]


def test_response_reader_answers_an_unbounded_read_with_a_bounded_chunk():
    """pyatv asks for "everything" in one branch. Answering literally would
    buffer the rest of the track, which is what this class exists to
    avoid — but the answer must still not be empty."""
    reader = _ResponseReader(_FakeStreamResponse([b"x" * 200_000]))

    chunk = _read(reader, -1)[0]

    assert 0 < len(chunk) <= _ResponseReader._UNBOUNDED_READ_SIZE


def test_response_reader_reads_zero_bytes_without_touching_the_stream():
    reader = _ResponseReader(_FakeStreamResponse([b"abc"]))

    assert _read(reader, 0) == [b""]


def test_airplay_a_stream_that_fails_to_close_does_not_mask_the_real_error():
    """The close runs in a finally that may already be unwinding a real
    failure — and on the cancellation path the connection is usually
    half-torn-down, which is exactly when aclose() has something to
    complain about. It must not become the failure."""
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock()
    atv.close.return_value = []
    response = _FakeStreamResponse([b"bytes"])
    response.aclose = AsyncMock(side_effect=httpx.ReadError("connection already gone"))

    d, client = _run_airplay_track(response, atv)

    # Got past the close and finished the teardown it guards.
    client.aclose.assert_awaited()
    assert d._atv is None


# ── AirPlayDelivery metadata ─────────────────────────────────────────────────
# Told to the device rather than left to be read out of the stream. Two
# things make the stream unable to carry it: ffmpeg's -vn strips the cover
# before anything downstream sees it, and the surviving tags are only
# readable from a fully seekable source, which a live stream isn't.


def _metadata_of(atv):
    return atv.stream.stream_file.call_args[1]["metadata"]


def test_airplay_tells_the_device_what_is_playing():
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock()
    atv.close.return_value = []
    d = AirPlayDelivery("HomePod")
    client = _fake_stream_client(_FakeStreamResponse([b"bytes"]))

    async def run():
        with (
            patch.object(
                AirPlayDelivery, "_find_device", new=AsyncMock(return_value=MagicMock())
            ),
            patch("pyatv.connect", new=AsyncMock(return_value=atv)),
            patch("delivery.airplay.httpx.AsyncClient", return_value=client),
            patch("delivery.airplay._fetch_artwork", new=AsyncMock(return_value=b"jpeg")),
        ):
            await d.play(
                "http://host/stream/s1",
                "Song Title",
                "Some Artist",
                "http://host/cover.jpg",
                200.0,
                "An Album",
            )
            await d._stream_task

    asyncio.run(run())

    md = _metadata_of(atv)
    assert md.title == "Song Title"
    assert md.artist == "Some Artist"
    assert md.album == "An Album"
    assert md.duration == 200.0
    assert md.artwork == b"jpeg"


def test_airplay_sends_no_empty_strings_as_metadata():
    """pyatv passes these straight into the DAAP fields. An empty string is
    a value the device will happily display as blank; None means "not
    known" and leaves the field out."""
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock()
    atv.close.return_value = []
    d = AirPlayDelivery("HomePod")
    client = _fake_stream_client(_FakeStreamResponse([b"bytes"]))

    async def run():
        with (
            patch.object(
                AirPlayDelivery, "_find_device", new=AsyncMock(return_value=MagicMock())
            ),
            patch("pyatv.connect", new=AsyncMock(return_value=atv)),
            patch("delivery.airplay.httpx.AsyncClient", return_value=client),
            patch("delivery.airplay._fetch_artwork", new=AsyncMock(return_value=None)),
        ):
            await d.play("http://host/stream/s1", "Song Title", "", None, 200.0, "")
            await d._stream_task

    asyncio.run(run())

    md = _metadata_of(atv)
    assert md.artist is None
    assert md.album is None
    assert md.artwork is None


# ── _fetch_artwork ───────────────────────────────────────────────────────────


def _artwork(url, response=None, error=None):
    http = MagicMock()
    http.get = AsyncMock(return_value=response) if error is None else AsyncMock(side_effect=error)
    http.__aenter__ = AsyncMock(return_value=http)
    http.__aexit__ = AsyncMock(return_value=False)
    with patch("delivery.airplay.httpx.AsyncClient", return_value=http):
        return asyncio.run(_fetch_artwork(url))


def _jpeg_response(payload: bytes):
    resp = MagicMock()
    resp.content = payload
    resp.raise_for_status = MagicMock()
    return resp


def test_fetch_artwork_returns_the_bytes():
    assert _artwork("http://host/cover.jpg", _jpeg_response(b"jpeg-bytes")) == b"jpeg-bytes"


def test_fetch_artwork_without_a_url_is_not_an_error():
    """A track with no cover art at all is ordinary, not a failure."""
    assert asyncio.run(_fetch_artwork(None)) is None


def test_fetch_artwork_refuses_an_oversized_image():
    """It rides on the same connection as the audio — a mis-sized image
    must not get the chance to crowd out the stream."""
    oversized = b"x" * (_MAX_ARTWORK_BYTES + 1)

    assert _artwork("http://host/huge.jpg", _jpeg_response(oversized)) is None


def test_fetch_artwork_never_stops_the_music():
    """Artwork is decoration. A media server having a bad moment must cost
    the cover, not the track."""
    assert _artwork("http://host/cover.jpg", error=httpx.ConnectError("refused")) is None


# ── AirPlayDelivery failure reporting ────────────────────────────────────────


def test_airplay_reports_a_device_that_died_mid_track():
    """The gap this closes: every other target pulls GET /stream for the
    whole track, so a device going away closes that connection and
    routes/stream.py notices. AirPlay is pushed to — a failed push was the
    only trace, and it went into a log line and nowhere else. See
    docs/playback-bugs/airplay-silent-death.md."""
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock(side_effect=Exception("not connected to remote"))
    atv.close.return_value = []
    reported: list[str] = []

    async def on_error(detail: str) -> None:
        reported.append(detail)

    _run_airplay_track(_FakeStreamResponse([b"bytes"]), atv, on_playback_error=on_error)

    assert len(reported) == 1
    assert "HomePod" in reported[0]


def test_airplay_reports_nothing_when_we_stopped_it_ourselves():
    """/pause and /stop cancel the stream task. Reporting that as a failure
    would raise an interruption toast for something the user just did."""
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock(side_effect=asyncio.CancelledError)
    atv.close.return_value = []
    reported: list[str] = []

    async def on_error(detail: str) -> None:
        reported.append(detail)

    _run_airplay_track(_FakeStreamResponse([b"bytes"]), atv, on_playback_error=on_error)

    assert reported == []


def test_airplay_reports_nothing_for_an_unrelated_error():
    """Only the disconnect is a device death. An unexpected exception is a
    bug in this code, logged as one, not an interruption to offer a Resume
    button for."""
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock(side_effect=ValueError("something else"))
    atv.close.return_value = []
    reported: list[str] = []

    async def on_error(detail: str) -> None:
        reported.append(detail)

    _run_airplay_track(_FakeStreamResponse([b"bytes"]), atv, on_playback_error=on_error)

    assert reported == []


def test_airplay_survives_having_no_one_to_report_to():
    """routes/devices.py builds a throwaway instance just to stop a device;
    it has no session behind it. The teardown in _stream()'s finally must
    still run."""
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock(side_effect=Exception("not connected to remote"))
    atv.close.return_value = []
    response = _FakeStreamResponse([b"bytes"])

    _run_airplay_track(response, atv, on_playback_error=None)

    assert response.closed is True


def test_airplay_a_failing_reporter_does_not_break_the_teardown():
    """The callback reaches into session state and broadcasts over SSE —
    both of which can fail. The connection still has to be closed."""
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock(side_effect=Exception("not connected to remote"))
    atv.close.return_value = []
    response = _FakeStreamResponse([b"bytes"])

    async def on_error(detail: str) -> None:
        raise RuntimeError("broadcast failed")

    _run_airplay_track(response, atv, on_playback_error=on_error)

    assert response.closed is True


# ── AirPlayDelivery._find_device ─────────────────────────────────────────────


def _fake_pyatv_device(name: str, address: str = "10.0.0.5") -> MagicMock:
    device = MagicMock()
    device.name = name
    device.address = address
    return device


def test_find_device_uses_cached_address_for_a_fast_unicast_scan():
    ctx.discovered["airplay"] = [{"name": "HomePod", "address": "10.0.0.5"}]
    found = _fake_pyatv_device("HomePod", "10.0.0.5")
    scan_calls = []

    async def fake_scan(loop, timeout, protocol, hosts):
        scan_calls.append(hosts)
        return [found] if hosts == ["10.0.0.5"] else []

    d = AirPlayDelivery("HomePod")
    with (
        patch("delivery.airplay.creds_store.get", return_value=None),
        patch("pyatv.scan", new=fake_scan),
    ):
        result = asyncio.run(d._find_device())

    assert result is found
    assert scan_calls == [["10.0.0.5"]]  # only the fast unicast scan ran


def test_find_device_falls_back_to_a_full_scan_when_the_cached_address_is_stale():
    ctx.discovered["airplay"] = [{"name": "HomePod", "address": "10.0.0.5"}]
    found = _fake_pyatv_device("HomePod", "10.0.0.9")  # moved to a new IP since

    async def fake_scan(loop, timeout, protocol, hosts):
        return [found] if hosts is None else []

    d = AirPlayDelivery("HomePod")
    with (
        patch("delivery.airplay.creds_store.get", return_value=None),
        patch("pyatv.scan", new=fake_scan),
    ):
        result = asyncio.run(d._find_device())

    assert result is found


def test_find_device_scans_fully_when_nothing_cached():
    ctx.discovered["airplay"] = []
    found = _fake_pyatv_device("HomePod")
    scan_calls = []

    async def fake_scan(loop, timeout, protocol, hosts):
        scan_calls.append(hosts)
        return [found]

    d = AirPlayDelivery("HomePod")
    with (
        patch("delivery.airplay.creds_store.get", return_value=None),
        patch("pyatv.scan", new=fake_scan),
    ):
        result = asyncio.run(d._find_device())

    assert result is found
    assert scan_calls == [None]  # no cached address, went straight to a full scan


def test_find_device_raises_when_not_found_in_either_scan():
    ctx.discovered["airplay"] = []
    other = _fake_pyatv_device("Kitchen Speaker")

    async def fake_scan(loop, timeout, protocol, hosts):
        return [other]

    d = AirPlayDelivery("HomePod")
    with (
        patch("delivery.airplay.creds_store.get", return_value=None),
        patch("pyatv.scan", new=fake_scan),
        pytest.raises(RuntimeError, match="Kitchen Speaker"),
    ):
        asyncio.run(d._find_device())


def test_find_device_applies_stored_credentials_to_both_protocols():
    """A paired AirPlay 2 device needs its RAOP service to carry the same
    HAP credentials the pairing yielded too — otherwise pyatv sets up an
    unencrypted RAOP session and the device refuses the audio port."""
    ctx.discovered["airplay"] = []
    found = _fake_pyatv_device("HomePod")
    protocols_used = []

    async def fake_scan(loop, timeout, protocol, hosts):
        protocols_used.append(protocol)
        return [found]

    d = AirPlayDelivery("HomePod")
    with (
        patch("delivery.airplay.creds_store.get", return_value="stored-hap-creds"),
        patch("pyatv.scan", new=fake_scan),
    ):
        result = asyncio.run(d._find_device())

    assert result is found
    # A full-protocol scan (not RAOP-only) — a paired device's AirPlay (HAP)
    # service needs to actually be exposed to receive the credentials below.
    assert protocols_used == [None]
    found.set_credentials.assert_any_call(Protocol.AirPlay, "stored-hap-creds")
    found.set_credentials.assert_any_call(Protocol.RAOP, "stored-hap-creds")


def test_find_device_uses_raop_only_scan_when_unpaired():
    ctx.discovered["airplay"] = []
    found = _fake_pyatv_device("HomePod")
    protocols_used = []

    async def fake_scan(loop, timeout, protocol, hosts):
        protocols_used.append(protocol)
        return [found]

    d = AirPlayDelivery("HomePod")
    with (
        patch("delivery.airplay.creds_store.get", return_value=None),
        patch("pyatv.scan", new=fake_scan),
    ):
        asyncio.run(d._find_device())

    assert protocols_used == [Protocol.RAOP]
    found.set_credentials.assert_not_called()


# ── AirPlayDelivery.play()'s _stream() task ──────────────────────────────────


def test_airplay_play_with_no_stream_url_logs_and_does_nothing():
    d = AirPlayDelivery("HomePod")
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock()
    atv.close.return_value = []

    async def run():
        with (
            patch.object(
                AirPlayDelivery, "_find_device", new=AsyncMock(return_value=MagicMock())
            ),
            patch("pyatv.connect", new=AsyncMock(return_value=atv)),
        ):
            await d.play("", "Title")
            await d._stream_task

    asyncio.run(run())
    atv.stream.stream_file.assert_not_called()


def test_airplay_stream_task_cancellation_is_logged_and_swallowed(caplog):
    d = AirPlayDelivery("HomePod")
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock(side_effect=asyncio.CancelledError())
    atv.close.return_value = []

    async def run():
        with (
            patch.object(
                AirPlayDelivery, "_find_device", new=AsyncMock(return_value=MagicMock())
            ),
            patch("pyatv.connect", new=AsyncMock(return_value=atv)),
            caplog.at_level(logging.INFO, logger="delivery"),
        ):
            await d.play("http://host/radio.mp3", "Title")
            await d._stream_task  # swallowed inside _stream() — must not raise

    asyncio.run(run())
    assert "Stream cancelled" in caplog.text


def test_airplay_stream_logs_disconnection_without_traceback_for_a_known_teardown_error(
    caplog,
):
    """'not connected to remote' is teardown noise from the Apple TV having
    already dropped the connection — the actual cause was already logged by
    pyatv itself, so this doesn't need (or want) its own traceback."""
    d = AirPlayDelivery("HomePod")
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock(side_effect=RuntimeError("not connected to remote"))
    atv.close.return_value = []

    async def run():
        with (
            patch.object(
                AirPlayDelivery, "_find_device", new=AsyncMock(return_value=MagicMock())
            ),
            patch("pyatv.connect", new=AsyncMock(return_value=atv)),
            caplog.at_level(logging.WARNING, logger="delivery"),
        ):
            await d.play("http://host/radio.mp3", "Title")
            await d._stream_task

    asyncio.run(run())
    assert "Device disconnected during stream" in caplog.text


def test_airplay_stream_logs_an_unexpected_error(caplog):
    d = AirPlayDelivery("HomePod")
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock(side_effect=RuntimeError("decoder crashed"))
    atv.close.return_value = []

    async def run():
        with (
            patch.object(
                AirPlayDelivery, "_find_device", new=AsyncMock(return_value=MagicMock())
            ),
            patch("pyatv.connect", new=AsyncMock(return_value=atv)),
            caplog.at_level(logging.ERROR, logger="delivery"),
        ):
            await d.play("http://host/radio.mp3", "Title")
            await d._stream_task

    asyncio.run(run())
    assert "decoder crashed" in caplog.text


def test_airplay_stream_swallows_cancellation_during_shielded_teardown():
    """finally's own close (shielded so an outer cancellation of _stream()
    itself can't cut it short) can still raise CancelledError on its own —
    e.g. the whole app shutting down mid-close — and must be swallowed the
    same way the rest of _stream() already handles cancellation, not
    propagate out of the finally block."""
    d = AirPlayDelivery("HomePod")
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock()

    async def run():
        with (
            patch.object(
                AirPlayDelivery, "_find_device", new=AsyncMock(return_value=MagicMock())
            ),
            patch("pyatv.connect", new=AsyncMock(return_value=atv)),
            patch.object(
                AirPlayDelivery,
                "_close_atv",
                new=AsyncMock(side_effect=asyncio.CancelledError()),
            ),
        ):
            await d.play("http://host/radio.mp3", "Title")
            await d._stream_task  # must not raise

    asyncio.run(run())


# ── AirPlayDelivery.stop() / _stop_locked() ──────────────────────────────────


def test_airplay_stop_awaits_close_tasks_when_present():
    """_close_atv() must await whatever tasks atv.close() itself returns
    (aiohttp session teardown) rather than firing and forgetting them."""

    async def _noop():
        return None

    d = AirPlayDelivery("HomePod")
    atv = MagicMock()
    atv.close.return_value = [_noop(), _noop()]
    d._atv = atv

    asyncio.run(d.stop())  # must not raise/warn about un-awaited coroutines

    atv.close.assert_called_once()


def test_airplay_stop_cancels_an_active_stream_task():
    d = AirPlayDelivery("HomePod")

    async def _never_ending():
        await asyncio.sleep(1000)

    async def run():
        d._stream_task = asyncio.create_task(_never_ending())
        await asyncio.sleep(0)  # let it actually start before stopping it
        await d.stop()

    asyncio.run(run())
    assert d._stream_task.cancelled()


# ── ChromecastDelivery cache ──────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clear_chromecast_cache():
    _chromecast_mod._chromecast_cache.clear()
    yield
    _chromecast_mod._chromecast_cache.clear()


def test_chromecast_cache_returns_connected_device():
    cast = MagicMock()
    cast.socket_client.is_connected = True
    _chromecast_mod._chromecast_cache["tv"] = cast
    assert _chromecast_mod._get_cached_chromecast("TV") is cast


def test_chromecast_cache_evicts_disconnected_device():
    cast = MagicMock()
    cast.socket_client.is_connected = False
    _chromecast_mod._chromecast_cache["tv"] = cast
    assert _chromecast_mod._get_cached_chromecast("TV") is None
    assert "tv" not in _chromecast_mod._chromecast_cache


def test_chromecast_cache_evicts_on_socket_exception():
    cast = MagicMock()
    type(cast.socket_client).is_connected = property(
        lambda self: (_ for _ in ()).throw(RuntimeError("dead"))
    )
    _chromecast_mod._chromecast_cache["tv"] = cast
    assert _chromecast_mod._get_cached_chromecast("TV") is None
    assert "tv" not in _chromecast_mod._chromecast_cache


def test_chromecast_cache_miss_returns_none():
    assert _chromecast_mod._get_cached_chromecast("nope") is None


# ── ChromecastDelivery._get_device ───────────────────────────────────────────


def test_chromecast_get_device_uses_cache_when_available():
    cast = _mock_cast()
    cast.socket_client.is_connected = True
    _chromecast_mod._chromecast_cache["tv"] = cast

    assert ChromecastDelivery("TV")._get_device() is cast


def test_chromecast_get_device_discovers_and_caches_a_new_device():
    cast_info = MagicMock()
    cast_info.friendly_name = "TV"
    browser = MagicMock()
    browser.devices = {"uuid-1": cast_info}
    new_cast = _mock_cast()

    with (
        patch(
            "delivery.chromecast._ensure_cast_browser", return_value=(browser, MagicMock())
        ),
        patch("delivery.chromecast._wait_for_discovery"),
        patch("pychromecast.get_chromecast_from_cast_info", return_value=new_cast),
    ):
        result = ChromecastDelivery("TV")._get_device()

    assert result is new_cast
    new_cast.wait.assert_called_once_with(timeout=10)
    assert _chromecast_mod._chromecast_cache["tv"] is new_cast


def test_chromecast_get_device_raises_with_available_names_when_not_found():
    other = MagicMock()
    other.friendly_name = "Bedroom"
    browser = MagicMock()
    browser.devices = {"uuid-1": other}

    with (
        patch(
            "delivery.chromecast._ensure_cast_browser", return_value=(browser, MagicMock())
        ),
        patch("delivery.chromecast._wait_for_discovery"),
        pytest.raises(RuntimeError, match="Bedroom"),
    ):
        ChromecastDelivery("TV")._get_device()


# ── ChromecastDelivery playback ───────────────────────────────────────────────


def _mock_cast():
    cast = MagicMock()
    cast.media_controller = MagicMock()
    return cast


def test_chromecast_play_calls_media_controller():
    cast = _mock_cast()
    d = ChromecastDelivery("TV")
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        asyncio.run(d.play("http://stream", "Title"))
    cast.media_controller.play_media.assert_called_once_with(
        "http://stream",
        "audio/mpeg",
        title="Title",
        thumb=None,
        metadata={"metadataType": 3, "title": "Title", "artist": ""},
    )
    cast.media_controller.block_until_active.assert_called_once_with(10)


def test_chromecast_play_uses_passed_content_type():
    cast = _mock_cast()
    d = ChromecastDelivery("TV")
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        asyncio.run(
            d.play("http://stream", "Title", "", None, None, "", "audio/aac")
        )
    cast.media_controller.play_media.assert_called_once_with(
        "http://stream",
        "audio/aac",
        title="Title",
        thumb=None,
        metadata={"metadataType": 3, "title": "Title", "artist": ""},
    )


def test_chromecast_pause_resume_stop_delegate_to_controller():
    cast = _mock_cast()
    d = ChromecastDelivery("TV")
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        asyncio.run(d.pause())
        asyncio.run(d.resume())
        asyncio.run(d.stop())
    cast.media_controller.pause.assert_called_once()
    cast.media_controller.play.assert_called_once()
    cast.media_controller.stop.assert_called_once()


def test_chromecast_play_includes_album_art_and_album_in_metadata():
    cast = _mock_cast()
    d = ChromecastDelivery("TV")
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        asyncio.run(
            d.play("http://stream", "Title", "Artist", "http://art.jpg", None, "The Album")
        )
    call_kwargs = cast.media_controller.play_media.call_args.kwargs
    assert call_kwargs["thumb"] == "http://art.jpg"
    assert call_kwargs["metadata"]["images"] == [{"url": "http://art.jpg"}]
    assert call_kwargs["metadata"]["albumName"] == "The Album"


def test_chromecast_play_omits_album_art_and_album_when_not_given():
    cast = _mock_cast()
    d = ChromecastDelivery("TV")
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        asyncio.run(d.play("http://stream", "Title"))
    metadata = cast.media_controller.play_media.call_args.kwargs["metadata"]
    assert "images" not in metadata
    assert "albumName" not in metadata


def test_chromecast_get_position_while_playing():
    cast = _mock_cast()
    cast.media_controller.status.player_state = "PLAYING"
    cast.media_controller.status.adjusted_current_time = 42.5
    d = ChromecastDelivery("TV")
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        assert asyncio.run(d.get_position()) == 42.5


def test_chromecast_get_position_returns_none_when_idle():
    cast = _mock_cast()
    cast.media_controller.status.player_state = "IDLE"
    d = ChromecastDelivery("TV")
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        assert asyncio.run(d.get_position()) is None


# ── DlnaDelivery ──────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clear_dlna_caches():
    _dlna_mod._device_cache.clear()
    _dlna_mod._location_cache.clear()
    yield
    _dlna_mod._device_cache.clear()
    _dlna_mod._location_cache.clear()


def _mock_dmr_device(media_position=None, volume_level=None):
    device = MagicMock()
    device.async_set_transport_uri = AsyncMock()
    device.async_play = AsyncMock()
    device.async_pause = AsyncMock()
    device.async_stop = AsyncMock()
    device.async_update = AsyncMock()
    device.async_set_volume_level = AsyncMock()
    device.media_position = media_position
    device.volume_level = volume_level
    return device


def test_dlna_play_sets_transport_uri_then_plays():
    device = _mock_dmr_device()
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        asyncio.run(d.play("http://stream", "Title", "Artist"))
    call_args = device.async_set_transport_uri.call_args.args
    assert call_args[0] == "http://stream"
    assert call_args[1] == "Title"
    assert "<upnp:artist>Artist</upnp:artist>" in call_args[2]
    device.async_play.assert_called_once()


def test_dlna_play_defaults_protocol_info_to_audio_mpeg():
    device = _mock_dmr_device()
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        asyncio.run(d.play("http://stream", "Title"))
    xml = device.async_set_transport_uri.call_args.args[2]
    assert 'protocolInfo="http-get:*:audio/mpeg:*"' in xml


def test_dlna_play_uses_passed_content_type_in_protocol_info():
    device = _mock_dmr_device()
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        asyncio.run(
            d.play("http://stream", "Title", "", None, None, "", "audio/flac")
        )
    xml = device.async_set_transport_uri.call_args.args[2]
    assert 'protocolInfo="http-get:*:audio/flac:*"' in xml


def test_dlna_play_without_artist_sends_no_artist_or_album_art():
    device = _mock_dmr_device()
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        asyncio.run(d.play("http://stream", "Title"))
    xml = device.async_set_transport_uri.call_args.args[2]
    assert "<upnp:artist>" not in xml
    assert "<dc:creator>" not in xml
    assert "<upnp:albumArtURI>" not in xml
    assert "<upnp:album>" not in xml


def test_dlna_play_includes_album_in_metadata():
    device = _mock_dmr_device()
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        asyncio.run(
            d.play(
                "http://stream", "Title", "Artist", None, None, "The Album"
            )
        )
    xml = device.async_set_transport_uri.call_args.args[2]
    assert "<upnp:album>The Album</upnp:album>" in xml


def test_dlna_play_includes_album_art_url_and_duration_in_metadata():
    device = _mock_dmr_device()
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        asyncio.run(
            d.play("http://stream", "Title", "Artist", "http://nav/cover.jpg", 185.0)
        )
    xml = device.async_set_transport_uri.call_args.args[2]
    assert "<upnp:albumArtURI>http://nav/cover.jpg</upnp:albumArtURI>" in xml
    assert 'duration="0:03:05"' in xml


# ── _build_metadata / _format_didl_duration ────────────────────────────────────


def test_build_metadata_includes_title_artist_creator_and_forces_music_track():
    xml = _dlna_mod._build_metadata("http://stream", "My Title", "My Artist")
    assert "<dc:title>My Title</dc:title>" in xml
    assert "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" in xml
    assert "<upnp:artist>My Artist</upnp:artist>" in xml
    # Both set — upnp:artist is DLNA-preferred, but some renderers only read
    # the older dc:creator (this was reported as "{Artist} | null" showing on
    # a real renderer before dc:creator was added).
    assert "<dc:creator>My Artist</dc:creator>" in xml


def test_build_metadata_defaults_protocol_info_to_audio_mpeg():
    xml = _dlna_mod._build_metadata("http://stream", "Title")
    assert 'protocolInfo="http-get:*:audio/mpeg:*"' in xml


def test_build_metadata_uses_passed_content_type():
    xml = _dlna_mod._build_metadata("http://stream", "Title", content_type="audio/ogg")
    assert 'protocolInfo="http-get:*:audio/ogg:*"' in xml


def test_build_metadata_omits_optional_fields_when_not_given():
    xml = _dlna_mod._build_metadata("http://stream", "Title")
    assert "<upnp:artist>" not in xml
    assert "<dc:creator>" not in xml
    assert "<upnp:albumArtURI>" not in xml
    assert "duration=" not in xml


def test_format_didl_duration_rounds_and_zero_pads():
    assert _dlna_mod._format_didl_duration(0) == "0:00:00"
    assert _dlna_mod._format_didl_duration(65) == "0:01:05"
    assert _dlna_mod._format_didl_duration(3725) == "1:02:05"
    assert _dlna_mod._format_didl_duration(3725.6) == "1:02:06"


def test_dlna_music_track_didl_class_declares_album_art_uri():
    """Regression guard for one of two upstream didl_lite gaps this module
    patches around: MusicTrack (unlike MusicAlbum) doesn't declare
    upnp:albumArtURI by default, so DidlObject.to_xml() silently drops it —
    meaning any album_art_url we pass never reaches the device at all, not
    even as a dropped/invalid value. See dlna.py's module-level patch."""
    from didl_lite.didl_lite import MusicTrack

    assert any(p[1] == "albumArtURI" for p in MusicTrack.didl_properties_defs)


def test_resource_to_xml_serializes_duration():
    """Regression guard for the second upstream didl_lite gap: Resource.to_xml()
    only ever wrote protocolInfo, silently dropping duration/size/bitrate/etc.
    even though they're accepted (and round-tripped by from_xml()). This is
    what caused tracks to show with no playback duration on the device."""
    from didl_lite.didl_lite import Resource

    resource = Resource(
        uri="http://stream", protocol_info="http-get:*:audio/mpeg:*", duration="0:03:05"
    )
    el = resource.to_xml()
    assert el.attrib["duration"] == "0:03:05"
    assert el.attrib["protocolInfo"] == "http-get:*:audio/mpeg:*"


def test_dlna_pause_resume_stop_delegate_to_device():
    device = _mock_dmr_device()
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        asyncio.run(d.pause())
        asyncio.run(d.resume())
        asyncio.run(d.stop())
    device.async_pause.assert_called_once()
    device.async_play.assert_called_once()
    device.async_stop.assert_called_once()


def test_dlna_get_position_returns_seconds():
    device = _mock_dmr_device(media_position=93)
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        position = asyncio.run(d.get_position())
    assert position == 93.0
    device.async_update.assert_called_once_with(do_ping=False)


def test_dlna_get_position_returns_none_when_unavailable():
    device = _mock_dmr_device(media_position=None)
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        assert asyncio.run(d.get_position()) is None


def test_dlna_get_volume_maps_0_to_1_to_percent():
    device = _mock_dmr_device(volume_level=0.42)
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        assert asyncio.run(d.get_volume()) == 42


def test_dlna_get_volume_returns_none_when_unavailable():
    device = _mock_dmr_device(volume_level=None)
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        assert asyncio.run(d.get_volume()) is None


def test_dlna_set_volume_scales_to_0_to_1():
    device = _mock_dmr_device()
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        asyncio.run(d.set_volume(70))
    device.async_set_volume_level.assert_called_once_with(0.7)


def test_dlna_set_volume_clamps_to_valid_range():
    device = _mock_dmr_device()
    d = DlnaDelivery("Receiver")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        asyncio.run(d.set_volume(250))
        asyncio.run(d.set_volume(-10))
    device.async_set_volume_level.assert_any_call(1.0)
    device.async_set_volume_level.assert_any_call(0.0)


def test_create_dmr_device_wraps_non_media_renderer_with_friendly_name():
    """Regression test for the raw, unhelpful "could not find device of type"
    warning some non-renderer UPnP devices (routers, NAS boxes, a Philips Hue
    bridge, ...) produce when they answer our MediaRenderer SSDP search but
    their own XML doesn't declare one."""
    from async_upnp_client.exceptions import UpnpError

    fake_upnp_device = MagicMock()
    fake_upnp_device.friendly_name = "Philips Hue Bridge"

    async def fake_async_create_device(self, location):
        return fake_upnp_device

    def fake_dmr_init(self, device, event_handler=None):
        raise UpnpError("Could not find device of type: [...]")

    with (
        patch(
            "async_upnp_client.client_factory.UpnpFactory.async_create_device",
            new=fake_async_create_device,
        ),
        patch("async_upnp_client.profiles.dlna.DmrDevice.__init__", new=fake_dmr_init),
    ):
        with pytest.raises(_dlna_mod.UnsupportedDlnaDevice) as exc_info:
            asyncio.run(_dlna_mod._create_dmr_device("http://10.2.2.139/desc.xml"))

    assert exc_info.value.friendly_name == "Philips Hue Bridge"


def test_dlna_get_device_uses_cached_location(monkeypatch):
    _dlna_mod._location_cache["receiver"] = "http://10.0.0.4:1400/desc.xml"
    created = _mock_dmr_device()

    async def _fake_create(location):
        assert location == "http://10.0.0.4:1400/desc.xml"
        return created

    monkeypatch.setattr(_dlna_mod, "_create_dmr_device", _fake_create)

    d = DlnaDelivery("Receiver")
    device = asyncio.run(d._get_device())
    assert device is created
    assert _dlna_mod._device_cache["receiver"] is created


def test_dlna_get_device_raises_when_not_found(monkeypatch):
    async def _fake_discover_dlna():
        return []

    import delivery.manager as _manager_mod

    monkeypatch.setattr(_manager_mod, "discover_dlna", _fake_discover_dlna)

    d = DlnaDelivery("Nonexistent")
    with pytest.raises(RuntimeError, match="not found"):
        asyncio.run(d._get_device())


def test_dlna_play_evicts_cache_on_error():
    device = _mock_dmr_device()
    device.async_play.side_effect = RuntimeError("device went away")
    _dlna_mod._device_cache["receiver"] = device

    d = DlnaDelivery("Receiver")
    with pytest.raises(RuntimeError):
        asyncio.run(d.play("http://stream", "Title"))
    assert "receiver" not in _dlna_mod._device_cache


def test_dlna_get_device_resolves_location_via_a_fresh_scan(monkeypatch):
    """No cached location at all (e.g. built directly from a (type, name)
    pair — see core/state.py's resolve_target()) — falls back to a live
    scan and picks the matching device out of it, distinct from
    test_dlna_get_device_raises_when_not_found's empty-scan case."""
    created = _mock_dmr_device()

    async def _fake_discover_dlna():
        return [
            {"name": "Other Receiver", "location": "http://10.0.0.9/desc.xml"},
            {"name": "Receiver", "location": "http://10.0.0.4:1400/desc.xml"},
        ]

    async def _fake_create(location):
        assert location == "http://10.0.0.4:1400/desc.xml"
        return created

    import delivery.manager as _manager_mod

    monkeypatch.setattr(_manager_mod, "discover_dlna", _fake_discover_dlna)
    monkeypatch.setattr(_dlna_mod, "_create_dmr_device", _fake_create)

    d = DlnaDelivery("Receiver")
    device = asyncio.run(d._get_device())

    assert device is created
    assert _dlna_mod._device_cache["receiver"] is created


def test_dlna_get_device_or_evict_reraises_the_lookup_failure(monkeypatch):
    """pause()/resume()/stop()/get_position()/get_volume()/set_volume() all
    go through this instead of _get_device() directly — a lookup failure
    (device renamed, taken offline, ...) must still propagate, same
    contract play()'s own _get_device() call has."""

    async def _fake_discover_dlna():
        return []  # the device is genuinely gone

    import delivery.manager as _manager_mod

    monkeypatch.setattr(_manager_mod, "discover_dlna", _fake_discover_dlna)

    d = DlnaDelivery("Receiver")
    with pytest.raises(RuntimeError, match="not found"):
        asyncio.run(d.pause())
    assert "receiver" not in _dlna_mod._device_cache
