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
def _disable_rate_limiter():
    # A name search followed by a url-rels lookup would otherwise sleep a
    # real 1.1s inside a single test. Nothing here tests the limit itself.
    with patch.object(recommendations, "_MB_MIN_INTERVAL", 0.0):
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


# ── first_artist ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("credit", "expected"),
    [
        ("Cardi B & Bruno Mars", "Cardi B"),
        ("Post Malone feat. Morgan Wallen", "Post Malone"),
        ("David Guetta ft. Bebe Rexha", "David Guetta"),
        ("Earth, Wind & Fire", "Earth"),
        # A band whose own name contains a separator splits too - callers try
        # the whole name first (see fanart.get_artist_art).
        ("AC/DC", "AC"),
        # One name, nothing to fall back to.
        ("Cher", None),
        ("", None),
    ],
)
def test_first_artist(credit, expected):
    assert recommendations.first_artist(credit) == expected


# ── resolve_mbid ──────────────────────────────────────────────────────────


async def test_resolve_mbid_cache_hit_skips_network():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"mbid_by_name_v2": {"radiohead": "abc-123"}}, f)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            result = await recommendations.resolve_mbid("Radiohead")
    assert result == "abc-123"
    client.get.assert_not_called()


async def test_resolve_mbid_ignores_a_cached_negative_and_retries():
    """Only a positive MBID is a cache hit. A `null` left behind by an older
    build — a MusicBrainz hiccup once wrote one for real artists like "Dua
    Lipa" — is re-resolved rather than trusted."""
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"mbid_by_name_v2": {"dua lipa": None}}, f)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=lambda url, params=None: _mb_response(url, "real-mbid")
            )
            result = await recommendations.resolve_mbid("Dua Lipa")

    assert result == "real-mbid"


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
        assert cache["mbid_by_name_v2"]["boards of canada"] == "new-mbid-1"


async def test_resolve_mbid_prefers_an_exact_name_over_the_top_hit():
    """MusicBrainz's Lucene query matches the name as a word anywhere in an
    artist's name, so "Bush"'s top hit is "Kate Bush" (score 100) with the
    band actually called "Bush" second (95) — taking the top hit handed out
    the wrong artist's Fanart.tv image."""
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                return_value=httpx.Response(
                    200,
                    json={
                        "artists": [
                            {"id": "kate-bush", "name": "Kate Bush", "score": 100},
                            {"id": "bush-band", "name": "Bush", "score": 95},
                        ]
                    },
                    request=httpx.Request("GET", recommendations._MB_SEARCH_URL),
                )
            )
            result = await recommendations.resolve_mbid("Bush")

    assert result == "bush-band"


