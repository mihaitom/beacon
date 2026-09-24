"""Tests for core/fanart.py — artist banners/backgrounds from Fanart.tv."""

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from core import api_keys, fanart


@pytest.fixture(autouse=True)
def _clear_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(api_keys, "_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(fanart, "_CACHE_PATH", str(tmp_path / "fanart_cache.json"))
    monkeypatch.setattr(fanart, "_IMAGE_DIR", str(tmp_path / "fanart_images"))
    monkeypatch.setattr(fanart, "_PREFETCH_GAP", 0)
    api_keys._cache.clear()
    fanart._cache.clear()
    yield
    for task in fanart._prefetching.values():
        task.cancel()
    fanart._prefetching.clear()
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

    assert art == {"banner": "banner", "background": None, "backgrounds": [], "logo": None}
    # The project key is the API key, and there is no client_key to send.
    assert get.await_args.kwargs["params"] == {"api_key": "beacon-project"}


async def test_no_mbid_means_nothing_to_show(key):
    with _with_mbid(None):
        assert await fanart.get_artist_art("Nobody") is None


async def test_a_collaboration_credit_falls_back_to_its_first_artist(key):
    """A credit like "Cardi B & Bruno Mars" has no MusicBrainz artist of its
    own, so nothing resolves and the track would go undressed; the first
    performer is who it gets dressed with."""
    payload = {"artistbackground": [{"url": "bg", "likes": "1"}]}
    resolve = AsyncMock(side_effect=lambda name: {"cardi b": "mbid-cardi"}.get(name.lower()))
    with patch.object(fanart, "resolve_mbid", resolve), _with_get(_response(200, payload)):
        art = await fanart.get_artist_art("Cardi B & Bruno Mars")

    assert art == {"banner": None, "background": "bg", "backgrounds": ["bg"], "logo": None}
    assert [call.args[0] for call in resolve.await_args_list] == ["Cardi B & Bruno Mars", "Cardi B"]


async def test_a_band_with_a_separator_in_its_name_stays_whole(key):
    """The whole credit is tried first: "Simon & Garfunkel" is one artist, so
    it must not fall back to "Simon"."""
    payload = {"artistbackground": [{"url": "bg", "likes": "1"}]}
    resolve = AsyncMock(return_value="mbid-duo")
    with patch.object(fanart, "resolve_mbid", resolve), _with_get(_response(200, payload)):
        await fanart.get_artist_art("Simon & Garfunkel")

    resolve.assert_awaited_once_with("Simon & Garfunkel")


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

    # Nothing on disk yet, so the most liked one.
    assert art["banner"] == "banner-high"
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
            "backgrounds": [],
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


def _backgrounds(likes_by_id: dict[int, int]) -> dict:
    return {
        "artistbackground": [
            {"id": str(i), "url": f"bg{i}", "likes": str(likes)} for i, likes in likes_by_id.items()
        ]
    }


def test_likes_are_compared_as_numbers():
    """Fanart.tv sends likes as strings; as strings, "9" would outrank "15"."""
    picked = fanart._pick(_backgrounds({1: 9, 2: 15, 3: 12}))

    assert picked["background"] == ["bg2", "bg3", "bg1"]


def test_pick_keeps_the_seven_most_liked_and_the_three_newest():
    # Old images with likes (ids 1-9), newer ones without (ids 10-14).
    likes = {i: 20 - i for i in range(1, 10)} | {i: 0 for i in range(10, 15)}
    picked = fanart._pick(_backgrounds(likes))

    liked = [f"bg{i}" for i in range(1, 8)]
    newest = ["bg14", "bg13", "bg12"]
    assert picked["background"] == liked + newest


def test_pick_keeps_everything_when_there_are_ten_or_fewer():
    picked = fanart._pick(_backgrounds({i: 0 for i in range(1, 11)}))

    assert len(picked["background"]) == 10


async def test_shows_the_most_liked_when_nothing_is_on_disk(key):
    with _with_mbid(), _with_get(_response(200, _backgrounds({1: 2, 2: 5, 3: 1}))):
        art = await fanart.get_artist_art("Cher")

    assert art["background"] == "bg2"
    assert art["backgrounds"] == ["bg2", "bg1", "bg3"]


async def test_prefers_an_image_already_on_disk(key):
    """A returning artist is shown straight from disk rather than waiting on
    a download of the best one."""
    fanart.store_image("bg3", b"jpeg")
    with _with_mbid(), _with_get(_response(200, _backgrounds({1: 2, 2: 5, 3: 1}))):
        art = await fanart.get_artist_art("Cher")

    assert art["background"] == "bg3"


async def test_downloads_the_other_backgrounds_in_the_background(key):
    fetch = AsyncMock(return_value=(b"jpeg", "image/jpeg"))
    with (
        _with_mbid(),
        _with_get(_response(200, _backgrounds({1: 3, 2: 2, 3: 1}))),
        patch.object(fanart, "fetch_image", fetch),
    ):
        art = await fanart.get_artist_art("Cher")
        await asyncio.gather(*fanart._prefetching.values())

    # The shown one is left to the image route, which the page asks for
    # anyway - fetching it here too would download it twice.
    assert art["background"] == "bg1"
    assert [call.args[0] for call in fetch.await_args_list] == ["bg2", "bg3"]
    assert fanart.is_image_cached("bg2") and fanart.is_image_cached("bg3")


async def test_a_second_visit_does_not_start_a_second_download_run(key):
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_fetch(url):
        started.set()
        await release.wait()
        return b"jpeg", "image/jpeg"

    fetch = AsyncMock(side_effect=slow_fetch)
    with (
        _with_mbid(),
        _with_get(_response(200, _backgrounds({1: 2, 2: 1}))),
        patch.object(fanart, "fetch_image", fetch),
    ):
        await fanart.get_artist_art("Cher")
        await asyncio.wait_for(started.wait(), timeout=1)
        await fanart.get_artist_art("Cher")
        release.set()
        await asyncio.gather(*fanart._prefetching.values())

    assert fetch.await_count == 1


def _write_cache(entries: dict) -> None:
    with open(fanart._CACHE_PATH, "w") as f:
        json.dump(entries, f)


def _entry(art: dict | None, *, fetched: float, used: float | None = None, version=None) -> dict:
    return {
        "fetched": fetched,
        "used": fetched if used is None else used,
        "version": fanart._CACHE_VERSION if version is None else version,
        "art": art,
    }


_URL = "https://assets.fanart.tv/fanart/"


async def test_a_refreshed_list_keeps_the_images_it_still_names(key):
    """A Fanart.tv image URL never changes content, so asking for the list
    again must not throw away bytes that are still wanted - only the image
    the new list dropped goes."""
    old = time.time() - fanart._REFRESH - 1
    _write_cache({"abc": _entry({"background": [_URL + "kept", _URL + "gone"]}, fetched=old)})
    fanart.store_image(_URL + "kept", b"jpeg")
    fanart.store_image(_URL + "gone", b"jpeg")
    payload = {"artistbackground": [{"id": "1", "url": _URL + "kept", "likes": "1"}]}

    with _with_mbid(), _with_get(_response(200, payload)) as get:
        art = await fanart.get_artist_art("Cher")

    get.assert_awaited_once()
    assert art["background"] == _URL + "kept"
    assert fanart.get_cached_image(_URL + "kept") == b"jpeg"
    assert fanart.get_cached_image(_URL + "gone") is None


async def test_metadata_cached_by_an_older_version_is_fetched_again(key):
    """The old top-five lists were picked with a string sort; they are asked
    for again right away, not after a month."""
    _write_cache({"abc": _entry({"background": ["stale"]}, fetched=time.time(), version=1)})

    with _with_mbid(), _with_get(_response(200, _backgrounds({1: 1}))) as get:
        art = await fanart.get_artist_art("Cher")

    get.assert_awaited_once()
    assert art["background"] == "bg1"


async def test_an_entry_from_before_the_used_stamp_is_still_read(key):
    """Entries written before fetched/used existed carry only an expiry."""
    expires = time.time() + fanart._REFRESH / 2
    _write_cache(
        {
            "abc": {
                "expires": expires,
                "version": fanart._CACHE_VERSION,
                "art": {"background": ["bg"]},
            }
        }
    )

    with _with_mbid(), _with_get(_response(200, {})) as get:
        art = await fanart.get_artist_art("Cher")

    get.assert_not_awaited()
    assert art["background"] == "bg"


async def test_a_failed_refresh_keeps_showing_the_stale_list(key):
    """The stale list still names images on disk; Fanart.tv being down is no
    reason to show nothing."""
    old = time.time() - fanart._REFRESH - 1
    _write_cache({"abc": _entry({"background": ["bg"]}, fetched=old)})
    failed = httpx.Response(500, request=httpx.Request("GET", "https://x"))

    with _with_mbid(), _with_get(failed):
        art = await fanart.get_artist_art("Cher")

    assert art["background"] == "bg"


async def test_an_artist_unused_for_a_month_is_dropped_with_its_images(key):
    now = time.time()
    unused = now - fanart._UNUSED - 1
    _write_cache(
        {
            "old": _entry({"background": [_URL + "old"]}, fetched=unused),
            # Fetched just as long ago, but opened since - it stays.
            "busy": _entry({"background": [_URL + "busy"]}, fetched=unused, used=now),
        }
    )
    fanart.store_image(_URL + "old", b"jpeg")
    fanart.store_image(_URL + "busy", b"jpeg")

    # Any write of the cache prunes; a lookup of a third artist is one.
    with _with_mbid("new"), _with_get(_response(200, {})):
        await fanart.get_artist_art("Someone")

    assert fanart.get_cached_image(_URL + "old") is None
    assert fanart.get_cached_image(_URL + "busy") == b"jpeg"
    assert set(fanart._load_cache()) == {"busy", "new"}


async def test_opening_an_artist_keeps_it_from_being_dropped(key):
    now = time.time()
    _write_cache({"abc": _entry({"background": ["bg"]}, fetched=now - 5 * 86400)})

    with _with_mbid(), _with_get(_response(200, {})):
        await fanart.get_artist_art("Cher")

    assert fanart._load_cache()["abc"]["used"] >= now


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


# ── stored backgrounds ───────────────────────────────────────────────────────


def _store_artist(mbid: str, backgrounds: list[str], on_disk: list[str]) -> None:
    cache = fanart._load_cache()
    cache[mbid] = {
        "fetched": time.time(),
        "used": time.time(),
        "version": fanart._CACHE_VERSION,
        "art": {"background": backgrounds},
    }
    fanart._save_cache(cache)
    for url in on_disk:
        fanart.store_image(url, b"jpeg")


def test_stored_backgrounds_offers_only_what_is_on_disk():
    """Nothing is downloaded for a list page's header - a background whose
    bytes are not stored yet is left out."""
    _store_artist("a", [_URL + "a1", _URL + "a2"], on_disk=[_URL + "a1"])
    _store_artist("b", [_URL + "b1"], on_disk=[_URL + "b1"])

    assert sorted(fanart.stored_backgrounds()) == [_URL + "a1", _URL + "b1"]


def test_stored_backgrounds_narrows_to_the_named_artists(monkeypatch):
    """A genre's header shows that genre's artists only, found through the
    MBIDs already resolved - a collaboration credit through its first
    performer, as the lookup itself does."""
    _store_artist("mbid-a", [_URL + "a1"], on_disk=[_URL + "a1"])
    _store_artist("mbid-b", [_URL + "b1"], on_disk=[_URL + "b1"])
    known = {"artist a": "mbid-a", "artist b": "mbid-b"}
    monkeypatch.setattr(fanart, "cached_mbid", lambda name: known.get(name.strip().lower()))

    assert fanart.stored_backgrounds(["Artist A & Someone"]) == [_URL + "a1"]
    assert fanart.stored_backgrounds(["Nobody"]) == []


def test_stored_backgrounds_never_asks_musicbrainz(monkeypatch):
    monkeypatch.setattr(fanart, "resolve_mbid", AsyncMock(side_effect=AssertionError("asked")))
    monkeypatch.setattr(fanart, "cached_mbid", lambda name: None)

    assert fanart.stored_backgrounds(["Unknown Artist"]) == []


def test_stored_backgrounds_is_capped(monkeypatch):
    monkeypatch.setattr(fanart, "_STORED_LIMIT", 3)
    urls = [_URL + f"bg{i}" for i in range(10)]
    _store_artist("a", urls, on_disk=urls)

    backgrounds = fanart.stored_backgrounds()
    assert len(backgrounds) == 3
    assert set(backgrounds) <= set(urls)


def test_the_stored_backgrounds_route(client, key):
    _store_artist("a", [_URL + "a1"], on_disk=[_URL + "a1"])

    resp = client.post("/fanart/stored-backgrounds", json={})

    assert resp.status_code == 200
    assert resp.json() == {"backgrounds": [_URL + "a1"]}
