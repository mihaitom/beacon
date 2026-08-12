"""Tests for routes/join.py — /join and /claim."""

from unittest.mock import AsyncMock, patch

import pytest

from delivery import (
    AirPlayDelivery,
    ChromecastDelivery,
    DeliveryManager,
    SonosDelivery,
)

# ── /join ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def _streaming(default_session):
    default_session.state.is_streaming = True
    yield


def test_join_rejected_when_not_streaming(client, default_session):
    r = client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})
    assert "error" in r.json()


def test_join_chromecast_plays_and_sets_active(client, default_session, _streaming):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        r = client.post(
            "/join", json={"target_type": "chromecast", "target_name": "TV"}
        )

    assert r.json()["status"] == "joined"
    play.assert_awaited_once()
    assert isinstance(default_session.state.active_delivery, ChromecastDelivery)
    assert default_session.state.active_delivery.target == "TV"


def test_join_airplay_plays_and_sets_active(client, default_session, _streaming):
    with patch.object(AirPlayDelivery, "play", new=AsyncMock()) as play:
        r = client.post(
            "/join", json={"target_type": "airplay", "target_name": "HomePod"}
        )

    assert r.json()["status"] == "joined"
    play.assert_awaited_once()
    assert isinstance(default_session.state.active_delivery, AirPlayDelivery)


def test_join_chromecast_appends_to_existing_manager(
    client, default_session, _streaming
):
    existing = AirPlayDelivery("HomePod")
    default_session.state.active_delivery = DeliveryManager.from_deliveries([existing])

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    mgr = default_session.state.active_delivery
    assert isinstance(mgr, DeliveryManager)
    assert len(mgr.deliveries) == 2
    assert any(isinstance(d, ChromecastDelivery) for d in mgr.deliveries)


def test_join_chromecast_promotes_single_active_to_manager(
    client, default_session, _streaming
):
    default_session.state.active_delivery = AirPlayDelivery("HomePod")

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    mgr = default_session.state.active_delivery
    assert isinstance(mgr, DeliveryManager)
    assert {type(d) for d in mgr.deliveries} == {AirPlayDelivery, ChromecastDelivery}


def test_join_sonos_falls_back_to_individual_play_when_group_fails(
    client, default_session, _streaming
):
    existing_sonos = SonosDelivery("Küche")
    default_session.state.active_delivery = existing_sonos

    fallback = AsyncMock()
    with (
        patch.object(
            SonosDelivery, "_get_device", side_effect=RuntimeError("group failed")
        ),
        patch.object(SonosDelivery, "play", new=fallback),
    ):
        r = client.post(
            "/join", json={"target_type": "sonos", "target_name": "Wohnzimmer"}
        )

    assert r.json()["status"] == "joined"
    fallback.assert_awaited_once()


def test_join_reconnects_to_radio_url_not_stream_proxy(
    client, default_session, _streaming
):
    """Radio has no track loaded, so joining an additional device must reuse
    its own URL — the FFmpeg /stream proxy 204s with nothing to play."""
    default_session.state.radio_info = {"title": "Radio FM", "url": "http://stream/radio"}

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        r = client.post(
            "/join", json={"target_type": "chromecast", "target_name": "TV"}
        )

    assert r.json()["status"] == "joined"
    play.assert_awaited_once_with("http://stream/radio", "Radio FM")


def test_join_sonos_without_existing_sonos_plays_individually(
    client, default_session, _streaming
):
    default_session.state.active_delivery = None

    with patch.object(SonosDelivery, "play", new=AsyncMock()) as play:
        r = client.post(
            "/join", json={"target_type": "sonos", "target_name": "Wohnzimmer"}
        )

    assert r.json()["status"] == "joined"
    play.assert_awaited_once()


def test_join_rejected_when_target_claimed_by_another_session(client, _streaming):
    from core.claims import claims

    import asyncio

    asyncio.run(claims.claim("chromecast", "TV", "some-other-session"))

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        r = client.post(
            "/join", json={"target_type": "chromecast", "target_name": "TV"}
        )

    body = r.json()
    assert body["error"] == "device_in_use"
    assert body["device"] == {"name": "TV", "type": "chromecast"}
    play.assert_not_awaited()


def test_join_with_force_displaces_other_sessions_claim(
    client, default_session, _streaming
):
    from core.claims import claims
    from core.session import registry

    import asyncio

    other = asyncio.run(registry.get_or_create("some-other-session"))
    other.state.is_streaming = True
    other_delivery = ChromecastDelivery("TV")
    other.state.active_delivery = other_delivery
    asyncio.run(claims.claim("chromecast", "TV", "some-other-session"))

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
        patch.object(ChromecastDelivery, "stop", new=AsyncMock()) as other_stop,
    ):
        r = client.post(
            "/join",
            json={"force": True, "target_type": "chromecast", "target_name": "TV"},
        )

    assert r.json()["status"] == "joined"
    play.assert_awaited_once()
    other_stop.assert_awaited_once()
    assert other.state.active_delivery is None
    assert other.state.is_streaming is False
    assert claims.owner_of("chromecast", "TV") == default_session.session_id
    assert isinstance(default_session.state.active_delivery, ChromecastDelivery)


# ── /claim ────────────────────────────────────────────────────────────────────


def test_claim_sets_active_delivery_without_starting_playback(client, default_session):
    from core.claims import claims

    r = client.post(
        "/claim", json={"targets": [{"name": "TV", "type": "chromecast"}]}
    )

    assert r.json()["status"] == "claimed"
    # resolve_target() always wraps a `targets` list in a DeliveryManager,
    # even for a single device.
    active = default_session.state.active_delivery
    assert isinstance(active, DeliveryManager)
    assert [d.target for d in active.deliveries] == ["TV"]
    assert isinstance(active.deliveries[0], ChromecastDelivery)
    # No playback started — /claim only reserves the device.
    assert default_session.state.is_streaming is False
    assert claims.owner_of("chromecast", "TV") == default_session.session_id


def test_claim_rejected_without_force_when_claimed_by_another_session(client, default_session):
    from core.claims import claims

    import asyncio

    asyncio.run(claims.claim("chromecast", "TV", "some-other-session"))

    r = client.post(
        "/claim", json={"targets": [{"name": "TV", "type": "chromecast"}]}
    )

    body = r.json()
    assert body["error"] == "device_in_use"
    assert body["device"] == {"name": "TV", "type": "chromecast"}


def test_claim_with_force_displaces_other_sessions_claim_and_stops_their_delivery(
    client, default_session
):
    from core.claims import claims
    from core.session import registry

    import asyncio

    other = asyncio.run(registry.get_or_create("some-other-session"))
    other.state.is_streaming = True
    other_delivery = ChromecastDelivery("TV")
    other.state.active_delivery = other_delivery
    asyncio.run(claims.claim("chromecast", "TV", "some-other-session"))

    with patch.object(ChromecastDelivery, "stop", new=AsyncMock()) as other_stop:
        r = client.post(
            "/claim",
            json={"force": True, "targets": [{"name": "TV", "type": "chromecast"}]},
        )

    assert r.json()["status"] == "claimed"
    other_stop.assert_awaited_once()
    assert other.state.active_delivery is None
    assert other.state.is_streaming is False
    assert claims.owner_of("chromecast", "TV") == default_session.session_id
    active = default_session.state.active_delivery
    assert isinstance(active, DeliveryManager)
    assert [d.target for d in active.deliveries] == ["TV"]
    assert default_session.state.is_streaming is False


def test_claim_returns_error_with_no_targets(client, default_session):
    r = client.post("/claim", json={"targets": []})
    assert "error" in r.json()
