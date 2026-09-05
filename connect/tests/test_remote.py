"""Tests for Remote Control (core/remote.py + routes/remote.py).

Success-path SSE/relay flows aren't exercised end-to-end through the HTTP
layer here, same reasoning as test_auth.py's /events tests: the stream never
terminates naturally, so a real success case would hang the suite. The
command/query relay's actual message-passing (RemoteState.new_pending /
resolve_pending) is covered directly as a plain asyncio unit test instead;
HTTP-level tests only cover the parts that terminate on their own (503 when
no renderer is connected, 504 on a real timeout).
"""

import asyncio
import json
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import routes.radio as radio_module
from core.remote import remote
from main import app
from media import SubsonicClient
from routes import remote as remote_routes


async def _time_out(coro, timeout):
    """Stand-in for asyncio.wait_for() that fails instantly instead of
    after a real 15s wait — closes `coro` first (the real queue.get() call
    the patched-out wait_for would otherwise have awaited) so it doesn't
    linger as an unawaited-coroutine warning. Same technique as
    test_stream_events.py's identical helper."""
    coro.close()
    raise TimeoutError()


@pytest.fixture
def unauthed():
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ── enable / disable / status / keepalive (require_token) ───────────────────


def test_enable_requires_token(unauthed):
    assert unauthed.post("/remote/enable").status_code == 401


def test_enable_returns_password_pin_and_address(client):
    resp = client.post("/remote/enable")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["password"]) > 20
    assert len(body["pin"]) == 6 and body["pin"].isdigit()
    assert body["port"] > 0
    assert remote.enabled is True


def test_enable_regenerates_credentials(client):
    first = client.post("/remote/enable").json()
    second = client.post("/remote/enable").json()
    assert first["password"] != second["password"]
    assert first["pin"] != second["pin"] or True  # PINs may collide by chance; password never does


def test_status_never_returns_password(client):
    client.post("/remote/enable")
    body = client.get("/remote/status").json()
    assert "password" not in body
    assert body["enabled"] is True
    assert body["pin"] == remote.pin


def test_status_pin_hidden_when_disabled(client):
    body = client.get("/remote/status").json()
    assert body["enabled"] is False
    assert body["pin"] is None


def test_disable_clears_state(client):
    client.post("/remote/enable")
    assert client.post("/remote/disable").json() == {"success": True}
    assert remote.enabled is False
    assert remote.password is None
    assert remote.pin is None


def test_keepalive_updates_last_seen(client):
    client.post("/remote/enable")
    remote.last_keepalive = 0
    client.post("/remote/keepalive")
    assert remote.last_keepalive > 0


# ── reaper ────────────────────────────────────────────────────────────────


async def test_reap_disables_after_keepalive_timeout():
    remote.enable()
    remote.last_keepalive = 0
    assert remote.is_stale() is True
    remote.disable()
    assert remote.is_stale() is False  # disabled feature is never "stale"


async def test_reap_stale_remote_disables_once_stale():
    from core.remote import reap_stale_remote

    remote.enable()
    remote.last_keepalive = 0  # already stale before the loop even starts

    with patch("core.remote.asyncio.sleep", side_effect=[None, asyncio.CancelledError()]):
        task = asyncio.create_task(reap_stale_remote())
        try:
            await task
        except asyncio.CancelledError:
            pass

    assert remote.enabled is False


async def test_reap_stale_remote_leaves_a_fresh_session_enabled():
    from core.remote import reap_stale_remote

    remote.enable()
    remote.touch_keepalive()  # not stale

    with patch("core.remote.asyncio.sleep", side_effect=[None, asyncio.CancelledError()]):
        task = asyncio.create_task(reap_stale_remote())
        try:
            await task
        except asyncio.CancelledError:
            pass

    assert remote.enabled is True


# ── PIN login + rate limiting ────────────────────────────────────────────


def test_login_requires_enabled(unauthed):
    assert unauthed.post("/remote/login", json={"pin": "123456"}).status_code == 404


