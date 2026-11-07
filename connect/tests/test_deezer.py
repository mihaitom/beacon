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
            "deezerId": 0,
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


async def test_artist_top_keeps_one_version_of_each_song_and_still_fills_the_limit():
    search = {"data": [{"id": 3, "name": "Martin Garrix"}]}
    top = {
        "data": [
            _track("Animals", "Martin Garrix", id=1),
            _track("Scared to Be Lonely", "Martin Garrix", id=2),
            _track("Animals (Extended Mix)", "Martin Garrix", title_short="Animals", id=3),
            _track("Scared To Be Lonely", "Martin Garrix", id=4),
            _track("Tremor", "Martin Garrix", id=5),
            _track("Bouncybob", "Martin Garrix", id=6),
        ]
    }
    with _patch_get(search, top) as get:
        tracks = await deezer.get_artist_top("Martin Garrix", 3)
    assert get.call_args_list[1].kwargs["params"]["limit"] == 6
    assert [t["deezerId"] for t in tracks] == [1, 2, 5]


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


# ── radio and playlists ──────────────────────────────────────────────────────


async def test_radio_resolves_the_artist_and_asks_for_its_radio():
    search = {"data": [{"id": 27, "name": "Daft Punk", "nb_fan": 1}]}
    with _patch_get(search, {"data": [_track("Chase", "Giorgio Moroder")]}) as get:
        tracks = await deezer.get_artist_radio("Daft Punk", 30)
    assert get.call_args_list[1].args[0].endswith("/artist/27/radio")
    assert tracks[0]["artist"] == "Giorgio Moroder"


async def test_an_unknown_id_is_not_found_rather_than_upstream():
    no_data = {"error": {"type": "DataException", "message": "no data", "code": 800}}
    with _patch_get(no_data), pytest.raises(deezer.DeezerError) as e:
        await deezer.get_playlist_tracks(1)
    assert e.value.not_found


async def test_playlist_is_fetched_whole_not_cut_to_the_track_count():
    with _patch_get({"data": []}) as get:
        await deezer.get_playlist_tracks(42)
    assert get.call_args.args[0].endswith("/playlist/42/tracks")
    assert get.call_args.kwargs["params"] == {"limit": deezer._MAX_PLAYLIST_TRACKS}


def _playlist_entry(playlist_id: int, title: str, owner_key: str = "user") -> dict:
    return {
        "id": playlist_id,
        "title": title,
        "nb_tracks": 50,
        "picture_medium": "https://img/p.jpg",
        owner_key: {"name": "Deezer Editor"},
    }


async def test_empty_query_lists_the_popular_playlists():
    with _patch_get({"data": [_playlist_entry(1, "Hits"), {"id": 2, "title": ""}]}) as get:
        found = await deezer.search_playlists("")
    assert get.call_args.args[0].endswith("/chart/0/playlists")
    assert found == [
        {
            "id": 1,
            "title": "Hits",
            "owner": "Deezer Editor",
            "trackCount": 50,
            "pictureUrl": "https://img/p.jpg",
        }
    ]


async def test_a_query_searches_playlists():
    with _patch_get({"data": [_playlist_entry(3, "Deep House")]}) as get:
        found = await deezer.search_playlists("deep house")
    assert get.call_args.args[0].endswith("/search/playlist")
    assert get.call_args.kwargs["params"]["q"] == "deep house"
    assert [p["title"] for p in found] == ["Deep House"]


async def test_a_pasted_link_finds_that_one_playlist():
    with _patch_get(_playlist_entry(5648610682, "Chill House", owner_key="creator")) as get:
        found = await deezer.search_playlists("https://www.deezer.com/de/playlist/5648610682?x=1")
    assert get.call_args.args[0].endswith("/playlist/5648610682")
    assert found[0]["owner"] == "Deezer Editor"


async def test_a_share_link_is_followed_to_the_playlist():
    redirect = httpx.Response(
        302,
        headers={"location": "https://www.deezer.com/en/playlist/77?utm_source=share"},
        request=httpx.Request("GET", "https://link.deezer.com/s/abc"),
    )
    responses = [redirect, _response(_playlist_entry(77, "Shared"))]
    with patch.object(deezer._client, "get", AsyncMock(side_effect=responses)) as get:
        found = await deezer.search_playlists("https://link.deezer.com/s/abc")
    assert get.call_args_list[0].kwargs == {"follow_redirects": False}
    assert [p["id"] for p in found] == [77]


async def test_a_link_elsewhere_is_never_fetched():
    with patch.object(deezer._client, "get", AsyncMock()) as get:
        found = await deezer.search_playlists("http://192.168.1.1/playlist/5")
    assert found == []
    get.assert_not_called()


async def test_a_share_link_redirecting_off_deezer_is_not_followed_further():
    redirect = httpx.Response(
        302,
        headers={"location": "https://evil.example/playlist/5"},
        request=httpx.Request("GET", "https://link.deezer.com/s/abc"),
    )
    with patch.object(deezer._client, "get", AsyncMock(return_value=redirect)) as get:
        found = await deezer.search_playlists("https://link.deezer.com/s/abc")
    assert found == []
    assert get.call_count == 1


async def test_a_deezer_link_that_is_not_a_playlist_says_so():
    with pytest.raises(deezer.DeezerError) as e:
        await deezer.search_playlists("https://www.deezer.com/de/album/123")
    assert e.value.not_found


