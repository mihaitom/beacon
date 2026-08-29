"""Tests for core/claims.py — ClaimRegistry."""

import asyncio

from core.claims import ClaimRegistry


def test_claim_succeeds_when_unclaimed():
    registry = ClaimRegistry()
    result = asyncio.run(registry.claim("chromecast", "TV", "session-a"))
    assert result is None
    assert registry.owner_of("chromecast", "TV") == "session-a"


def test_claim_is_idempotent_for_same_owner():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("chromecast", "TV", "session-a"))
    result = asyncio.run(registry.claim("chromecast", "TV", "session-a"))
    assert result is None
    assert registry.owner_of("chromecast", "TV") == "session-a"


def test_claim_refused_by_default_when_owned_by_another_session():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("chromecast", "TV", "session-a"))
    result = asyncio.run(registry.claim("chromecast", "TV", "session-b"))
    assert result == "session-a"
    assert registry.owner_of("chromecast", "TV") == "session-a"


def test_claim_with_force_displaces_previous_owner():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("chromecast", "TV", "session-a"))
    result = asyncio.run(registry.claim("chromecast", "TV", "session-b", force=True))
    assert result == "session-a"
    assert registry.owner_of("chromecast", "TV") == "session-b"


def test_owner_of_returns_none_for_unclaimed_device():
    registry = ClaimRegistry()
    assert registry.owner_of("chromecast", "TV") is None


def test_release_removes_claim():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("chromecast", "TV", "session-a"))
    asyncio.run(registry.release("chromecast", "TV"))
    assert registry.owner_of("chromecast", "TV") is None


def test_release_with_session_id_noop_when_not_owner():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("chromecast", "TV", "session-a"))
    asyncio.run(registry.release("chromecast", "TV", session_id="session-b"))
    assert registry.owner_of("chromecast", "TV") == "session-a"


def test_release_with_session_id_removes_when_owner_matches():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("chromecast", "TV", "session-a"))
    asyncio.run(registry.release("chromecast", "TV", session_id="session-a"))
    assert registry.owner_of("chromecast", "TV") is None


def test_release_missing_claim_is_noop():
    registry = ClaimRegistry()
    asyncio.run(registry.release("chromecast", "TV"))
    assert registry.owner_of("chromecast", "TV") is None


def test_release_all_for_session_releases_only_that_sessions_claims():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("chromecast", "TV", "session-a"))
    asyncio.run(registry.claim("sonos", "Küche", "session-a"))
    asyncio.run(registry.claim("airplay", "HomePod", "session-b"))

    released = asyncio.run(registry.release_all_for_session("session-a"))

    assert set(released) == {("chromecast", "TV"), ("sonos", "Küche")}
    assert registry.owner_of("chromecast", "TV") is None
    assert registry.owner_of("sonos", "Küche") is None
    assert registry.owner_of("airplay", "HomePod") == "session-b"


def test_release_all_for_session_with_no_claims_returns_empty_list():
    registry = ClaimRegistry()
    released = asyncio.run(registry.release_all_for_session("session-a"))
    assert released == []


# ── claim_many ───────────────────────────────────────────────────────────────


def test_claim_many_succeeds_when_all_unclaimed():
    registry = ClaimRegistry()
    result = asyncio.run(
        registry.claim_many([("sonos", "Küche"), ("sonos", "Wohnzimmer")], "session-a")
    )
    assert result is None
    assert registry.owner_of("sonos", "Küche") == "session-a"
    assert registry.owner_of("sonos", "Wohnzimmer") == "session-a"


def test_claim_many_is_all_or_nothing_on_conflict():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("sonos", "Wohnzimmer", "session-a"))

    result = asyncio.run(
        registry.claim_many([("sonos", "Küche"), ("sonos", "Wohnzimmer")], "session-b")
    )

    assert result == ("sonos", "Wohnzimmer", "session-a")
    # The first pair must NOT have been claimed despite coming before the conflict.
    assert registry.owner_of("sonos", "Küche") is None
    assert registry.owner_of("sonos", "Wohnzimmer") == "session-a"


def test_claim_many_with_force_displaces_all_conflicting_owners():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("sonos", "Wohnzimmer", "session-a"))

    result = asyncio.run(
        registry.claim_many([("sonos", "Küche"), ("sonos", "Wohnzimmer")], "session-b", force=True)
    )

    assert result is None
    assert registry.owner_of("sonos", "Küche") == "session-b"
    assert registry.owner_of("sonos", "Wohnzimmer") == "session-b"


def test_claim_many_idempotent_for_same_owner():
    registry = ClaimRegistry()
    asyncio.run(registry.claim_many([("sonos", "Küche")], "session-a"))
    result = asyncio.run(registry.claim_many([("sonos", "Küche")], "session-a"))
    assert result is None
    assert registry.owner_of("sonos", "Küche") == "session-a"


def test_claim_many_with_empty_pairs_is_noop():
    registry = ClaimRegistry()
    result = asyncio.run(registry.claim_many([], "session-a"))
    assert result is None


# ── force_claim_many ─────────────────────────────────────────────────────────


def test_force_claim_many_succeeds_when_all_unclaimed_and_reports_no_displacement():
    registry = ClaimRegistry()
    displaced = asyncio.run(
        registry.force_claim_many([("sonos", "Küche"), ("sonos", "Wohnzimmer")], "session-a")
    )
    assert displaced == []
    assert registry.owner_of("sonos", "Küche") == "session-a"
    assert registry.owner_of("sonos", "Wohnzimmer") == "session-a"


def test_force_claim_many_displaces_a_single_conflicting_owner():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("chromecast", "TV", "session-a"))

    displaced = asyncio.run(registry.force_claim_many([("chromecast", "TV")], "session-b"))

    assert displaced == [("chromecast", "TV", "session-a")]
    assert registry.owner_of("chromecast", "TV") == "session-b"


def test_force_claim_many_displaces_multiple_different_owners():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("sonos", "Küche", "session-a"))
    asyncio.run(registry.claim("sonos", "Wohnzimmer", "session-c"))

    displaced = asyncio.run(
        registry.force_claim_many([("sonos", "Küche"), ("sonos", "Wohnzimmer")], "session-b")
    )

    assert set(displaced) == {
        ("sonos", "Küche", "session-a"),
        ("sonos", "Wohnzimmer", "session-c"),
    }
    assert registry.owner_of("sonos", "Küche") == "session-b"
    assert registry.owner_of("sonos", "Wohnzimmer") == "session-b"


def test_force_claim_many_omits_pairs_already_owned_by_same_session():
    registry = ClaimRegistry()
    asyncio.run(registry.claim("chromecast", "TV", "session-a"))

    displaced = asyncio.run(registry.force_claim_many([("chromecast", "TV")], "session-a"))

    assert displaced == []
    assert registry.owner_of("chromecast", "TV") == "session-a"


def test_force_claim_many_with_empty_pairs_is_noop():
    registry = ClaimRegistry()
    displaced = asyncio.run(registry.force_claim_many([], "session-a"))
    assert displaced == []
