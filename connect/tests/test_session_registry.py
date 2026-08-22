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


def _stale_casting_session(session_id: str, uri: str | None):
    """An idle-past-the-timeout session that still believes it is casting,
    with a device that reports `uri` as what it's currently playing (None =
    can't say)."""
    from unittest.mock import AsyncMock

    from core.session import SESSION_IDLE_TIMEOUT, registry

    session = asyncio.run(registry.get_or_create(session_id))
    delivery = ChromecastDelivery("TV")
    delivery.stop = AsyncMock()
    delivery.current_uri = AsyncMock(return_value=uri)
    session.state.active_delivery = delivery
    session.state.is_streaming = True
    session.last_seen = time.time() - SESSION_IDLE_TIMEOUT - 1
    return session, delivery


def test_reap_once_stops_delivery_and_releases_claims():
    from core.claims import claims
    from core.session import reap_once, registry
    from core.state import stream_url

    session, delivery = _stale_casting_session(
        "stale-with-delivery", stream_url("stale-with-delivery")
    )
    asyncio.run(claims.claim("chromecast", "TV", "stale-with-delivery"))

    asyncio.run(reap_once())

    delivery.stop.assert_awaited_once()
    assert claims.owner_of("chromecast", "TV") is None
    assert registry.get("stale-with-delivery") is None


def test_reap_once_leaves_a_device_alone_when_the_session_was_not_streaming():
    """The 2026-08-22 incident (see docs/playback-bugs.md): a session whose
    cast had ended hours earlier still held its old delivery. Reaping stopped
    that speaker — which a *different* Beacon instance was streaming to by
    then, and which therefore saw a cast device drop for no reason of its
    own. A session that already knows it isn't streaming has no business
    stopping anything."""
    from core.session import reap_once, registry

    session, delivery = _stale_casting_session("stale-not-streaming", None)
    session.state.is_streaming = False

    reaped = asyncio.run(reap_once())

    delivery.stop.assert_not_awaited()
    assert reaped == ["stale-not-streaming"]  # the session still goes away
    assert registry.get("stale-not-streaming") is None


def test_reap_once_leaves_a_device_playing_someone_elses_stream_alone():
    """Same speaker, different owner: the device answers with a URL that
    isn't this session's stream (another instance's port, or another
    session's id), so stopping it would cut off playback nobody asked to
    end."""
    from core.session import reap_once

    _, delivery = _stale_casting_session(
        "stale-taken-over", "http://10.0.0.5:9071/stream/other-session"
    )

    asyncio.run(reap_once())

    delivery.stop.assert_not_awaited()


def test_reap_once_still_stops_a_device_that_cannot_report_its_uri():
    """AirPlay and anything else without a transport to query — unchanged
    behaviour, and the safer default: a speaker left playing forever is
    worse than a stop that was already justified while the session lived."""
    from core.session import reap_once

    _, delivery = _stale_casting_session("stale-silent-device", None)

    asyncio.run(reap_once())

    delivery.stop.assert_awaited_once()


def test_reap_once_compares_against_the_station_url_for_radio():
    """Radio never goes through our own /stream — the station URL is what
    was handed to the device, so that's what its answer has to match."""
    from core.session import reap_once

    session, delivery = _stale_casting_session("stale-radio", "http://radio/stream")
    session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}

    asyncio.run(reap_once())

    delivery.stop.assert_awaited_once()


def test_reap_once_survives_a_device_that_errors_on_the_uri_lookup():
    from unittest.mock import AsyncMock

    from core.session import reap_once

    _, delivery = _stale_casting_session("stale-uri-error", None)
    delivery.current_uri = AsyncMock(side_effect=RuntimeError("device unreachable"))

    asyncio.run(reap_once())  # must not raise

    delivery.stop.assert_awaited_once()  # unknown counts as ours


def test_reap_once_still_reaps_a_session_whose_delivery_wont_stop():
    from unittest.mock import AsyncMock

    from core.session import reap_once, registry

    session, delivery = _stale_casting_session("stale-unresponsive", None)
    delivery.stop = AsyncMock(side_effect=RuntimeError("device unreachable"))

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
