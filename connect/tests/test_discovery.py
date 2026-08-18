"""Tests for routes/discovery.py — /discover."""

from unittest.mock import AsyncMock, patch

from core import state


def _unclaimed(device: dict) -> dict:
    """/discover annotates every device with claim info — with no claims in
    the registry (the default in tests), all fields are None."""
    return {
        **device,
        "in_use_by_name": None,
        "in_use_by_session_id": None,
        "in_use_by_song": None,
    }


def test_discover_returns_all_four_device_types(client, default_session):
    sonos = [{"name": "Küche", "ip": "10.0.0.1"}]
    airplay = [
        {"name": "HomePod", "address": "10.0.0.2", "model": "X", "needs_pairing": True}
    ]
    chromecast = [{"name": "TV", "host": "10.0.0.3", "model": "Chromecast"}]
    dlna = [{"name": "Receiver", "location": "http://10.0.0.4:1400/desc.xml"}]

    with (
        patch("routes.discovery.discover_sonos", new=AsyncMock(return_value=sonos)),
        patch("routes.discovery.discover_airplay", new=AsyncMock(return_value=airplay)),
        patch(
            "routes.discovery.discover_chromecast", new=AsyncMock(return_value=chromecast)
        ),
        patch("routes.discovery.discover_dlna", new=AsyncMock(return_value=dlna)),
    ):
        r = client.get("/discover")

    assert r.status_code == 200
    body = r.json()
    assert body["sonos"] == [_unclaimed(d) for d in sonos]
    assert body["airplay"] == [_unclaimed(d) for d in airplay]
    assert body["chromecast"] == [_unclaimed(d) for d in chromecast]
    assert body["dlna"] == [_unclaimed(d) for d in dlna]


def test_discover_all_coalesces_concurrent_callers():
    """Two users opening the popover at nearly the same time (or a
    request-triggered refresh overlapping the periodic background scan)
    must share a single real scan instead of each starting their own."""
    import asyncio

    from routes.discovery import discover_all

    call_count = 0

    async def slow_discover_sonos():
        nonlocal call_count
        call_count += 1
        await asyncio.sleep(0.05)
        return [{"name": "Küche", "ip": "10.0.0.1"}]

    with (
        patch("routes.discovery.discover_sonos", new=slow_discover_sonos),
        patch("routes.discovery.discover_airplay", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_chromecast", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_dlna", new=AsyncMock(return_value=[])),
    ):
        async def _run():
            return await asyncio.gather(discover_all(), discover_all(), discover_all())

        results = asyncio.run(_run())

    assert call_count == 1
    assert results[0] == results[1] == results[2]
    assert results[0]["sonos"] == [{"name": "Küche", "ip": "10.0.0.1"}]


def test_discover_all_starts_a_new_scan_after_the_previous_one_finished():
    """Coalescing must not get stuck reusing a completed scan forever —
    the next call after completion should trigger a fresh one."""
    import asyncio

    from routes.discovery import discover_all

    call_count = 0

    async def counting_discover_sonos():
        nonlocal call_count
        call_count += 1
        return [{"name": "Küche", "ip": "10.0.0.1"}]

    with (
        patch("routes.discovery.discover_sonos", new=counting_discover_sonos),
        patch("routes.discovery.discover_airplay", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_chromecast", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_dlna", new=AsyncMock(return_value=[])),
    ):
        asyncio.run(discover_all())
        asyncio.run(discover_all())

    assert call_count == 2


