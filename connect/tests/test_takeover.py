"""Tests for core/session.py's check_claims()/displace_target() — the Phase 2
takeover primitives shared by /play, /play-url and /join."""

import asyncio
from unittest.mock import AsyncMock

from core.claims import claims
from core.session import check_claims, displace_target, registry
from delivery import ChromecastDelivery, DeliveryManager, SonosDelivery


# ── check_claims ─────────────────────────────────────────────────────────────


def test_check_claims_refuses_without_force_on_conflict(default_session):
    asyncio.run(claims.claim("chromecast", "TV", "other-session"))
    target = ChromecastDelivery("TV")

    error, displaced = asyncio.run(check_claims(target, default_session, force=False))

    assert error == {
        "device": {"name": "TV", "type": "chromecast"},
        "error": "device_in_use",
        "owner": "another session",
    }
    assert displaced == []
    assert claims.owner_of("chromecast", "TV") == "other-session"


def test_check_claims_reports_owners_display_name_when_known(default_session):
    other = asyncio.run(registry.get_or_create("other-session"))
    other.display_name = "Bob"
    asyncio.run(claims.claim("chromecast", "TV", "other-session"))
    target = ChromecastDelivery("TV")

    error, _ = asyncio.run(check_claims(target, default_session, force=False))

    assert error["owner"] == "Bob"


def test_check_claims_succeeds_when_unclaimed(default_session):
    target = ChromecastDelivery("TV")

    error, displaced = asyncio.run(check_claims(target, default_session, force=False))

    assert error is None
    assert displaced == []
    assert claims.owner_of("chromecast", "TV") == default_session.session_id


def test_check_claims_with_force_displaces_and_returns_previous_owner(default_session):
    asyncio.run(claims.claim("chromecast", "TV", "other-session"))
    target = ChromecastDelivery("TV")

    error, displaced = asyncio.run(check_claims(target, default_session, force=True))

    assert error is None
    assert displaced == [("chromecast", "TV", "other-session")]
    assert claims.owner_of("chromecast", "TV") == default_session.session_id


# ── displace_target ───────────────────────────────────────────────────────────


def test_displace_target_stops_delivery_and_clears_single_active_delivery(default_session):
    other = asyncio.run(registry.get_or_create("other-session"))
    delivery = ChromecastDelivery("TV")
    delivery.stop = AsyncMock()
    other.state.is_streaming = True
    other.state.active_delivery = delivery

    asyncio.run(displace_target(other, "chromecast", "TV"))

    delivery.stop.assert_awaited_once()
    assert other.state.active_delivery is None
    assert other.state.is_streaming is False


def test_displace_target_only_removes_the_matching_device_from_a_group(default_session):
    other = asyncio.run(registry.get_or_create("other-session"))
    lost = SonosDelivery("Küche")
    lost.stop = AsyncMock()
    kept = SonosDelivery("Wohnzimmer")
    other.state.is_streaming = True
    other.state.active_delivery = DeliveryManager.from_deliveries([lost, kept])

    asyncio.run(displace_target(other, "sonos", "Küche"))

    lost.stop.assert_awaited_once()
    # Still streaming — the other Sonos speaker in the group is untouched.
    assert other.state.is_streaming is True
    assert other.state.active_delivery is kept


def test_displace_target_broadcasts_on_the_owners_own_event_bus(default_session):
    other = asyncio.run(registry.get_or_create("other-session"))
    delivery = ChromecastDelivery("TV")
    delivery.stop = AsyncMock()
    other.state.active_delivery = delivery
    q = other.event_bus.subscribe()

    asyncio.run(displace_target(other, "chromecast", "TV"))

    payload = q.get_nowait()
    assert payload["targets"] == []
    assert payload["streaming"] is False


def test_displace_target_is_a_noop_when_target_does_not_match_active_delivery(default_session):
    other = asyncio.run(registry.get_or_create("other-session"))
    delivery = ChromecastDelivery("TV")
    delivery.stop = AsyncMock()
    other.state.is_streaming = True
    other.state.active_delivery = delivery

    # Displacing an unrelated device the session isn't actually streaming to
    # must not touch its real active_delivery.
    asyncio.run(displace_target(other, "sonos", "Küche"))

    delivery.stop.assert_not_awaited()
    assert other.state.active_delivery is delivery
    assert other.state.is_streaming is True


def test_displace_target_is_a_noop_when_owner_has_no_active_delivery(default_session):
    other = asyncio.run(registry.get_or_create("other-session"))
    other.state.active_delivery = None

    # Must not raise even though there's nothing to stop.
    asyncio.run(displace_target(other, "chromecast", "TV"))

    assert other.state.active_delivery is None
