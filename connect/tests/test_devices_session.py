"""Tests for routes/devices.py — /device-stop."""

from unittest.mock import AsyncMock, patch

from delivery import (
    AirPlayDelivery,
    ChromecastDelivery,
    DeliveryManager,
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
