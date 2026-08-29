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
        captured["params"] = kwargs["params"]
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
    assert (
        headers.get("X-Custom-Header") == "keep-me" or headers.get("x-custom-header") == "keep-me"
    )


# ── Repeated query params (Subsonic's list-argument convention) ──────────────
#
# createPlaylist.view/updatePlaylist.view send a song list as a repeated key
# (songId=a&songId=b&songId=c). dict(request.query_params) silently collapses
# that to just the last value — a "create a playlist from these 3 songs"
# request arrived here fine but left for Navidrome with only the last one.


def test_proxy_forwards_every_value_of_a_repeated_query_param(client, default_session):
    from media import SubsonicClient

    default_session.media = SubsonicClient("http://navidrome.internal:4533")
    proxy_mod = _reload_proxy("http://navidrome.internal:4533")
    mock_client_cls, captured = _mock_httpx_client()

    with patch.object(proxy_mod.httpx, "AsyncClient", mock_client_cls):
        client.get(
            "/rest/createPlaylist.view?u=user&t=token&s=salt&v=1.16.1&c=test&f=json"
            "&name=Mix&songId=a&songId=b&songId=c"
        )

    song_ids = [v for k, v in captured["params"] if k == "songId"]
    assert song_ids == ["a", "b", "c"]


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


def test_proxy_auth_forwards_to_navidrome_when_configured(client):
    proxy_mod = _reload_proxy("http://navidrome.internal:4533")
    mock_client_cls, captured = _mock_httpx_client()

    with patch.object(proxy_mod.httpx, "AsyncClient", mock_client_cls):
        r = client.post("/auth/login", json={"username": "user", "password": "pass"})

    assert r.status_code == 200
    assert captured["url"] == "http://navidrome.internal:4533/auth/login"


def test_proxy_navidrome_api_forwards_to_navidrome_when_configured(client):
    # nginx strips "/api/" before this ever reaches the backend — see this
    # route's own module comment — so a bare "/album/abc123" here is the
    # equivalent of the frontend having requested "/api/album/abc123".
    proxy_mod = _reload_proxy("http://navidrome.internal:4533")
    mock_client_cls, captured = _mock_httpx_client()

    with patch.object(proxy_mod.httpx, "AsyncClient", mock_client_cls):
        r = client.get("/album/abc123")

    assert r.status_code == 200
    assert captured["url"] == "http://navidrome.internal:4533/api/album/abc123"


# ── _proxy()'s httpx failure handling ────────────────────────────────────────


def _failing_client(exc: Exception) -> MagicMock:
    mock_client = MagicMock()
    mock_client.build_request = MagicMock(return_value=MagicMock())
    mock_client.send = AsyncMock(side_effect=exc)
    # The app's own shutdown (main.py's lifespan) awaits this regardless of
    # what happened during the test — must stay a real awaitable or every
    # subsequent test sharing routes.proxy's module-level _client breaks too.
    mock_client.aclose = AsyncMock()
    return MagicMock(return_value=mock_client)


def test_proxy_returns_502_on_connect_error(client, default_session):
    import httpx

    from media import SubsonicClient

    default_session.media = SubsonicClient("http://navidrome.internal:4533")
    proxy_mod = _reload_proxy("http://navidrome.internal:4533")

    with patch.object(
        proxy_mod.httpx, "AsyncClient", _failing_client(httpx.ConnectError("refused"))
    ):
        r = client.get("/rest/ping.view?u=user&t=token&s=salt&v=1.16.1&c=test&f=json")

    assert r.status_code == 502
    assert "not reachable" in r.json()["error"]


def test_proxy_returns_504_on_timeout(client, default_session):
    import httpx

    from media import SubsonicClient

    default_session.media = SubsonicClient("http://navidrome.internal:4533")
    proxy_mod = _reload_proxy("http://navidrome.internal:4533")

    with patch.object(
        proxy_mod.httpx, "AsyncClient", _failing_client(httpx.TimeoutException("timed out"))
    ):
        r = client.get("/rest/ping.view?u=user&t=token&s=salt&v=1.16.1&c=test&f=json")

    assert r.status_code == 504
    assert "Timeout" in r.json()["error"]


def test_proxy_returns_502_on_an_unexpected_httpx_error(client, default_session):
    """Catch-all for the several other httpx exceptions that can surface
    here (RemoteProtocolError, PoolTimeout, ...) — not worth enumerating
    individually, see _proxy()'s own comment."""
    from media import SubsonicClient

    default_session.media = SubsonicClient("http://navidrome.internal:4533")
    proxy_mod = _reload_proxy("http://navidrome.internal:4533")

    with patch.object(
        proxy_mod.httpx, "AsyncClient", _failing_client(RuntimeError("something else"))
    ):
        r = client.get("/rest/ping.view?u=user&t=token&s=salt&v=1.16.1&c=test&f=json")

    assert r.status_code == 502
    assert "Proxy error" in r.json()["error"]


def test_proxy_drops_the_stale_content_length_when_the_response_was_compressed(
    client, default_session
):
    """httpx already decompresses a gzipped origin response before this ever
    sees it — the original Content-Length header describes the *compressed*
    size and must not be forwarded as-is, or the browser reading the now-
    larger decompressed body against it would mismatch."""
    from media import SubsonicClient

    default_session.media = SubsonicClient("http://navidrome.internal:4533")
    proxy_mod = _reload_proxy("http://navidrome.internal:4533")

    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.headers = {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "9999",  # stale — describes the compressed body
    }

    async def aiter_bytes():
        yield b"{}"

    fake_response.aiter_bytes = aiter_bytes
    fake_response.aclose = AsyncMock()
    mock_client = MagicMock()
    mock_client.build_request = MagicMock(return_value=MagicMock())
    mock_client.send = AsyncMock(return_value=fake_response)
    mock_client.aclose = AsyncMock()

    with patch.object(proxy_mod.httpx, "AsyncClient", MagicMock(return_value=mock_client)):
        r = client.get("/rest/ping.view?u=user&t=token&s=salt&v=1.16.1&c=test&f=json")

    assert r.headers.get("content-length") != "9999"


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


def test_the_shared_client_keeps_enough_connections_alive_for_a_library_scroll():
    """Regression guard (2026-08-22): with httpx's defaults only 20 of up to
    100 connections were kept alive, and only for 5s. Scrolling a library
    view past hundreds of covers therefore closed and re-opened connections
    continuously — a DNS lookup and TLS handshake each time — which was
    enough to overrun the host's DNS stub. A pool that discards most of its
    connections between requests is not doing its job."""
    import routes.proxy as proxy_mod

    limits = proxy_mod._LIMITS
    assert limits.max_keepalive_connections == limits.max_connections
    assert limits.keepalive_expiry >= 60