async def test_resolve_mbid_does_not_cache_a_negative():
    """A response with no artists is indistinguishable from a MusicBrainz
    hiccup, so it is not remembered at all — the next lookup retries."""
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(side_effect=lambda url, params=None: _mb_response(url, None))
            result = await recommendations.resolve_mbid("Definitely Not A Real Artist")

        assert result is None
        assert "definitely not a real artist" not in recommendations._load_cache().get(
            "mbid_by_name_v2", {}
        )


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
            assert "radiohead" not in recommendations._load_cache().get("mbid_by_name_v2", {})

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
                    "mbid_by_name_v2": {"radiohead": "rh-mbid"},
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
                    "mbid_by_name_v2": {"radiohead": "rh-mbid"},
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
                    "mbid_by_name_v2": {"radiohead": "rh-mbid"},
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
                    "mbid_by_name_v2": {"a": "a-mbid", "b": "b-mbid"},
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
                    "mbid_by_name_v2": {"seed": "s-mbid"},
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

    # image_large is filled in on the way out for an entry stored before
    # the field existed — see _with_large_image().
    assert result == {"Portishead": {"image": "img", "image_large": "img", "link": "link"}}
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
                            "picture_xl": "https://img/1-xl",
                            "link": "https://deezer/1",
                        }
                    ],
                )
            )
            result = await recommendations.get_artist_images(["Portishead"])

        assert result == {
            "Portishead": {
                "image": "https://img/1",
                "image_large": "https://img/1-xl",
                "link": "https://deezer/1",
            }
        }
        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
        assert cache["deezer_by_name"]["portishead"] == {
            "image": "https://img/1",
            "image_large": "https://img/1-xl",
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
                            "picture_xl": "https://img/real-xl",
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

    assert result["Radiohead"] == {
        "image": "https://img/real",
        "image_large": "https://img/real-xl",
        "link": "https://deezer/real",
    }


def test_a_large_image_is_derived_for_an_entry_stored_before_the_field_existed():
    """The Deezer cache has no expiry at all, so an artist looked up before
    there was a second size would stay soft in the artwork viewer forever.
    The size sits in the CDN path, so the large variant of a URL this
    module produced itself is a substitution, not another lookup."""
    stored = {
        "image": "https://cdn-images.dzcdn.net/images/artist/abc/250x250-000000-80-0-0.jpg",
        "link": "https://deezer/x",
    }

    assert recommendations._with_large_image(stored)["image_large"] == (
        "https://cdn-images.dzcdn.net/images/artist/abc/1000x1000-000000-80-0-0.jpg"
    )


def test_a_stored_large_image_is_left_alone():
    stored = {"image": "https://img/m", "image_large": "https://img/xl", "link": "l"}

    assert recommendations._with_large_image(stored)["image_large"] == "https://img/xl"


def test_an_unrecognised_image_url_falls_back_to_itself():
    """A slightly soft picture beats none — and beats guessing at a URL
    shape this module did not produce."""
    stored = {"image": "https://elsewhere/photo.jpg", "link": "l"}

    assert recommendations._with_large_image(stored)["image_large"] == "https://elsewhere/photo.jpg"
    assert recommendations._with_large_image({"image": None, "link": "l"})["image_large"] is None
    assert recommendations._with_large_image(None) is None


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
                            "picture_xl": f"img-{name}-xl",
                            "link": f"link-{name}",
                        }
                    ],
                )

            client.get = AsyncMock(side_effect=fake_get)
            result = await recommendations.get_artist_images(["A", "B"])

    assert result == {
        "A": {"image": "img-A", "image_large": "img-A-xl", "link": "link-A"},
        "B": {"image": "img-B", "image_large": "img-B-xl", "link": "link-B"},
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
                    "mbid_by_name_v2": {"radiohead": "mbid-1"},
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
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(side_effect=lambda url, params=None: _mb_response(url, None))
            result = await recommendations.get_artist_links(["Obscure Act"])

    assert result == {"Obscure Act": {}}
    # Only the name search; no url-rels lookup follows a name with no MBID.
    assert client.get.await_count == 1


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


# ── get_artist_bio ────────────────────────────────────────────────────────


def _json_response(url: str, payload: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=payload, request=httpx.Request("GET", url))


def _summary(title: str, lang: str, text: str, page_type: str = "standard") -> dict:
    return {
        "type": page_type,
        "extract": text,
        "content_urls": {"desktop": {"page": f"https://{lang}.wikipedia.org/wiki/{title}"}},
    }


def _fake_web(relations: list[dict], sitelinks: dict[str, str], summaries: dict[str, dict]):
    """One stand-in for all three hosts: MusicBrainz (name search and
    url-rels), Wikidata's sitelinks and Wikipedia's summary endpoint, the
    latter keyed by the URL's own "<lang>.wikipedia.org/.../<title>" tail."""

    def fake_get(url, params=None):
        if "musicbrainz.org" in url:
            if params and "inc" in params:
                return _mb_url_rels_response(url, relations)
            return _mb_response(url, "mbid-1")
        if "wikidata.org" in url:
            wanted = params["sitefilter"].split("|")
            links = {s: {"title": t} for s, t in sitelinks.items() if s in wanted}
            return _json_response(url, {"entities": {params["ids"]: {"sitelinks": links}}})
        for key, payload in summaries.items():
            lang, title = key.split(":", 1)
            if url.startswith(f"https://{lang}.wikipedia.org/") and url.endswith(f"/{title}"):
                return _json_response(url, payload)
        return _json_response(url, {}, status=404)

    return fake_get


_WIKIDATA_REL = _url_rel("wikidata", "https://www.wikidata.org/wiki/Q44190")


async def test_get_artist_bio_reads_the_article_in_the_requested_language():
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=_fake_web(
                    [_WIKIDATA_REL],
                    {"dewiki": "Radiohead", "enwiki": "Radiohead"},
                    {
                        "de:Radiohead": _summary("Radiohead", "de", "Eine britische Band."),
                        "en:Radiohead": _summary("Radiohead", "en", "An English band."),
                    },
                )
            )
            bio = await recommendations.get_artist_bio("Radiohead", "de")

    assert bio == {
        "text": "Eine britische Band.",
        "url": "https://de.wikipedia.org/wiki/Radiohead",
        "lang": "de",
    }


