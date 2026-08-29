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
from core.recommendations import rank_similar


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
    return httpx.Response(200, json={"artists": artists}, request=httpx.Request("GET", url))


def _lb_response(url: str, items: list[dict]) -> httpx.Response:
    return httpx.Response(200, json=items, request=httpx.Request("GET", url))


# ── _load_cache / _save_cache ────────────────────────────────────────────────


def test_load_cache_returns_empty_dict_on_malformed_json(caplog):
    import logging

    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            f.write("{not valid json")
        with (
            patch.object(recommendations, "_PATH", path),
            caplog.at_level(logging.WARNING, logger="connect.recommendations"),
        ):
            cache = recommendations._load_cache()

    assert cache == {}
    assert "Cache load failed" in caplog.text


def test_save_cache_logs_but_does_not_raise_when_the_directory_is_unwritable(caplog):
    import logging

    with tempfile.TemporaryDirectory() as d:
        # A file, not a directory, as the parent — os.makedirs() on it fails.
        blocker = Path(d) / "blocker"
        blocker.write_text("x")
        path = str(blocker / "nested" / "cache.json")
        with (
            patch.object(recommendations, "_PATH", path),
            caplog.at_level(logging.ERROR, logger="connect.recommendations"),
        ):
            recommendations._save_cache({"some": "data"})  # must not raise

    assert "Cache save failed" in caplog.text


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


async def test_resolve_mbid_does_not_cache_transient_http_failure():
    """The actual bug — confirmed live: a burst of MusicBrainz 503s got
    cached as a *permanent* negative result, indistinguishable from a name
    MusicBrainz genuinely has no artist for. A failed call must leave
    nothing behind, so the next lookup for the same name gets a real
    retry instead of being stuck with a false negative forever."""
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):

            def fail(url, params=None):
                raise httpx.ConnectError("unreachable", request=httpx.Request("GET", url))

            client.get = AsyncMock(side_effect=fail)

            result = await recommendations.resolve_mbid("Radiohead")
            assert result is None
            # _load_cache(), not raw open() — nothing was ever written on a
            # failed call, so the cache file may not even exist yet, which
            # _load_cache() already treats the same as "empty".
            assert "radiohead" not in recommendations._load_cache().get("mbid_by_name", {})

            # Recovers on the very next call — not cached, so no stale
            # negative to override.
            client.get = AsyncMock(side_effect=lambda url, params=None: _mb_response(url, "mbid-1"))
            result = await recommendations.resolve_mbid("Radiohead")
            assert result == "mbid-1"


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

    # Normalized against this seed's own best, which is this one — see
    # rank_similar on why the raw count doesn't travel any further.
    assert result == [{"mbid": "x", "name": "Portishead", "score": 1.0}]
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
                        "rh-mbid": {
                            "fetched_at": stale_ts,
                            "similar": [{"mbid": "x", "name": "Old", "score": 1}],
                        }
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
                    url,
                    [
                        {
                            "artist_mbid": "y",
                            "name": "Fresh",
                            "score": 99,
                            "reference_mbid": "rh-mbid",
                        }
                    ],
                )
            )
            result = await recommendations.get_similar_artists(["Radiohead"])

    assert result == [{"mbid": "y", "name": "Fresh", "score": 1.0}]


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
    # One entry, and its score is the sum of two seeds' normalized ones —
    # each seed's own best result is 1.0 by definition, so an artist that
    # is the best match under both lands at 2.0. The raw 10 and 40 say
    # nothing comparable (see rank_similar).
    assert result[0]["score"] == 2.0


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
    # Normalized against this seed's own best (9), in the same order.
    assert [round(a["score"], 3) for a in result] == [1.0, round(8 / 9, 3), round(7 / 9, 3)]


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


async def test_fetch_similar_batch_returns_empty_for_no_mbids():
    # No point spending a Labs round trip on an empty seed list.
    assert await recommendations._fetch_similar_batch([]) == {}


