"""Tests for PlexClient and media/plex.py's module-level plex.tv functions."""

import httpx
import pytest

from media import PlexClient
from media.plex import (
    _connection_url,
    _pick_connection,
    check_pin,
    client_identifier,
    create_pin,
    get_account_username,
    list_resources,
)

# Captured at import time, before conftest's autouse _stub_media_ping
# monkeypatches PlexClient.ping for the duration of each test — lets
# ping-specific tests below restore the real implementation.
_REAL_PING = PlexClient.ping


def _client(url="http://plex:32400", internal_url="", token="tok") -> PlexClient:
    return PlexClient(url, token=token, internal_url=internal_url)


# ── internal_url fallback ────────────────────────────────────────────────────


def test_internal_url_defaults_to_base_url():
    c = _client(url="http://plex:32400", internal_url="")
    assert c.internal_url == "http://plex:32400"
    assert c.base_url == "http://plex:32400"


def test_trailing_slash_stripped():
    c = _client(url="http://proxy:9180/", internal_url="http://plex:32400/")
    assert c.base_url == "http://proxy:9180"
    assert c.internal_url == "http://plex:32400"


# ── get_cover_art_url ─────────────────────────────────────────────────────────


def test_cover_art_uses_base_url():
    c = _client(url="http://proxy:9180", internal_url="http://plex:32400", token="tok")
    url = c.get_cover_art_url("2001")
    assert url == "http://proxy:9180/library/metadata/2001/thumb?X-Plex-Token=tok"


def test_cover_art_uses_internal_url_when_requested():
    c = _client(url="http://proxy:9180", internal_url="http://plex:32400", token="tok")
    url = c.get_cover_art_url("2001", internal=True)
    assert url == "http://plex:32400/library/metadata/2001/thumb?X-Plex-Token=tok"


def test_cover_art_none_when_no_id():
    assert _client().get_cover_art_url("") is None


# ── get_track parses Plex item JSON ──────────────────────────────────────────


