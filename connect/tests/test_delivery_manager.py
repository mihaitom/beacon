"""Tests for DeliveryManager — construction, factories and fan-out."""

import asyncio
import importlib
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import delivery.manager as manager_mod
from delivery import (
    AirPlayDelivery,
    ChromecastDelivery,
    DeliveryManager,
    DlnaDelivery,
    SonosDelivery,
)


@pytest.fixture(autouse=True)
def _sonos_dedup_enabled(monkeypatch):
    """Pin the Sonos-as-AirPlay/Sonos-as-DLNA dedup filters on for every test
    here.

    manager._debug_enabled() reads the app's *persisted* log level (see
    core/log_level.py), which lives outside the repo — so with Debug
    selected in Settings on the machine running the suite, the filters
    switch themselves off and every test asserting they filter fails,
    while the same code passes on a machine set to Info. Found exactly
    that way on 2026-09-03. The two tests that cover the debug behaviour
    monkeypatch this back to True themselves; theirs runs after this one
    and wins.
    """
    monkeypatch.setattr(manager_mod, "_debug_enabled", lambda: False)


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


def test_manager_current_uri_takes_the_first_target_that_can_answer():
    """play() hands every target the same URL, so one answer speaks for the
    group — see core/session.py's reap_once(), which asks this before
    stopping anything it no longer owns."""
    a = AirPlayDelivery("HomePod")  # can never say
    c = ChromecastDelivery("TV")
    a.current_uri = AsyncMock(return_value=None)
    c.current_uri = AsyncMock(return_value="http://host:8071/stream/abc")
    m = DeliveryManager.from_deliveries([a, c])

    assert asyncio.run(m.current_uri()) == "http://host:8071/stream/abc"


def test_manager_current_uri_skips_a_target_that_errors():
    a = AirPlayDelivery("HomePod")
    c = ChromecastDelivery("TV")
    a.current_uri = AsyncMock(side_effect=RuntimeError("unreachable"))
    c.current_uri = AsyncMock(return_value="http://host:8071/stream/abc")
    m = DeliveryManager.from_deliveries([a, c])

    assert asyncio.run(m.current_uri()) == "http://host:8071/stream/abc"


def test_manager_current_uri_is_none_when_nobody_can_answer():
    a = AirPlayDelivery("HomePod")
    a.current_uri = AsyncMock(return_value=None)
    m = DeliveryManager.from_deliveries([a])

    assert asyncio.run(m.current_uri()) is None


def test_manager_play_single_sonos_skips_grouping():
    s = SonosDelivery("Küche")
    s.play = AsyncMock()
    m = DeliveryManager.from_deliveries([s])

    with patch.object(m, "_play_grouped_sonos", new=AsyncMock()) as grouped:
        asyncio.run(m.play("http://stream"))

    grouped.assert_not_awaited()
    s.play.assert_awaited_once()


# ── import_in_thread / where the protocol libraries get imported ─────────────
# Regression tests: every discover_* below used to import its library inline
# in the coroutine, i.e. on the event loop. Measured in the deployed image
# on 2026-08-22 — pyatv 0.68s, async_upnp_client 0.22s, soco 0.19s — and a
# scan starts all of them at once, which showed up as a 1.71s event-loop
# stall (core/loop_health.py). A scan happens while music is playing, and
# that window is time a cast device's /stream socket isn't served either.


async def test_import_in_thread_runs_off_the_event_loop():
    import threading

    from delivery.lazy_import import import_in_thread

    where: list[int] = []
    real_import = importlib.import_module

    def _recording_import(name: str):
        where.append(threading.get_ident())
        return real_import(name)

    with patch("importlib.import_module", new=_recording_import):
        module = await import_in_thread("json")

    assert module is json
    assert where and where[0] != threading.get_ident()