async def test_get_artist_bio_falls_back_to_english_without_an_article_in_the_language():
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=_fake_web(
                    [_WIKIDATA_REL],
                    {"enwiki": "Small Band"},
                    {"en:Small_Band": _summary("Small_Band", "en", "A small band.")},
                )
            )
            bio = await recommendations.get_artist_bio("Small Band", "it")

    assert bio["lang"] == "en"
    assert bio["text"] == "A small band."


async def test_get_artist_bio_encodes_a_slash_in_the_title():
    """AC/DC: an unencoded slash would ask Wikipedia for a sub-path instead
    of the article."""
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=_fake_web(
                    [_WIKIDATA_REL],
                    {"enwiki": "AC/DC"},
                    {"en:AC%2FDC": _summary("AC%2FDC", "en", "An Australian band.")},
                )
            )
            bio = await recommendations.get_artist_bio("AC/DC", "en")

    assert bio["text"] == "An Australian band."


async def test_get_artist_bio_uses_a_direct_wikipedia_link_when_there_is_no_wikidata_item():
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=_fake_web(
                    [_url_rel("wikipedia", "https://fr.wikipedia.org/wiki/Air_(groupe)")],
                    {},
                    {"fr:Air_%28groupe%29": _summary("Air_(groupe)", "fr", "Un duo.")},
                )
            )
            bio = await recommendations.get_artist_bio("Air", "de")

    assert bio == {
        "text": "Un duo.",
        "url": "https://fr.wikipedia.org/wiki/Air_(groupe)",
        "lang": "fr",
    }


async def test_get_artist_bio_ignores_a_language_that_is_not_a_language_code():
    """The language becomes part of a hostname - anything but a plain code
    must not reach it."""
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=_fake_web(
                    [_WIKIDATA_REL],
                    {"enwiki": "Radiohead"},
                    {"en:Radiohead": _summary("Radiohead", "en", "An English band.")},
                )
            )
            bio = await recommendations.get_artist_bio("Radiohead", "evil.example.com/x")

    assert bio["lang"] == "en"
    requested = [str(c.args) + str(c.kwargs) for c in client.get.call_args_list]
    assert not any("evil" in call for call in requested)


async def test_get_artist_bio_skips_a_disambiguation_page():
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=_fake_web(
                    [_WIKIDATA_REL],
                    {"enwiki": "Mercury"},
                    {
                        "en:Mercury": _summary(
                            "Mercury", "en", "Mercury may refer to:", "disambiguation"
                        )
                    },
                )
            )
            bio = await recommendations.get_artist_bio("Mercury", "en")

    assert bio is None


