"""Tests for SubsonicClient — especially the internal_url logic."""

from media import SubsonicClient

# Captured at import time, before conftest's autouse _stub_media_ping
# monkeypatches SubsonicClient.ping for the duration of each test — lets
# ping-specific tests below restore the real implementation.
_REAL_PING = SubsonicClient.ping


def _client(
    url="http://proxy:9180", internal_url="", credential="u=usr&s=salt&t=tok"
) -> SubsonicClient:
    return SubsonicClient(url, credential=credential, internal_url=internal_url)


# ── internal_url Fallback ─────────────────────────────────────────────────────


def test_internal_url_defaults_to_base_url():
    c = _client(url="http://nav:4533", internal_url="")
    assert c.internal_url == "http://nav:4533"
    assert c.base_url == "http://nav:4533"


def test_internal_url_set_explicitly():
    c = _client(url="http://proxy:9180", internal_url="http://nav:4533")
    assert c.internal_url == "http://nav:4533"
    assert c.base_url == "http://proxy:9180"


def test_trailing_slash_stripped():
    c = _client(url="http://proxy:9180/", internal_url="http://nav:4533/")
    assert c.base_url == "http://proxy:9180"
    assert c.internal_url == "http://nav:4533"


# ── get_stream_url verwendet internal_url ────────────────────────────────────


def test_stream_url_uses_internal_url():
    c = _client(url="http://proxy:9180", internal_url="http://nav:4533")
    url = c.get_stream_url("track-123")
    assert url.startswith("http://nav:4533/rest/stream.view")
    assert "id=track-123" in url


def test_stream_url_uses_base_when_no_internal():
    c = _client(url="http://nav:4533", internal_url="")
    url = c.get_stream_url("track-abc")
    assert url.startswith("http://nav:4533/rest/stream.view")


# ── get_cover_art_url verwendet base_url (Browser-URL) ───────────────────────


def test_cover_art_uses_base_url():
    c = _client(url="http://proxy:9180", internal_url="http://nav:4533")
    url = c.get_cover_art_url("cover-1")
    # Cover art goes through the proxy (base_url) so the browser can fetch it
    assert url.startswith("http://proxy:9180/rest/getCoverArt.view")
    assert "id=cover-1" in url


def test_cover_art_none_when_no_id():
    c = _client()
    assert c.get_cover_art_url("") is None
    assert c.get_cover_art_url(None) is None


def test_cover_art_uses_internal_url_when_requested():
    """internal=True is for cast devices (Sonos/Chromecast/AirPlay/DLNA)
    fetching the image directly themselves on the LAN, not the browser —
    they can't go through the same proxy path a browser uses."""
    c = _client(url="http://proxy:9180", internal_url="http://nav:4533")
    url = c.get_cover_art_url("cover-1", internal=True)
    assert url.startswith("http://nav:4533/rest/getCoverArt.view")
    assert "id=cover-1" in url


def test_cover_art_internal_falls_back_to_base_when_no_internal_url_configured():
    c = _client(url="http://nav:4533", internal_url="")
    url = c.get_cover_art_url("cover-1", internal=True)
    assert url.startswith("http://nav:4533/rest/getCoverArt.view")


# ── Auth-Parameter ────────────────────────────────────────────────────────────


def test_auth_params_from_credential_string():
    c = SubsonicClient("http://nav:4533", credential="u=alice&s=salt1&t=abc123")
    params = c._auth_params()
    assert params["u"] == "alice"
    assert params["s"] == "salt1"
    assert params["t"] == "abc123"
    assert params["f"] == "json"


def test_auth_params_adds_defaults_to_credential():
    c = SubsonicClient("http://nav:4533", credential="u=alice&s=s&t=t")
    params = c._auth_params()
    assert "v" in params
    assert "c" in params
    assert "f" in params


def test_auth_params_from_user_password():
    c = SubsonicClient("http://nav:4533", user="bob", password="secret")
    params = c._auth_params()
    assert params["u"] == "bob"
    assert "t" in params  # token = md5(password+salt)
    assert "s" in params
    assert params["f"] == "json"


# ── get_track parses Subsonic song JSON ────────────────────────────────────────


def test_get_track_parses_song(monkeypatch):
    import httpx

    song = {
        "id": "abc",
        "title": "Song Title",
        "artist": "Artist A",
        "album": "The Album",
        "duration": 213,
        "coverArt": "cover-1",
    }

    def fake_get(url, **kwargs):
        return httpx.Response(
            200,
            json={"subsonic-response": {"status": "ok", "song": song}},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    track = _client().get_track("abc")
    assert track.id == "abc"
    assert track.title == "Song Title"
    assert track.artist == "Artist A"
    assert track.album == "The Album"
    assert track.duration == 213
    assert track.cover_art_id == "cover-1"


def test_ping_uses_internal_url(monkeypatch):
    import httpx

    captured = {}

    def fake_get(url, **kwargs):
        captured["url"] = url
        mock = httpx.Response(
            200, json={"subsonic-response": {"status": "ok", "version": "1.16.1"}}
        )
        return mock

    monkeypatch.setattr(SubsonicClient, "ping", _REAL_PING)
    monkeypatch.setattr(httpx, "get", fake_get)

    c = _client(url="http://proxy:9180", internal_url="http://nav:4533")
    c.ping()

    assert captured["url"].startswith("http://nav:4533"), (
        f"_get() sollte internal_url nutzen, nutzte aber: {captured['url']}"
    )
