"""Tests for DeliveryManager — construction, factories and fan-out."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from delivery import (
    AirPlayDelivery,
    ChromecastDelivery,
    DeliveryManager,
    DlnaDelivery,
    SonosDelivery,
)


# ── from_deliveries / list_targets ────────────────────────────────────────────


def test_from_deliveries_creates_manager():
    s = SonosDelivery("Küche")
    a = AirPlayDelivery("HomePod")
    c = ChromecastDelivery("TV")
    d = DlnaDelivery("Receiver")
    m = DeliveryManager.from_deliveries([s, a, c, d])
    assert m.deliveries == [s, a, c, d]


def test_list_targets_reports_type_and_name():
    m = DeliveryManager.from_deliveries(
        [
            SonosDelivery("Küche"),
            AirPlayDelivery("HomePod"),
            ChromecastDelivery("TV"),
            DlnaDelivery("Receiver"),
        ]
    )
    assert m.list_targets() == [
        {"type": "sonos", "name": "Küche"},
        {"type": "airplay", "name": "HomePod"},
        {"type": "chromecast", "name": "TV"},
        {"type": "dlna", "name": "Receiver"},
    ]


# ── play / stop fan-out ───────────────────────────────────────────────────────


def test_manager_play_calls_every_delivery():
    a = AirPlayDelivery("HomePod")
    c = ChromecastDelivery("TV")
    a.play = AsyncMock()
    c.play = AsyncMock()
    m = DeliveryManager.from_deliveries([a, c])

    asyncio.run(m.play("http://stream", "Title"))

    a.play.assert_awaited_once_with("http://stream", "Title", "", None, None, "", "audio/mpeg")
    c.play.assert_awaited_once_with("http://stream", "Title", "", None, None, "", "audio/mpeg")


def test_manager_stop_swallows_exceptions():
    a = AirPlayDelivery("HomePod")
    c = ChromecastDelivery("TV")
    a.stop = AsyncMock(side_effect=RuntimeError("boom"))
    c.stop = AsyncMock()
    m = DeliveryManager.from_deliveries([a, c])

    asyncio.run(m.stop())

    a.stop.assert_awaited_once()
    c.stop.assert_awaited_once()


def test_manager_play_single_sonos_skips_grouping():
    s = SonosDelivery("Küche")
    s.play = AsyncMock()
    m = DeliveryManager.from_deliveries([s])

    with patch.object(m, "_play_grouped_sonos", new=AsyncMock()) as grouped:
        asyncio.run(m.play("http://stream"))

    grouped.assert_not_awaited()
    s.play.assert_awaited_once()


# ── discover_dlna ─────────────────────────────────────────────────────────────


def test_discover_dlna_filters_out_sonos_manufactured_devices():
    """Sonos speakers expose themselves as generic DLNA MediaRenderers too
    (SoCo itself talks UPnP) — they should only ever show up as Sonos."""
    from delivery.manager import discover_dlna

    sonos_headers = {"location": "http://10.0.0.1/desc.xml", "usn": "uuid:sonos"}
    receiver_headers = {"location": "http://10.0.0.2/desc.xml", "usn": "uuid:receiver"}

    async def fake_async_search(async_callback, **kwargs):
        await async_callback(sonos_headers)
        await async_callback(receiver_headers)

    sonos_device = MagicMock()
    sonos_device.manufacturer = "Sonos, Inc."
    sonos_device.name = "Sonos Media Renderer"

    receiver_device = MagicMock()
    receiver_device.manufacturer = "Yamaha Corporation"
    receiver_device.name = "AV Receiver"

    async def fake_create_dmr_device(location):
        return sonos_device if location == sonos_headers["location"] else receiver_device

    with (
        patch("async_upnp_client.search.async_search", new=fake_async_search),
        patch("delivery.manager._create_dmr_device", new=fake_create_dmr_device),
    ):
        result = asyncio.run(discover_dlna())

    assert result == [{"location": "http://10.0.0.2/desc.xml", "name": "AV Receiver"}]


def test_discover_dlna_skips_and_logs_non_media_renderer_devices(caplog):
    """Devices that answer our MediaRenderer SSDP search but aren't one
    (routers, NAS boxes, a Philips Hue bridge, ...) must be skipped without
    breaking discovery, and logged with their name/IP rather than the raw,
    unhelpful async-upnp-client exception text."""
    import logging

    from delivery.dlna import UnsupportedDlnaDevice
    from delivery.manager import discover_dlna

    hue_headers = {"location": "http://10.2.2.139:80/description.xml", "usn": "uuid:hue"}

    async def fake_async_search(async_callback, **kwargs):
        await async_callback(hue_headers)

    async def fake_create_dmr_device(location):
        raise UnsupportedDlnaDevice("Philips Hue Bridge")

    with (
        patch("async_upnp_client.search.async_search", new=fake_async_search),
        patch("delivery.manager._create_dmr_device", new=fake_create_dmr_device),
        caplog.at_level(logging.INFO, logger="delivery"),
    ):
        result = asyncio.run(discover_dlna())

    assert result == []
    messages = "\n".join(r.message for r in caplog.records)
    assert "Philips Hue Bridge" in messages
    assert "10.2.2.139" in messages


def test_discover_dlna_includes_sonos_when_debug_enabled(monkeypatch):
    """Debug (or louder) log level lets a Sonos-only household exercise the
    DLNA code path — see manager._debug_enabled()'s docstring."""
    from delivery import manager as manager_mod

    monkeypatch.setattr(manager_mod, "_debug_enabled", lambda: True)

    sonos_headers = {"location": "http://10.0.0.1/desc.xml", "usn": "uuid:sonos"}

    async def fake_async_search(async_callback, **kwargs):
        await async_callback(sonos_headers)

    sonos_device = MagicMock()
    sonos_device.manufacturer = "Sonos, Inc."
    sonos_device.name = "Sonos Media Renderer"

    async def fake_create_dmr_device(location):
        return sonos_device

    with (
        patch("async_upnp_client.search.async_search", new=fake_async_search),
        patch("delivery.manager._create_dmr_device", new=fake_create_dmr_device),
    ):
        result = asyncio.run(manager_mod.discover_dlna())

    assert result == [{"location": "http://10.0.0.1/desc.xml", "name": "Sonos Media Renderer"}]