async def test_get_artist_bio_is_none_without_an_mbid_and_asks_nobody():
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(side_effect=lambda url, params=None: _mb_response(url, None))
            bio = await recommendations.get_artist_bio("Obscure Act", "en")

    assert bio is None
    # Only the name search; no Wikidata/Wikipedia lookup follows.
    assert client.get.await_count == 1


async def test_get_artist_bio_serves_a_fresh_cache_entry_without_the_network():
    cached = {"text": "Cached.", "url": "https://en.wikipedia.org/wiki/X", "lang": "en"}
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "mbid_by_name_v2": {"x": "mbid-1"},
                    "bio_by_mbid": {"mbid-1": {"en": {"fetched_at": time.time(), "bio": cached}}},
                },
                f,
            )
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            bio = await recommendations.get_artist_bio("X", "en")

    assert bio == cached
    client.get.assert_not_called()


async def test_get_artist_bio_rereads_a_stale_cache_entry():
    stale = time.time() - recommendations._BIO_TTL_SECONDS - 1
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "mbid_by_name_v2": {"radiohead": "mbid-1"},
                    "wiki_by_mbid": {"mbid-1": {"wikidata": "Q44190", "wikipedia": None}},
                    "bio_by_mbid": {"mbid-1": {"en": {"fetched_at": stale, "bio": None}}},
                },
                f,
            )
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=_fake_web(
                    [],
                    {"enwiki": "Radiohead"},
                    {"en:Radiohead": _summary("Radiohead", "en", "An English band.")},
                )
            )
            bio = await recommendations.get_artist_bio("Radiohead", "en")

    assert bio["text"] == "An English band."
    # The Wikidata item was already known - no MusicBrainz call to find it.
    assert not any("musicbrainz" in c.args[0] for c in client.get.call_args_list)


async def test_get_artist_bio_does_not_cache_a_failed_wikipedia_call():
    """Same rule as resolve_mbid(): an outage must not be remembered as
    "this artist has no article"."""
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            working = _fake_web(
                [_WIKIDATA_REL],
                {"enwiki": "Radiohead"},
                {"en:Radiohead": _summary("Radiohead", "en", "An English band.")},
            )

            def wikipedia_down(url, params=None):
                if "wikipedia.org" in url:
                    return _json_response(url, {}, status=503)
                return working(url, params)

            client.get = AsyncMock(side_effect=wikipedia_down)
            assert await recommendations.get_artist_bio("Radiohead", "en") is None
            assert "bio_by_mbid" not in recommendations._load_cache()

            client.get = AsyncMock(side_effect=working)
            bio = await recommendations.get_artist_bio("Radiohead", "en")

    assert bio["text"] == "An English band."


async def test_links_and_wikipedia_reference_share_one_musicbrainz_lookup():
    """Both come out of the same url-rels response; the second of the two
    must not cost another rate-limited MusicBrainz call."""
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=_fake_web(
                    [_WIKIDATA_REL, _url_rel("youtube", "https://www.youtube.com/channel/abc")],
                    {"enwiki": "Radiohead"},
                    {"en:Radiohead": _summary("Radiohead", "en", "An English band.")},
                )
            )
            links = await recommendations.get_artist_links(["Radiohead"])
            bio = await recommendations.get_artist_bio("Radiohead", "en")

    assert links["Radiohead"]["youtube"] == "https://www.youtube.com/channel/abc"
    assert bio["text"] == "An English band."
    url_rels_calls = [
        c for c in client.get.call_args_list if (c.kwargs.get("params") or {}).get("inc")
    ]
    assert len(url_rels_calls) == 1