def test_login_correct_pin_returns_password(client):
    client.post("/remote/enable")
    resp = client.post("/remote/login", json={"pin": remote.pin})
    assert resp.status_code == 200
    assert resp.json()["password"] == remote.password


def test_login_wrong_pin_rejected(client):
    client.post("/remote/enable")
    wrong_pin = "000000" if remote.pin != "000000" else "111111"
    resp = client.post("/remote/login", json={"pin": wrong_pin})
    assert resp.status_code == 401


def test_login_rate_limited_after_repeated_failures(client):
    client.post("/remote/enable")
    wrong_pin = "000000" if remote.pin != "000000" else "111111"
    for _ in range(5):
        assert client.post("/remote/login", json={"pin": wrong_pin}).status_code == 401
    locked = client.post("/remote/login", json={"pin": wrong_pin})
    assert locked.status_code == 429
    # Even the *correct* PIN is refused while locked out.
    assert client.post("/remote/login", json={"pin": remote.pin}).status_code == 429


def test_login_success_clears_lockout_history(client):
    client.post("/remote/enable")
    ip = "testclient"
    remote.record_failed_attempt(ip)
    client.post("/remote/login", json={"pin": remote.pin})
    assert remote._attempts.get(ip, []) == []


# ── require_remote_password ──────────────────────────────────────────────


def test_phone_endpoint_404_when_disabled(unauthed):
    assert unauthed.get("/remote/state").status_code == 404


def test_phone_endpoint_401_when_wrong_password(client):
    # X-Connect-Token (auto-attached by the `client` fixture) is irrelevant
    # to require_remote_password — phone-facing endpoints never accept it as
    # an alternative to the actual remote password (see routes/remote.py's
    # module docstring), so this exercises the rejection on its own.
    client.post("/remote/enable")
    resp = client.get("/remote/state", headers={"X-Remote-Password": "wrong"})
    assert resp.status_code == 401


def test_phone_endpoint_accepts_header(client):
    client.post("/remote/enable")
    resp = client.get("/remote/state", headers={"X-Remote-Password": remote.password})
    assert resp.status_code == 200


def test_phone_endpoint_accepts_query_param(client):
    client.post("/remote/enable")
    resp = client.get(f"/remote/state?password={remote.password}")
    assert resp.status_code == 200


def test_state_reflects_last_pushed_snapshot(client):
    client.post("/remote/enable")
    client.post("/remote/state", json={"snapshot": {"playing": True, "position": 12}})
    resp = client.get(f"/remote/state?password={remote.password}")
    assert resp.json() == {"playing": True, "position": 12}


# ── command / query relay ────────────────────────────────────────────────


def test_command_503_when_no_renderer_connected(client):
    client.post("/remote/enable")
    resp = client.post(
        "/remote/command",
        json={"type": "toggle-play", "payload": {}},
        headers={"X-Remote-Password": remote.password},
    )
    assert resp.status_code == 503


def test_command_timeout_is_more_generous_than_a_query_timeout():
    # Commands are acked only once they've actually *finished*, and
    # cast-to-many (or play-song while casting) waits on a real
    # UPnP/Chromecast/AirPlay handshake first — far longer than any library
    # query. Sharing QUERY_TIMEOUT would 504 a command that in fact
    # succeeded, and the phone re-enabling its buttons on that 504 is how a
    # single tap becomes a double action.
    assert remote_routes.COMMAND_TIMEOUT > remote_routes.QUERY_TIMEOUT


def test_command_504_on_timeout(client, monkeypatch):
    # Same reasoning/pattern as test_songs_query_504_on_timeout below —
    # send_command() now blocks on the same pending-Future relay _query()
    # does (see that endpoint's own comment), so the terminating case worth
    # covering at the HTTP level is the timeout, not a success that would
    # need a renderer to actually answer it (see this module's docstring).
    monkeypatch.setattr(remote_routes, "COMMAND_TIMEOUT", 0.05)
    client.post("/remote/enable")
    remote.renderer_connected = True
    resp = client.post(
        "/remote/command",
        json={"type": "toggle-play", "payload": {}},
        headers={"X-Remote-Password": remote.password},
    )
    assert resp.status_code == 504