@pytest.mark.parametrize(
    "func,expected",
    [
        ("discover_sonos", "soco"),
        ("discover_airplay", "pyatv"),
        ("discover_dlna", "async_upnp_client.search"),
    ],
)
def test_discovery_imports_its_library_off_the_loop(func, expected):
    """Pins the fix in place: the import has to go through the helper, not
    back into a bare `import x` inside the coroutine."""
    import delivery.manager as manager_mod

    imported: list[str] = []

    async def _recording(name: str):
        imported.append(name)
        return importlib.import_module(name)

    async def _nothing(*args, **kwargs):
        return []

    with (
        patch.object(manager_mod, "import_in_thread", new=_recording),
        patch("pyatv.scan", new=_nothing),
        patch("async_upnp_client.search.async_search", new=_nothing),
        patch("soco.discover", return_value=[]),
    ):
        asyncio.run(getattr(manager_mod, func)())

    assert expected in imported


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


def _fake_service(
    protocol,
    pairing,
    enabled: bool = True,
    manufacturer: str = "Apple Inc.",
    requires_password: bool = False,
):
    """One pyatv service. The protocol and pairing requirement are the real
    enum members, not stand-ins — discover_airplay() compares against them
    by identity, so a mock that merely looks like one would pass whatever
    the rule happened to be."""
    service = MagicMock()
    service.protocol = protocol
    service.pairing = pairing
    service.enabled = enabled
    service.requires_password = requires_password
    service.properties = {"manufacturer": manufacturer}
    return service


def _fake_airplay_device(manufacturer: str, name: str, services=None) -> MagicMock:
    device = MagicMock()
    if services is None:
        service = MagicMock()
        service.properties = {"manufacturer": manufacturer}
        services = [service]
    device.services = services
    device.name = name
    device.address = "10.0.0.1"
    device.device_info.model = "Model"
    return device


def _needs_pairing_for(services) -> bool:
    """discover_airplay()'s answer for one device with exactly `services`."""
    from delivery.manager import discover_airplay

    device = _fake_airplay_device("Apple Inc.", "Some Receiver", services)

    async def fake_scan(loop, timeout=10):
        return [device]

    with patch("pyatv.scan", new=fake_scan):
        return asyncio.run(discover_airplay())[0]["needs_pairing"]


def test_needs_pairing_is_false_when_raop_asks_for_nothing():
    """The case that made this wrong for everybody. Every modern AirPlay
    receiver also speaks AirPlay 2, and the rule used to be "speaks AirPlay
    2" — so a network of devices that ask for nothing was shown as needing
    pairing throughout, greyed out and unselectable on the phone. Scanned
    live: an Apple TV and four AirPort Express units, all RAOP NotNeeded,
    all marked as needing pairing."""
    from pyatv.const import PairingRequirement, Protocol

    services = [
        _fake_service(Protocol.AirPlay, PairingRequirement.NotNeeded),
        _fake_service(Protocol.RAOP, PairingRequirement.NotNeeded),
    ]

    assert _needs_pairing_for(services) is False


def test_needs_pairing_ignores_a_protocol_the_audio_never_uses():
    """A real Apple TV reports DMAP Mandatory — that is its old remote
    control protocol, and delivery/airplay.py streams over RAOP either way.
    What some other service wants says nothing about the audio path."""
    from pyatv.const import PairingRequirement, Protocol

    services = [
        _fake_service(Protocol.DMAP, PairingRequirement.Mandatory),
        _fake_service(Protocol.AirPlay, PairingRequirement.NotNeeded),
        _fake_service(Protocol.RAOP, PairingRequirement.NotNeeded),
    ]

    assert _needs_pairing_for(services) is False


def test_needs_pairing_is_true_for_a_password_protected_speaker():
    """A speaker password is not pairing — pyatv keeps the two apart, and an
    AirPort Express with one set reports RAOP `requires_password` while its
    pairing requirement stays NotNeeded (confirmed on a real unit). It is
    still not usable as it stands, and the remedy is the same one: pairing,
    with the password typed into that flow. Marking it ready would trade
    the old "everything needs pairing" mistake for a device that fails
    silently the moment somebody presses play."""
    from pyatv.const import PairingRequirement, Protocol

    services = [
        _fake_service(Protocol.AirPlay, PairingRequirement.NotNeeded, requires_password=True),
        _fake_service(Protocol.RAOP, PairingRequirement.NotNeeded, requires_password=True),
    ]

    assert _needs_pairing_for(services) is True


def test_needs_pairing_is_true_when_raop_demands_it():
    from pyatv.const import PairingRequirement, Protocol

    services = [_fake_service(Protocol.RAOP, PairingRequirement.Mandatory)]

    assert _needs_pairing_for(services) is True


