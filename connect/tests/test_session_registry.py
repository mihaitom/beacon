"""Tests for core/session.py — SessionRegistry, get_session, reap_stale_sessions."""

import asyncio
import time

from delivery import ChromecastDelivery
from media import Track


def test_get_or_create_returns_same_instance_for_same_id():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    a = asyncio.run(registry.get_or_create("session-a"))
    b = asyncio.run(registry.get_or_create("session-a"))
    assert a is b


def test_get_or_create_isolates_different_ids():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    a = asyncio.run(registry.get_or_create("session-a"))
    b = asyncio.run(registry.get_or_create("session-b"))
    assert a is not b

    a.state.current_track = Track("1", "Song A", "Artist", 100, "")
    assert b.state.current_track is None


def test_get_returns_none_for_unknown_session_without_creating():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    assert registry.get("nope") is None
    assert registry.all() == []


def test_get_does_not_touch_last_seen():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    session = asyncio.run(registry.get_or_create("session-a"))
    session.last_seen = 0.0

    registry.get("session-a")

    assert session.last_seen == 0.0


def test_require_authenticated_session_does_not_create_a_session(client):
    """An unauthenticated caller (anyone with just CONNECT_TOKEN) hitting a
    require_authenticated_session-gated route with an arbitrary, never-seen
    X-Connect-Session must not be able to grow the registry — see
    core/session.py's require_authenticated_session docstring."""
    from core.session import registry

    r = client.get("/discover", headers={"X-Connect-Session": "never-seen-before"})

    assert r.status_code == 401
    assert registry.get("never-seen-before") is None


def test_get_session_falls_back_to_default_with_no_header_or_query():
    from core.session import DEFAULT_SESSION_ID, SessionRegistry, get_session

    registry = SessionRegistry()
    # get_session uses the module-level registry, so patch it via the
    # function's own closure isn't possible without importing the module —
    # exercise the real module-level registry, isolated by the autouse
    # reset_state fixture in conftest.py.
    import core.session as session_module

    original_registry = session_module.registry
    session_module.registry = registry
    try:
        session = asyncio.run(get_session(x_connect_session=None, session=None))
        assert session.session_id == DEFAULT_SESSION_ID
    finally:
        session_module.registry = original_registry


def test_get_session_prefers_header_over_query():
    from core.session import get_session

    session = asyncio.run(
        get_session(x_connect_session="from-header", session="from-query")
    )
    assert session.session_id == "from-header"


def test_get_session_uses_query_when_no_header():
    from core.session import get_session

    session = asyncio.run(get_session(x_connect_session=None, session="from-query"))
    assert session.session_id == "from-query"


def test_remove_pops_session():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    asyncio.run(registry.get_or_create("session-a"))
    removed = asyncio.run(registry.remove("session-a"))
    assert removed is not None
    assert removed.session_id == "session-a"
    assert registry.get("session-a") is None


def test_remove_missing_session_returns_none():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    assert asyncio.run(registry.remove("nope")) is None


# ── reap_once ─────────────────────────────────────────────────────────────────


def test_reap_once_removes_idle_session_past_timeout():
    from core.session import SESSION_IDLE_TIMEOUT, reap_once, registry

    session = asyncio.run(registry.get_or_create("stale-session"))
    session.last_seen = time.time() - SESSION_IDLE_TIMEOUT - 1

    reaped = asyncio.run(reap_once())

    assert reaped == ["stale-session"]
    assert registry.get("stale-session") is None


def test_reap_once_leaves_recently_touched_session_alone():
    from core.session import reap_once, registry

    asyncio.run(registry.get_or_create("fresh-session"))

    reaped = asyncio.run(reap_once())

    assert reaped == []
    assert registry.get("fresh-session") is not None


def test_reap_once_stops_delivery_and_releases_claims():
    from unittest.mock import AsyncMock

    from core.claims import claims
    from core.session import SESSION_IDLE_TIMEOUT, reap_once, registry

    session = asyncio.run(registry.get_or_create("stale-with-delivery"))
    delivery = ChromecastDelivery("TV")
    delivery.stop = AsyncMock()
    session.state.active_delivery = delivery
    session.last_seen = time.time() - SESSION_IDLE_TIMEOUT - 1
    asyncio.run(claims.claim("chromecast", "TV", "stale-with-delivery"))

    asyncio.run(reap_once())

    delivery.stop.assert_awaited_once()
    assert claims.owner_of("chromecast", "TV") is None
    assert registry.get("stale-with-delivery") is None


def test_reap_once_still_reaps_a_session_whose_delivery_wont_stop():
    from unittest.mock import AsyncMock

    from core.session import SESSION_IDLE_TIMEOUT, reap_once, registry

    session = asyncio.run(registry.get_or_create("stale-unresponsive"))
    delivery = ChromecastDelivery("TV")
    delivery.stop = AsyncMock(side_effect=RuntimeError("device unreachable"))
    session.state.active_delivery = delivery
    session.last_seen = time.time() - SESSION_IDLE_TIMEOUT - 1

    reaped = asyncio.run(reap_once())  # must not raise

    assert reaped == ["stale-unresponsive"]
    assert registry.get("stale-unresponsive") is None


async def test_reap_stale_sessions_calls_reap_once_after_the_interval():
    from unittest.mock import AsyncMock, patch

    from core.session import reap_stale_sessions

    with (
        patch("core.session.asyncio.sleep", side_effect=[None, asyncio.CancelledError()]),
        patch("core.session.reap_once", new=AsyncMock()) as reap_once_mock,
    ):
        task = asyncio.create_task(reap_stale_sessions())
        try:
            await task
        except asyncio.CancelledError:
            pass

    reap_once_mock.assert_awaited_once()


# ── track_label ────────────────────────────────────────────────────────────────


def test_track_label_formats_artist_and_title(default_session):
    from core.session import track_label

    default_session.state.current_track = Track("1", "Song Title", "Artist Name", 200, "")

    assert track_label(default_session) == "Artist Name - Song Title"


def test_track_label_omits_dash_when_no_artist(default_session):
    from core.session import track_label

    default_session.state.current_track = Track("1", "Song Title", "", 200, "")

    assert track_label(default_session) == "Song Title"


def test_track_label_uses_radio_title_when_no_track(default_session):
    from core.session import track_label

    default_session.state.radio_info = {"title": "Radio FM", "url": "http://stream"}

    assert track_label(default_session) == "Radio FM"


def test_track_label_none_when_nothing_playing(default_session):
    from core.session import track_label

    assert track_label(default_session) is None
