"""Tests for media/jellyfin_bridge.py and routes/proxy.py's dispatch to it."""

import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from core import radio_stations
from core.session import DEFAULT_SESSION_ID, SessionState
from core.session import registry as session_registry
from media import JellyfinClient, SubsonicClient, jellyfin_bridge


@pytest.fixture
def jellyfin_session(reset_state) -> SessionState:
    """Direct equivalent of conftest.py's default_session, but with a
    JellyfinClient — installed under DEFAULT_SESSION_ID since the `client`
    fixture sends no X-Connect-Session header (see stores/auth.ts's
    SubsonicClient, which never did before this session — see
    services/subsonic/client.ts's sessionId comment)."""
    session = SessionState(DEFAULT_SESSION_ID)
    session.media = JellyfinClient(
        "http://proxy:9180", token="tok", user_id="u1", internal_url="http://jf:8096"
    )
    session.authenticated = True
    session_registry._sessions[DEFAULT_SESSION_ID] = session
    return session


def _fake_jf_client(json_by_path: dict[str, dict] | None = None):
    """Mocks jellyfin_bridge._get_client() so _jf_request() (used by every
    JSON handler via _jf_get()) resolves against a canned {path: json} table
    instead of a real Jellyfin server. Any request not matching the table
    (typically a POST/DELETE mutation, which handlers don't parse a body
    from — see _jf_request's comment) succeeds with an empty body. Returns
    (mock_client, calls) — calls is a list of (method, url, params, json)
    tuples, for asserting what a mutation actually sent."""
    json_by_path = json_by_path or {}
    calls: list[tuple] = []

    async def fake_request(method, url, headers=None, params=None, json=None):
        calls.append((method, url, params, json))
        for path, payload in json_by_path.items():
            if url.endswith(path):
                response = MagicMock()
                response.raise_for_status = MagicMock()
                response.content = b"1"
                response.json = MagicMock(return_value=payload)
                return response
        response = MagicMock()
        response.raise_for_status = MagicMock()
        response.content = b""
        return response

    mock_client = MagicMock()
    mock_client.request = fake_request
    return mock_client, calls


# ── Field mapping (pure functions, no I/O) ──────────────────────────────────


def test_map_song_basic_fields():
    item = {
        "Id": "song-1",
        "Name": "Track Title",
        "Artists": ["Artist A"],
        "Album": "The Album",
        "AlbumId": "album-1",
        "RunTimeTicks": 200 * 10_000_000,
        "IndexNumber": 3,
        "ParentIndexNumber": 1,
        "ProductionYear": 2020,
        "Genres": ["Rock"],
        "ArtistItems": [{"Id": "artist-1"}],
        "MediaSources": [{"Container": "flac", "Bitrate": 320_000}],
        "UserData": {"PlayCount": 5, "IsFavorite": True},
    }
    song = jellyfin_bridge._map_song(item)
    assert song["id"] == "song-1"
    assert song["title"] == "Track Title"
    assert song["artist"] == "Artist A"
    assert song["album"] == "The Album"
    assert song["albumId"] == "album-1"
    assert song["duration"] == 200
    assert song["track"] == 3
    assert song["discNumber"] == 1
    assert song["year"] == 2020
    assert song["genre"] == "Rock"
    assert song["artistId"] == "artist-1"
    assert song["coverArt"] == "song-1"
    assert song["suffix"] == "flac"
    assert song["bitRate"] == 320
    assert song["playCount"] == 5
    assert song["starred"] == "true"


def test_map_song_carries_the_image_version_on_the_cover_art_id():
    # Replacing the artwork in Jellyfin changes ImageTags.Primary but not
    # the item id, so without this a cover would keep the key every cache in
    # the path is built on and the old picture would go on being served
    # until it expired (see media/base.py's artwork_id).
    item = {"Id": "song-1", "Name": "T", "RunTimeTicks": 0, "ImageTags": {"Primary": "abc123"}}
    assert jellyfin_bridge._map_song(item)["coverArt"] == "song-1_abc123"


def test_map_album_and_artist_carry_the_image_version_too():
    tagged = {"Id": "album-1", "Name": "A", "ImageTags": {"Primary": "def456"}}
    assert jellyfin_bridge._map_album(tagged)["coverArt"] == "album-1_def456"
    assert jellyfin_bridge._map_artist(tagged)["coverArt"] == "album-1_def456"


def test_map_song_leaves_the_id_alone_when_there_is_no_image():
    # An item with no artwork at all sends no ImageTags - the bare id still
    # has to be a usable cover art id.
    item = {"Id": "song-1", "Name": "T", "RunTimeTicks": 0}
    assert jellyfin_bridge._map_song(item)["coverArt"] == "song-1"


def test_map_song_omits_starred_when_not_favorite():
    item = {"Id": "s", "Name": "T", "RunTimeTicks": 0}
    song = jellyfin_bridge._map_song(item)
    assert "starred" not in song


def test_map_song_replay_gain_from_normalization_gain():
    item = {
        "Id": "s",
        "Name": "T",
        "RunTimeTicks": 0,
        "NormalizationGain": -3.5,
        "AlbumNormalizationGain": -2.1,
    }
    song = jellyfin_bridge._map_song(item)
    assert song["replayGain"] == {"trackGain": -3.5, "albumGain": -2.1}