async def test_fetch_similar_batch_returns_empty_on_listenbrainz_failure(caplog):
    import logging

    with patch.object(recommendations, "_client") as client:
        client.get = AsyncMock(side_effect=httpx.ConnectError("unreachable"))
        with caplog.at_level(logging.WARNING, logger="connect.recommendations"):
            result = await recommendations._fetch_similar_batch(["mbid-1"])

    assert result == {}
    assert "ListenBrainz similar-artists failed" in caplog.text


# ── get_artist_images ─────────────────────────────────────────────────────


def _deezer_response(url: str, artists: list[dict]) -> httpx.Response:
    return httpx.Response(200, json={"data": artists}, request=httpx.Request("GET", url))


async def test_get_artist_images_cache_hit_skips_network():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"deezer_by_name": {"portishead": {"image": "img", "link": "link"}}}, f)
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

        assert result == {"Portishead": {"image": "https://img/1", "link": "https://deezer/1"}}
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


async def test_fetch_deezer_returns_none_on_a_search_failure(caplog):
    import logging

    with patch.object(recommendations, "_client") as client:
        client.get = AsyncMock(side_effect=httpx.ConnectError("unreachable"))
        with caplog.at_level(logging.WARNING, logger="connect.recommendations"):
            result = await recommendations._fetch_deezer("Radiohead")

    assert result is None
    assert "Deezer search failed" in caplog.text


async def test_fetch_deezer_returns_none_when_the_match_has_neither_image_nor_link():
    with patch.object(recommendations, "_client") as client:
        client.get = AsyncMock(
            side_effect=lambda url, params=None: _deezer_response(
                url, [{"name": "Radiohead", "nb_fan": 100, "picture_medium": "", "link": ""}]
            )
        )
        result = await recommendations._fetch_deezer("Radiohead")

    assert result is None


async def test_get_artist_images_caches_negative_result_when_no_exact_match():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=lambda url, params=None: _deezer_response(
                    url,
                    [{"name": "Some Other Band", "nb_fan": 1, "picture_medium": "x", "link": "y"}],
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
                    url,
                    [
                        {
                            "name": name,
                            "nb_fan": 1,
                            "picture_medium": f"img-{name}",
                            "link": f"link-{name}",
                        }
                    ],
                )

            client.get = AsyncMock(side_effect=fake_get)
            result = await recommendations.get_artist_images(["A", "B"])

    assert result == {
        "A": {"image": "img-A", "link": "link-A"},
        "B": {"image": "img-B", "link": "link-B"},
    }


# ── get_artist_links ──────────────────────────────────────────────────────


def _mb_url_rels_response(url: str, relations: list[dict]) -> httpx.Response:
    return httpx.Response(200, json={"relations": relations}, request=httpx.Request("GET", url))


def _url_rel(rel_type: str, url: str) -> dict:
    return {"type": rel_type, "url": {"resource": url}}


async def test_get_artist_links_cache_hit_skips_network():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "mbid_by_name": {"radiohead": "mbid-1"},
                    "links_by_mbid": {"mbid-1": {"spotify": "https://open.spotify.com/artist/x"}},
                },
                f,
            )
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            result = await recommendations.get_artist_links(["Radiohead"])

    assert result == {"Radiohead": {"spotify": "https://open.spotify.com/artist/x"}}
    client.get.assert_not_called()


async def test_get_artist_links_no_mbid_skips_url_rels_call():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"mbid_by_name": {"obscure act": None}}, f)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            result = await recommendations.get_artist_links(["Obscure Act"])

    assert result == {"Obscure Act": {}}
    client.get.assert_not_called()