def test_needs_pairing_is_false_when_raop_only_offers_it():
    """Optional means it works either way, and the unpaired path is the one
    this backend takes when it can."""
    from pyatv.const import PairingRequirement, Protocol

    services = [_fake_service(Protocol.RAOP, PairingRequirement.Optional)]

    assert _needs_pairing_for(services) is False


def test_needs_pairing_is_true_without_a_usable_raop_service():
    """The one case that genuinely needs it: no RAOP at all means the
    unpaired path delivery/airplay.py takes does not exist for this device.
    A RAOP service that is present but disabled is the same thing."""
    from pyatv.const import PairingRequirement, Protocol

    airplay_only = [_fake_service(Protocol.AirPlay, PairingRequirement.NotNeeded)]
    disabled_raop = [
        _fake_service(Protocol.AirPlay, PairingRequirement.NotNeeded),
        _fake_service(Protocol.RAOP, PairingRequirement.NotNeeded, enabled=False),
    ]

    assert _needs_pairing_for(airplay_only) is True
    assert _needs_pairing_for(disabled_raop) is True


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


def test_manager_play_is_a_noop_with_no_deliveries():
    m = DeliveryManager.from_deliveries([])

    asyncio.run(m.play("http://stream"))  # must not raise


def test_manager_play_logs_but_does_not_raise_on_a_partial_delivery_error(caplog):
    """One target failing in a group must not sink the whole dispatch —
    the other target actually started fine, so callers (routes/playback.py)
    rolling back over this would kill state for a device that's genuinely
    playing, not just the one that had trouble."""
    import logging

    a = AirPlayDelivery("HomePod")
    a.play = AsyncMock(side_effect=RuntimeError("device unreachable"))
    c = ChromecastDelivery("TV")
    c.play = AsyncMock()
    m = DeliveryManager.from_deliveries([a, c])

    with caplog.at_level(logging.ERROR, logger="delivery"):
        asyncio.run(m.play("http://stream"))  # must not raise

    assert "device unreachable" in caplog.text
    c.play.assert_awaited_once()


def test_manager_play_raises_when_every_delivery_fails(caplog):
    """Regression test: unlike a partial failure, nothing is actually
    playing anywhere once *every* target in the group failed — callers
    need this to propagate so their own rollback (undoing state, releasing
    claims) actually fires, instead of a dispatch that produced no
    playback anywhere still reading as a success."""
    import logging

    a = AirPlayDelivery("HomePod")
    a.play = AsyncMock(side_effect=RuntimeError("device unreachable"))
    c = ChromecastDelivery("TV")
    c.play = AsyncMock(side_effect=RuntimeError("connection refused"))
    m = DeliveryManager.from_deliveries([a, c])

    with caplog.at_level(logging.ERROR, logger="delivery"), pytest.raises(RuntimeError):
        asyncio.run(m.play("http://stream"))

    assert "device unreachable" in caplog.text
    assert "connection refused" in caplog.text


def test_manager_pause_fans_out_and_swallows_exceptions():
    a = AirPlayDelivery("HomePod")
    c = ChromecastDelivery("TV")
    a.pause = AsyncMock(side_effect=RuntimeError("boom"))
    c.pause = AsyncMock()
    m = DeliveryManager.from_deliveries([a, c])

    asyncio.run(m.pause())  # must not raise

    a.pause.assert_awaited_once()
    c.pause.assert_awaited_once()


def test_manager_resume_fans_out_and_swallows_exceptions():
    a = AirPlayDelivery("HomePod")
    c = ChromecastDelivery("TV")
    a.resume = AsyncMock(side_effect=RuntimeError("boom"))
    c.resume = AsyncMock()
    m = DeliveryManager.from_deliveries([a, c])

    asyncio.run(m.resume())  # must not raise

    a.resume.assert_awaited_once()
    c.resume.assert_awaited_once()


def test_manager_play_all_and_stop_all_delegate_to_play_and_stop():
    a = AirPlayDelivery("HomePod")
    a.play = AsyncMock()
    a.stop = AsyncMock()
    m = DeliveryManager.from_deliveries([a])

    asyncio.run(m.play_all("http://stream", "Title"))
    asyncio.run(m.stop_all())

    a.play.assert_awaited_once_with("http://stream", "Title", "", None, None, "", "audio/mpeg")
    a.stop.assert_awaited_once()