def test_map_song_replay_gain_falls_back_to_lufs():
    # -18 LUFS reference target — a file scanned at -20 LUFS reads as +2dB
    # gain.
    item = {"Id": "s", "Name": "T", "RunTimeTicks": 0, "LUFS": -20}
    song = jellyfin_bridge._map_song(item)
    assert song["replayGain"] == {"trackGain": 2}


def test_map_song_omits_replay_gain_when_absent():
    item = {"Id": "s", "Name": "T", "RunTimeTicks": 0}
    song = jellyfin_bridge._map_song(item)
    assert "replayGain" not in song


def test_map_album_and_artist_favorite_presence():
    fav_album = jellyfin_bridge._map_album(
        {"Id": "a1", "Name": "Album", "UserData": {"IsFavorite": True}}
    )
    not_fav_album = jellyfin_bridge._map_album({"Id": "a2", "Name": "Album 2"})
    assert fav_album["starred"] == "true"
    assert "starred" not in not_fav_album

    fav_artist = jellyfin_bridge._map_artist(
        {"Id": "ar1", "Name": "Artist", "UserData": {"IsFavorite": True}}
    )
    assert fav_artist["starred"] == "true"


def test_map_album_includes_artist_id_year_and_genre_when_present():
    album = jellyfin_bridge._map_album(
        {
            "Id": "a1",
            "Name": "Album",
            "AlbumArtists": [{"Id": "artist-1"}],
            "ProductionYear": 2010,
            "Genres": ["Electronic", "Ambient"],
        }
    )
    assert album["artistId"] == "artist-1"
    assert album["year"] == 2010
    # First genre only — Subsonic's own shape has room for just one.
    assert album["genre"] == "Electronic"


def test_map_album_omits_artist_id_year_and_genre_when_absent():
    album = jellyfin_bridge._map_album({"Id": "a2", "Name": "Album 2"})
    assert "artistId" not in album
    assert "year" not in album
    assert "genre" not in album


# ── Shared httpx client lifecycle ────────────────────────────────────────────


def test_get_client_creates_once_and_reuses(monkeypatch):
    monkeypatch.setattr(jellyfin_bridge, "_client", None)

    first = jellyfin_bridge._get_client()
    second = jellyfin_bridge._get_client()

    assert first is second


async def test_close_closes_and_clears_the_shared_client(monkeypatch):
    fake_client = AsyncMock()
    monkeypatch.setattr(jellyfin_bridge, "_client", fake_client)

    await jellyfin_bridge.close()

    fake_client.aclose.assert_awaited_once()
    assert jellyfin_bridge._client is None


async def test_close_is_a_noop_when_never_initialized(monkeypatch):
    monkeypatch.setattr(jellyfin_bridge, "_client", None)

    await jellyfin_bridge.close()  # must not raise


async def test_jf_request_logs_when_a_call_takes_over_a_second(
    jellyfin_session, monkeypatch, caplog
):
    """Not every request — just the ones worth knowing about when something
    "feels slow" without actually erroring, see _jf_request()'s own
    comment. Times faked out rather than actually sleeping a second."""
    import logging
    import time as time_mod

    fake_client, _ = _fake_jf_client({"/Users/u1/Items/song-1": {"Id": "song-1"}})
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)
    # Only the two calls _jf_request() itself makes are faked — anything
    # else touching time.monotonic() (asyncio/pytest internals during
    # teardown, in particular) falls through to the real one, or a bare
    # iterator here would raise StopIteration well after this test's body
    # already finished.
    real_monotonic = time_mod.monotonic
    _exhausted = object()
    times = iter([0.0, 1.5])

    def _fake_monotonic():
        v = next(times, _exhausted)
        return real_monotonic() if v is _exhausted else v

    monkeypatch.setattr(time_mod, "monotonic", _fake_monotonic)

    with caplog.at_level(logging.INFO, logger="connect.jellyfin_bridge"):
        await jellyfin_bridge._jf_get(jellyfin_session.media, "/Users/u1/Items/song-1")

    assert "took 1.50s" in caplog.text


# ── routes/proxy.py dispatch ─────────────────────────────────────────────────