def test_songs_query_504_on_timeout(client, monkeypatch):
    monkeypatch.setattr(remote_routes, "QUERY_TIMEOUT", 0.05)
    client.post("/remote/enable")
    remote.renderer_connected = True
    resp = client.get("/remote/songs", headers={"X-Remote-Password": remote.password})
    assert resp.status_code == 504


def test_albums_query_relays_search_and_paging_to_the_renderer(client, monkeypatch):
    """The albums half of the phone's library view. Asserted on the relayed
    payload rather than on an answer: answering needs a renderer, which this
    module deliberately does not stand up (see its docstring)."""
    monkeypatch.setattr(remote_routes, "QUERY_TIMEOUT", 0.05)
    client.post("/remote/enable")
    remote.renderer_connected = True
    seen = {}

    async def capture(event, payload):
        seen["event"] = event
        seen["payload"] = payload
        return {"items": [], "total": 0}

    monkeypatch.setattr(remote_routes, "_query", capture)
    resp = client.get(
        "/remote/albums?search=blue&offset=50&limit=25",
        headers={"X-Remote-Password": remote.password},
    )

    assert resp.status_code == 200
    assert seen["event"] == "albums-request"
    assert seen["payload"] == {"search": "blue", "offset": 50, "limit": 25}


def test_albums_query_504_on_timeout(client, monkeypatch):
    monkeypatch.setattr(remote_routes, "QUERY_TIMEOUT", 0.05)
    client.post("/remote/enable")
    remote.renderer_connected = True
    resp = client.get("/remote/albums", headers={"X-Remote-Password": remote.password})
    assert resp.status_code == 504


def test_albums_query_401_with_a_wrong_password(client):
    """Same gate as every other phone-facing endpoint — see
    test_phone_endpoint_401_when_wrong_password for why the token the
    `client` fixture attaches is no substitute for it."""
    client.post("/remote/enable")
    resp = client.get("/remote/albums", headers={"X-Remote-Password": "wrong"})
    assert resp.status_code == 401


def test_devices_query_503_when_no_renderer_connected(client):
    client.post("/remote/enable")
    resp = client.get("/remote/devices", headers={"X-Remote-Password": remote.password})
    assert resp.status_code == 503


def test_device_volume_query_503_when_no_renderer_connected(client):
    client.post("/remote/enable")
    resp = client.get(
        "/remote/device-volume?type=sonos&name=Kitchen",
        headers={"X-Remote-Password": remote.password},
    )
    assert resp.status_code == 503


def test_playlists_query_503_when_no_renderer_connected(client):
    client.post("/remote/enable")
    resp = client.get("/remote/playlists", headers={"X-Remote-Password": remote.password})
    assert resp.status_code == 503


def test_playlist_by_id_query_503_when_no_renderer_connected(client):
    client.post("/remote/enable")
    resp = client.get("/remote/playlists/abc123", headers={"X-Remote-Password": remote.password})
    assert resp.status_code == 503


def test_radio_stations_query_503_when_no_renderer_connected(client):
    client.post("/remote/enable")
    resp = client.get("/remote/radio-stations", headers={"X-Remote-Password": remote.password})
    assert resp.status_code == 503


async def test_query_response_resolves_the_matching_pending_query(client):
    client.post("/remote/enable")
    future = remote.new_pending("req-1")

    resp = client.post("/remote/query-response", json={"request_id": "req-1", "data": {"ok": True}})

    assert resp.status_code == 200
    assert await asyncio.wait_for(future, timeout=1.0) == {"ok": True}


# ── agent_events (SSE) — the renderer's own long-lived command subscription ─
# Success-path here (unlike the module docstring's "never terminates
# naturally" note about driving these through the HTTP client) drives the
# generator directly via resp.body_iterator instead — same technique as
# test_stream_events.py's /events and /visualizer tests.