async def test_get_artist_links_distinguishes_hosts_sharing_a_musicbrainz_type():
    """The actual bug this exists to avoid — confirmed live against
    Radiohead's real MusicBrainz entry: "free streaming" covers both
    Spotify and Deezer, "streaming" covers Apple Music and TIDAL together.
    Only the URL host tells them apart."""
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):

            def fake_get(url, params=None):
                if params and "inc" in params:
                    return _mb_url_rels_response(
                        url,
                        [
                            _url_rel("free streaming", "https://open.spotify.com/artist/spot1"),
                            _url_rel("free streaming", "https://www.deezer.com/artist/123"),
                            _url_rel("streaming", "https://music.apple.com/gb/artist/657515"),
                            _url_rel("streaming", "https://tidal.com/artist/64518"),
                            _url_rel("youtube", "https://www.youtube.com/channel/abc"),
                            _url_rel("discogs", "https://www.discogs.com/artist/3840"),
                            _url_rel("official homepage", "http://www.radiohead.com/"),
                        ],
                    )
                return _mb_response(url, "mbid-1")

            client.get = AsyncMock(side_effect=fake_get)
            result = await recommendations.get_artist_links(["Radiohead"])

    assert result == {
        "Radiohead": {
            "musicbrainz": "https://musicbrainz.org/artist/mbid-1",
            "spotify": "https://open.spotify.com/artist/spot1",
            "apple_music": "https://music.apple.com/gb/artist/657515",
            "tidal": "https://tidal.com/artist/64518",
            "youtube": "https://www.youtube.com/channel/abc",
            "discogs": "https://www.discogs.com/artist/3840",
        }
    }


async def test_get_artist_links_skips_a_relation_with_no_url_resource():
    """MusicBrainz relations aren't all URL relations with a resolvable
    resource — e.g. a "member of band" relation to another artist entity
    entirely. Must be skipped, not raise trying to read a nonexistent URL."""
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):

            def fake_get(url, params=None):
                if params and "inc" in params:
                    return _mb_url_rels_response(
                        url,
                        [
                            {"type": "member of band"},  # no "url" key at all
                            _url_rel("youtube", "https://www.youtube.com/channel/abc"),
                        ],
                    )
                return _mb_response(url, "mbid-1")

            client.get = AsyncMock(side_effect=fake_get)
            result = await recommendations.get_artist_links(["Radiohead"])

    assert result["Radiohead"]["youtube"] == "https://www.youtube.com/channel/abc"


async def test_get_artist_links_caches_result_by_mbid():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):

            def fake_get(url, params=None):
                if params and "inc" in params:
                    return _mb_url_rels_response(
                        url, [_url_rel("youtube", "https://www.youtube.com/channel/abc")]
                    )
                return _mb_response(url, "mbid-1")

            client.get = AsyncMock(side_effect=fake_get)
            await recommendations.get_artist_links(["Radiohead"])

        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
        assert cache["links_by_mbid"]["mbid-1"] == {
            "musicbrainz": "https://musicbrainz.org/artist/mbid-1",
            "youtube": "https://www.youtube.com/channel/abc",
        }


async def test_get_artist_links_no_matching_hosts_returns_just_musicbrainz():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):

            def fake_get(url, params=None):
                if params and "inc" in params:
                    return _mb_url_rels_response(
                        url, [_url_rel("official homepage", "http://www.radiohead.com/")]
                    )
                return _mb_response(url, "mbid-1")

            client.get = AsyncMock(side_effect=fake_get)
            result = await recommendations.get_artist_links(["Radiohead"])

    assert result == {"Radiohead": {"musicbrainz": "https://musicbrainz.org/artist/mbid-1"}}


async def test_get_artist_links_keeps_musicbrainz_link_when_url_rels_call_fails():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):

            def fake_get(url, params=None):
                if params and "inc" in params:
                    raise httpx.ConnectError("unreachable", request=httpx.Request("GET", url))
                return _mb_response(url, "mbid-1")

            client.get = AsyncMock(side_effect=fake_get)
            result = await recommendations.get_artist_links(["Radiohead"])

    assert result == {"Radiohead": {"musicbrainz": "https://musicbrainz.org/artist/mbid-1"}}


