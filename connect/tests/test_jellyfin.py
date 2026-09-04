"""Tests for JellyfinClient."""

import httpx
import pytest

from media import JellyfinClient, http_client
from media.jellyfin import (
    authenticate_by_name,
    authenticate_with_quick_connect,
    check_quick_connect_authenticated,
    initiate_quick_connect,
)

# Captured at import time, before conftest's autouse _stub_media_ping
# monkeypatches JellyfinClient.ping for the duration of each test — lets
# ping-specific tests below restore the real implementation.
_REAL_PING = JellyfinClient.ping


def _client(url="http://proxy:9180", internal_url="", token="tok", user_id="u1") -> JellyfinClient:
    return JellyfinClient(url, token=token, user_id=user_id, internal_url=internal_url)


# ── internal_url Fallback ─────────────────────────────────────────────────────


def test_internal_url_defaults_to_base_url():
    c = _client(url="http://jf:8096", internal_url="")
    assert c.internal_url == "http://jf:8096"
    assert c.base_url == "http://jf:8096"


def test_internal_url_set_explicitly():
    c = _client(url="http://proxy:9180", internal_url="http://jf:8096")
    assert c.internal_url == "http://jf:8096"
    assert c.base_url == "http://proxy:9180"


def test_trailing_slash_stripped():
    c = _client(url="http://proxy:9180/", internal_url="http://jf:8096/")
    assert c.base_url == "http://proxy:9180"
    assert c.internal_url == "http://jf:8096"


# ── get_stream_url verwendet internal_url + Download-Endpoint ─────────────────


def test_stream_url_uses_download_endpoint():
    c = _client(url="http://proxy:9180", internal_url="http://jf:8096", token="t0k")
    url = c.get_stream_url("track-123")
    assert url == "http://jf:8096/Items/track-123/Download?api_key=t0k"


def test_stream_url_uses_base_when_no_internal():
    c = _client(url="http://jf:8096", internal_url="", token="abc")
    url = c.get_stream_url("trk")
    assert url.startswith("http://jf:8096/Items/trk/Download")


# ── get_cover_art_url ─────────────────────────────────────────────────────────


def test_cover_art_uses_base_url():
    c = _client(url="http://proxy:9180", internal_url="http://jf:8096")
    url = c.get_cover_art_url("item-1")
    assert url == "http://proxy:9180/Items/item-1/Images/Primary?maxHeight=300"


def test_cover_art_none_when_no_id():
    c = _client()
    assert c.get_cover_art_url("") is None


def test_cover_art_uses_internal_url_when_requested():
    """internal=True is for cast devices fetching the image directly
    themselves on the LAN, not the browser."""
    c = _client(url="http://proxy:9180", internal_url="http://jf:8096")
    url = c.get_cover_art_url("item-1", internal=True)
    assert url == "http://jf:8096/Items/item-1/Images/Primary?maxHeight=300"


def test_cover_art_sends_the_image_version_back_as_a_tag():
    # The bridge puts Jellyfin's own image tag on the id (see
    # media/base.py's artwork_id, and jellyfin_bridge's _cover_art_id) so
    # that replacing the artwork changes the id every cache is keyed by.
    # Here it has to come back off the id and reach Jellyfin as `tag`.
    c = _client(url="http://proxy:9180", internal_url="http://jf:8096")
    url = c.get_cover_art_url("item-1_a1b2c3")
    assert url == "http://proxy:9180/Items/item-1/Images/Primary?maxHeight=300&tag=a1b2c3"


def test_cover_art_still_resolves_an_id_with_no_version():
    # An id saved by an older build (a restored queue, a cached library)
    # has no version on it and must keep working exactly as it did.
    c = _client(url="http://proxy:9180", internal_url="http://jf:8096")
    url = c.get_cover_art_url("item-1")
    assert url == "http://proxy:9180/Items/item-1/Images/Primary?maxHeight=300"


# ── get_track parses Jellyfin item JSON ───────────────────────────────────────


def test_get_track_parses_item(monkeypatch):
    item = {
        "Id": "abc",
        "Name": "Song Title",
        "Artists": ["Artist A", "Artist B"],
        "AlbumArtist": "Artist A",
        "Album": "The Album",
        # 180s × 10_000_000 ticks/second
        "RunTimeTicks": 180 * 10_000_000,
    }

    def fake_get(url, headers=None, params=None, timeout=None):
        assert url.endswith("/Users/u1/Items/abc")
        assert headers == {"X-Emby-Token": "tok"}
        return httpx.Response(200, json=item, request=httpx.Request("GET", url))

    monkeypatch.setattr(http_client, "get", fake_get)
    track = _client().get_track("abc")
    assert track.id == "abc"
    assert track.title == "Song Title"
    assert track.artist == "Artist A, Artist B"
    assert track.duration == 180
    assert track.album == "The Album"
    # Cover art id == item id for Jellyfin
    assert track.cover_art_id == "abc"