async def test_get_artist_bio_looks_up_the_wikidata_item_for_links_cached_before_it_existed():
    """Artists whose links were cached before bios existed have no Wikipedia
    reference stored - they get one url-rels lookup, not "no article"."""
    with tempfile.TemporaryDirectory() as d:
        path = _tmp_path(d)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "mbid_by_name_v2": {"radiohead": "mbid-1"},
                    "links_by_mbid": {"mbid-1": {"musicbrainz": "https://musicbrainz.org/x"}},
                },
                f,
            )
        with (
            patch.object(recommendations, "_PATH", path),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                side_effect=_fake_web(
                    [_WIKIDATA_REL],
                    {"enwiki": "Radiohead"},
                    {"en:Radiohead": _summary("Radiohead", "en", "An English band.")},
                )
            )
            bio = await recommendations.get_artist_bio("Radiohead", "en")

    assert bio["text"] == "An English band."


# ── get_album_bio ─────────────────────────────────────────────────────────


def _fake_album_web(
    *,
    releases: dict[str, str] | None = None,
    groups: dict[str, list[dict]] | None = None,
    search: list[dict] | None = None,
    summaries: dict[str, dict] | None = None,
):
    """MusicBrainz as the album lookups use it - a release walked up to its
    group, a group's url-rels, a release-group search - plus Wikidata and
    Wikipedia. `releases` maps a release id to its group, `groups` a group
    id to its url-rels; anything else is MusicBrainz's 404."""
    releases = releases or {}
    groups = groups or {}
    calls: list[str] = []

    def fake_get(url, params=None):
        calls.append(url)
        if "musicbrainz.org" in url:
            path = url.split("/ws/2/", 1)[1]
            if path == "release-group/":
                return _json_response(url, {"release-groups": search or []})
            kind, _, entity = path.partition("/")
            if kind == "release" and entity in releases:
                return _json_response(url, {"release-group": {"id": releases[entity]}})
            if kind == "release-group" and entity in groups:
                return _json_response(url, {"id": entity, "relations": groups[entity]})
            return _json_response(url, {"error": "Not Found"}, status=404)
        if "wikidata.org" in url:
            links = {"enwiki": {"title": "Album"}, "dewiki": {"title": "Album"}}
            return _json_response(url, {"entities": {params["ids"]: {"sitelinks": links}}})
        for key, payload in (summaries or {}).items():
            lang, title = key.split(":", 1)
            if url.startswith(f"https://{lang}.wikipedia.org/") and url.endswith(f"/{title}"):
                return _json_response(url, payload)
        return _json_response(url, {}, status=404)

    fake_get.calls = calls
    return fake_get


_ALBUM_SUMMARIES = {"de:Album": _summary("Album", "de", "Ein Studioalbum.")}


async def _album_bio(fake, *args, **kwargs):
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(side_effect=fake)
            return await recommendations.get_album_bio(*args, **kwargs)


async def test_get_album_bio_walks_a_release_up_to_its_group():
    """Navidrome and Jellyfin send the release (one edition); Wikipedia is
    linked from the release group every edition belongs to."""
    fake = _fake_album_web(
        releases={"rel-1": "rg-1"}, groups={"rg-1": [_WIKIDATA_REL]}, summaries=_ALBUM_SUMMARIES
    )
    bio = await _album_bio(fake, "rel-1", "Artist", "Album", "de")

    assert bio["text"] == "Ein Studioalbum."
    assert any("release-group/rg-1" in url for url in fake.calls)


async def test_get_album_bio_takes_an_id_that_is_already_a_group():
    """Plex may send the release group itself, which is no release."""
    fake = _fake_album_web(groups={"rg-1": [_WIKIDATA_REL]}, summaries=_ALBUM_SUMMARIES)

    bio = await _album_bio(fake, "rg-1", "Artist", "Album", "de")

    assert bio["text"] == "Ein Studioalbum."


