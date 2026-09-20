"""Tests for core/fanart.py — artist banners/backgrounds from Fanart.tv."""

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from core import api_keys, fanart


@pytest.fixture(autouse=True)
def _clear_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(api_keys, "_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(fanart, "_CACHE_PATH", str(tmp_path / "fanart_cache.json"))
    monkeypatch.setattr(fanart, "_IMAGE_DIR", str(tmp_path / "fanart_images"))
    api_keys._cache.clear()
    fanart._cache.clear()
    yield
    api_keys._cache.clear()
    fanart._cache.clear()


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setenv("FANART_API_KEY", "fanart-key")
    api_keys._cache.clear()
    yield
    api_keys._cache.clear()


def _response(status: int, payload: dict) -> httpx.Response:
    return httpx.Response(status, json=payload, request=httpx.Request("GET", "https://x"))


def _with_mbid(mbid: str | None = "abc") -> AsyncMock:
    return patch.object(fanart, "resolve_mbid", AsyncMock(return_value=mbid))


def _with_get(response: httpx.Response) -> AsyncMock:
    return patch.object(fanart._client, "get", AsyncMock(return_value=response))


async def test_works_without_a_personal_key_using_beacons_project_key(monkeypatch):
    """The personal key is optional - Beacon's own project key fetches the
    images on its own, as Jellyfin's Fanart plugin does."""
    monkeypatch.setattr(fanart, "_PROJECT_KEY", "beacon-project")
    payload = {"artistbanner": [{"url": "banner", "likes": "1"}]}
    with _with_mbid(), _with_get(_response(200, payload)) as get:
        art = await fanart.get_artist_art("Cher")

    assert art == {"banner": "banner", "background": None, "logo": None}
    # The project key is the API key, and there is no client_key to send.
    assert get.await_args.kwargs["params"] == {"api_key": "beacon-project"}


async def test_no_mbid_means_nothing_to_show(key):
    with _with_mbid(None):
        assert await fanart.get_artist_art("Nobody") is None


async def test_returns_one_image_of_each_kind(key):
    payload = {
        "artistbanner": [
            {"url": "banner-low", "likes": "1"},
            {"url": "banner-high", "likes": "9"},
        ],
        "artistbackground": [{"url": "bg", "likes": "3"}],
        "hdmusiclogo": [{"url": "logo", "likes": "5"}],
    }
    with _with_mbid(), _with_get(_response(200, payload)):
        art = await fanart.get_artist_art("Cher")

    # The banner is one of the two candidates (picked at random - see
    # test_pick_keeps_the_five_most_liked for the ordering); the other two
    # kinds have a single entry each.
    assert art["banner"] in {"banner-high", "banner-low"}
    assert art["background"] == "bg"
    assert art["logo"] == "logo"


async def test_an_artist_with_no_images_is_no_art(key):
    with _with_mbid(), _with_get(_response(200, {"name": "Nobody"})):
        assert await fanart.get_artist_art("Nobody") is None


async def test_a_404_is_no_art(key):
    with _with_mbid(), _with_get(_response(404, {"error": "not found"})):
        assert await fanart.get_artist_art("Nobody") is None


async def test_sends_beacons_project_key_alongside_the_users_personal_one(key, monkeypatch):
    """Fanart.tv's terms require a publicly available program to identify
    itself with its project key, in addition to the user's own."""
    monkeypatch.setattr(fanart, "_PROJECT_KEY", "beacon-project")
    payload = {"artistbanner": [{"url": "banner", "likes": "1"}]}
    with _with_mbid(), _with_get(_response(200, payload)) as get:
        await fanart.get_artist_art("Cher")
    assert get.await_args.kwargs["params"] == {
        "api_key": "fanart-key",
        "client_key": "beacon-project",
    }


async def test_omits_the_client_key_when_no_project_key_is_set(key, monkeypatch):
    monkeypatch.setattr(fanart, "_PROJECT_KEY", "")
    payload = {"artistbanner": [{"url": "banner", "likes": "1"}]}
    with _with_mbid(), _with_get(_response(200, payload)) as get:
        await fanart.get_artist_art("Cher")
    assert get.await_args.kwargs["params"] == {"api_key": "fanart-key"}


async def test_caches_a_result(key):
    payload = {"artistbanner": [{"url": "banner", "likes": "1"}]}
    with _with_mbid(), _with_get(_response(200, payload)) as get:
        await fanart.get_artist_art("Cher")
        await fanart.get_artist_art("Cher")
    assert get.await_count == 1


async def test_a_failed_request_is_not_cached(key):
    """Fanart.tv being briefly unreachable must not leave the artist without
    a banner for the rest of the day."""
    payload = {"artistbanner": [{"url": "banner", "likes": "1"}]}
    with _with_mbid(), _with_get(httpx.Response(500, request=httpx.Request("GET", "https://x"))):
        assert await fanart.get_artist_art("Cher") is None
    with _with_mbid(), _with_get(_response(200, payload)):
        assert await fanart.get_artist_art("Cher") == {
            "banner": "banner",
            "background": None,
            "logo": None,
        }


async def test_the_metadata_cache_survives_a_restart(key):
    payload = {"artistbanner": [{"url": "banner", "likes": "1"}]}
    with _with_mbid(), _with_get(_response(200, payload)):
        first = await fanart.get_artist_art("Cher")

    # What a restart looks like from this module's point of view: the
    # in-memory cache is gone, the file on disk is not.
    fanart._cache.clear()
    with _with_mbid(), _with_get(_response(200, payload)) as get:
        second = await fanart.get_artist_art("Cher")

    assert second == first
    get.assert_not_awaited()


def test_pick_keeps_the_five_most_liked():
    payload = {"artistbackground": [{"url": f"bg{i}", "likes": str(i)} for i in range(8)]}
    picked = fanart._pick(payload)

    assert picked["background"] == ["bg7", "bg6", "bg5", "bg4", "bg3"]


async def test_shows_one_of_the_five_most_liked(key):
    payload = {"artistbackground": [{"url": f"bg{i}", "likes": str(i)} for i in range(8)]}
    with _with_mbid(), _with_get(_response(200, payload)):
        art = await fanart.get_artist_art("Cher")

    # A random one of the top five, never the sixth-best and below.
    assert art["background"] in {"bg7", "bg6", "bg5", "bg4", "bg3"}


# ── image bytes ──────────────────────────────────────────────────────────────


def test_only_fanart_hosts_may_be_fetched():
    """An open image proxy is an SSRF hole - the route serves whatever URL
    it is handed, so only Fanart.tv's own hosts get through."""
    assert fanart.is_allowed_image_url("https://assets.fanart.tv/fanart/a.jpg")
    assert fanart.is_allowed_image_url("https://fanart.tv/a.jpg")
    assert not fanart.is_allowed_image_url("http://assets.fanart.tv/a.jpg")
    assert not fanart.is_allowed_image_url("https://evil.example.com/a.jpg")
    assert not fanart.is_allowed_image_url("https://169.254.169.254/latest/meta-data")


def test_the_image_cache_round_trips():
    url = "https://assets.fanart.tv/fanart/music/x/background/bg.jpg"

    assert fanart.get_cached_image(url) is None
    fanart.store_image(url, b"jpeg-bytes")
    assert fanart.get_cached_image(url) == b"jpeg-bytes"


def test_the_image_route_serves_and_caches(client, key):
    url = "https://assets.fanart.tv/fanart/music/x/background/bg.jpg"
    fetched = httpx.Response(
        200,
        content=b"jpeg-bytes",
        headers={"content-type": "image/jpeg"},
        request=httpx.Request("GET", url),
    )
    with patch.object(fanart._client, "get", AsyncMock(return_value=fetched)):
        resp = client.get("/fanart/image", params={"url": url})

    assert resp.status_code == 200
    assert resp.content == b"jpeg-bytes"
    assert resp.headers["content-type"] == "image/jpeg"
    assert resp.headers["cache-control"].startswith("public")
    # The colour extractor reads these pixels through a canvas.
    assert resp.headers["access-control-allow-origin"] == "*"

    # Now cached: a second request does not touch Fanart.tv again.
    with patch.object(fanart._client, "get", AsyncMock(side_effect=AssertionError("refetched"))):
        again = client.get("/fanart/image", params={"url": url})
    assert again.content == b"jpeg-bytes"


def test_the_image_route_refuses_a_non_fanart_url(client, key):
    resp = client.get("/fanart/image", params={"url": "https://evil.example.com/a.jpg"})
    assert resp.status_code == 404