def test_manager_repr_lists_every_target():
    m = DeliveryManager.from_deliveries([SonosDelivery("Küche"), ChromecastDelivery("TV")])

    assert repr(m) == "sonos:Küche, chromecast:TV"


def test_manager_repr_with_no_targets():
    m = DeliveryManager.from_deliveries([])

    assert repr(m) == "<no targets>"


# ── _play_grouped_sonos ──────────────────────────────────────────────────────
# Real SoCo group choreography: every follower leaves its current group,
# then joins the (arbitrarily-chosen-as-first) coordinator, with a settle
# delay on either side, and only then does /play actually get dispatched —
# to the coordinator only, which is what fans it out to the whole group.


def _fake_sonos_device(name: str) -> MagicMock:
    device = MagicMock()
    device.player_name = name
    return device


def test_play_grouped_sonos_joins_followers_to_the_first_devices_coordinator():
    coordinator_delivery = SonosDelivery("Küche")
    follower_delivery = SonosDelivery("Wohnzimmer")
    raw_coordinator = _fake_sonos_device("Küche")
    raw_follower = _fake_sonos_device("Wohnzimmer")
    coordinator_delivery._get_device = MagicMock(return_value=raw_coordinator)
    follower_delivery._get_device = MagicMock(return_value=raw_follower)
    coordinator_delivery.play = AsyncMock()
    m = DeliveryManager.from_deliveries([coordinator_delivery, follower_delivery])

    with patch("asyncio.sleep", new=AsyncMock()):
        asyncio.run(
            m._play_grouped_sonos(
                [coordinator_delivery, follower_delivery], "http://stream", "Title"
            )
        )

    raw_follower.unjoin.assert_called_once()
    raw_follower.join.assert_called_once_with(raw_coordinator)
    # Only the coordinator's own delivery actually dispatches /play — SoCo
    # fans it out to the rest of the group once joined.
    coordinator_delivery.play.assert_awaited_once_with(
        "http://stream", "Title", "", None, None, "", "audio/mpeg"
    )


def test_play_grouped_sonos_survives_a_follower_that_wont_unjoin():
    coordinator_delivery = SonosDelivery("Küche")
    follower_delivery = SonosDelivery("Wohnzimmer")
    raw_coordinator = _fake_sonos_device("Küche")
    raw_follower = _fake_sonos_device("Wohnzimmer")
    raw_follower.unjoin.side_effect = RuntimeError("network hiccup")
    coordinator_delivery._get_device = MagicMock(return_value=raw_coordinator)
    follower_delivery._get_device = MagicMock(return_value=raw_follower)
    coordinator_delivery.play = AsyncMock()
    m = DeliveryManager.from_deliveries([coordinator_delivery, follower_delivery])

    with patch("asyncio.sleep", new=AsyncMock()):
        asyncio.run(
            m._play_grouped_sonos(
                [coordinator_delivery, follower_delivery], "http://stream", "Title"
            )
        )  # must not raise

    # Still attempts to join afterwards, and still dispatches /play — one
    # follower failing to leave its old group shouldn't abandon the rest of
    # the grouping choreography.
    raw_follower.join.assert_called_once_with(raw_coordinator)
    coordinator_delivery.play.assert_awaited_once()


def test_play_grouped_sonos_survives_a_follower_that_wont_join():
    coordinator_delivery = SonosDelivery("Küche")
    follower_delivery = SonosDelivery("Wohnzimmer")
    raw_coordinator = _fake_sonos_device("Küche")
    raw_follower = _fake_sonos_device("Wohnzimmer")
    raw_follower.join.side_effect = RuntimeError("device busy")
    coordinator_delivery._get_device = MagicMock(return_value=raw_coordinator)
    follower_delivery._get_device = MagicMock(return_value=raw_follower)
    coordinator_delivery.play = AsyncMock()
    m = DeliveryManager.from_deliveries([coordinator_delivery, follower_delivery])

    with patch("asyncio.sleep", new=AsyncMock()):
        asyncio.run(
            m._play_grouped_sonos(
                [coordinator_delivery, follower_delivery], "http://stream", "Title"
            )
        )  # must not raise

    coordinator_delivery.play.assert_awaited_once()


