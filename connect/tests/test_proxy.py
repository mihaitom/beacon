"""Tests for routes/proxy.py — Navidrome proxy endpoints."""

import importlib
from unittest.mock import AsyncMock, MagicMock, patch


# ── Utility function: Reload proxy module with a given environment variable ───────────────


def _reload_proxy(internal_url: str):
    """Proxy module with a given environment variable."""
    import routes.proxy as proxy_mod

    with patch.dict("os.environ", {"NAVIDROME_INTERNAL_URL": internal_url}):
        importlib.reload(proxy_mod)
    return proxy_mod


# ── Forward-auth header stripping ───────────────────────────────────────────────
#
# A reverse proxy in front of this backend (e.g. Traefik + Authentik ForwardAuth)
# may inject headers identifying whoever is browsing (X-authentik-username, ...).
# If those reach Navidrome and its source-IP is in ND_EXTAUTH_TRUSTEDSOURCES (as
# this backend's often is, being an internal caller), Navidrome silently
# authenticates the proxied request as that SSO identity instead of the Subsonic
# credentials actually being sent — breaking login as any Navidrome account other
# than the browsing user's own. These headers must never reach Navidrome.


def test_is_forward_auth_header_matches_known_sso_headers():
    from routes.proxy import _is_forward_auth_header

    assert _is_forward_auth_header("X-authentik-username")
    assert _is_forward_auth_header("x-authentik-groups")
    assert _is_forward_auth_header("Remote-User")
    assert _is_forward_auth_header("Remote-Groups")
    assert _is_forward_auth_header("Remote-Email")
    assert _is_forward_auth_header("Remote-Name")


def test_is_forward_auth_header_leaves_unrelated_headers_alone():
    from routes.proxy import _is_forward_auth_header

    assert not _is_forward_auth_header("Content-Type")
    assert not _is_forward_auth_header("Authorization")
    assert not _is_forward_auth_header("X-Connect-Token")
    assert not _is_forward_auth_header("User-Agent")


def _mock_httpx_client():
    """Mocks httpx.AsyncClient so _proxy() runs its real header-filtering logic
    without a real Navidrome to talk to. Returns (mock_client_cls, captured), where
    captured['headers'] is filled in once a request is built."""
    captured: dict = {}

    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.headers = {"content-type": "application/json"}

    async def aiter_bytes():
        yield b"{}"

    fake_response.aiter_bytes = aiter_bytes
    fake_response.aclose = AsyncMock()

    mock_client = MagicMock()

    def build_request(**kwargs):
        captured["headers"] = kwargs["headers"]
        captured["url"] = kwargs["url"]
        return MagicMock()

    mock_client.build_request = build_request
    mock_client.send = AsyncMock(return_value=fake_response)
    mock_client.aclose = AsyncMock()

    mock_client_cls = MagicMock(return_value=mock_client)
    return mock_client_cls, captured


def test_proxy_strips_authentik_headers_before_forwarding(client, default_session):
    # /rest/{path}'s target is session-derived (see routes/proxy.py's
    # proxy_subsonic) — default_session's media must actually point at the
    # URL this test expects to be hit.
    from media import SubsonicClient

    default_session.media = SubsonicClient("http://navidrome.internal:4533")
    proxy_mod = _reload_proxy("http://navidrome.internal:4533")
    mock_client_cls, captured = _mock_httpx_client()

    with patch.object(proxy_mod.httpx, "AsyncClient", mock_client_cls):
        client.get(
            "/rest/getUser.view?u=testuser&t=token&s=salt&v=1.16.1&c=test&f=json",
            headers={
                "X-Authentik-Username": "thomas",
                "X-Authentik-Groups": "admins",
                "X-Custom-Header": "keep-me",
            },
        )

    headers = captured["headers"]
    assert "x-authentik-username" not in {k.lower() for k in headers}
    assert "x-authentik-groups" not in {k.lower() for k in headers}
    assert headers.get("X-Custom-Header") == "keep-me" or headers.get(
        "x-custom-header"
    ) == "keep-me"


# ── ClientDisconnect ─────────────────────────────────────────────────────────
#
# The browser can abort a proxied request (navigation, component unmount,
# flaky network) before we finish reading its body. Unhandled, this surfaced
# as an ERROR-level unhandled-exception traceback on every occurrence, even
# though it's an expected, benign network condition — not a real backend fault.