def test_discover_returns_cached_results_immediately(client, default_session):
    state.ctx.discovered = {
        "sonos": [{"name": "Cached"}],
        "airplay": [],
        "chromecast": [],
        "dlna": [],
    }

    with (
        patch("routes.discovery.discover_sonos", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_airplay", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_chromecast", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_dlna", new=AsyncMock(return_value=[])),
    ):
        r = client.get("/discover")

    assert r.status_code == 200
    assert r.json()["sonos"] == [_unclaimed({"name": "Cached"})]


def test_discover_keeps_cached_branch_when_scanner_raises(client, default_session):
    state.ctx.discovered = {
        "sonos": [{"name": "Stale"}],
        "airplay": [],
        "chromecast": [],
        "dlna": [],
    }

    with (
        patch(
            "routes.discovery.discover_sonos",
            new=AsyncMock(side_effect=RuntimeError("net")),
        ),
        patch("routes.discovery.discover_airplay", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_chromecast", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_dlna", new=AsyncMock(return_value=[])),
    ):
        r = client.get("/discover")

    assert r.status_code == 200
    assert r.json()["sonos"] == [_unclaimed({"name": "Stale"})]


def test_discover_fresh_scan_when_cache_empty(client, default_session):
    with (
        patch("routes.discovery.discover_sonos", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_airplay", new=AsyncMock(return_value=[])),
        patch(
            "routes.discovery.discover_chromecast",
            new=AsyncMock(return_value=[{"name": "TV"}]),
        ),
        patch("routes.discovery.discover_dlna", new=AsyncMock(return_value=[])),
    ):
        r = client.get("/discover")

    assert r.status_code == 200
    assert r.json()["chromecast"] == [_unclaimed({"name": "TV"})]


def test_discover_explicit_fresh_scan_is_verbose(client, default_session):
    """An explicit "Scan again" (fresh=true) should log which Sonos-duplicate
    AirPlay/DLNA entries get filtered out — see discover_all()'s docstring."""
    with (
        patch("routes.discovery.discover_sonos", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_airplay", new=AsyncMock(return_value=[])) as airplay,
        patch("routes.discovery.discover_chromecast", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_dlna", new=AsyncMock(return_value=[])) as dlna,
    ):
        client.get("/discover?fresh=true")

    airplay.assert_awaited_once_with(verbose=True)
    dlna.assert_awaited_once_with(verbose=True)


def test_discover_all_defaults_to_quiet(client):
    """discover_all()'s default (used by the background rescan every popover
    open triggers, and by the periodic scan in main.py) must not be verbose —
    only an explicit "Scan again" opts in, see the test above."""
    import asyncio

    from routes.discovery import discover_all

    with (
        patch("routes.discovery.discover_sonos", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_airplay", new=AsyncMock(return_value=[])) as airplay,
        patch("routes.discovery.discover_chromecast", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_dlna", new=AsyncMock(return_value=[])) as dlna,
    ):
        asyncio.run(discover_all())

    airplay.assert_awaited_once_with(verbose=False)
    dlna.assert_awaited_once_with(verbose=False)


def test_discover_reports_claim_owner(client, default_session):
    from core.claims import claims
    from core.session import SessionState, registry
    from media import Track

    owner = SessionState("owner-session")
    owner.display_name = "alice"
    owner.state.current_track = Track("1", "Song Title", "Artist Name", 200, "")
    registry._sessions["owner-session"] = owner

    async def _claim():
        await claims.claim("sonos", "Küche", "owner-session")

    import asyncio

    asyncio.run(_claim())

    with (
        patch(
            "routes.discovery.discover_sonos",
            new=AsyncMock(return_value=[{"name": "Küche", "ip": "10.0.0.1"}]),
        ),
        patch("routes.discovery.discover_airplay", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_chromecast", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_dlna", new=AsyncMock(return_value=[])),
    ):
        r = client.get("/discover")

    device = r.json()["sonos"][0]
    assert device["in_use_by_session_id"] == "owner-session"
    assert device["in_use_by_name"] == "alice"
    assert device["in_use_by_song"] == "Artist Name - Song Title"


def test_discover_reports_radio_title_as_track_for_claim_owner(client, default_session):
    from core.claims import claims
    from core.session import SessionState, registry

    owner = SessionState("owner-session")
    owner.display_name = "alice"
    owner.state.radio_info = {"title": "Radio FM", "url": "http://stream"}
    registry._sessions["owner-session"] = owner

    import asyncio

    asyncio.run(claims.claim("sonos", "Küche", "owner-session"))

    with (
        patch(
            "routes.discovery.discover_sonos",
            new=AsyncMock(return_value=[{"name": "Küche", "ip": "10.0.0.1"}]),
        ),
        patch("routes.discovery.discover_airplay", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_chromecast", new=AsyncMock(return_value=[])),
        patch("routes.discovery.discover_dlna", new=AsyncMock(return_value=[])),
    ):
        r = client.get("/discover")

    assert r.json()["sonos"][0]["in_use_by_song"] == "Radio FM"
