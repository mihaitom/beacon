"""Tests for routes/navidrome.py — the smart playlist editor's way into
Navidrome's own API, and the server detection it depends on."""

from unittest.mock import MagicMock

import httpx
import pytest

from media import http_client
from media.jellyfin import JellyfinClient
from media.subsonic import SubsonicClient
from routes.navidrome import LOGIN_REQUIRED, PASSWORD_REJECTED


@pytest.fixture
def navidrome(default_session):
    media = SubsonicClient(
        "https://music.example", credential="u=thomas&t=abc&s=xyz", internal_url="http://nd:4533"
    )
    media.server_software = "navidrome"
    default_session.media = media
    default_session.account_username = "Thomas"
    return default_session


@pytest.fixture
def navidrome_api(monkeypatch):
    """Stands in for Navidrome's /api: records each request and answers with
    whatever the test queued (a plain 200 by default)."""
    calls: list[dict] = []
    answers: list[httpx.Response] = []

    def request(method, url, headers=None, json=None, params=None, timeout=None):
        calls.append(
            {"method": method, "url": url, "headers": headers, "json": json, "params": params}
        )
        return answers.pop(0) if answers else httpx.Response(200, json={})

    fake = MagicMock()
    fake.request = request
    monkeypatch.setattr(http_client, "client", lambda: fake)
    return calls, answers


def _login_answer(monkeypatch, response: httpx.Response | Exception):
    calls: list[dict] = []

    def post(url, json=None, timeout=None):
        calls.append({"url": url, "json": json})
        if isinstance(response, Exception):
            raise response
        # raise_for_status() needs the request a real response carries.
        response.request = httpx.Request("POST", url)
        return response

    monkeypatch.setattr(http_client, "post", post)
    return calls


# ── Logging in ───────────────────────────────────────────────────────────────


def test_login_asks_navidrome_for_a_token_as_the_signed_in_account(client, navidrome, monkeypatch):
    calls = _login_answer(monkeypatch, httpx.Response(200, json={"token": "jwt-1", "id": "u1"}))

    r = client.post("/navidrome/session", json={"password": "secret"})

    assert r.status_code == 200
    assert calls == [
        {
            "url": "http://nd:4533/auth/login",
            # The name Navidrome reported at /config, not the credential's.
            "json": {"username": "Thomas", "password": "secret"},
        }
    ]
    assert navidrome.navidrome_token == "jwt-1"


def test_login_keeps_the_token_and_not_the_password(client, navidrome, monkeypatch):
    _login_answer(monkeypatch, httpx.Response(200, json={"token": "jwt-1"}))

    client.post("/navidrome/session", json={"password": "secret"})

    held = {**vars(navidrome), **vars(navidrome.media)}
    assert "secret" not in [value for value in held.values() if isinstance(value, str)]


def test_login_falls_back_to_the_credential_name_when_none_was_verified(
    client, navidrome, monkeypatch
):
    navidrome.account_username = ""
    calls = _login_answer(monkeypatch, httpx.Response(200, json={"token": "jwt-1"}))

    client.post("/navidrome/session", json={"password": "secret"})

    assert calls[0]["json"]["username"] == "thomas"


def test_login_says_so_when_navidrome_refuses_the_password(client, navidrome, monkeypatch):
    _login_answer(monkeypatch, httpx.Response(401, json={"error": "Invalid username or password"}))

    r = client.post("/navidrome/session", json={"password": "wrong"})

    # Not a 401, which the frontend would take for its own session lapsing.
    assert r.status_code == 403
    assert r.json()["detail"] == PASSWORD_REJECTED
    assert navidrome.navidrome_token == ""


def test_login_reports_an_unreachable_server_as_such(client, navidrome, monkeypatch):
    _login_answer(monkeypatch, httpx.ConnectError("refused"))

    r = client.post("/navidrome/session", json={"password": "secret"})

    assert r.status_code == 502
    assert navidrome.navidrome_token == ""