def test_get_track_falls_back_to_album_artist(monkeypatch):
    item = {"Id": "x", "Name": "T", "AlbumArtist": "AA", "RunTimeTicks": 0}

    def fake_get(url, **kwargs):
        return httpx.Response(200, json=item, request=httpx.Request("GET", url))

    monkeypatch.setattr(http_client, "get", fake_get)
    track = _client().get_track("x")
    assert track.artist == "AA"
    assert track.duration == 0


def test_get_track_requires_user_id():
    c = JellyfinClient("http://jf:8096", token="t", user_id="")
    with pytest.raises(RuntimeError, match="user_id"):
        c.get_track("abc")


# ── _auth_header ──────────────────────────────────────────────────────────────


def test_auth_header_empty_without_a_token():
    c = _client(token="")
    assert c._auth_header() == {}


def test_auth_headers_public_accessor_delegates_to_auth_header():
    """media/jellyfin_bridge.py's own public entry point for this — that
    module calls several Jellyfin endpoints this class has no method of
    its own for."""
    c = _client(token="tok")
    assert c.auth_headers() == {"X-Emby-Token": "tok"}


# ── get_similar_songs2 (Autoplay's internal-code-path Instant Mix) ──────────


def test_get_similar_songs2_requires_user_id():
    c = JellyfinClient("http://jf:8096", token="t", user_id="")
    with pytest.raises(RuntimeError, match="user_id"):
        c.get_similar_songs2("seed-1")


def test_get_similar_songs2_parses_instant_mix_items(monkeypatch):
    data = {
        "Items": [
            {
                "Id": "similar-1",
                "Name": "Similar Song",
                "Artists": ["Artist A", "Artist B"],
                "Album": "The Album",
                "RunTimeTicks": 200 * 10_000_000,
            }
        ]
    }

    def fake_get(url, headers=None, params=None, timeout=None):
        assert url.endswith("/Items/seed-1/InstantMix")
        assert params["userId"] == "u1"
        assert params["Limit"] == 5
        return httpx.Response(200, json=data, request=httpx.Request("GET", url))

    monkeypatch.setattr(http_client, "get", fake_get)
    tracks = _client().get_similar_songs2("seed-1", count=5)

    assert len(tracks) == 1
    assert tracks[0].id == "similar-1"
    assert tracks[0].artist == "Artist A, Artist B"
    assert tracks[0].duration == 200
    assert tracks[0].cover_art_id == "similar-1"


def test_get_similar_songs2_falls_back_to_album_artist(monkeypatch):
    data = {
        "Items": [
            {"Id": "s1", "Name": "T", "AlbumArtist": "AA", "RunTimeTicks": 0},
        ]
    }
    monkeypatch.setattr(
        http_client,
        "get",
        lambda *a, **k: httpx.Response(200, json=data, request=httpx.Request("GET", a[0])),
    )
    tracks = _client().get_similar_songs2("seed-1")
    assert tracks[0].artist == "AA"


# ── _device_id persistence ───────────────────────────────────────────────────


def test_device_id_falls_back_gracefully_when_persisting_fails(monkeypatch, tmp_path):
    from media import jellyfin as jellyfin_mod

    monkeypatch.setattr(jellyfin_mod, "_DEVICE_ID_FILE", tmp_path / "no-such-dir" / "device-id")

    device_id = jellyfin_mod._device_id()  # must not raise

    assert len(device_id) == 32  # secrets.token_hex(16)


# ── ping ──────────────────────────────────────────────────────────────────────


