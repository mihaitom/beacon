"""Tests for core/deezer.py and routes/deezer.py — parsing Deezer's track
and genre objects, picking the right artist, its in-body errors, and the
route's mapping of failures onto status codes."""

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from core import deezer


def _response(payload: object, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=payload, request=httpx.Request("GET", deezer._BASE_URL))


def _patch_get(*payloads: object):
    return patch.object(
        deezer._client, "get", AsyncMock(side_effect=[_response(p) for p in payloads])
    )


def _track(title: str, artist: str, **extra) -> dict:
    return {"title": title, "artist": {"name": artist}, **extra}


# ── parsing ──────────────────────────────────────────────────────────────────


async def test_chart_tracks_use_the_short_title_and_carry_display_fields():
    entry = _track(
        "Get Lucky (Radio Edit)",
        "Daft Punk",
        title_short="Get Lucky",
        duration=248,
        album={"title": "Random Access Memories", "cover_medium": "https://img/250.jpg"},
    )
    with _patch_get({"data": [entry]}):
        tracks = await deezer.get_chart(0, 10)

    assert tracks == [
        {
            "title": "Get Lucky",
            "artist": "Daft Punk",
            "mbid": "",
            "album": "Random Access Memories",
            "coverArtUrl": "https://img/250.jpg",
            "duration": 248,
        }
    ]


async def test_chart_drops_entries_without_a_title_or_artist():
    data = {
        "data": [
            _track("Teardrop", "Massive Attack"),
            _track("", "Massive Attack"),
            _track("Angel", "  "),
            {"title": "Risingson"},
            "not a dict",
        ]
    }
    with _patch_get(data):
        tracks = await deezer.get_chart(0, 10)
    assert [t["title"] for t in tracks] == ["Teardrop"]


async def test_chart_asks_for_the_genre_and_caps_the_limit():
    with _patch_get({"data": []}) as get:
        await deezer.get_chart(116, 5000)
    url = get.call_args.args[0]
    assert url.endswith("/chart/116/tracks")
    assert get.call_args.kwargs["params"] == {"limit": deezer._MAX_LIMIT}


async def test_genres_leave_out_audiobooks_and_pass_the_language():
    data = {
        "data": [
            {"id": 0, "name": "All"},
            {"id": 132, "name": "Pop"},
            {"id": 457, "name": "Audiobooks"},
            {"id": "x", "name": "Broken"},
        ]
    }
    with _patch_get(data) as get:
        genres = await deezer.get_genres("de")
    assert genres == [{"id": 0, "name": "All"}, {"id": 132, "name": "Pop"}]
    assert get.call_args.kwargs["headers"] == {"Accept-Language": "de"}


# ── artist ───────────────────────────────────────────────────────────────────


async def test_artist_prefers_the_exact_name_with_the_most_fans():
    # Deezer's own order put an obscure namesake first (see _find_artist).
    search = {
        "data": [
            {"id": 1, "name": "Radiohead Tribute", "nb_fan": 9_000_000},
            {"id": 2, "name": "Radiohead", "nb_fan": 484},
            {"id": 3, "name": "radiohead", "nb_fan": 4_000_000},
        ]
    }
    with _patch_get(search, {"data": [_track("Creep", "Radiohead")]}) as get:
        tracks = await deezer.get_artist_top("Radiohead", 10)
    assert get.call_args_list[1].args[0].endswith("/artist/3/top")
    assert [t["title"] for t in tracks] == ["Creep"]


async def test_artist_falls_back_to_the_top_hit_without_an_exact_match():
    search = {"data": [{"id": 7, "name": "Beyoncé"}, {"id": 8, "name": "Beyonce Tribute"}]}
    with _patch_get(search, {"data": []}) as get:
        await deezer.get_artist_top("beyonce", 10)
    assert get.call_args_list[1].args[0].endswith("/artist/7/top")


async def test_unknown_artist_is_a_not_found_error():
    with _patch_get({"data": [], "total": 0}), pytest.raises(deezer.DeezerError) as e:
        await deezer.get_artist_top("nobody at all", 10)
    assert e.value.not_found


# ── errors ───────────────────────────────────────────────────────────────────


async def test_an_error_object_in_a_200_is_a_failure():
    quota = {"error": {"type": "Exception", "message": "Quota limit exceeded", "code": 4}}
    with _patch_get(quota), pytest.raises(deezer.DeezerError) as e:
        await deezer.get_chart(0, 10)
    assert not e.value.not_found
    assert "Quota" in str(e.value)


async def test_a_network_failure_is_a_deezer_error():
    down = AsyncMock(side_effect=httpx.ConnectError("down"))
    with patch.object(deezer._client, "get", down), pytest.raises(deezer.DeezerError) as e:
        await deezer.get_chart(0, 10)
    assert not e.value.not_found


# ── route ────────────────────────────────────────────────────────────────────


def test_songs_route_returns_the_chart(client):
    with _patch_get({"data": [_track("Believe", "Cher")]}):
        resp = client.get("/deezer/songs", params={"op": "charts", "genre": 132, "limit": 5})
    assert resp.status_code == 200
    assert resp.json()["tracks"][0]["title"] == "Believe"


def test_songs_route_needs_an_artist_for_the_artist_op(client):
    assert client.get("/deezer/songs", params={"op": "artist"}).status_code == 422


def test_songs_route_maps_an_unknown_artist_to_404_and_upstream_to_502(client):
    with _patch_get({"data": []}):
        resp = client.get("/deezer/songs", params={"op": "artist", "artist": "nobody"})
    assert resp.status_code == 404

    with patch.object(deezer._client, "get", AsyncMock(side_effect=httpx.ConnectError("x"))):
        resp = client.get("/deezer/songs", params={"op": "charts"})
    assert resp.status_code == 502


def test_genres_route(client):
    with _patch_get({"data": [{"id": 0, "name": "Alle"}]}):
        resp = client.get("/deezer/genres", params={"lang": "de"})
    assert resp.json() == {"genres": [{"id": 0, "name": "Alle"}]}
