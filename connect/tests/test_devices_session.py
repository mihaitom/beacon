"""Tests for routes/devices.py — /device-stop."""

import logging
from unittest.mock import AsyncMock, MagicMock, patch

from delivery import (
    AirPlayDelivery,
    ChromecastDelivery,
    DeliveryManager,
    DlnaDelivery,
    SonosDelivery,
)


def test_device_stop_chromecast_resets_state_when_last(client, default_session):
    default_session.state.is_streaming = True
    default_session.state.active_delivery = ChromecastDelivery("TV")

    with patch.object(ChromecastDelivery, "stop", new=AsyncMock()) as stop:
        r = client.post("/device-stop?device_type=chromecast&name=TV")

    assert r.status_code == 200
    assert r.json()["status"] == "stopped"
    stop.assert_awaited_once()
    assert default_session.state.is_streaming is False
    assert default_session.state.active_delivery is None


def test_device_stop_chromecast_keeps_remaining_deliveries(client, default_session):
    remaining_sonos = SonosDelivery("Küche")
    default_session.state.is_streaming = True
    default_session.state.active_delivery = DeliveryManager.from_deliveries(
        [ChromecastDelivery("TV"), remaining_sonos]
    )

    with patch.object(ChromecastDelivery, "stop", new=AsyncMock()):
        r = client.post("/device-stop?device_type=chromecast&name=TV")

    assert r.json()["status"] == "stopped"
    assert default_session.state.is_streaming is True
    assert default_session.state.active_delivery is remaining_sonos


def test_device_stop_airplay_branch(client, default_session):
    default_session.state.is_streaming = True
    default_session.state.active_delivery = AirPlayDelivery("HomePod")

    with patch.object(AirPlayDelivery, "stop", new=AsyncMock()) as stop:
        r = client.post("/device-stop?device_type=airplay&name=HomePod")

    assert r.json()["status"] == "stopped"
    stop.assert_awaited_once()
    assert default_session.state.active_delivery is None


def test_device_stop_airplay_stops_the_real_instance(client, default_session):
    """Regression test: /device-stop used to construct a fresh
    AirPlayDelivery(name) and call stop() on THAT instead of the real,
    currently-streaming instance held in session.state.active_delivery — a
    no-op, since AirPlay's stream task/connection live on the instance
    itself (see delivery/airplay.py), leaving the RAOP stream running
    forever after deselecting the device in the frontend. Patching the
    class (as the other AirPlay test above does) wouldn't catch this — it
    intercepts stop() on ANY instance — so this asserts object identity."""
    real = AirPlayDelivery("HomePod")
    real.stop = AsyncMock()
    default_session.state.is_streaming = True
    default_session.state.active_delivery = real

    r = client.post("/device-stop?device_type=airplay&name=HomePod")

    assert r.json()["status"] == "stopped"
    real.stop.assert_awaited_once()


def test_device_stop_returns_error_on_exception(client, default_session):
    default_session.state.is_streaming = True
    default_session.state.active_delivery = ChromecastDelivery("TV")

    with patch.object(
        ChromecastDelivery, "stop", new=AsyncMock(side_effect=RuntimeError("boom"))
    ):
        r = client.post("/device-stop?device_type=chromecast&name=TV")

    assert "error" in r.json()


def test_device_stop_dlna_branch(client, default_session):
    default_session.state.is_streaming = True
    default_session.state.active_delivery = DlnaDelivery("Receiver")

    with patch.object(DlnaDelivery, "stop", new=AsyncMock()) as stop:
        r = client.post("/device-stop?device_type=dlna&name=Receiver")

    assert r.json()["status"] == "stopped"
    stop.assert_awaited_once()
    assert default_session.state.active_delivery is None


# ── Sonos branch — coordinator/follower ungrouping, restart on the rest ─────


def _fake_soco_device(name: str, is_coordinator: bool = True) -> MagicMock:
    device = MagicMock()
    device.player_name = name
    device.is_coordinator = is_coordinator
    return device