async def test_get_artist_links_does_not_cache_transient_url_rels_failure():
    """The actual bug — confirmed live: a burst of MusicBrainz 503s got
    cached as this mbid's *permanent* answer (just the musicbrainz
    self-link, Spotify/Apple Music/TIDAL/YouTube/Discogs silently missing
    forever after, long after MusicBrainz itself had recovered). A failed
    url-rels call must leave nothing in links_by_mbid, so the next lookup
    for the same mbid gets a real retry."""
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):

            def fail(url, params=None):
                raise httpx.ConnectError("unreachable", request=httpx.Request("GET", url))

            client.get = AsyncMock(side_effect=fail)
            result = await recommendations.get_artist_links_by_mbid(["mbid-1"])
            assert result == {"mbid-1": {"musicbrainz": "https://musicbrainz.org/artist/mbid-1"}}
            # _load_cache(), not raw open() — nothing was ever written on a
            # failed call, so the cache file may not even exist yet, which
            # _load_cache() already treats the same as "empty".
            assert "mbid-1" not in recommendations._load_cache().get("links_by_mbid", {})

            # Recovers on the very next call — not cached, so no stale,
            # incomplete answer to override.
            client.get = AsyncMock(
                side_effect=lambda url, params=None: _mb_url_rels_response(
                    url, [_url_rel("youtube", "https://www.youtube.com/channel/abc")]
                )
            )
            result = await recommendations.get_artist_links_by_mbid(["mbid-1"])
            assert result == {
                "mbid-1": {
                    "musicbrainz": "https://musicbrainz.org/artist/mbid-1",
                    "youtube": "https://www.youtube.com/channel/abc",
                }
            }


# ── get_artist_links_by_mbid ─────────────────────────────────────────────


async def test_get_artist_links_by_mbid_skips_resolve_mbid_entirely():
    """The whole point — a caller with a trusted MBID already on hand
    (HomeView.vue's shelf, from ListenBrainz Labs) shouldn't pay for a
    redundant name-search round trip resolve_mbid() would otherwise need."""
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
            patch.object(recommendations, "resolve_mbid") as resolve_mbid,
        ):
            client.get = AsyncMock(
                side_effect=lambda url, params=None: _mb_url_rels_response(
                    url, [_url_rel("youtube", "https://www.youtube.com/channel/abc")]
                )
            )
            result = await recommendations.get_artist_links_by_mbid(["mbid-1"])

    resolve_mbid.assert_not_called()
    assert result == {
        "mbid-1": {
            "musicbrainz": "https://musicbrainz.org/artist/mbid-1",
            "youtube": "https://www.youtube.com/channel/abc",
        }
    }


async def test_get_artist_links_by_mbid_cache_hit_skips_network():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {"links_by_mbid": {"mbid-1": {"spotify": "https://open.spotify.com/artist/x"}}},
                f,
            )
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            result = await recommendations.get_artist_links_by_mbid(["mbid-1"])

    assert result == {"mbid-1": {"spotify": "https://open.spotify.com/artist/x"}}
    client.get.assert_not_called()


async def test_get_artist_links_by_mbid_multiple_mbids():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):

            def fake_get(url, params=None):
                mbid = url.rsplit("/", 1)[-1]
                return _mb_url_rels_response(
                    url, [_url_rel("youtube", f"https://www.youtube.com/channel/{mbid}")]
                )

            client.get = AsyncMock(side_effect=fake_get)
            result = await recommendations.get_artist_links_by_mbid(["mbid-1", "mbid-2"])

    assert result == {
        "mbid-1": {
            "musicbrainz": "https://musicbrainz.org/artist/mbid-1",
            "youtube": "https://www.youtube.com/channel/mbid-1",
        },
        "mbid-2": {
            "musicbrainz": "https://musicbrainz.org/artist/mbid-2",
            "youtube": "https://www.youtube.com/channel/mbid-2",
        },
    }


# ── GET /recommendations/similar-artists, /artist-images, /artist-links ──


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


def test_artist_links_endpoint(client):
    fake = AsyncMock(return_value={"Radiohead": {"spotify": "https://open.spotify.com/artist/x"}})
    with patch("routes.recommendations.get_artist_links", fake):
        r = client.get("/recommendations/artist-links?name=Radiohead")

    assert r.status_code == 200
    assert r.json() == {"links": {"Radiohead": {"spotify": "https://open.spotify.com/artist/x"}}}
    fake.assert_awaited_once_with(["Radiohead"])