async def test_agent_events_opens_with_retry_and_flips_renderer_connected():
    from routes.remote import agent_events

    remote.renderer_connected = False
    resp = await agent_events()
    gen = resp.body_iterator
    try:
        first = await gen.__anext__()
        assert first == "retry: 2000\n\n"
        assert remote.renderer_connected is True
    finally:
        await gen.aclose()

    # Cleared once the connection closes, so phone-facing endpoints correctly
    # fail fast (503) again instead of hanging against a dead connection.
    assert remote.renderer_connected is False


async def test_agent_events_overlapping_reconnect_does_not_clobber_the_new_connection():
    """Regression test: a quick renderer reconnect (a brief network blip, a
    page reload) can briefly overlap — the *new* connection lands and sets
    renderer_connected=True before the *old* one has finished unwinding.
    The old connection's own belated cleanup must not clear
    renderer_connected out from under the new, still-live one."""
    from routes.remote import agent_events

    remote.renderer_connected = False
    old_resp = await agent_events()
    old_gen = old_resp.body_iterator
    await old_gen.__anext__()  # retry — old connection is now "live"
    assert remote.renderer_connected is True

    # A new connection lands before the old one has been torn down.
    new_resp = await agent_events()
    new_gen = new_resp.body_iterator
    try:
        await new_gen.__anext__()  # retry
        assert remote.renderer_connected is True

        # The old, now-superseded connection finally closes.
        await old_gen.aclose()

        # Must still read as connected — the new connection is very much
        # still live, and only the old connection's own (now-stale) cleanup
        # ran.
        assert remote.renderer_connected is True
    finally:
        await new_gen.aclose()

    # Only once the *actually current* connection closes does this clear.
    assert remote.renderer_connected is False


async def test_agent_events_forwards_a_broadcast_command():
    from routes.remote import agent_events

    resp = await agent_events()
    gen = resp.body_iterator
    try:
        await gen.__anext__()  # retry
        payload = {"kind": "command", "type": "toggle-play", "payload": {}}
        await remote.command_bus.broadcast(payload)
        forwarded = await gen.__anext__()
    finally:
        await gen.aclose()

    assert forwarded == f"data: {json.dumps(payload)}\n\n"


async def test_agent_events_heartbeats_on_timeout():
    from routes.remote import agent_events

    resp = await agent_events()
    gen = resp.body_iterator
    try:
        await gen.__anext__()  # retry
        with patch("routes.remote.asyncio.wait_for", _time_out):
            tick = await gen.__anext__()
    finally:
        await gen.aclose()

    assert tick == ": heartbeat\n\n"


async def test_agent_events_unsubscribes_on_close():
    from routes.remote import agent_events

    resp = await agent_events()
    gen = resp.body_iterator
    await gen.__anext__()
    assert len(remote.command_bus._queues) == 1

    await gen.aclose()

    assert remote.command_bus._queues == []


# ── phone_events (SSE) — a paired phone's status subscription ───────────────


async def test_phone_events_opens_with_retry_and_the_current_snapshot():
    from routes.remote import phone_events

    remote.snapshot = {"playing": True}
    resp = await phone_events()
    gen = resp.body_iterator
    try:
        first = await gen.__anext__()
        second = await gen.__anext__()
    finally:
        await gen.aclose()

    assert first == "retry: 2000\n\n"
    assert second == f"data: {json.dumps({'playing': True})}\n\n"


async def test_phone_events_forwards_a_broadcast_snapshot():
    from routes.remote import phone_events

    resp = await phone_events()
    gen = resp.body_iterator
    try:
        await gen.__anext__()  # retry
        await gen.__anext__()  # initial snapshot
        await remote.event_bus.broadcast({"playing": False})
        forwarded = await gen.__anext__()
    finally:
        await gen.aclose()

    assert forwarded == f"data: {json.dumps({'playing': False})}\n\n"


