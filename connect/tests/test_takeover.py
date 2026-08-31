"""Tests for core/session.py's check_claims()/displace_target() — the Phase 2
takeover primitives shared by /play, /play-url and /join."""

import asyncio
from unittest.mock import AsyncMock, patch

from core.claims import claims
from core.session import check_claims, displace_target, registry
from delivery import ChromecastDelivery, DeliveryManager, SonosDelivery
from media import SubsonicClient, Track
from routes.playback import PlayRequest, play_tracks

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


def test_displace_target_removes_from_a_group_of_more_than_two(default_session):
    """Distinct from the two-device group test above (which leaves a single
    plain BaseDelivery behind) — three devices removing one still leaves a
    genuine DeliveryManager, not a bare delivery instance."""
    other = asyncio.run(registry.get_or_create("other-session"))
    lost = SonosDelivery("Küche")
    lost.stop = AsyncMock()
    kept_a = SonosDelivery("Wohnzimmer")
    kept_b = SonosDelivery("Schlafzimmer")
    other.state.is_streaming = True
    other.state.active_delivery = DeliveryManager.from_deliveries([lost, kept_a, kept_b])

    asyncio.run(displace_target(other, "sonos", "Küche"))

    lost.stop.assert_awaited_once()
    assert other.state.is_streaming is True
    assert isinstance(other.state.active_delivery, DeliveryManager)
    assert other.state.active_delivery.deliveries == [kept_a, kept_b]


def test_displace_target_is_a_noop_when_target_is_not_in_the_group(default_session):
    """The right delivery *type*, just not the specific device named —
    distinct from is_a_noop_when_target_does_not_match_active_delivery
    below, which is a type/kind mismatch instead."""
    other = asyncio.run(registry.get_or_create("other-session"))
    present = SonosDelivery("Wohnzimmer")
    present.stop = AsyncMock()
    other.state.is_streaming = True
    other.state.active_delivery = DeliveryManager.from_deliveries([present])

    asyncio.run(displace_target(other, "sonos", "Küche"))

    present.stop.assert_not_awaited()
    assert other.state.is_streaming is True


def test_displace_target_swallows_a_failed_stop(default_session):
    other = asyncio.run(registry.get_or_create("other-session"))
    delivery = ChromecastDelivery("TV")
    delivery.stop = AsyncMock(side_effect=RuntimeError("device unreachable"))
    other.state.active_delivery = delivery

    asyncio.run(displace_target(other, "chromecast", "TV"))  # must not raise

    assert other.state.active_delivery is None


async def test_displace_target_falls_back_when_owners_play_lock_times_out(caplog):
    """Bounded by a timeout rather than awaited unconditionally — see the
    function's own docstring on why an unbounded wait here risks a
    cross-session deadlock. Falls back to the same (racy but non-blocking)
    displacement instead of hanging the request."""
    import logging

    other = await registry.get_or_create("locked-session")
    delivery = ChromecastDelivery("TV")
    delivery.stop = AsyncMock()
    other.state.active_delivery = delivery

    async def _hold_lock():
        async with other.play_lock:
            await asyncio.sleep(10)

    holder = asyncio.create_task(_hold_lock())
    await asyncio.sleep(0)  # let it actually acquire the lock first

    # Capture the real asyncio.timeout before patching it out — the
    # replacement below still needs to call through to it (with a much
    # shorter duration), and patching "core.session.asyncio.timeout"
    # patches the actual global asyncio module (same object), so a naive
    # `asyncio.timeout(...)` inside the replacement would recurse into
    # the mock instead of the real thing.
    real_timeout = asyncio.timeout
    try:
        with (
            patch("core.session.asyncio.timeout", side_effect=lambda _: real_timeout(0.05)),
            caplog.at_level(logging.WARNING, logger="connect.session"),
        ):
            await displace_target(other, "chromecast", "TV")
    finally:
        holder.cancel()

    assert "Timed out" in caplog.text
    delivery.stop.assert_awaited_once()
    assert other.state.active_delivery is None


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


# ── active_delivery_seq: the rollback-clobber race ───────────────────────────


async def test_play_rollback_does_not_clobber_a_concurrent_unlocked_displacement(
    default_session,
    caplog,
):
    """Regression test for a real, documented (if rare) race: /play holds
    its own session's play_lock for its whole dispatch, including its own
    rollback-on-failure. If a force-takeover's displace_target() times out
    waiting for that same lock (see that function's own docstring) and
    falls back to mutating active_delivery *without* it, and this
    session's own dispatch then fails and rolls back, the rollback must
    not silently undo a takeover another session was already told (via the
    "displaced" broadcast) had succeeded — see active_delivery_seq's own
    comment in core/state.py."""
    import logging

    default_session.media = SubsonicClient("http://nav")
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="")
    default_session.media.get_track = lambda track_id: track
    default_session.state.active_delivery = ChromecastDelivery("TV")
    default_session.state.is_streaming = True
    default_session.state.current_track = Track(
        id="0", title="Previous", artist="A", duration=100, cover_art_id=""
    )

    async def _slow_then_fails(*args, **kwargs):
        # Long enough for the concurrent displace_target() below to time
        # out waiting for this session's play_lock and fall back, still in
        # flight when this then raises.
        await asyncio.sleep(0.1)
        raise RuntimeError("device unreachable")

    real_timeout = asyncio.timeout

    async def _run_play():
        req = PlayRequest(song_ids=["1"], target_name="TV", target_type="chromecast")
        with patch.object(ChromecastDelivery, "play", new=_slow_then_fails):
            return await play_tracks(req, default_session)

    async def _run_displace():
        await asyncio.sleep(0.02)  # let /play's dispatch begin (and hold play_lock) first
        with patch("core.session.asyncio.timeout", side_effect=lambda _: real_timeout(0.03)):
            await displace_target(default_session, "chromecast", "TV")

    with caplog.at_level(logging.WARNING, logger="connect.session"):
        result, _ = await asyncio.gather(_run_play(), _run_displace())

    # Classified now, with the library's own text kept as `detail` — see
    # delivery/errors.py.
    assert result["error"] == "delivery_failed"
    assert result["detail"] == "device unreachable"
    # The takeover that landed *during* the failed dispatch must survive
    # the rollback, not get silently restored to the pre-dispatch snapshot.
    assert default_session.state.active_delivery is None
    assert default_session.state.is_streaming is False
    # Everything displace_target() never touches must still roll back
    # normally — this isn't a blanket "skip the whole rollback" either.
    assert default_session.state.current_track.id == "0"


async def test_play_rollback_restores_active_delivery_when_nothing_raced_it(default_session):
    """The common case (no concurrent displacement at all) must be
    unaffected — active_delivery_seq only ever skips the restore when it
    actually changed underneath this dispatch."""
    default_session.media = SubsonicClient("http://nav")
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="")
    default_session.media.get_track = lambda track_id: track
    previous_delivery = ChromecastDelivery("TV")
    default_session.state.active_delivery = previous_delivery

    req = PlayRequest(song_ids=["1"], target_name="TV", target_type="chromecast")
    with patch.object(ChromecastDelivery, "play", new=AsyncMock(side_effect=RuntimeError("boom"))):
        result = await play_tracks(req, default_session)

    assert result["error"] == "delivery_failed"
    assert result["detail"] == "boom"
    assert default_session.state.active_delivery is previous_delivery