def test_artist_links_by_mbid_endpoint(client):
    fake = AsyncMock(return_value={"mbid-1": {"spotify": "https://open.spotify.com/artist/x"}})
    with patch("routes.recommendations.get_artist_links_by_mbid", fake):
        r = client.get("/recommendations/artist-links-by-mbid?mbid=mbid-1")

    assert r.status_code == 200
    assert r.json() == {"links": {"mbid-1": {"spotify": "https://open.spotify.com/artist/x"}}}
    fake.assert_awaited_once_with(["mbid-1"])


# ── rank_similar ──────────────────────────────────────────────────────────
# ListenBrainz's raw score counts listening sessions, so it is only
# meaningful within one seed's own results. Measured live 2026-08-27:
# Queen's *worst* similar artist scored 736, Toto's *best* scored 348.


def test_rank_similar_gives_every_seed_the_same_say():
    """Ranked on raw scores, a popular seed's entire list outranks every
    result from a less-listened one — the top ten for Queen and Toto
    together were ten Queen results and no Toto ones."""
    queen = [{"name": f"Q{i}", "mbid": f"q{i}", "score": 2342 - i * 20} for i in range(10)]
    toto = [{"name": f"T{i}", "mbid": f"t{i}", "score": 348 - i * 5} for i in range(10)]

    ranked = rank_similar([queen, toto], set(), 10)

    names = [a["name"] for a in ranked]
    # Both seeds are properly represented — the exact split follows from
    # how steeply each one's scores fall off, which is the point: what
    # matters is that neither list is shut out.
    assert sum(1 for n in names if n.startswith("Q")) >= 3
    assert sum(1 for n in names if n.startswith("T")) >= 3
    # Each seed's best comes out level at the top, whatever its raw count.
    assert {ranked[0]["name"], ranked[1]["name"]} == {"Q0", "T0"}


def test_rank_similar_puts_an_artist_matching_several_seeds_first():
    # Turning up next to two of somebody's artists is a better reason to
    # recommend them than being a near-perfect match for one.
    seed_a = [
        {"name": "Both", "mbid": "b", "score": 800},
        {"name": "Only A", "mbid": "a", "score": 900},
    ]
    seed_b = [
        {"name": "Both", "mbid": "b", "score": 80},
        {"name": "Only B", "mbid": "c", "score": 90},
    ]

    ranked = rank_similar([seed_a, seed_b], set(), 10)

    assert ranked[0]["name"] == "Both"
    # Its score is the sum of two normalized ones, so it can exceed the 1.0
    # ceiling any single-seed match has.
    assert ranked[0]["score"] > 1


def test_rank_similar_counts_a_repeated_name_once_per_seed():
    """ListenBrainz returns the same act several times when MusicBrainz
    holds more than one entry for it — 34 of Toto's 134 results. Counting
    those separately would let a duplicate outrank a genuine two-seed
    match."""
    seed = [
        {"name": "The Beatles", "mbid": "x", "score": 348},
        {"name": "The Beatles", "mbid": "y", "score": 348},
        {"name": "Someone", "mbid": "z", "score": 300},
    ]

    ranked = rank_similar([seed], set(), 10)

    assert [a["name"] for a in ranked] == ["The Beatles", "Someone"]
    assert ranked[0]["score"] == 1.0


def test_rank_similar_leaves_out_the_seeds_themselves():
    seed = [
        {"name": "Queen", "mbid": "q", "score": 900},
        {"name": "Other", "mbid": "o", "score": 100},
    ]

    ranked = rank_similar([seed], {"queen"}, 10)

    assert [a["name"] for a in ranked] == ["Other"]


def test_rank_similar_survives_a_seed_with_nothing_to_offer():
    # An empty list, and one whose scores are all zero — the normalisation
    # divides by the best score, which must not be a division by zero.
    ranked = rank_similar([[], [{"name": "Flat", "mbid": "f", "score": 0}]], set(), 10)

    assert [a["name"] for a in ranked] == ["Flat"]


def test_rank_similar_honours_the_limit():
    seed = [{"name": f"A{i}", "mbid": str(i), "score": 100 - i} for i in range(30)]

    assert len(rank_similar([seed], set(), 5)) == 5
