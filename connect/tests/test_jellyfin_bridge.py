"""Tests for media/jellyfin_bridge.py and routes/proxy.py's dispatch to it."""

import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

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


def test_map_song_omits_starred_when_not_favorite():
    item = {"Id": "s", "Name": "T", "RunTimeTicks": 0}
    song = jellyfin_bridge._map_song(item)
    assert "starred" not in song


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


# ── routes/proxy.py dispatch ─────────────────────────────────────────────────


def test_proxy_dispatches_jellyfin_session_to_bridge(
    client, jellyfin_session, monkeypatch
):
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


def test_proxy_dispatches_subsonic_session_to_passthrough(
    client, default_session, monkeypatch
):
    # default_session (conftest.py) is a SubsonicClient. Force
    # SERVER_INTERNAL_URL empty and reload routes/proxy.py (same pattern as
    # test_proxy.py's _reload_proxy) so the passthrough branch's behavior is
    # deterministic regardless of the ambient dev .env — this only needs to
    # prove the *other* branch ran (the passthrough's own "not configured"
    # 503), not exercise a real Navidrome round-trip.
    import importlib

    import routes.proxy as proxy_mod

    monkeypatch.setenv("SERVER_INTERNAL_URL", "")
    importlib.reload(proxy_mod)

    assert isinstance(default_session.media, SubsonicClient)
    r = client.get("/rest/getSong.view?id=1")
    assert r.status_code == 503
    assert "subsonic-response" not in r.json()

    monkeypatch.delenv("SERVER_INTERNAL_URL", raising=False)
    importlib.reload(proxy_mod)


# ── Unmatched / unbridged endpoints ──────────────────────────────────────────


def test_unbridged_endpoint_returns_failed_envelope(client, jellyfin_session):
    r = client.get("/rest/setRating.view?id=1&rating=5")
    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "failed"
    assert "error" in body


def test_handler_exception_returns_failed_envelope_not_500(
    client, jellyfin_session, monkeypatch
):
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

    r = client.get("/rest/search3.view?query=&songCount=3000&albumCount=0&artistCount=0&songOffset=0")
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

    client.get("/rest/search3.view?query=&songCount=3000&albumCount=0&artistCount=0&songOffset=3000")
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

    r = client.get(
        "/rest/updatePlaylist.view?playlistId=p1&songIdToAdd=s1&songIdToAdd=s2"
    )
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

    r = client.get(
        "/rest/updatePlaylist.view?playlistId=p1&songIndexToRemove=1"
    )
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