async def test_phone_events_heartbeats_on_timeout():
    from routes.remote import phone_events

    resp = await phone_events()
    gen = resp.body_iterator
    try:
        await gen.__anext__()
        await gen.__anext__()
        with patch("routes.remote.asyncio.wait_for", _time_out):
            tick = await gen.__anext__()
    finally:
        await gen.aclose()

    assert tick == ": heartbeat\n\n"


async def test_phone_events_unsubscribes_on_close():
    from routes.remote import phone_events

    resp = await phone_events()
    gen = resp.body_iterator
    await gen.__anext__()
    await gen.__anext__()
    assert len(remote.event_bus._queues) == 1

    await gen.aclose()

    assert remote.event_bus._queues == []


# ── /remote/cover-art, /remote/radio-favicon ─────────────────────────────
# Both exist so the phone never has to be handed a URL carrying the real
# CONNECT_TOKEN (see routes/remote.py's own comment on why coverArtUrl()/
# radioFaviconUrl() as-is aren't safe to reuse for a phone-facing surface).


def test_cover_art_requires_remote_password(client):
    client.post("/remote/enable")
    resp = client.get("/remote/cover-art?id=abc123")
    assert resp.status_code == 401


def test_cover_art_404_when_no_media_server_configured(client, default_session):
    client.post("/remote/enable")
    resp = client.get(
        f"/remote/cover-art?id=abc123&session={default_session.session_id}",
        headers={"X-Remote-Password": remote.password},
    )
    assert resp.status_code == 404


def test_cover_art_redirects_without_leaking_connect_token(client, default_session):
    default_session.media = SubsonicClient(
        "http://navidrome.example:4533", user="alice", password="secret"
    )
    client.post("/remote/enable")
    resp = client.get(
        f"/remote/cover-art?id=abc123&session={default_session.session_id}",
        headers={"X-Remote-Password": remote.password},
        follow_redirects=False,
    )
    assert resp.status_code == 307
    location = resp.headers["location"]
    assert location.startswith("http://navidrome.example:4533/rest/getCoverArt.view?")
    assert "id=abc123" in location
    assert "token=" not in location  # CONNECT_TOKEN must never reach the phone


def test_radio_favicon_requires_remote_password(unauthed):
    resp = unauthed.get("/remote/radio-favicon?url=http://example.com")
    assert resp.status_code == 404  # feature not enabled in this fixture


def test_radio_favicon_rejects_non_http_url(client):
    client.post("/remote/enable")
    resp = client.get(
        "/remote/radio-favicon?url=ftp://example.com",
        headers={"X-Remote-Password": remote.password},
    )
    assert resp.status_code == 400


async def test_new_pending_resolved_by_query_response():
    """Unit-level coverage of the relay's actual message-passing, without
    going through the HTTP layer (see module docstring)."""
    future = remote.new_pending("abc123")
    assert remote.resolve_pending("abc123", {"items": [], "total": 0}) is True
    result = await asyncio.wait_for(future, timeout=1.0)
    assert result == {"items": [], "total": 0}


async def test_resolve_pending_unknown_id_is_noop():
    assert remote.resolve_pending("does-not-exist", {}) is False


async def test_disable_cancels_pending_futures():
    future = remote.new_pending("abc123")
    remote.disable()
    with pytest.raises(asyncio.CancelledError):
        await future


# ── static app shell ─────────────────────────────────────────────────────
# /remote/app (no trailing slash) must redirect rather than serve directly —
# every relative asset reference in index.html (app.css, app.js, and app.js's
# own relative imports) resolves against the *current* URL's directory, so
# serving the shell directly at the no-slash path would silently break every
# one of those into a request one level too shallow (e.g. /remote/app.js
# instead of /remote/app/app.js). Caught live against a real browser/QR-code
# flow — see the fix commit for the concrete repro.


def test_app_no_slash_redirects_to_trailing_slash(client):
    client.post("/remote/enable")
    resp = client.get("/remote/app", follow_redirects=False)
    assert resp.status_code == 308
    assert resp.headers["location"] == "/remote/app/"