# ── discover_airplay ─────────────────────────────────────────────────────────


def _fake_airplay_device(manufacturer: str, name: str) -> MagicMock:
    service = MagicMock()
    service.properties = {"manufacturer": manufacturer}
    device = MagicMock()
    device.services = [service]
    device.name = name
    device.address = "10.0.0.1"
    device.device_info.model = "Model"
    return device


def test_discover_airplay_filters_out_sonos_manufactured_devices():
    """Sonos exposes AirPlay 2 but requires MFi auth pyatv can't do — real
    streaming to it fails, so it's hidden from the AirPlay list by default."""
    from delivery.manager import discover_airplay

    sonos_device = _fake_airplay_device("Sonos, Inc.", "Sonos AirPlay")
    apple_device = _fake_airplay_device("Apple Inc.", "Living Room HomePod")

    async def fake_scan(loop, timeout=10):
        return [sonos_device, apple_device]

    with patch("pyatv.scan", new=fake_scan):
        result = asyncio.run(discover_airplay())

    assert [d["name"] for d in result] == ["Living Room HomePod"]


def test_discover_airplay_includes_sonos_when_debug_enabled(monkeypatch):
    from delivery import manager as manager_mod

    monkeypatch.setattr(manager_mod, "_debug_enabled", lambda: True)
    sonos_device = _fake_airplay_device("Sonos, Inc.", "Sonos AirPlay")

    async def fake_scan(loop, timeout=10):
        return [sonos_device]

    with patch("pyatv.scan", new=fake_scan):
        result = asyncio.run(manager_mod.discover_airplay())

    assert [d["name"] for d in result] == ["Sonos AirPlay"]


def test_manager_play_multiple_sonos_uses_grouping():
    s1 = SonosDelivery("Küche")
    s2 = SonosDelivery("Wohnzimmer")
    s1.play = AsyncMock()
    s2.play = AsyncMock()
    m = DeliveryManager.from_deliveries([s1, s2])

    with patch.object(m, "_play_grouped_sonos", new=AsyncMock()) as grouped:
        asyncio.run(m.play("http://stream", "T"))

    grouped.assert_awaited_once()