def test_songs_route_radio_and_playlist(client):
    search = {"data": [{"id": 27, "name": "Daft Punk"}]}
    with _patch_get(search, {"data": [_track("Chase", "Giorgio Moroder")]}):
        resp = client.get("/deezer/songs", params={"op": "radio", "artist": "Daft Punk"})
    assert resp.json()["tracks"][0]["title"] == "Chase"

    assert client.get("/deezer/songs", params={"op": "playlist"}).status_code == 422
    with _patch_get({"data": [_track("Believe", "Cher")]}):
        resp = client.get("/deezer/songs", params={"op": "playlist", "playlist": 9})
    assert resp.json()["tracks"][0]["artist"] == "Cher"


def test_playlists_route(client):
    with _patch_get({"data": [_playlist_entry(1, "Hits")]}):
        resp = client.get("/deezer/playlists")
    assert resp.json()["playlists"][0]["title"] == "Hits"


# ── previews ─────────────────────────────────────────────────────────────────


def _hit(artist: str, title: str, short: str | None = None, rank: int = 0, **extra) -> dict:
    return {
        "id": rank,
        "title": title,
        "title_short": short or title,
        "artist": {"name": artist},
        "rank": rank,
        "preview": f"https://cdn/preview-{rank}.mp3",
        "link": f"https://www.deezer.com/track/{rank}",
        **extra,
    }


def test_deezer_tracks_carry_their_id_for_a_later_preview():
    assert deezer._tracks({"data": [_hit("Cher", "Believe", rank=5)]})[0]["deezerId"] == 5


def test_preview_prefers_the_plain_version_over_a_more_popular_remix():
    hits = [
        _hit("Massive Attack", "Teardrop (Dub)", short="Teardrop", rank=900),
        _hit("Massive Attack", "Teardrop", rank=100),
    ]
    assert deezer._pick_preview(hits, "Massive Attack", "Teardrop")["rank"] == 100


def test_preview_falls_back_to_another_version_then_a_longer_title():
    remix = _hit("Cher", "Believe (Club Mix)", short="Believe", rank=2)
    longer = _hit("Cher", "Believe In Me", rank=9)
    assert deezer._pick_preview([longer, remix], "Cher", "Believe") is remix
    assert deezer._pick_preview([longer], "Cher", "Believe") is longer


def test_preview_needs_the_same_artist_and_a_preview():
    hits = [
        _hit("Sandstorm", "Teardrop", rank=999),
        _hit("Massive Attack", "Teardrop", rank=5, preview=""),
    ]
    assert deezer._pick_preview(hits, "Massive Attack", "Teardrop") is None


def test_preview_matching_ignores_case_accents_and_punctuation():
    hit = _hit("Sigur Rós", "Hoppípolla", rank=1)
    assert deezer._pick_preview([hit], "sigur ros", "Hoppipolla") is hit
    hyphen = _hit("Ne‐Yo", "So Sick", rank=1)
    assert deezer._pick_preview([hyphen], "Ne-Yo", "So Sick") is hyphen


async def test_preview_by_id_checks_that_track_and_hands_out_no_url():
    with _patch_get(_hit("Daft Punk", "Around the World", rank=3)) as get:
        found = await deezer.get_preview("", "", 3)
    assert get.call_args.args[0].endswith("/track/3")
    # The signed URL expires, so it is fetched again when it plays.
    assert found == {"id": 3, "link": "https://www.deezer.com/track/3"}


async def test_a_preview_id_is_played_from_a_freshly_signed_url():
    with _patch_get(_hit("Cher", "Believe", rank=42)) as get:
        url = await deezer.preview_stream_url("deezer:42")
    assert get.call_args.args[0].endswith("/track/42")
    assert url == "https://cdn/preview-42.mp3"


async def test_a_broken_preview_id_has_no_audio_rather_than_failing():
    assert await deezer.preview_stream_url("deezer:nope") is None
    down = AsyncMock(side_effect=httpx.ConnectError("down"))
    with patch.object(deezer._client, "get", down):
        assert await deezer.preview_stream_url("deezer:42") is None


def test_preview_ids_are_told_from_library_ids():
    assert deezer.is_preview_id("deezer:42")
    assert not deezer.is_preview_id("42")
    assert not deezer.is_preview_id(None)


def test_preview_route(client):
    with _patch_get({"data": [_hit("Cher", "Believe", rank=7)]}) as get:
        resp = client.get("/deezer/preview", params={"artist": "Cher", "title": "Believe"})
    assert resp.json() == {"id": 7, "link": "https://www.deezer.com/track/7"}
    assert get.call_args.kwargs["params"]["q"] == "Cher Believe"

    with _patch_get({"data": []}):
        resp = client.get("/deezer/preview", params={"artist": "Nobody", "title": "Nothing"})
    assert resp.json() == {"id": 0, "link": ""}

    no_data = {"error": {"type": "DataException", "message": "no data", "code": 800}}
    with _patch_get(no_data):
        resp = client.get("/deezer/preview", params={"id": 1})
    assert resp.json()["id"] == 0

    assert client.get("/deezer/preview", params={"artist": "Cher"}).status_code == 422


def test_the_waveform_of_a_preview_is_drawn_from_deezer_not_the_server(client, default_session):
    with (
        patch.object(deezer, "preview_stream_url", AsyncMock(return_value="https://cdn/p.mp3")),
        patch("core.waveform.get_waveform", AsyncMock(return_value=[0.5])) as get,
        patch.object(default_session.media, "get_stream_url") as server,
    ):
        resp = client.get("/waveform/deezer:42")
    assert resp.json() == {"peaks": [0.5]}
    get.assert_awaited_once_with("deezer:42", "https://cdn/p.mp3")
    server.assert_not_called()