def test_login_is_refused_for_a_subsonic_server_that_is_not_navidrome(
    client, navidrome, monkeypatch
):
    navidrome.media.server_software = "gonic"
    calls = _login_answer(monkeypatch, httpx.Response(200, json={"token": "jwt-1"}))

    r = client.post("/navidrome/session", json={"password": "secret"})

    assert r.status_code == 404
    assert calls == []


def test_login_is_refused_for_a_jellyfin_session(client, default_session, monkeypatch):
    default_session.media = JellyfinClient("http://jf:8096", token="t", user_id="u")
    calls = _login_answer(monkeypatch, httpx.Response(200, json={"token": "jwt-1"}))

    r = client.post("/navidrome/session", json={"password": "secret"})

    assert r.status_code == 404
    assert calls == []


def test_login_needs_a_signed_in_session(client, navidrome, monkeypatch):
    navidrome.authenticated = False
    calls = _login_answer(monkeypatch, httpx.Response(200, json={"token": "jwt-1"}))

    r = client.post("/navidrome/session", json={"password": "secret"})

    assert r.status_code == 401
    assert calls == []


# ── Forwarding ───────────────────────────────────────────────────────────────


def test_forwarding_without_a_token_asks_for_the_login_and_sends_nothing(
    client, navidrome, navidrome_api
):
    calls, _answers = navidrome_api

    r = client.get("/navidrome/api/playlist/pl1")

    assert r.status_code == 403
    assert r.json()["detail"] == LOGIN_REQUIRED
    assert calls == []


def test_reading_a_playlist_sends_the_token_and_returns_navidrome_s_answer(
    client, navidrome, navidrome_api
):
    calls, answers = navidrome_api
    navidrome.navidrome_token = "jwt-1"
    rules = {"all": [{"is": {"loved": True}}]}
    answers.append(httpx.Response(200, json={"id": "pl1", "rules": rules}))

    r = client.get("/navidrome/api/playlist/pl1")

    assert r.status_code == 200
    assert r.json() == {"id": "pl1", "rules": rules}
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "http://nd:4533/api/playlist/pl1"
    assert calls[0]["headers"] == {"X-ND-Authorization": "Bearer jwt-1"}


def test_saving_rules_forwards_the_body_unchanged(client, navidrome, navidrome_api):
    calls, _answers = navidrome_api
    navidrome.navidrome_token = "jwt-1"
    body = {"name": "Late night", "rules": {"any": [{"contains": {"genre": "jazz"}}]}}

    r = client.put("/navidrome/api/playlist/pl1", json=body)

    assert r.status_code == 200
    assert calls[0]["method"] == "PUT"
    assert calls[0]["json"] == body


def test_creating_a_playlist_posts_to_the_list(client, navidrome, navidrome_api):
    calls, answers = navidrome_api
    navidrome.navidrome_token = "jwt-1"
    answers.append(httpx.Response(200, json={"id": "new"}))

    r = client.post("/navidrome/api/playlist", json={"name": "New", "rules": {"all": []}})

    assert r.json() == {"id": "new"}
    assert (calls[0]["method"], calls[0]["url"]) == ("POST", "http://nd:4533/api/playlist")


def test_listing_passes_the_paging_through(client, navidrome, navidrome_api):
    calls, _answers = navidrome_api
    navidrome.navidrome_token = "jwt-1"

    client.get("/navidrome/api/playlist?_start=0&_end=50&_sort=name")

    assert calls[0]["params"] == {"_start": "0", "_end": "50", "_sort": "name"}


def test_keeps_the_token_navidrome_refreshed(client, navidrome, navidrome_api):
    _calls, answers = navidrome_api
    navidrome.navidrome_token = "jwt-1"
    answers.append(httpx.Response(200, json={}, headers={"X-ND-Authorization": "jwt-2"}))

    client.get("/navidrome/api/playlist/pl1")

    assert navidrome.navidrome_token == "jwt-2"