# ── discover_sonos ────────────────────────────────────────────────────────────


def test_discover_sonos_reports_name_and_ip():
    from delivery.manager import discover_sonos

    device = MagicMock()
    device.player_name = "Küche"
    device.ip_address = "10.0.0.5"

    with patch("soco.discover", return_value=[device]):
        result = asyncio.run(discover_sonos())

    assert result == [{"name": "Küche", "ip": "10.0.0.5"}]


def test_discover_sonos_handles_no_devices_found():
    from delivery.manager import discover_sonos

    with patch("soco.discover", return_value=None):
        result = asyncio.run(discover_sonos())

    assert result == []


# ── discover_chromecast ──────────────────────────────────────────────────────


def test_discover_chromecast_reports_host_model_and_name():
    from delivery.manager import discover_chromecast

    info = MagicMock(model_name="Chromecast Ultra", friendly_name="TV")
    info.host = "10.0.0.9"
    browser = MagicMock()
    browser.devices = {"uuid-1": info}

    with (
        patch("delivery.manager._ensure_cast_browser", return_value=(browser, MagicMock())),
        patch("delivery.manager._wait_for_discovery"),
    ):
        result = asyncio.run(discover_chromecast())

    assert result == [{"host": "10.0.0.9", "model": "Chromecast Ultra", "name": "TV"}]


def test_discover_chromecast_handles_a_device_reporting_no_host():
    from delivery.manager import discover_chromecast

    info = MagicMock(model_name="Chromecast", friendly_name="Bedroom")
    info.host = None
    browser = MagicMock()
    browser.devices = {"uuid-1": info}

    with (
        patch("delivery.manager._ensure_cast_browser", return_value=(browser, MagicMock())),
        patch("delivery.manager._wait_for_discovery"),
    ):
        result = asyncio.run(discover_chromecast())

    assert result == [{"host": "", "model": "Chromecast", "name": "Bedroom"}]


# ── verbose logging for the Sonos-duplicate skips ────────────────────────────


def test_discover_airplay_logs_skipped_sonos_devices_when_verbose(caplog):
    import logging

    from delivery.manager import discover_airplay

    sonos_device = _fake_airplay_device("Sonos, Inc.", "Sonos AirPlay")

    async def fake_scan(loop, timeout=10):
        return [sonos_device]

    with (
        patch("pyatv.scan", new=fake_scan),
        caplog.at_level(logging.INFO, logger="delivery"),
    ):
        result = asyncio.run(discover_airplay(verbose=True))

    assert result == []
    assert "Sonos AirPlay" in caplog.text


def test_discover_dlna_logs_skipped_sonos_devices_when_verbose(caplog):
    import logging

    from delivery.manager import discover_dlna

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
        caplog.at_level(logging.INFO, logger="delivery"),
    ):
        result = asyncio.run(discover_dlna(verbose=True))

    assert result == []
    assert "Sonos Media Renderer" in caplog.text


def test_discover_dlna_skips_and_logs_a_device_that_errors_unexpectedly(caplog):
    """Distinct from test_discover_dlna_skips_and_logs_non_media_renderer_devices
    above (UnsupportedDlnaDevice, expected/handled) — this is a genuinely
    unexpected failure (device dropped off the network mid-probe, malformed
    XML, ...) and must be skipped the same way, not bubble up and abort the
    whole discovery sweep over every other device found."""
    import logging

    from delivery.manager import discover_dlna

    flaky_headers = {"location": "http://10.0.0.7/desc.xml", "usn": "uuid:flaky"}

    async def fake_async_search(async_callback, **kwargs):
        await async_callback(flaky_headers)

    async def fake_create_dmr_device(location):
        raise ConnectionError("connection reset")

    with (
        patch("async_upnp_client.search.async_search", new=fake_async_search),
        patch("delivery.manager._create_dmr_device", new=fake_create_dmr_device),
        caplog.at_level(logging.WARNING, logger="delivery"),
    ):
        result = asyncio.run(discover_dlna())

    assert result == []
    assert "10.0.0.7" in caplog.text