def test_proxy_returns_499_on_client_disconnect(client, default_session, monkeypatch):
    from starlette.requests import ClientDisconnect, Request

    from media import SubsonicClient

    default_session.media = SubsonicClient("http://navidrome.internal:4533")
    _reload_proxy("http://navidrome.internal:4533")

    async def raise_disconnect(self):
        raise ClientDisconnect()

    monkeypatch.setattr(Request, "body", raise_disconnect)

    r = client.post("/rest/scrobble.view", json={"id": "1"})

    assert r.status_code == 499
    assert r.json()["error"] == "client disconnected"


# ── /rest/{path} ─────────────────────────────────────────────────────────────


def test_proxy_rest_returns_503_for_unconfigured_session(client, default_session):
    # default_session's media defaults to SubsonicClient("") (see
    # conftest.py) — nobody has called /config for it yet, so there's
    # nothing to forward to regardless of NAVIDROME_INTERNAL_URL.
    r = client.get("/rest/ping.view?u=user&t=token&s=salt&v=1.16.1&c=test&f=json")
    assert r.status_code == 503
    assert "error" in r.json()


def test_proxy_rest_uses_session_url_not_navidrome_internal_url(
    client, default_session, monkeypatch
):
    # Regression test: /rest/{path} used to always forward to the fixed
    # NAVIDROME_INTERNAL_URL env var, completely ignoring which server the
    # session actually authenticated against (see proxy_subsonic's own
    # comment) — deliberately mismatched here to prove the session wins.
    from media import SubsonicClient

    default_session.media = SubsonicClient("http://session-server:4533")
    proxy_mod = _reload_proxy("http://env-var-server:4533")
    mock_client_cls, captured = _mock_httpx_client()

    with patch.object(proxy_mod.httpx, "AsyncClient", mock_client_cls):
        client.get("/rest/ping.view?u=user&t=token&s=salt&v=1.16.1&c=test&f=json")

    assert captured["url"].startswith("http://session-server:4533")


def test_proxy_auth_returns_503_when_no_url_configured(client, monkeypatch):
    monkeypatch.setenv("NAVIDROME_INTERNAL_URL", "")
    import routes.proxy as proxy_mod

    importlib.reload(proxy_mod)

    r = client.post("/auth/login", json={"username": "user", "password": "pass"})
    assert r.status_code == 503


def test_proxy_navidrome_api_returns_503_when_no_url_configured(client, monkeypatch):
    monkeypatch.setenv("NAVIDROME_INTERNAL_URL", "")
    import routes.proxy as proxy_mod

    importlib.reload(proxy_mod)

    r = client.get("/album")
    assert r.status_code == 503


# ── Pairing-Liste (no hardware required) ──────────────────────────────────────


def test_pair_list_returns_empty_initially(client, default_session):
    import tempfile
    from delivery import credentials

    with tempfile.TemporaryDirectory() as d:
        import os

        with patch.object(credentials, "_PATH", os.path.join(d, "c.json")):
            r = client.get("/pair/airplay")
    assert r.status_code == 200
    assert r.json()["paired"] == []


def test_pair_start_returns_404_for_unknown_device(client, default_session):
    """Start fails when device is not found on the network."""

    async def fake_scan(*args, **kwargs):
        return []

    with patch("pyatv.scan", new=AsyncMock(return_value=[])):
        r = client.post("/pair/airplay/start", json={"name": "NonExistentDevice"})

    assert r.status_code == 404
    assert "error" in r.json()


def test_pair_finish_without_start_returns_400(client, default_session):
    r = client.post("/pair/airplay/finish", json={"name": "HomePod"})
    assert r.status_code == 400
    assert "error" in r.json()


def test_unpair_nonexistent_returns_404(client, default_session):
    import tempfile
    from delivery import credentials

    with tempfile.TemporaryDirectory() as d:
        import os

        with patch.object(credentials, "_PATH", os.path.join(d, "c.json")):
            r = client.delete("/pair/airplay/HomePod")
    assert r.status_code == 404


def test_unpair_existing_returns_success(client, default_session):
    import tempfile
    from delivery import credentials

    with tempfile.TemporaryDirectory() as d:
        import os

        path = os.path.join(d, "c.json")
        with patch.object(credentials, "_PATH", path):
            credentials.save("HomePod", "some-creds")
            r = client.delete("/pair/airplay/HomePod")
    assert r.status_code == 200
    assert r.json()["success"] is True