def test_an_expired_token_is_dropped_and_the_login_asked_for(client, navidrome, navidrome_api):
    _calls, answers = navidrome_api
    navidrome.navidrome_token = "jwt-old"
    answers.append(httpx.Response(401, json={"error": "token expired"}))

    r = client.get("/navidrome/api/playlist/pl1")

    assert r.status_code == 403
    assert r.json()["detail"] == LOGIN_REQUIRED
    assert navidrome.navidrome_token == ""


def test_navidrome_s_own_refusal_reaches_the_frontend_as_a_detail(client, navidrome, navidrome_api):
    # A 403 without a detail would make the frontend back off all polling.
    _calls, answers = navidrome_api
    navidrome.navidrome_token = "jwt-1"
    answers.append(httpx.Response(403, json={"error": "not the owner"}))

    r = client.put("/navidrome/api/playlist/pl1", json={"rules": {"all": []}})

    assert r.status_code == 403
    assert r.json() == {"detail": "Navidrome: not the owner"}


def test_a_navidrome_failure_is_reported_as_a_bad_gateway(client, navidrome, navidrome_api):
    _calls, answers = navidrome_api
    navidrome.navidrome_token = "jwt-1"
    answers.append(httpx.Response(500, text="boom"))

    r = client.post("/navidrome/api/playlist", json={"name": "x", "rules": {"all": []}})

    assert r.status_code == 502
    assert r.json()["detail"] == "Navidrome: 500"


def test_an_unreachable_server_is_reported_as_such(client, navidrome, monkeypatch):
    navidrome.navidrome_token = "jwt-1"
    fake = MagicMock()
    fake.request = MagicMock(side_effect=httpx.ConnectError("refused"))
    monkeypatch.setattr(http_client, "client", lambda: fake)

    r = client.get("/navidrome/api/playlist/pl1")

    assert r.status_code == 502


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/navidrome/api/user"),
        ("GET", "/navidrome/api/library"),
        ("DELETE", "/navidrome/api/playlist/pl1"),
        ("POST", "/navidrome/api/playlist/pl1/tracks"),
        ("GET", "/navidrome/api/playlist/pl1/../../user"),
    ],
)
def test_the_token_reaches_nothing_but_the_playlists(
    client, navidrome, navidrome_api, method, path
):
    # These fall through to routes/proxy.py's older catch-all instead, which
    # never attaches the session's Navidrome token.
    calls, _answers = navidrome_api
    navidrome.navidrome_token = "jwt-1"

    r = client.request(method, path)

    assert r.status_code != 200
    assert calls == []


def test_an_id_that_could_leave_the_playlist_path_is_refused(client, navidrome, navidrome_api):
    calls, _answers = navidrome_api
    navidrome.navidrome_token = "jwt-1"

    r = client.get("/navidrome/api/playlist/a.b")

    assert r.status_code == 400
    assert calls == []


def test_an_old_uuid_playlist_id_is_accepted(client, navidrome, navidrome_api):
    calls, _answers = navidrome_api
    navidrome.navidrome_token = "jwt-1"

    client.get("/navidrome/api/playlist/0b7c2a3e-1f4d-4e6a-9c1b-2d3e4f5a6b7c")

    assert calls[0]["url"].endswith("/api/playlist/0b7c2a3e-1f4d-4e6a-9c1b-2d3e4f5a6b7c")


# ── Knowing it is Navidrome ──────────────────────────────────────────────────


def test_health_reports_the_server_software(client, navidrome):
    r = client.get("/health")

    assert r.json()["session_server_software"] == "navidrome"


def test_a_new_login_drops_the_previous_navidrome_token(client, navidrome):
    navidrome.navidrome_token = "jwt-of-someone-else"

    r = client.post(
        "/config",
        json={"url": "http://nd:4533", "credential": "u=anna&t=x&s=y", "username": "anna"},
    )

    assert r.status_code == 200
    assert navidrome.navidrome_token == ""