async def test_get_album_bio_prefers_the_album_over_its_title_track():
    """ "Born This Way" is an album and a single; without an id, the album's
    article is the one wanted unless the server says otherwise."""
    search = [
        {"id": "rg-single", "title": "Born This Way", "primary-type": "Single"},
        {"id": "rg-album", "title": "Born This Way", "primary-type": "Album"},
    ]
    groups = {"rg-album": [_WIKIDATA_REL], "rg-single": []}

    fake = _fake_album_web(search=search, groups=groups, summaries=_ALBUM_SUMMARIES)
    assert (await _album_bio(fake, None, "Lady Gaga", "Born This Way", "de"))["text"]
    assert any("release-group/rg-album" in url for url in fake.calls)

    fake = _fake_album_web(search=search, groups=groups, summaries=_ALBUM_SUMMARIES)
    await _album_bio(fake, None, "Lady Gaga", "Born This Way", "de", "single")
    assert any("release-group/rg-single" in url for url in fake.calls)


async def test_get_album_bio_shows_nothing_without_an_exact_title_match():
    """Another album's article is worse than none."""
    search = [{"id": "rg-other", "title": "Born This Way: The Remix", "primary-type": "Album"}]
    fake = _fake_album_web(search=search, groups={"rg-other": [_WIKIDATA_REL]})

    assert await _album_bio(fake, None, "Lady Gaga", "Born This Way", "de") is None
    assert not any("wikipedia.org" in url for url in fake.calls)


async def test_get_album_bio_is_none_when_musicbrainz_links_no_article():
    fake = _fake_album_web(releases={"rel-1": "rg-1"}, groups={"rg-1": []})

    assert await _album_bio(fake, "rel-1", "Artist", "Album", "de") is None


async def test_get_album_bio_does_not_remember_a_failed_musicbrainz_call():
    """A 503 is MusicBrainz being busy, not the album lacking a group."""
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(
                return_value=_json_response("https://musicbrainz.org/ws/2/release/x", {}, 503)
            )
            assert await recommendations.get_album_bio("rel-1", "A", "Album", "de") is None

            client.get = AsyncMock(
                side_effect=_fake_album_web(
                    releases={"rel-1": "rg-1"},
                    groups={"rg-1": [_WIKIDATA_REL]},
                    summaries=_ALBUM_SUMMARIES,
                )
            )
            bio = await recommendations.get_album_bio("rel-1", "A", "Album", "de")

    assert bio["text"] == "Ein Studioalbum."


async def test_get_album_bio_serves_a_second_visit_from_the_cache():
    fake = _fake_album_web(
        releases={"rel-1": "rg-1"}, groups={"rg-1": [_WIKIDATA_REL]}, summaries=_ALBUM_SUMMARIES
    )
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(side_effect=fake)
            await recommendations.get_album_bio("rel-1", "A", "Album", "de")
            calls = len(fake.calls)
            bio = await recommendations.get_album_bio("rel-1", "A", "Album", "de")

    assert bio["text"] == "Ein Studioalbum."
    assert len(fake.calls) == calls


def test_phrase_escapes_what_would_end_a_search_phrase():
    assert recommendations._phrase('Say "Hi" \\ now') == '"Say \\"Hi\\" \\\\ now"'


def test_cached_mbids_reads_only_resolved_names_and_asks_nobody():
    with tempfile.TemporaryDirectory() as d:
        with (
            patch.object(recommendations, "_PATH", _tmp_path(d)),
            patch.object(recommendations, "_client") as client,
        ):
            client.get = AsyncMock(side_effect=AssertionError("asked"))
            recommendations._save_cache(
                {"mbid_by_name_v2": {"radiohead": "mbid-r", "legacy": None}}
            )

            found = recommendations.cached_mbids([" Radiohead ", "legacy", "unknown"])

            assert found == {" Radiohead ": "mbid-r"}


def test_cached_mbids_reads_the_cache_once_for_any_number_of_names():
    """A genre's header asks about hundreds of artists; one file read per
    name held connect's event loop for seconds."""
    with patch.object(recommendations, "_load_cache", return_value={}) as load:
        recommendations.cached_mbids([f"artist {i}" for i in range(300)])

    assert load.call_count == 1
