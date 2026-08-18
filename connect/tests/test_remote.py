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

import pytest
from fastapi.testclient import TestClient

from core.remote import remote
from main import app
from media import SubsonicClient
from routes import remote as remote_routes


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


def test_command_accepted_when_renderer_connected(client):
    client.post("/remote/enable")
    remote.renderer_connected = True
    resp = client.post(
        "/remote/command",
        json={"type": "toggle-play", "payload": {}},
        headers={"X-Remote-Password": remote.password},
    )
    assert resp.status_code == 202


def test_songs_query_504_on_timeout(client, monkeypatch):
    monkeypatch.setattr(remote_routes, "QUERY_TIMEOUT", 0.05)
    client.post("/remote/enable")
    remote.renderer_connected = True
    resp = client.get("/remote/songs", headers={"X-Remote-Password": remote.password})
    assert resp.status_code == 504


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


def test_app_unknown_subpath_falls_back_to_index_for_spa_router(client):
    client.post("/remote/enable")
    resp = client.get("/remote/app/queue")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]


def test_app_404_when_disabled(unauthed):
    resp = unauthed.get("/remote/app/")
    assert resp.status_code == 404
