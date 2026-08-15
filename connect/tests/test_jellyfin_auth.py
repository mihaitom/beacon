"""Tests for POST /jellyfin/login."""

import httpx


def test_login_returns_token_and_user_id(client, monkeypatch):
    def fake_authenticate_by_name(url, username, password):
        assert url == "http://jf:8096"
        assert username == "alice"
        assert password == "secret"
        return {"token": "tok-abc", "user_id": "user-guid-1"}

    # routes/jellyfin_auth.py does `from media.jellyfin import
    # authenticate_by_name`, binding its own name in this module's
    # namespace — patching media.jellyfin's copy wouldn't affect it.
    import routes.jellyfin_auth as route_mod

    monkeypatch.setattr(route_mod, "authenticate_by_name", fake_authenticate_by_name)

    r = client.post(
        "/jellyfin/login",
        json={"url": "http://jf:8096", "username": "alice", "password": "secret"},
    )
    assert r.status_code == 200
    assert r.json() == {"token": "tok-abc", "user_id": "user-guid-1"}


def test_login_returns_401_on_rejected_credentials(client, monkeypatch):
    def fake_authenticate_by_name(url, username, password):
        raise httpx.HTTPStatusError(
            "401", request=httpx.Request("POST", url), response=httpx.Response(401)
        )

    import routes.jellyfin_auth as route_mod

    monkeypatch.setattr(route_mod, "authenticate_by_name", fake_authenticate_by_name)

    r = client.post(
        "/jellyfin/login",
        json={"url": "http://jf:8096", "username": "alice", "password": "wrong"},
    )
    assert r.status_code == 401


def test_login_returns_502_when_server_unreachable(client, monkeypatch):
    def fake_authenticate_by_name(url, username, password):
        raise httpx.ConnectError("nope")

    import routes.jellyfin_auth as route_mod

    monkeypatch.setattr(route_mod, "authenticate_by_name", fake_authenticate_by_name)

    r = client.post(
        "/jellyfin/login",
        json={"url": "http://unreachable:8096", "username": "a", "password": "b"},
    )
    assert r.status_code == 502


def test_login_requires_connect_token(client, monkeypatch):
    from core import auth as auth_mod

    if not auth_mod.TOKEN:
        return  # No token configured in this environment — nothing to enforce.
    r = client.post(
        "/jellyfin/login",
        json={"url": "http://jf:8096", "username": "a", "password": "b"},
        headers={"X-Connect-Token": "wrong"},
    )
    assert r.status_code == 401


# ── Quick Connect ────────────────────────────────────────────────────────────


def test_quickconnect_initiate_returns_secret_and_code(client, monkeypatch):
    def fake_initiate(url):
        assert url == "http://jf:8096"
        return {"secret": "sec-1", "code": "123456"}

    import routes.jellyfin_auth as route_mod

    monkeypatch.setattr(route_mod, "initiate_quick_connect", fake_initiate)

    r = client.post("/jellyfin/quickconnect/initiate", json={"url": "http://jf:8096"})
    assert r.status_code == 200
    assert r.json() == {"secret": "sec-1", "code": "123456"}


def test_quickconnect_initiate_returns_400_when_disabled(client, monkeypatch):
    def fake_initiate(url):
        raise httpx.HTTPStatusError(
            "400", request=httpx.Request("POST", url), response=httpx.Response(400)
        )

    import routes.jellyfin_auth as route_mod

    monkeypatch.setattr(route_mod, "initiate_quick_connect", fake_initiate)

    r = client.post("/jellyfin/quickconnect/initiate", json={"url": "http://jf:8096"})
    assert r.status_code == 400


def test_quickconnect_initiate_returns_502_when_unreachable(client, monkeypatch):
    def fake_initiate(url):
        raise httpx.ConnectError("nope")

    import routes.jellyfin_auth as route_mod

    monkeypatch.setattr(route_mod, "initiate_quick_connect", fake_initiate)

    r = client.post("/jellyfin/quickconnect/initiate", json={"url": "http://jf:8096"})
    assert r.status_code == 502


def test_quickconnect_connect_returns_false_while_pending(client, monkeypatch):
    import routes.jellyfin_auth as route_mod

    monkeypatch.setattr(route_mod, "check_quick_connect_authenticated", lambda url, secret: False)

    r = client.post(
        "/jellyfin/quickconnect/connect", json={"url": "http://jf:8096", "secret": "sec-1"}
    )
    assert r.status_code == 200
    assert r.json() == {"authenticated": False}


def test_quickconnect_connect_exchanges_once_approved(client, monkeypatch):
    import routes.jellyfin_auth as route_mod

    monkeypatch.setattr(route_mod, "check_quick_connect_authenticated", lambda url, secret: True)
    monkeypatch.setattr(
        route_mod,
        "authenticate_with_quick_connect",
        lambda url, secret: {"token": "tok-xyz", "user_id": "u1", "username": "alice"},
    )

    r = client.post(
        "/jellyfin/quickconnect/connect", json={"url": "http://jf:8096", "secret": "sec-1"}
    )
    assert r.status_code == 200
    assert r.json() == {
        "authenticated": True,
        "token": "tok-xyz",
        "user_id": "u1",
        "username": "alice",
    }


def test_quickconnect_connect_returns_502_when_status_check_fails(client, monkeypatch):
    import routes.jellyfin_auth as route_mod

    def fake_check(url, secret):
        raise httpx.ConnectError("nope")

    monkeypatch.setattr(route_mod, "check_quick_connect_authenticated", fake_check)

    r = client.post(
        "/jellyfin/quickconnect/connect", json={"url": "http://jf:8096", "secret": "sec-1"}
    )
    assert r.status_code == 502


def test_quickconnect_connect_returns_401_when_exchange_rejected(client, monkeypatch):
    import routes.jellyfin_auth as route_mod

    monkeypatch.setattr(route_mod, "check_quick_connect_authenticated", lambda url, secret: True)

    def fake_exchange(url, secret):
        raise httpx.HTTPStatusError(
            "401", request=httpx.Request("POST", url), response=httpx.Response(401)
        )

    monkeypatch.setattr(route_mod, "authenticate_with_quick_connect", fake_exchange)

    r = client.post(
        "/jellyfin/quickconnect/connect", json={"url": "http://jf:8096", "secret": "sec-1"}
    )
    assert r.status_code == 401
