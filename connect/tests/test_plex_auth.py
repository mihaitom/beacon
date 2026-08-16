"""Tests for POST /plex/pin/initiate, /plex/pin/check, /plex/resources."""

import httpx


def test_pin_initiate_returns_id_code_and_auth_url(client, monkeypatch):
    import routes.plex_auth as route_mod

    monkeypatch.setattr(route_mod, "create_pin", lambda: {"id": 42, "code": "ABCD"})
    monkeypatch.setattr(route_mod, "client_identifier", lambda: "client-1")

    r = client.post("/plex/pin/initiate")
    assert r.status_code == 200
    data = r.json()
    assert data["id"] == 42
    assert data["code"] == "ABCD"
    assert data["auth_url"].startswith("https://app.plex.tv/auth#?")
    assert "clientID=client-1" in data["auth_url"]
    assert "code=ABCD" in data["auth_url"]


def test_pin_initiate_returns_502_when_unreachable(client, monkeypatch):
    import routes.plex_auth as route_mod

    def fake_create_pin():
        raise httpx.ConnectError("nope")

    monkeypatch.setattr(route_mod, "create_pin", fake_create_pin)

    r = client.post("/plex/pin/initiate")
    assert r.status_code == 502


def test_pin_check_returns_false_while_pending(client, monkeypatch):
    import routes.plex_auth as route_mod

    monkeypatch.setattr(route_mod, "check_pin", lambda pin_id: None)

    r = client.post("/plex/pin/check", json={"id": 42})
    assert r.status_code == 200
    assert r.json() == {"authenticated": False}


def test_pin_check_returns_account_token_once_approved(client, monkeypatch):
    import routes.plex_auth as route_mod

    monkeypatch.setattr(route_mod, "check_pin", lambda pin_id: "acct-tok-1")
    monkeypatch.setattr(route_mod, "get_account_username", lambda account_token: "alice")

    r = client.post("/plex/pin/check", json={"id": 42})
    assert r.status_code == 200
    assert r.json() == {"authenticated": True, "account_token": "acct-tok-1", "username": "alice"}


def test_pin_check_tolerates_username_lookup_failure(client, monkeypatch):
    import routes.plex_auth as route_mod

    monkeypatch.setattr(route_mod, "check_pin", lambda pin_id: "acct-tok-1")

    def fake_get_username(account_token):
        raise httpx.HTTPStatusError(
            "401", request=httpx.Request("GET", "http://x"), response=httpx.Response(401)
        )

    monkeypatch.setattr(route_mod, "get_account_username", fake_get_username)

    r = client.post("/plex/pin/check", json={"id": 42})
    assert r.status_code == 200
    assert r.json() == {"authenticated": True, "account_token": "acct-tok-1", "username": ""}


def test_pin_check_returns_502_when_unreachable(client, monkeypatch):
    import routes.plex_auth as route_mod

    def fake_check_pin(pin_id):
        raise httpx.ConnectError("nope")

    monkeypatch.setattr(route_mod, "check_pin", fake_check_pin)

    r = client.post("/plex/pin/check", json={"id": 42})
    assert r.status_code == 502


def test_resources_returns_server_list(client, monkeypatch):
    import routes.plex_auth as route_mod

    servers = [
        {
            "name": "My Server",
            "machine_identifier": "abc123",
            "url": "http://192.168.1.10:32400",
            "token": "server-tok-1",
        }
    ]
    monkeypatch.setattr(route_mod, "list_resources", lambda account_token: servers)

    r = client.post("/plex/resources", json={"account_token": "acct-tok-1"})
    assert r.status_code == 200
    assert r.json() == {"servers": servers}


def test_resources_returns_401_when_token_rejected(client, monkeypatch):
    import routes.plex_auth as route_mod

    def fake_list_resources(account_token):
        raise httpx.HTTPStatusError(
            "401", request=httpx.Request("GET", "http://x"), response=httpx.Response(401)
        )

    monkeypatch.setattr(route_mod, "list_resources", fake_list_resources)

    r = client.post("/plex/resources", json={"account_token": "bad-token"})
    assert r.status_code == 401


def test_resources_returns_502_when_unreachable(client, monkeypatch):
    import routes.plex_auth as route_mod

    def fake_list_resources(account_token):
        raise httpx.ConnectError("nope")

    monkeypatch.setattr(route_mod, "list_resources", fake_list_resources)

    r = client.post("/plex/resources", json={"account_token": "acct-tok-1"})
    assert r.status_code == 502


def test_pin_initiate_requires_connect_token(client):
    from core import auth as auth_mod

    if not auth_mod.TOKEN:
        return  # No token configured in this environment — nothing to enforce.
    r = client.post("/plex/pin/initiate", headers={"X-Connect-Token": "wrong"})
    assert r.status_code == 401