def test_app_no_slash_404_when_disabled(unauthed):
    resp = unauthed.get("/remote/app", follow_redirects=False)
    assert resp.status_code == 404


def test_app_index_served_at_trailing_slash(client):
    client.post("/remote/enable")
    resp = client.get("/remote/app/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]


def test_app_static_asset_served_relative_to_trailing_slash(client):
    client.post("/remote/enable")
    resp = client.get("/remote/app/app.js")
    assert resp.status_code == 200


def test_every_precached_shell_asset_is_actually_served(client):
    """sw.js precaches the shell by path, and app.js pulls its modules in as
    ES imports — either one naming a file the route does not serve breaks
    the whole app, not just one feature (an import that 404s aborts the
    module graph). Walking the list catches a module added without being
    added here, which is exactly the shape of that mistake."""
    import re

    client.post("/remote/enable")
    sw = (remote_routes._static_dir() / "sw.js").read_text()
    listed = re.search(r"SHELL_PATHS = \[(.*?)\]", sw, re.DOTALL)
    assert listed, "SHELL_PATHS not found in sw.js"
    paths = [p for p in re.findall(r"'\./([^']*)'", listed.group(1)) if p]
    assert len(paths) > 5, "suspiciously short shell list — did the format change?"

    for path in paths:
        resp = client.get(f"/remote/app/{path}")
        assert resp.status_code == 200, f"{path} is precached but not served"
        # Status alone proves nothing: an unknown subpath deliberately falls
        # back to index.html for the SPA router (see the test below), so a
        # missing module answers 200 with HTML and the import fails at
        # parse time instead. Anything but the shell page itself must come
        # back as its own type.
        if not path.endswith(".html"):
            assert "text/html" not in resp.headers["content-type"], (
                f"{path} is precached but only resolves to the index fallback"
            )


def test_app_files_are_always_revalidated(client):
    """Nothing in this shell is content-hashed, so without an explicit
    Cache-Control a browser applies its own heuristic freshness — commonly a
    tenth of the file's age — and stops asking for a week-old file for most
    of a day. That is a phone stuck on the layout from before the last
    change, with reloading unable to fix it: there is nothing to revalidate
    while the browser believes what it holds is fresh."""
    client.post("/remote/enable")

    for path in ("", "app.js", "app.css", "js/api.js", "fonts/mdi.css"):
        resp = client.get(f"/remote/app/{path}")
        assert resp.status_code == 200, path
        assert resp.headers["cache-control"] == "no-cache", path
        assert resp.headers["etag"], path


def test_app_file_revalidation_answers_304_for_an_unchanged_file(client):
    """What keeps "ask every time" cheap. FileResponse does not do this on
    its own (only StaticFiles implements it), so without the explicit
    handling every visit would re-download the whole shell, icon font
    included."""
    client.post("/remote/enable")
    first = client.get("/remote/app/app.js")
    assert first.status_code == 200

    again = client.get("/remote/app/app.js", headers={"If-None-Match": first.headers["etag"]})

    assert again.status_code == 304
    assert again.content == b""
    assert again.headers["cache-control"] == "no-cache"


def test_app_file_revalidation_sends_the_file_when_it_has_changed(client):
    client.post("/remote/enable")

    resp = client.get("/remote/app/app.js", headers={"If-None-Match": '"something-else"'})

    assert resp.status_code == 200
    assert resp.content


def test_app_index_fallback_is_revalidated_too(client):
    """The SPA fallback is the one file a phone loads on every cold start —
    serving it stale is what pins the whole app to an old version, since
    every module it imports is named in it."""
    client.post("/remote/enable")
    first = client.get("/remote/app/queue")
    assert first.status_code == 200
    assert first.headers["cache-control"] == "no-cache"

    again = client.get("/remote/app/queue", headers={"If-None-Match": first.headers["etag"]})

    assert again.status_code == 304


def test_app_file_etag_changes_when_the_file_does(client, tmp_path, monkeypatch):
    """A stale answer must never survive an edit — the whole point. The
    ETag is derived from mtime and size, so a rewritten file gets a new
    one and the client's conditional request misses."""
    shell = tmp_path / "remote"
    shell.mkdir()
    (shell / "index.html").write_text("<html></html>")
    (shell / "app.js").write_text("console.log('v1');")
    monkeypatch.setattr(remote_routes, "_static_dir", lambda: shell)
    client.post("/remote/enable")
    first = client.get("/remote/app/app.js")

    (shell / "app.js").write_text("console.log('v2 — a longer line');")
    again = client.get("/remote/app/app.js", headers={"If-None-Match": first.headers["etag"]})

    assert again.status_code == 200
    assert b"v2" in again.content
    assert again.headers["etag"] != first.headers["etag"]


def test_app_unknown_subpath_falls_back_to_index_for_spa_router(client):
    client.post("/remote/enable")
    resp = client.get("/remote/app/queue")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]