def test_proxy_dispatches_jellyfin_session_to_bridge(client, jellyfin_session, monkeypatch):
    fake_client, _calls = _fake_jf_client(
        {
            "/Users/u1/Items/song-1": {
                "Id": "song-1",
                "Name": "T",
                "RunTimeTicks": 0,
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getSong.view?id=song-1")
    assert r.status_code == 200
    body = r.json()
    assert body["subsonic-response"]["status"] == "ok"
    assert body["subsonic-response"]["song"]["id"] == "song-1"


def test_proxy_dispatches_subsonic_session_to_passthrough(client, default_session, monkeypatch):
    # default_session (conftest.py) is a SubsonicClient. Force
    # NAVIDROME_INTERNAL_URL empty and reload routes/proxy.py (same pattern as
    # test_proxy.py's _reload_proxy) so the passthrough branch's behavior is
    # deterministic regardless of the ambient dev .env — this only needs to
    # prove the *other* branch ran (the passthrough's own "not configured"
    # 503), not exercise a real Navidrome round-trip.
    import importlib

    import routes.proxy as proxy_mod

    monkeypatch.setenv("NAVIDROME_INTERNAL_URL", "")
    importlib.reload(proxy_mod)

    assert isinstance(default_session.media, SubsonicClient)
    r = client.get("/rest/getSong.view?id=1")
    assert r.status_code == 503
    assert "subsonic-response" not in r.json()

    monkeypatch.delenv("NAVIDROME_INTERNAL_URL", raising=False)
    importlib.reload(proxy_mod)


# ── Unmatched / unbridged endpoints ──────────────────────────────────────────


def test_unbridged_endpoint_returns_failed_envelope(client, jellyfin_session):
    r = client.get("/rest/setRating.view?id=1&rating=5")
    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "failed"
    assert "error" in body


def test_handler_exception_returns_failed_envelope_not_500(client, jellyfin_session, monkeypatch):
    async def broken_request(method, url, headers=None, params=None, json=None):
        raise RuntimeError("boom")

    fake_client = MagicMock()
    fake_client.request = broken_request
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getSong.view?id=1")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


# ── search3 (also the engine behind fetchAllTracks()'s bulk-load / Genres) ──


def test_search3_empty_query_omits_search_term(client, jellyfin_session, monkeypatch):
    # Regression test: fetchAllTracks() (stores/library.ts) bulk-loads the
    # whole track catalog via search3('', 3000, 0, 0, offset) — an empty
    # query must NOT be sent to Jellyfin as searchTerm="" (which returns
    # nothing), unlike Subsonic where an empty query means "match everything".
    fake_client, calls = _fake_jf_client({"/Users/u1/Items": {"Items": []}})
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get(
        "/rest/search3.view?query=&songCount=3000&albumCount=0&artistCount=0&songOffset=0"
    )
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"
    params = calls[0][2]
    assert "searchTerm" not in params


def test_search3_nonempty_query_sends_search_term(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client({"/Users/u1/Items": {"Items": []}})
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    client.get("/rest/search3.view?query=beatles&songCount=25&albumCount=25&artistCount=25")
    assert calls[0][2]["searchTerm"] == "beatles"


def test_search3_maps_song_offset_to_start_index(client, jellyfin_session, monkeypatch):
    # Regression test: without this, every "page" of a paginated bulk load
    # re-fetched the exact same items — pagination never actually advanced.
    fake_client, calls = _fake_jf_client({"/Users/u1/Items": {"Items": []}})
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    client.get(
        "/rest/search3.view?query=&songCount=3000&albumCount=0&artistCount=0&songOffset=3000"
    )
    assert calls[0][2]["StartIndex"] == "3000"


def test_search3_only_requests_nonzero_count_types(client, jellyfin_session, monkeypatch):
    # Regression test: fetchAllTracks() sets albumCount=artistCount=0 — Jellyfin
    # must not be asked for those types too, since they'd otherwise crowd
    # unwanted results into the one shared Limit meant entirely for songs.
    fake_client, calls = _fake_jf_client({"/Users/u1/Items": {"Items": []}})
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    client.get("/rest/search3.view?query=&songCount=3000&albumCount=0&artistCount=0")
    assert calls[0][2]["IncludeItemTypes"] == "Audio"
    assert calls[0][2]["Limit"] == "3000"


def test_search3_all_zero_counts_skips_request_entirely(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/search3.view?query=&songCount=0&albumCount=0&artistCount=0")
    assert r.status_code == 200
    body = r.json()["subsonic-response"]["searchResult3"]
    assert body == {"song": [], "album": [], "artist": []}
    assert calls == []


def test_search3_buckets_results_by_type(client, jellyfin_session, monkeypatch):
    fake_client, _calls = _fake_jf_client(
        {
            "/Users/u1/Items": {
                "Items": [
                    {"Id": "s1", "Name": "Song", "Type": "Audio", "RunTimeTicks": 0},
                    {"Id": "a1", "Name": "Album", "Type": "MusicAlbum"},
                    {"Id": "ar1", "Name": "Artist", "Type": "MusicArtist"},
                ]
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/search3.view?query=x&songCount=25&albumCount=25&artistCount=25")
    body = r.json()["subsonic-response"]["searchResult3"]
    assert [s["id"] for s in body["song"]] == ["s1"]
    assert [a["id"] for a in body["album"]] == ["a1"]
    assert [ar["id"] for ar in body["artist"]] == ["ar1"]


def test_search3_surfaces_total_record_count(client, jellyfin_session, monkeypatch):
    # Extra, non-Subsonic-standard field — lets stores/library.ts's bulk
    # track load show real progress ("6000 / 20147") for Jellyfin.
    fake_client, _calls = _fake_jf_client(
        {"/Users/u1/Items": {"Items": [], "TotalRecordCount": 20147}}
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/search3.view?query=&songCount=200&albumCount=0&artistCount=0")
    body = r.json()["subsonic-response"]["searchResult3"]
    assert body["totalRecordCount"] == 20147


def test_search3_skips_malformed_item_instead_of_failing_whole_page(
    client, jellyfin_session, monkeypatch
):
    fake_client, _calls = _fake_jf_client(
        {
            "/Users/u1/Items": {
                "Items": [
                    {"Name": "Missing Id", "Type": "Audio"},  # no "Id" -> KeyError in _map_song
                    {"Id": "s2", "Name": "Good Song", "Type": "Audio", "RunTimeTicks": 0},
                ]
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/search3.view?query=x&songCount=25&albumCount=0&artistCount=0")
    assert r.status_code == 200
    body = r.json()["subsonic-response"]["searchResult3"]
    assert [s["id"] for s in body["song"]] == ["s2"]


# ── Library browsing (getAlbumList2 / getAlbum / getArtists / getArtist) ────


def test_get_album_list2_maps_albums_and_forwards_sort_params(
    client, jellyfin_session, monkeypatch
):
    fake_client, calls = _fake_jf_client(
        {"/Users/u1/Items": {"Items": [{"Id": "album-1", "Name": "Album", "RunTimeTicks": 0}]}}
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getAlbumList2.view?type=alphabeticalByName")

    assert r.status_code == 200
    albums = r.json()["subsonic-response"]["albumList2"]["album"]
    assert [a["id"] for a in albums] == ["album-1"]
    assert calls[0][2]["SortBy"] == "SortName"


def test_get_album_list2_uses_random_sort_when_requested(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client({"/Users/u1/Items": {"Items": []}})
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    client.get("/rest/getAlbumList2.view?type=random")

    assert calls[0][2]["SortBy"] == "Random"


def test_get_album_includes_its_songs(client, jellyfin_session, monkeypatch):
    fake_client, _ = _fake_jf_client(
        {
            "/Users/u1/Items/album-1": {"Id": "album-1", "Name": "Album", "RunTimeTicks": 0},
            "/Users/u1/Items": {"Items": [{"Id": "song-1", "Name": "Song", "RunTimeTicks": 0}]},
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getAlbum.view?id=album-1")

    assert r.status_code == 200
    album = r.json()["subsonic-response"]["album"]
    assert album["id"] == "album-1"
    assert [s["id"] for s in album["song"]] == ["song-1"]


def test_get_artists_buckets_by_first_letter(client, jellyfin_session, monkeypatch):
    """Jellyfin has no native indexed-by-letter grouping — see get_artists()'s
    own comment — bucketed client-side to match Subsonic's shape."""
    fake_client, _ = _fake_jf_client(
        {
            "/Users/u1/Items": {
                "Items": [
                    {"Id": "a1", "Name": "ABBA"},
                    {"Id": "b1", "Name": "Beatles"},
                    {"Id": "a2", "Name": "Air"},
                ]
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getArtists.view")

    assert r.status_code == 200
    index = r.json()["subsonic-response"]["artists"]["index"]
    assert [entry["name"] for entry in index] == ["A", "B"]
    a_names = {a["name"] for a in index[0]["artist"]}
    assert a_names == {"ABBA", "Air"}


def test_get_artist_includes_its_albums(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client(
        {
            "/Users/u1/Items/artist-1": {"Id": "artist-1", "Name": "Radiohead"},
            "/Users/u1/Items": {
                "Items": [{"Id": "album-1", "Name": "OK Computer", "RunTimeTicks": 0}]
            },
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getArtist.view?id=artist-1")

    assert r.status_code == 200
    artist = r.json()["subsonic-response"]["artist"]
    assert artist["id"] == "artist-1"
    assert [a["id"] for a in artist["album"]] == ["album-1"]
    # Scoped to this specific artist, not a generic album listing.
    assert calls[-1][2]["ArtistIds"] == "artist-1"


# ── Favorites ─────────────────────────────────────────────────────────────────


def test_star_uses_id_over_album_and_artist_id(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/star.view?id=song-1&albumId=album-1&artistId=artist-1")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"
    method, url, _params, _json = calls[0]
    assert method == "POST"
    assert url.endswith("/Users/u1/FavoriteItems/song-1")


def test_star_falls_back_to_album_id(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    client.get("/rest/star.view?albumId=album-1")
    assert calls[0][1].endswith("/Users/u1/FavoriteItems/album-1")


def test_unstar_sends_delete(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/unstar.view?id=song-1")
    assert r.status_code == 200
    assert calls[0][0] == "DELETE"


def test_star_without_any_id_fails_cleanly(client, jellyfin_session, monkeypatch):
    fake_client, _calls = _fake_jf_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/star.view")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_get_starred2_issues_three_type_scoped_calls(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client(
        {"/Users/u1/Items": {"Items": []}},
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getStarred2.view")
    assert r.status_code == 200
    body = r.json()["subsonic-response"]["starred2"]
    assert body == {"song": [], "album": [], "artist": []}
    item_types = [c[2]["IncludeItemTypes"] for c in calls]
    assert set(item_types) == {"Audio", "MusicAlbum", "MusicArtist"}
    assert all(c[2]["Filters"] == "IsFavorite" for c in calls)


# ── Playlists ─────────────────────────────────────────────────────────────────


def test_get_playlists_maps_items(client, jellyfin_session, monkeypatch):
    fake_client, _calls = _fake_jf_client(
        {
            "/Users/u1/Items": {
                "Items": [{"Id": "p1", "Name": "Road Trip", "ChildCount": 12, "RunTimeTicks": 0}]
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getPlaylists.view")
    playlists = r.json()["subsonic-response"]["playlists"]["playlist"]
    assert playlists == [
        {
            "id": "p1",
            "name": "Road Trip",
            "songCount": 12,
            "duration": 0,
            "coverArt": "p1",
            "public": False,
        }
    ]


def test_get_playlist_includes_entries(client, jellyfin_session, monkeypatch):
    fake_client, _calls = _fake_jf_client(
        {
            "/Users/u1/Items/p1": {
                "Id": "p1",
                "Name": "Road Trip",
                "ChildCount": 1,
                "RunTimeTicks": 0,
            },
            "/Playlists/p1/Items": {"Items": [{"Id": "s1", "Name": "Song", "RunTimeTicks": 0}]},
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getPlaylist.view?id=p1")
    playlist = r.json()["subsonic-response"]["playlist"]
    assert playlist["id"] == "p1"
    assert playlist["entry"] == [
        {
            "id": "s1",
            "title": "Song",
            "artist": "Unknown",
            "album": "",
            "duration": 0,
            "coverArt": "s1",
            "playCount": 0,
        }
    ]


def test_create_playlist_sends_name_and_ids(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/createPlaylist.view?name=My+Mix&songId=s1&songId=s2")
    assert r.status_code == 200
    method, url, _params, json_body = calls[0]
    assert method == "POST"
    assert url.endswith("/Playlists")
    assert json_body == {"Name": "My Mix", "UserId": "u1", "Ids": ["s1", "s2"]}


def test_add_to_playlist_via_update_playlist(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/updatePlaylist.view?playlistId=p1&songIdToAdd=s1&songIdToAdd=s2")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"
    method, url, params, _json = calls[0]
    assert method == "POST"
    assert url.endswith("/Playlists/p1/Items")
    assert params["Ids"] == "s1,s2"


def test_remove_from_playlist_translates_index_to_playlist_item_id(
    client, jellyfin_session, monkeypatch
):
    fake_client, calls = _fake_jf_client(
        {
            "/Playlists/p1/Items": {
                "Items": [
                    {"Id": "s1", "PlaylistItemId": "pi-1"},
                    {"Id": "s2", "PlaylistItemId": "pi-2"},
                ]
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/updatePlaylist.view?playlistId=p1&songIndexToRemove=1")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"
    delete_call = next(c for c in calls if c[0] == "DELETE")
    assert delete_call[2]["EntryIds"] == "pi-2"


def test_update_playlist_rename_only_fails_cleanly(client, jellyfin_session, monkeypatch):
    fake_client, _calls = _fake_jf_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/updatePlaylist.view?playlistId=p1&name=New+Name")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_delete_playlist_hits_items_endpoint(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/deletePlaylist.view?id=p1")
    assert r.status_code == 200
    method, url, _params, _json = calls[0]
    assert method == "DELETE"
    assert url.endswith("/Items/p1")


# ── Internet radio stations (self-hosted, not a Jellyfin API call) ──────────


def _isolated_station_store():
    d = tempfile.TemporaryDirectory()
    path = str(Path(d.name) / "test_stations.json")
    return d, patch.object(radio_stations, "_PATH", path)


def test_get_internet_radio_stations_maps_stored_list(client, jellyfin_session):
    d, patcher = _isolated_station_store()
    with d, patcher:
        radio_stations.create("KEXP", "https://stream.kexp.org", "https://kexp.org")
        r = client.get("/rest/getInternetRadioStations.view")
    assert r.status_code == 200
    stations = r.json()["subsonic-response"]["internetRadioStations"]["internetRadioStation"]
    assert len(stations) == 1
    assert stations[0]["name"] == "KEXP"
    assert stations[0]["streamUrl"] == "https://stream.kexp.org"
    assert stations[0]["homePageUrl"] == "https://kexp.org"


def test_create_internet_radio_station_persists(client, jellyfin_session):
    d, patcher = _isolated_station_store()
    with d, patcher:
        r = client.get(
            "/rest/createInternetRadioStation.view"
            "?name=KEXP&streamUrl=https://stream.kexp.org&homepageUrl=https://kexp.org"
        )
        assert r.status_code == 200
        assert r.json()["subsonic-response"]["status"] == "ok"
        stored = radio_stations.list_stations()
    assert len(stored) == 1
    assert stored[0]["name"] == "KEXP"
    assert stored[0]["homePageUrl"] == "https://kexp.org"


def test_update_internet_radio_station(client, jellyfin_session):
    d, patcher = _isolated_station_store()
    with d, patcher:
        station = radio_stations.create("Old", "https://old.example")
        r = client.get(
            f"/rest/updateInternetRadioStation.view?id={station['id']}"
            "&name=New&streamUrl=https://new.example&homepageUrl=https://new.example/home"
        )
        assert r.status_code == 200
        assert r.json()["subsonic-response"]["status"] == "ok"
        stored = radio_stations.list_stations()
    assert stored[0]["name"] == "New"
    assert stored[0]["streamUrl"] == "https://new.example"


def test_update_unknown_radio_station_fails_cleanly(client, jellyfin_session):
    d, patcher = _isolated_station_store()
    with d, patcher:
        r = client.get(
            "/rest/updateInternetRadioStation.view?id=no-such&name=X&streamUrl=https://x.example"
        )
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_delete_internet_radio_station(client, jellyfin_session):
    d, patcher = _isolated_station_store()
    with d, patcher:
        station = radio_stations.create("Gone Soon", "https://gone.example")
        r = client.get(f"/rest/deleteInternetRadioStation.view?id={station['id']}")
        assert r.status_code == 200
        assert r.json()["subsonic-response"]["status"] == "ok"
        assert radio_stations.list_stations() == []


def test_delete_unknown_radio_station_fails_cleanly(client, jellyfin_session):
    d, patcher = _isolated_station_store()
    with d, patcher:
        r = client.get("/rest/deleteInternetRadioStation.view?id=does-not-exist")
        assert r.status_code == 200
        assert r.json()["subsonic-response"]["status"] == "failed"


# ── Track/Artist Radio (InstantMix) ─────────────────────────────────────────


def test_get_similar_songs2_maps_instant_mix_results(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client(
        {
            "/Items/song-1/InstantMix": {
                "Items": [
                    {"Id": "s2", "Name": "Similar Song", "RunTimeTicks": 0},
                ]
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getSimilarSongs2.view?id=song-1&count=50")
    assert r.status_code == 200
    body = r.json()["subsonic-response"]["similarSongs2"]
    assert [s["id"] for s in body["song"]] == ["s2"]
    params = calls[0][2]
    assert params["userId"] == "u1"
    assert params["Limit"] == "50"


def test_get_similar_songs2_requires_id(client, jellyfin_session):
    r = client.get("/rest/getSimilarSongs2.view")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


# ── scrobble / play tracking ─────────────────────────────────────────────────


def test_scrobble_submission_true_reports_playback_stopped(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client(
        {"/Users/u1/Items/song-1": {"RunTimeTicks": 1_800_000_000}}
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/scrobble.view?id=song-1&submission=true")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"
    # submission=true reports Jellyfin's own session-based
    # playback-stopped event, with PositionTicks set to the track's full
    # duration (Subsonic gives no real position) so it reads as a
    # completed listen — see scrobble()'s comment.
    get_calls = [c for c in calls if c[0] == "GET"]
    assert len(get_calls) == 1
    assert get_calls[0][1].endswith("/Users/u1/Items/song-1")
    post_calls = [c for c in calls if c[0] == "POST"]
    assert len(post_calls) == 1
    _method, url, _params, json_body = post_calls[0]
    assert url.endswith("/Sessions/Playing/Stopped")
    assert json_body == {"ItemId": "song-1", "PositionTicks": 1_800_000_000, "IsPaused": True}


def test_scrobble_submission_false_reports_now_playing(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/scrobble.view?id=song-1&submission=false")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"
    assert len(calls) == 1
    method, url, _params, json_body = calls[0]
    assert method == "POST"
    assert url.endswith("/Sessions/Playing")
    assert json_body == {"ItemId": "song-1"}


def test_scrobble_requires_id_on_submission(client, jellyfin_session):
    r = client.get("/rest/scrobble.view?submission=true")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


# ── Binary passthrough (getCoverArt.view / stream.view) ─────────────────────


def _mock_binary_httpx_client():
    captured: dict = {}
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.headers = {"content-type": "audio/mpeg"}

    async def aiter_bytes():
        yield b"abc"

    fake_response.aiter_bytes = aiter_bytes
    fake_response.aclose = AsyncMock()

    mock_client = MagicMock()

    def build_request(method, url, headers=None):
        captured["method"] = method
        captured["url"] = url
        captured["headers"] = headers
        return MagicMock()

    mock_client.build_request = build_request
    mock_client.send = AsyncMock(return_value=fake_response)
    return mock_client, captured


def test_stream_view_forwards_range_header(client, jellyfin_session, monkeypatch):
    fake_client, captured = _mock_binary_httpx_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/stream.view?id=song-1", headers={"Range": "bytes=0-100"})
    assert r.status_code == 200
    assert captured["headers"]["Range"] == "bytes=0-100"
    assert captured["url"] == "http://jf:8096/Items/song-1/Download?api_key=tok"


def test_cover_art_view_builds_jellyfin_image_url(client, jellyfin_session, monkeypatch):
    fake_client, captured = _mock_binary_httpx_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getCoverArt.view?id=item-1&size=600")
    assert r.status_code == 200
    assert captured["url"] == "http://jf:8096/Items/item-1/Images/Primary?maxHeight=600"


def test_cover_art_view_requires_id(client, jellyfin_session):
    r = client.get("/rest/getCoverArt.view")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_stream_view_requires_id(client, jellyfin_session):
    r = client.get("/rest/stream.view")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_binary_handler_exception_returns_failed_envelope_not_500(
    client, jellyfin_session, monkeypatch
):
    """Unlike every JSON handler, _handle_binary()/_stream_binary() had no
    try/except of their own — a Jellyfin connectivity blip mid cover-art-
    load or mid-stream used to propagate as a raw 500 instead of degrading
    like every other endpoint here."""

    async def broken_stream_binary(request, url, media):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(jellyfin_bridge, "_stream_binary", broken_stream_binary)

    r = client.get("/rest/getCoverArt.view?id=item-1")

    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_create_playlist_with_id_reorders_by_moving_the_song_that_moved(
    client, jellyfin_session, monkeypatch
):
    """createPlaylist with a playlistId is Subsonic's update form — the
    playlist's songs become exactly the list sent, in that order (see
    client.ts's setPlaylistSongs). Jellyfin has no such call, so the bridge
    moves entries instead."""
    fake_client, calls = _fake_jf_client(
        {
            "/Playlists/p1/Items": {
                "Items": [
                    {"Id": "s1", "PlaylistItemId": "pi-1"},
                    {"Id": "s2", "PlaylistItemId": "pi-2"},
                    {"Id": "s3", "PlaylistItemId": "pi-3"},
                ]
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    # s1 dragged to the end.
    r = client.get("/rest/createPlaylist.view?playlistId=p1&songId=s2&songId=s3&songId=s1")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"

    # Nothing added or removed — the same songs, in a different order.
    assert not [c for c in calls if c[0] == "DELETE"]
    moves = [c for c in calls if c[0] == "POST"]
    assert len(moves) == 1
    assert moves[0][1].endswith("/Playlists/p1/Items/pi-1/Move/2")


def test_create_playlist_with_id_adds_and_drops_songs_to_match_the_list(
    client, jellyfin_session, monkeypatch
):
    fake_client, calls = _fake_jf_client(
        {
            "/Playlists/p1/Items": {
                "Items": [
                    {"Id": "s1", "PlaylistItemId": "pi-1"},
                    {"Id": "s2", "PlaylistItemId": "pi-2"},
                ]
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    # s2 gone, s9 new.
    r = client.get("/rest/createPlaylist.view?playlistId=p1&songId=s1&songId=s9")
    assert r.status_code == 200
    delete_call = next(c for c in calls if c[0] == "DELETE")
    assert delete_call[2]["EntryIds"] == "pi-2"
    add_call = next(c for c in calls if c[0] == "POST" and c[1].endswith("/Playlists/p1/Items"))
    assert add_call[2]["Ids"] == "s9"


def test_create_playlist_without_id_still_creates_one(client, jellyfin_session, monkeypatch):
    # The playlistId branch must not swallow the create case — a playlist
    # created with the same songs would otherwise silently do nothing.
    fake_client, calls = _fake_jf_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/createPlaylist.view?name=Fresh&songId=s1")
    assert r.status_code == 200
    method, url, _params, json_body = calls[0]
    assert (method, json_body["Name"]) == ("POST", "Fresh")
    assert url.endswith("/Playlists")


def test_get_lyrics_returns_the_files_own_synced_lyrics(client, jellyfin_session, monkeypatch):
    """Jellyfin times lyric lines in ticks from the start of the track; the
    Subsonic extension the frontend speaks wants milliseconds."""
    fake_client, _calls = _fake_jf_client(
        {
            "/Audio/song-1/Lyrics": {
                "Metadata": {"IsSynced": True},
                "Lyrics": [
                    {"Start": 0, "Text": "First line"},
                    {"Start": 12_300_000, "Text": "Second line"},
                ],
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getLyricsBySongId.view?id=song-1")
    assert r.status_code == 200
    lyrics = r.json()["subsonic-response"]["lyricsList"]["structuredLyrics"]
    assert len(lyrics) == 1
    assert lyrics[0]["synced"] is True
    assert lyrics[0]["line"] == [
        {"start": 0, "value": "First line"},
        {"start": 1230, "value": "Second line"},
    ]


def test_get_lyrics_marks_untimed_lyrics_as_unsynced(client, jellyfin_session, monkeypatch):
    fake_client, _calls = _fake_jf_client(
        {
            "/Audio/song-1/Lyrics": {
                "Metadata": {"IsSynced": False},
                "Lyrics": [{"Text": "Just words"}],
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getLyricsBySongId.view?id=song-1")
    lyrics = r.json()["subsonic-response"]["lyricsList"]["structuredLyrics"]
    assert lyrics[0]["synced"] is False
    # No start key at all rather than a made-up 0, which would read as
    # "every line begins at the top of the track".
    assert lyrics[0]["line"] == [{"value": "Just words"}]


def test_get_lyrics_treats_a_track_without_lyrics_as_an_empty_answer(
    client, jellyfin_session, monkeypatch
):
    """Jellyfin answers 404 for a track with no lyrics — the common case,
    not a failure. Surfacing it as an error would log a warning per track
    played, for nothing."""
    fake_client, _calls = _fake_jf_client()
    original_request = fake_client.request

    async def not_found(method, url, headers=None, params=None, json=None):
        response = await original_request(method, url, headers=headers, params=params, json=json)
        if url.endswith("/Lyrics"):
            response.status_code = 404
            request = httpx.Request(method, url)
            response.raise_for_status = MagicMock(
                side_effect=httpx.HTTPStatusError(
                    "404", request=request, response=httpx.Response(404, request=request)
                )
            )
        return response

    fake_client.request = not_found
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getLyricsBySongId.view?id=song-1")
    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "ok"
    assert body["lyricsList"] == {}


def test_get_lyrics_drops_the_terminator_line_an_id3_tag_leaves_behind(
    client, jellyfin_session, monkeypatch
):
    """Reading lyrics out of a file's tags leaves Jellyfin's last line as a
    lone NUL byte, and it reports no Metadata at all for them — both seen
    live (2026-08-27). The line would otherwise show up as a blank the
    lyric view scrolls to and sits on, and the missing metadata must not
    make timed lyrics look untimed."""
    fake_client, _calls = _fake_jf_client(
        {
            "/Audio/song-1/Lyrics": {
                "Metadata": {},
                "Lyrics": [
                    {"Start": 130_000_000, "Text": "Common love isn't for us"},
                    {"Start": 1_878_600_000, "Text": "\x00"},
                ],
            }
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getLyricsBySongId.view?id=song-1")
    lyrics = r.json()["subsonic-response"]["lyricsList"]["structuredLyrics"]
    assert lyrics[0]["synced"] is True
    # The byte is gone; its line stays, because a timed line with no text
    # is how LRC ends the previous line's highlight.
    assert lyrics[0]["line"] == [
        {"start": 13000, "value": "Common love isn't for us"},
        {"start": 187860, "value": ""},
    ]


def test_get_lyrics_is_empty_when_every_line_turns_out_blank(client, jellyfin_session, monkeypatch):
    fake_client, _calls = _fake_jf_client(
        {"/Audio/song-1/Lyrics": {"Lyrics": [{"Start": 0, "Text": "\x00"}]}}
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getLyricsBySongId.view?id=song-1")
    assert r.json()["subsonic-response"]["lyricsList"] == {}


# A server's libraries as Jellyfin reports them — music is one of several,
# which is the whole point of the tests below.
_LIBRARIES = [
    {"CollectionType": "movies", "ItemId": "lib-movies", "Name": "Filme"},
    {"CollectionType": "music", "ItemId": "lib-music", "Name": "Musik", "RefreshStatus": "Idle"},
    {"CollectionType": "tvshows", "ItemId": "lib-tv", "Name": "Serien"},
]


def test_start_scan_refreshes_music_libraries_only(client, jellyfin_session, monkeypatch):
    """A server almost always holds films and series too. Jellyfin's own
    "scan everything" call would drag all of them through a scan because
    someone pressed a button in a music app."""
    fake_client, calls = _fake_jf_client({"/Library/VirtualFolders": _LIBRARIES})
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/startScan.view")
    assert r.json()["subsonic-response"]["scanStatus"] == {"scanning": True}

    refreshes = [c[1] for c in calls if c[0] == "POST" and c[1].endswith("/Refresh")]
    assert refreshes == ["http://jf:8096/Items/lib-music/Refresh"]
    assert not any("/Library/Refresh" in c[1] for c in calls), "must not scan the whole server"


def test_start_scan_covers_every_music_library(client, jellyfin_session, monkeypatch):
    fake_client, calls = _fake_jf_client(
        {
            "/Library/VirtualFolders": [
                {"CollectionType": "music", "ItemId": "lib-a"},
                {"CollectionType": "music", "ItemId": "lib-b"},
            ]
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    client.get("/rest/startScan.view")

    refreshes = sorted(c[1] for c in calls if c[0] == "POST" and c[1].endswith("/Refresh"))
    assert refreshes == [
        "http://jf:8096/Items/lib-a/Refresh",
        "http://jf:8096/Items/lib-b/Refresh",
    ]


def test_start_scan_says_so_when_there_is_no_music_library(client, jellyfin_session, monkeypatch):
    fake_client, _calls = _fake_jf_client(
        {"/Library/VirtualFolders": [{"CollectionType": "movies", "ItemId": "lib-movies"}]}
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    body = client.get("/rest/startScan.view").json()["subsonic-response"]
    assert body["status"] == "failed"
    assert "music library" in body["error"]["message"]


def test_scan_status_reads_the_music_librarys_own_progress(client, jellyfin_session, monkeypatch):
    fake_client, _calls = _fake_jf_client(
        {
            "/Library/VirtualFolders": [
                {"CollectionType": "movies", "ItemId": "lib-movies", "RefreshStatus": "Active"},
                {
                    "CollectionType": "music",
                    "ItemId": "lib-music",
                    "RefreshStatus": "Active",
                    "RefreshProgress": 33.6,
                },
            ]
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    status = client.get("/rest/getScanStatus.view").json()["subsonic-response"]["scanStatus"]
    assert status["scanning"] is True
    # A percentage, since Jellyfin has no count of processed items — and
    # rounded, because a button reading "33.6%" is noise.
    assert status["progress"] == 34
    assert "count" not in status


def test_scan_status_averages_across_several_music_libraries(client, jellyfin_session, monkeypatch):
    # Two libraries, one finished: halfway, not done.
    fake_client, _calls = _fake_jf_client(
        {
            "/Library/VirtualFolders": [
                {
                    "CollectionType": "music",
                    "ItemId": "a",
                    "RefreshStatus": "Idle",
                    "RefreshProgress": 100,
                },
                {
                    "CollectionType": "music",
                    "ItemId": "b",
                    "RefreshStatus": "Active",
                    "RefreshProgress": 20,
                },
            ]
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    status = client.get("/rest/getScanStatus.view").json()["subsonic-response"]["scanStatus"]
    assert status == {"scanning": True, "progress": 60}


def test_scan_status_ignores_a_scan_of_some_other_library(client, jellyfin_session, monkeypatch):
    """The films library being scanned by someone else is not this scan
    finishing — nor is it this scan running."""
    fake_client, _calls = _fake_jf_client(
        {
            "/Library/VirtualFolders": [
                {"CollectionType": "movies", "ItemId": "lib-movies", "RefreshStatus": "Active"},
                {"CollectionType": "music", "ItemId": "lib-music", "RefreshStatus": "Idle"},
            ]
        }
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    status = client.get("/rest/getScanStatus.view").json()["subsonic-response"]["scanStatus"]
    assert status == {"scanning": False}


def test_get_user_reports_whether_the_account_may_scan(client, jellyfin_session, monkeypatch):
    """Jellyfin has no Subsonic-style role list — what Beacon needs from
    getUser.view is the one bit deciding whether Settings offers a library
    rescan, and Jellyfin keeps that in the user's policy."""
    fake_client, calls = _fake_jf_client(
        {"/Users/Me": {"Name": "thomas", "Policy": {"IsAdministrator": True}}}
    )
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getUser.view?username=thomas")
    assert r.json()["subsonic-response"]["user"] == {"username": "thomas", "adminRole": True}
    # /Users/Me, not /Users/{id}: it answers for whoever the token belongs
    # to and needs no elevation.
    assert calls[0][1].endswith("/Users/Me")


def test_get_user_reports_an_ordinary_listener_as_such(client, jellyfin_session, monkeypatch):
    fake_client, _calls = _fake_jf_client({"/Users/Me": {"Name": "rita", "Policy": {}}})
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getUser.view?username=rita")
    assert r.json()["subsonic-response"]["user"]["adminRole"] is False
