"""Tests for SonosDelivery, AirPlayDelivery, ChromecastDelivery and DlnaDelivery."""

import asyncio
import io
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import delivery.chromecast as _chromecast_mod
import delivery.dlna as _dlna_mod
from delivery import AirPlayDelivery, ChromecastDelivery, DlnaDelivery, SonosDelivery


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
    atv.stream.stream_file.assert_called_once_with("http://host/radio.mp3")


def test_airplay_play_downloads_track_before_streaming():
    """Queued tracks (duration given) must be fully downloaded before being
    handed to pyatv, not passed as a live URL — pyatv's decoder-detection
    has a hardcoded 10s read timeout (see audio_source.py's DEFAULT_TIMEOUT),
    and our own /stream/<session_id> proxy (fed by a freshly spawned ffmpeg
    transcode) can take longer than that to produce its first bytes, which
    fails with an opaque 'failed to init decoder' if streamed live."""
    d = AirPlayDelivery("HomePod")
    atv = MagicMock()
    atv.stream.stream_file = AsyncMock()
    atv.close.return_value = []

    fake_response = MagicMock()
    fake_response.content = b"fake-mp3-bytes"
    fake_response.raise_for_status = MagicMock()

    fake_http_client = AsyncMock()
    fake_http_client.get = AsyncMock(return_value=fake_response)
    fake_http_client.__aenter__ = AsyncMock(return_value=fake_http_client)
    fake_http_client.__aexit__ = AsyncMock(return_value=False)

    async def run():
        with (
            patch.object(
                AirPlayDelivery, "_find_device", new=AsyncMock(return_value=MagicMock())
            ),
            patch("pyatv.connect", new=AsyncMock(return_value=atv)),
            patch("delivery.airplay.httpx.AsyncClient", return_value=fake_http_client),
        ):
            await d.play("http://host/stream/session123", "Title", "Artist", None, 200.0)
            await d._stream_task

    asyncio.run(run())
    fake_http_client.get.assert_called_once_with("http://host/stream/session123")
    args, _ = atv.stream.stream_file.call_args
    assert isinstance(args[0], io.BytesIO)
    assert args[0].getvalue() == b"fake-mp3-bytes"


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