def test_get_track_parses_item(monkeypatch):
    item = {
        "ratingKey": "9001",
        "title": "Song Title",
        "grandparentTitle": "Artist A",
        "parentTitle": "The Album",
        "parentRatingKey": "2001",
        "duration": 180_000,
    }

    def fake_get(url, headers=None, params=None, timeout=None):
        assert url.endswith("/library/metadata/9001")
        return httpx.Response(
            200,
            json={"MediaContainer": {"Metadata": [item]}},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    track = _client().get_track("9001")
    assert track.id == "9001"
    assert track.title == "Song Title"
    assert track.artist == "Artist A"
    assert track.duration == 180
    assert track.album == "The Album"
    # Falls back to the album's id — tracks rarely have their own art.
    assert track.cover_art_id == "2001"


def test_get_track_raises_when_not_found(monkeypatch):
    def fake_get(url, **kwargs):
        return httpx.Response(
            200, json={"MediaContainer": {}}, request=httpx.Request("GET", url)
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    with pytest.raises(RuntimeError, match="not found"):
        _client().get_track("missing")


# ── get_stream_url resolves Media.Part.key ───────────────────────────────────


def test_get_stream_url_resolves_part_key(monkeypatch):
    item = {
        "ratingKey": "9001",
        "Media": [{"Part": [{"key": "/library/parts/555/file.mp3"}]}],
    }

    def fake_get(url, **kwargs):
        return httpx.Response(
            200,
            json={"MediaContainer": {"Metadata": [item]}},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    url = _client(url="http://proxy:9180", internal_url="http://plex:32400", token="tok").get_stream_url(
        "9001"
    )
    assert url == "http://plex:32400/library/parts/555/file.mp3?X-Plex-Token=tok"


def test_get_stream_url_raises_without_part(monkeypatch):
    def fake_get(url, **kwargs):
        return httpx.Response(
            200,
            json={"MediaContainer": {"Metadata": [{"ratingKey": "9001", "Media": []}]}},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    with pytest.raises(RuntimeError, match="no playable Part"):
        _client().get_stream_url("9001")


# ── ping ──────────────────────────────────────────────────────────────────────


def test_ping_hits_sections_endpoint_with_token(monkeypatch):
    captured = {}

    def fake_get(url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs.get("headers")
        return httpx.Response(200, json={}, request=httpx.Request("GET", url))

    monkeypatch.setattr(PlexClient, "ping", _REAL_PING)
    monkeypatch.setattr(httpx, "get", fake_get)
    c = _client(url="http://proxy:9180", internal_url="http://plex:32400", token="tok")
    assert c.ping() is True
    assert captured["url"] == "http://plex:32400/library/sections"
    assert captured["headers"]["X-Plex-Token"] == "tok"


def test_ping_returns_false_on_error(monkeypatch):
    def fake_get(url, **kwargs):
        raise httpx.ConnectError("nope")

    monkeypatch.setattr(PlexClient, "ping", _REAL_PING)
    monkeypatch.setattr(httpx, "get", fake_get)
    assert _client().ping() is False


# ── PIN linking ───────────────────────────────────────────────────────────────


def test_create_pin_returns_id_and_code(monkeypatch):
    def fake_post(url, params=None, headers=None, timeout=None):
        assert url == "https://plex.tv/api/v2/pins"
        assert headers["Accept"] == "application/json"
        return httpx.Response(
            200, json={"id": 42, "code": "ABCD"}, request=httpx.Request("POST", url)
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    assert create_pin() == {"id": 42, "code": "ABCD"}


def test_check_pin_returns_none_while_pending(monkeypatch):
    def fake_get(url, **kwargs):
        assert url == "https://plex.tv/api/v2/pins/42"
        return httpx.Response(
            200, json={"authToken": None}, request=httpx.Request("GET", url)
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    assert check_pin(42) is None


def test_check_pin_returns_token_once_approved(monkeypatch):
    def fake_get(url, **kwargs):
        return httpx.Response(
            200, json={"authToken": "acct-tok"}, request=httpx.Request("GET", url)
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    assert check_pin(42) == "acct-tok"


def test_client_identifier_stable_across_calls(monkeypatch, tmp_path):
    import media.plex as plex_mod

    monkeypatch.setattr(plex_mod, "_CLIENT_ID_FILE", tmp_path / ".plex-client-id")
    first = client_identifier()
    second = client_identifier()
    assert first == second


# ── get_account_username ─────────────────────────────────────────────────────


def test_get_account_username_prefers_username_field(monkeypatch):
    def fake_get(url, **kwargs):
        assert url == "https://plex.tv/api/v2/user"
        return httpx.Response(
            200,
            json={"username": "alice", "title": "Alice A", "email": "a@example.com"},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    assert get_account_username("acct-tok") == "alice"


def test_get_account_username_falls_back_to_title_then_email(monkeypatch):
    def fake_get(url, **kwargs):
        return httpx.Response(
            200, json={"email": "a@example.com"}, request=httpx.Request("GET", url)
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    assert get_account_username("acct-tok") == "a@example.com"


# ── list_resources / connection selection ────────────────────────────────────


def test_list_resources_filters_to_servers_only(monkeypatch):
    def fake_get(url, **kwargs):
        return httpx.Response(
            200,
            json=[
                {"provides": "player", "name": "Not a server"},
                {
                    "provides": "server",
                    "name": "My Server",
                    "clientIdentifier": "abc123",
                    "accessToken": "server-tok",
                    "connections": [
                        {"protocol": "http", "address": "10.2.2.11", "port": 32400, "local": True}
                    ],
                },
            ],
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    servers = list_resources("acct-tok")
    assert servers == [
        {
            "name": "My Server",
            "machine_identifier": "abc123",
            "url": "http://10.2.2.11:32400",
            "token": "server-tok",
        }
    ]


def test_list_resources_raises_on_empty_body(monkeypatch):
    def fake_get(url, **kwargs):
        return httpx.Response(200, content=b"", request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", fake_get)
    with pytest.raises(ValueError, match="empty response"):
        list_resources("acct-tok")


def test_pick_connection_prefers_local_http_over_local_https():
    connections = [
        {"protocol": "https", "local": True, "uri": "https://x.plex.direct:32400"},
        {"protocol": "http", "local": True, "address": "10.2.2.11", "port": 32400},
    ]
    picked = _pick_connection(connections)
    assert picked["protocol"] == "http"


def test_pick_connection_falls_back_to_remote_when_no_local():
    connections = [{"protocol": "https", "local": False, "uri": "https://remote.plex.direct:32400"}]
    picked = _pick_connection(connections)
    assert picked["protocol"] == "https"


def test_connection_url_builds_raw_ip_for_http():
    connection = {"protocol": "http", "address": "10.2.2.11", "port": 32400}
    assert _connection_url(connection) == "http://10.2.2.11:32400"


def test_connection_url_uses_uri_for_https():
    # A bare IP over HTTPS fails certificate validation (confirmed live
    # 2026-08-17, see _connection_url()'s own docstring) — must use the
    # ready-made hostname-based uri instead.
    connection = {
        "protocol": "https",
        "address": "10.2.2.11",
        "port": 32400,
        "uri": "https://10-2-2-11.example.plex.direct:32400",
    }
    assert _connection_url(connection) == "https://10-2-2-11.example.plex.direct:32400"