def test_ping_hits_authenticated_endpoint_with_token(monkeypatch):
    captured = {}

    def fake_get(url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs.get("headers")
        return httpx.Response(200, json={"Id": "user"}, request=httpx.Request("GET", url))

    monkeypatch.setattr(JellyfinClient, "ping", _REAL_PING)
    monkeypatch.setattr(http_client, "get", fake_get)
    c = _client(url="http://proxy:9180", internal_url="http://jf:8096", token="tok")
    assert c.ping() is True
    assert captured["url"] == "http://jf:8096/Users/Me"
    assert captured["headers"] == {"X-Emby-Token": "tok"}


def test_ping_returns_false_on_error(monkeypatch):
    def fake_get(url, **kwargs):
        raise httpx.ConnectError("nope")

    monkeypatch.setattr(JellyfinClient, "ping", _REAL_PING)
    monkeypatch.setattr(http_client, "get", fake_get)
    assert _client().ping() is False


def test_ping_returns_false_on_invalid_token(monkeypatch):
    def fake_get(url, **kwargs):
        return httpx.Response(401, request=httpx.Request("GET", url))

    monkeypatch.setattr(JellyfinClient, "ping", _REAL_PING)
    monkeypatch.setattr(http_client, "get", fake_get)
    assert _client(token="wrong").ping() is False


# ── authenticate_by_name ───────────────────────────────────────────────────


def test_authenticate_by_name_returns_token_and_user_id(monkeypatch):
    def fake_post(url, json=None, headers=None, timeout=None):
        assert url == "http://jf:8096/Users/AuthenticateByName"
        assert json == {"Username": "alice", "Pw": "secret"}
        assert headers["Authorization"].startswith("MediaBrowser ")
        assert 'Client="Beacon"' in headers["Authorization"]
        return httpx.Response(
            200,
            json={"AccessToken": "tok-abc", "User": {"Id": "user-guid-1"}},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(http_client, "post", fake_post)
    result = authenticate_by_name("http://jf:8096/", "alice", "secret")
    assert result == {"token": "tok-abc", "user_id": "user-guid-1"}


def test_authenticate_by_name_raises_on_rejected_credentials(monkeypatch):
    def fake_post(url, **kwargs):
        return httpx.Response(401, request=httpx.Request("POST", url))

    monkeypatch.setattr(http_client, "post", fake_post)
    with pytest.raises(httpx.HTTPStatusError):
        authenticate_by_name("http://jf:8096", "alice", "wrong")


def test_authenticate_by_name_device_id_stable_across_calls(monkeypatch, tmp_path):
    import media.jellyfin as jf_mod

    monkeypatch.setattr(jf_mod, "_DEVICE_ID_FILE", tmp_path / ".jellyfin-device-id")

    captured = []

    def fake_post(url, json=None, headers=None, timeout=None):
        captured.append(headers["Authorization"])
        return httpx.Response(
            200,
            json={"AccessToken": "t", "User": {"Id": "u"}},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(http_client, "post", fake_post)
    authenticate_by_name("http://jf:8096", "a", "b")
    authenticate_by_name("http://jf:8096", "a", "b")
    assert captured[0] == captured[1]


# ── Quick Connect ────────────────────────────────────────────────────────────


def test_initiate_quick_connect_returns_secret_and_code(monkeypatch):
    def fake_post(url, headers=None, timeout=None):
        assert url == "http://jf:8096/QuickConnect/Initiate"
        assert headers["Authorization"].startswith("MediaBrowser ")
        return httpx.Response(
            200,
            json={"Secret": "sec-1", "Code": "123456", "Authenticated": False},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(http_client, "post", fake_post)
    result = initiate_quick_connect("http://jf:8096/")
    assert result == {"secret": "sec-1", "code": "123456"}


def test_initiate_quick_connect_raises_when_disabled(monkeypatch):
    def fake_post(url, **kwargs):
        return httpx.Response(400, request=httpx.Request("POST", url))

    monkeypatch.setattr(http_client, "post", fake_post)
    with pytest.raises(httpx.HTTPStatusError):
        initiate_quick_connect("http://jf:8096")


def test_check_quick_connect_authenticated_true(monkeypatch):
    def fake_get(url, params=None, headers=None, timeout=None):
        assert url == "http://jf:8096/QuickConnect/Connect"
        assert params == {"secret": "sec-1"}
        return httpx.Response(200, json={"Authenticated": True}, request=httpx.Request("GET", url))

    monkeypatch.setattr(http_client, "get", fake_get)
    assert check_quick_connect_authenticated("http://jf:8096", "sec-1") is True


def test_check_quick_connect_authenticated_false(monkeypatch):
    def fake_get(url, **kwargs):
        return httpx.Response(200, json={"Authenticated": False}, request=httpx.Request("GET", url))

    monkeypatch.setattr(http_client, "get", fake_get)
    assert check_quick_connect_authenticated("http://jf:8096", "sec-1") is False


def test_authenticate_with_quick_connect_returns_token_user_id_and_username(monkeypatch):
    def fake_post(url, json=None, headers=None, timeout=None):
        assert url == "http://jf:8096/Users/AuthenticateWithQuickConnect"
        assert json == {"Secret": "sec-1"}
        return httpx.Response(
            200,
            json={"AccessToken": "tok-xyz", "User": {"Id": "u1", "Name": "alice"}},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(http_client, "post", fake_post)
    result = authenticate_with_quick_connect("http://jf:8096", "sec-1")
    assert result == {"token": "tok-xyz", "user_id": "u1", "username": "alice"}


def test_authenticate_with_quick_connect_raises_when_not_yet_approved(monkeypatch):
    def fake_post(url, **kwargs):
        return httpx.Response(401, request=httpx.Request("POST", url))

    monkeypatch.setattr(http_client, "post", fake_post)
    with pytest.raises(httpx.HTTPStatusError):
        authenticate_with_quick_connect("http://jf:8096", "sec-1")
