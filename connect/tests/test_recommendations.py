"""Tests for core/recommendations.py — MusicBrainz name->MBID resolution +
ListenBrainz Labs similar-artists, both cached to disk."""

import json
import tempfile
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from core import recommendations


def _tmp_path(tmp_dir: str) -> str:
    return str(Path(tmp_dir) / "test_recommendations_cache.json")


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    # Module-level, persists across tests otherwise — a cache-miss test
    # running within _MB_MIN_INTERVAL of a previous one would otherwise
    # incur a real sleep. 0.0 puts the "last call" far enough in
    # time.monotonic()'s past that the very next call never waits.
    recommendations._mb_last_call = 0.0
    yield


def _mb_response(url: str, mbid: str | None) -> httpx.Response:
    artists = [{"id": mbid, "score": 100}] if mbid else []
    return httpx.Response(
        200, json={"artists": artists}, request=httpx.Request("GET", url)
    )


def _lb_response(url: str, items: list[dict]) -> httpx.Response:
    return httpx.Response(200, json=items, request=httpx.Request("GET", url))


# ── resolve_mbid ──────────────────────────────────────────────────────────


async def test_resolve_mbid_cache_hit_skips_network():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"mbid_by_name": {"radiohead": "abc-123"}}, f)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            result = await recommendations.resolve_mbid("Radiohead")
    assert result == "abc-123"
    client.get.assert_not_called()


async def test_resolve_mbid_negative_cache_skips_network():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"mbid_by_name": {"some obscure act": None}}, f)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            result = await recommendations.resolve_mbid("Some Obscure Act")
    assert result is None
    client.get.assert_not_called()


async def test_resolve_mbid_fetches_and_caches_on_miss():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=lambda url, params=None: _mb_response(url, "new-mbid-1")
            )
            result = await recommendations.resolve_mbid("Boards of Canada")

        assert result == "new-mbid-1"
        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
        assert cache["mbid_by_name"]["boards of canada"] == "new-mbid-1"


async def test_resolve_mbid_caches_negative_result_when_not_found():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(side_effect=lambda url, params=None: _mb_response(url, None))
            result = await recommendations.resolve_mbid("Definitely Not A Real Artist")

        assert result is None
        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
        assert cache["mbid_by_name"]["definitely not a real artist"] is None


# ── get_similar_artists ──────────────────────────────────────────────────


async def test_get_similar_artists_uses_cached_similar_when_fresh():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "mbid_by_name": {"radiohead": "rh-mbid"},
                    "similar_by_mbid": {
                        "rh-mbid": {
                            "fetched_at": time.time(),
                            "similar": [{"mbid": "x", "name": "Portishead", "score": 50}],
                        }
                    },
                },
                f,
            )
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            result = await recommendations.get_similar_artists(["Radiohead"])

    assert result == [{"mbid": "x", "name": "Portishead", "score": 50}]
    client.get.assert_not_called()


async def test_get_similar_artists_refetches_when_stale():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        stale_ts = time.time() - recommendations._SIMILAR_TTL_SECONDS - 1
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "mbid_by_name": {"radiohead": "rh-mbid"},
                    "similar_by_mbid": {
                        "rh-mbid": {"fetched_at": stale_ts, "similar": [{"mbid": "x", "name": "Old", "score": 1}]}
                    },
                },
                f,
            )
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=lambda url, params=None: _lb_response(
                    url, [{"artist_mbid": "y", "name": "Fresh", "score": 99, "reference_mbid": "rh-mbid"}]
                )
            )
            result = await recommendations.get_similar_artists(["Radiohead"])

    assert result == [{"mbid": "y", "name": "Fresh", "score": 99}]


async def test_get_similar_artists_excludes_seed_names():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "mbid_by_name": {"radiohead": "rh-mbid"},
                    "similar_by_mbid": {
                        "rh-mbid": {
                            "fetched_at": time.time(),
                            "similar": [
                                # Case-different match against the seed itself — must not
                                # come back as a "new" suggestion.
                                {"mbid": "rh-mbid", "name": "RADIOHEAD", "score": 999},
                                {"mbid": "y", "name": "Portishead", "score": 50},
                            ],
                        }
                    },
                },
                f,
            )
        with patch.object(recommendations, "_PATH", path):
            result = await recommendations.get_similar_artists(["Radiohead"])

    assert [a["name"] for a in result] == ["Portishead"]


async def test_get_similar_artists_dedupes_keeping_higher_score():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "mbid_by_name": {"a": "a-mbid", "b": "b-mbid"},
                    "similar_by_mbid": {
                        "a-mbid": {
                            "fetched_at": time.time(),
                            "similar": [{"mbid": "x", "name": "Shared", "score": 10}],
                        },
                        "b-mbid": {
                            "fetched_at": time.time(),
                            "similar": [{"mbid": "x", "name": "shared", "score": 40}],
                        },
                    },
                },
                f,
            )
        with patch.object(recommendations, "_PATH", path):
            result = await recommendations.get_similar_artists(["A", "B"])

    assert len(result) == 1
    assert result[0]["score"] == 40