def test_device_stop_sonos_device_not_found_on_network(client, default_session, caplog):
    """The delivery instance itself is still matched/removed by type+name
    (independent of the live network lookup below) — only the raw-device
    stop() call is skipped when soco can no longer find it out there."""
    default_session.state.is_streaming = True
    default_session.state.active_delivery = SonosDelivery("Küche")

    with (
        patch("soco.discover", return_value=[]),
        caplog.at_level(logging.WARNING, logger="connect.devices"),
    ):
        r = client.post("/device-stop?device_type=sonos&name=Küche")

    assert r.json()["status"] == "stopped"
    assert "not found on network" in caplog.text
    assert default_session.state.active_delivery is None


def test_device_stop_sonos_standalone_coordinator_just_stops(client, default_session):
    raw = _fake_soco_device("Küche", is_coordinator=True)
    default_session.state.is_streaming = True
    default_session.state.active_delivery = SonosDelivery("Küche")

    with patch("soco.discover", return_value=[raw]):
        r = client.post("/device-stop?device_type=sonos&name=Küche")

    assert r.json()["status"] == "stopped"
    raw.stop.assert_called_once()
    raw.unjoin.assert_not_called()  # no followers to ungroup, wasn't itself one


def test_device_stop_sonos_follower_unjoins_itself_before_stopping(client, default_session):
    """Not the coordinator — must leave its group first so stopping it
    doesn't also kill playback for the rest of the group."""
    raw = _fake_soco_device("Wohnzimmer", is_coordinator=False)
    default_session.state.is_streaming = True
    default_session.state.active_delivery = SonosDelivery("Wohnzimmer")

    with patch("soco.discover", return_value=[raw]):
        r = client.post("/device-stop?device_type=sonos&name=Wohnzimmer")

    assert r.json()["status"] == "stopped"
    raw.unjoin.assert_called_once()
    raw.stop.assert_called_once()


def test_device_stop_sonos_coordinator_ungroups_followers_and_restarts_the_stream(
    client, default_session
):
    """Stopping the coordinator of a still-active group must not silence the
    remaining followers — they get ungrouped (each becomes its own
    coordinator) and the stream restarts on them, instead of the whole
    group falling silent along with the one device the user deselected."""
    raw_coordinator = _fake_soco_device("Küche", is_coordinator=True)
    raw_follower = _fake_soco_device("Wohnzimmer", is_coordinator=False)
    coordinator_delivery = SonosDelivery("Küche")
    follower_delivery = SonosDelivery("Wohnzimmer")
    follower_delivery.play = AsyncMock()
    default_session.state.is_streaming = True
    default_session.state.active_delivery = DeliveryManager.from_deliveries(
        [coordinator_delivery, follower_delivery]
    )

    with (
        patch("soco.discover", return_value=[raw_coordinator, raw_follower]),
        patch("asyncio.sleep", new=AsyncMock()),
    ):
        r = client.post("/device-stop?device_type=sonos&name=Küche")

    assert r.json()["status"] == "stopped"
    raw_follower.unjoin.assert_called_once()
    raw_coordinator.stop.assert_called_once()
    assert default_session.state.active_delivery is follower_delivery
    follower_delivery.play.assert_awaited_once()
    assert default_session.state.is_streaming is True


def test_device_stop_sonos_survives_a_follower_that_wont_ungroup(client, default_session, caplog):
    raw_coordinator = _fake_soco_device("Küche", is_coordinator=True)
    raw_follower = _fake_soco_device("Wohnzimmer", is_coordinator=False)
    raw_follower.unjoin.side_effect = RuntimeError("network hiccup")
    coordinator_delivery = SonosDelivery("Küche")
    follower_delivery = SonosDelivery("Wohnzimmer")
    follower_delivery.play = AsyncMock()
    default_session.state.is_streaming = True
    default_session.state.active_delivery = DeliveryManager.from_deliveries(
        [coordinator_delivery, follower_delivery]
    )

    with (
        patch("soco.discover", return_value=[raw_coordinator, raw_follower]),
        patch("asyncio.sleep", new=AsyncMock()),
        caplog.at_level(logging.WARNING, logger="connect.devices"),
    ):
        r = client.post("/device-stop?device_type=sonos&name=Küche")

    assert r.json()["status"] == "stopped"
    assert "unjoin Wohnzimmer" in caplog.text
    # Still restarts the stream despite the failed ungroup — one follower
    # not leaving cleanly shouldn't abandon the rest of the group.
    follower_delivery.play.assert_awaited_once()