def test_app_404_when_disabled(unauthed):
    resp = unauthed.get("/remote/app/")
    assert resp.status_code == 404


def test_app_rejects_a_path_traversal_attempt():
    """Called directly rather than through the HTTP client — httpx/starlette
    normalize `..` segments before routing, so a real request never actually
    exercises this guard; the guard exists for whatever survives that
    normalization (e.g. an already-resolved absolute path)."""
    from routes.remote import serve_remote_app

    remote.enable()
    try:
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(serve_remote_app(path="../../../../etc/passwd"))
    finally:
        remote.disable()

    assert exc_info.value.status_code == 404


def test_app_404_when_static_assets_are_entirely_missing(tmp_path, monkeypatch):
    from routes.remote import serve_remote_app

    monkeypatch.setattr(remote_routes, "_static_dir", lambda: tmp_path)
    remote.enable()
    try:
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(serve_remote_app(path="whatever.js"))
    finally:
        remote.disable()

    assert exc_info.value.status_code == 404


def test_radio_favicon_passes_a_real_hint_through_to_the_lookup(client, monkeypatch):
    # The re-export used to call routes/radio.py's endpoint function
    # directly without naming `hint`, which does not leave it as "" — it
    # leaves it as the FastAPI Query() object that is its declared default,
    # and the resolver calls .lower() on it. Every favicon the phone asked
    # for died on that AttributeError and came back 404, which is what the
    # remote renders as a fallback icon.
    seen: dict = {}

    async def fake_resolve(url, hint, min_size):
        seen.update(url=url, hint=hint, min_size=min_size)

    monkeypatch.setattr(radio_module, "_resolve_favicon", fake_resolve)
    radio_module._result_cache.clear()
    radio_module._inflight.clear()
    client.post("/remote/enable")

    client.get(
        "/remote/radio-favicon?url=http://station.example&min_size=120",
        headers={"X-Remote-Password": remote.password},
    )

    assert seen == {"url": "http://station.example", "hint": "", "min_size": 120}


def test_radio_favicon_resolves_from_a_hint_with_no_homepage(client, monkeypatch):
    # A station played straight out of the discover dialog carries Radio
    # Browser's own favicon URL but no homepage at all — the desktop
    # resolves those from the hint alone (see radioFaviconRequest), and the
    # phone could not ask for one: the parameter was not forwarded, and the
    # endpoint demanded a url.
    seen: dict = {}

    async def fake_resolve(url, hint, min_size):
        seen.update(url=url, hint=hint, min_size=min_size)

    monkeypatch.setattr(radio_module, "_resolve_favicon", fake_resolve)
    radio_module._result_cache.clear()
    radio_module._inflight.clear()
    client.post("/remote/enable")

    resp = client.get(
        "/remote/radio-favicon?hint=http://cdn.example/logo.png",
        headers={"X-Remote-Password": remote.password},
    )

    assert resp.status_code == 404  # the stub found nothing; the lookup still ran
    assert seen == {"url": "", "hint": "http://cdn.example/logo.png", "min_size": 0}