async def test_get_similar_artists_respects_limit():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        similar = [{"mbid": str(i), "name": f"Artist {i}", "score": i} for i in range(10)]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "mbid_by_name": {"seed": "s-mbid"},
                    "similar_by_mbid": {"s-mbid": {"fetched_at": time.time(), "similar": similar}},
                },
                f,
            )
        with patch.object(recommendations, "_PATH", path):
            result = await recommendations.get_similar_artists(["Seed"], limit=3)

    assert len(result) == 3
    assert [a["score"] for a in result] == [9, 8, 7]


async def test_get_similar_artists_returns_empty_when_no_seed_resolves():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(side_effect=lambda url, params=None: _mb_response(url, None))
            result = await recommendations.get_similar_artists(["Nobody Knows This Band"])

    assert result == []


# ── get_artist_images ─────────────────────────────────────────────────────


def _deezer_response(url: str, artists: list[dict]) -> httpx.Response:
    return httpx.Response(200, json={"data": artists}, request=httpx.Request("GET", url))


async def test_get_artist_images_cache_hit_skips_network():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {"deezer_by_name": {"portishead": {"image": "img", "link": "link"}}}, f
            )
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            result = await recommendations.get_artist_images(["Portishead"])

    assert result == {"Portishead": {"image": "img", "link": "link"}}
    client.get.assert_not_called()


async def test_get_artist_images_fetches_and_caches_on_miss():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=lambda url, params=None: _deezer_response(
                    url,
                    [
                        {
                            "name": "Portishead",
                            "nb_fan": 500,
                            "picture_medium": "https://img/1",
                            "link": "https://deezer/1",
                        }
                    ],
                )
            )
            result = await recommendations.get_artist_images(["Portishead"])

        assert result == {
            "Portishead": {"image": "https://img/1", "link": "https://deezer/1"}
        }
        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
        assert cache["deezer_by_name"]["portishead"] == {
            "image": "https://img/1",
            "link": "https://deezer/1",
        }


async def test_get_artist_images_picks_highest_fan_count_among_exact_matches():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=lambda url, params=None: _deezer_response(
                    url,
                    [
                        {
                            "name": "Radiohead",
                            "nb_fan": 484,
                            "picture_medium": "https://img/wrong",
                            "link": "https://deezer/wrong",
                        },
                        {
                            "name": "Radiohead",
                            "nb_fan": 4076156,
                            "picture_medium": "https://img/real",
                            "link": "https://deezer/real",
                        },
                        {
                            # Different name entirely — must not win regardless of fans.
                            "name": "DJ Radiohead",
                            "nb_fan": 99999999,
                            "picture_medium": "https://img/dj",
                            "link": "https://deezer/dj",
                        },
                    ],
                )
            )
            result = await recommendations.get_artist_images(["Radiohead"])

    assert result["Radiohead"] == {"image": "https://img/real", "link": "https://deezer/real"}


async def test_get_artist_images_caches_negative_result_when_no_exact_match():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=lambda url, params=None: _deezer_response(
                    url, [{"name": "Some Other Band", "nb_fan": 1, "picture_medium": "x", "link": "y"}]
                )
            )
            result = await recommendations.get_artist_images(["Totally Obscure Act"])

        assert result == {"Totally Obscure Act": None}
        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
        assert cache["deezer_by_name"]["totally obscure act"] is None


async def test_get_artist_images_fetches_multiple_names_concurrently():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):

            def fake_get(url, params=None):
                name = params["q"]
                return _deezer_response(
                    url, [{"name": name, "nb_fan": 1, "picture_medium": f"img-{name}", "link": f"link-{name}"}]
                )

            client.get = AsyncMock(side_effect=fake_get)
            result = await recommendations.get_artist_images(["A", "B"])

    assert result == {
        "A": {"image": "img-A", "link": "link-A"},
        "B": {"image": "img-B", "link": "link-B"},
    }


# ── GET /recommendations/similar-artists, /artist-images ────────────────


def test_similar_artists_endpoint(client):
    fake = AsyncMock(return_value=[{"mbid": "x", "name": "Portishead", "score": 50}])
    with patch("routes.recommendations.get_similar_artists", fake):
        r = client.get(
            "/recommendations/similar-artists?seed=Radiohead&seed=Boards+of+Canada&limit=10"
        )

    assert r.status_code == 200
    assert r.json() == {"artists": [{"mbid": "x", "name": "Portishead", "score": 50}]}
    fake.assert_awaited_once_with(["Radiohead", "Boards of Canada"], limit=10)


def test_artist_images_endpoint(client):
    fake = AsyncMock(return_value={"Portishead": {"image": "img", "link": "link"}})
    with patch("routes.recommendations.get_artist_images", fake):
        r = client.get("/recommendations/artist-images?name=Portishead")

    assert r.status_code == 200
    assert r.json() == {"images": {"Portishead": {"image": "img", "link": "link"}}}
    fake.assert_awaited_once_with(["Portishead"])