def test_device_stop_sonos_restart_uses_the_radio_url_when_a_radio_station_is_active(
    client, default_session
):
    raw_coordinator = _fake_soco_device("Küche", is_coordinator=True)
    raw_follower = _fake_soco_device("Wohnzimmer", is_coordinator=False)
    coordinator_delivery = SonosDelivery("Küche")
    follower_delivery = SonosDelivery("Wohnzimmer")
    follower_delivery.play = AsyncMock()
    default_session.state.is_streaming = True
    default_session.state.radio_info = {
        "url": "https://radio.example/stream",
        "title": "Jazz FM",
    }
    default_session.state.active_delivery = DeliveryManager.from_deliveries(
        [coordinator_delivery, follower_delivery]
    )

    with (
        patch("soco.discover", return_value=[raw_coordinator, raw_follower]),
        patch("asyncio.sleep", new=AsyncMock()),
    ):
        client.post("/device-stop?device_type=sonos&name=Küche")

    follower_delivery.play.assert_awaited_once_with("https://radio.example/stream", "Jazz FM")


def test_device_stop_sonos_restart_failure_is_logged_not_raised(client, default_session, caplog):
    raw_coordinator = _fake_soco_device("Küche", is_coordinator=True)
    raw_follower = _fake_soco_device("Wohnzimmer", is_coordinator=False)
    coordinator_delivery = SonosDelivery("Küche")
    follower_delivery = SonosDelivery("Wohnzimmer")
    follower_delivery.play = AsyncMock(side_effect=RuntimeError("device busy"))
    default_session.state.is_streaming = True
    default_session.state.active_delivery = DeliveryManager.from_deliveries(
        [coordinator_delivery, follower_delivery]
    )

    with (
        patch("soco.discover", return_value=[raw_coordinator, raw_follower]),
        patch("asyncio.sleep", new=AsyncMock()),
        caplog.at_level(logging.ERROR, logger="connect.devices"),
    ):
        r = client.post("/device-stop?device_type=sonos&name=Küche")

    assert r.status_code == 200  # the /device-stop request itself still succeeds
    assert "Restart error" in caplog.text


def test_device_stop_releases_the_claim(client, default_session):
    from core.claims import claims

    default_session.state.is_streaming = True
    default_session.state.active_delivery = ChromecastDelivery("TV")

    import asyncio

    asyncio.run(claims.claim("chromecast", "TV", default_session.session_id))
    assert claims.owner_of("chromecast", "TV") == default_session.session_id

    with patch.object(ChromecastDelivery, "stop", new=AsyncMock()):
        client.post("/device-stop?device_type=chromecast&name=TV")

    assert claims.owner_of("chromecast", "TV") is None


def test_device_stop_releases_the_claim_even_when_the_stop_call_fails(client, default_session):
    """Regression test: the device's own stop() call failing (offline,
    network timeout) must not leave it locked to this session forever —
    /discover would otherwise keep reporting device_in_use for a device
    nothing is confirmed to still be playing on."""
    from core.claims import claims

    default_session.state.is_streaming = True
    default_session.state.active_delivery = ChromecastDelivery("TV")

    import asyncio

    asyncio.run(claims.claim("chromecast", "TV", default_session.session_id))

    with patch.object(
        ChromecastDelivery, "stop", new=AsyncMock(side_effect=RuntimeError("boom"))
    ):
        r = client.post("/device-stop?device_type=chromecast&name=TV")

    assert "error" in r.json()
    assert claims.owner_of("chromecast", "TV") is None
