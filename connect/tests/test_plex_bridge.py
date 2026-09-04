"""Tests for media/plex_bridge.py and routes/proxy.py's dispatch to it."""

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from core.session import DEFAULT_SESSION_ID, SessionState
from core.session import registry as session_registry
from media import PlexClient, plex_bridge


@pytest.fixture
def plex_session(reset_state) -> SessionState:
    """Direct equivalent of test_jellyfin_bridge.py's jellyfin_session, but
    with a PlexClient."""
    session = SessionState(DEFAULT_SESSION_ID)
    session.media = PlexClient("http://plex:32400", token="tok", internal_url="http://plex:32400")
    session.authenticated = True
    session_registry._sessions[DEFAULT_SESSION_ID] = session
    return session


def _fake_px_client(json_by_path: dict[str, dict] | None = None):
    """Mocks plex_bridge._get_client() so _px_request() resolves against a
    canned {path: json} table instead of a real Plex server — same shape
    as test_jellyfin_bridge.py's own _fake_jf_client()."""
    json_by_path = json_by_path or {}
    calls: list[tuple] = []

    async def fake_request(method, url, headers=None, params=None):
        calls.append((method, url, params))
        for path, payload in json_by_path.items():
            # A key may carry a literal "?type=N" suffix to disambiguate
            # two calls hitting the exact same path with a different
            # `type` param (get_artists() does this: one call for
            # artists, one for albums, both against .../all) — the real
            # URL passed here never carries query params itself (see
            # _px_request, which sends them separately), so this has to
            # match against the params dict instead.
            base_path, _, type_suffix = path.partition("?type=")
            if not url.endswith(base_path):
                continue
            if type_suffix and (params or {}).get("type") != type_suffix:
                continue
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


# ── Shared httpx client lifecycle ────────────────────────────────────────────


def test_get_client_creates_once_and_reuses(monkeypatch):
    monkeypatch.setattr(plex_bridge, "_client", None)

    first = plex_bridge._get_client()
    second = plex_bridge._get_client()

    assert first is second


async def test_close_closes_and_clears_the_shared_client(monkeypatch):
    fake_client = AsyncMock()
    monkeypatch.setattr(plex_bridge, "_client", fake_client)

    await plex_bridge.close()

    fake_client.aclose.assert_awaited_once()
    assert plex_bridge._client is None


async def test_close_is_a_noop_when_never_initialized(monkeypatch):
    monkeypatch.setattr(plex_bridge, "_client", None)

    await plex_bridge.close()  # must not raise


# ── _music_section ────────────────────────────────────────────────────────────


async def test_music_section_reuses_an_already_resolved_key(plex_session, monkeypatch):
    plex_session.media.music_section_key = "5"
    fake_client, calls = _fake_px_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    key = await plex_bridge._music_section(plex_session.media)

    assert key == "5"
    assert calls == []  # never hit the network — the cached key won


async def test_music_section_raises_when_no_music_library_exists(plex_session, monkeypatch):
    fake_client, _ = _fake_px_client(
        {"/library/sections": {"MediaContainer": {"Directory": [{"key": "1", "type": "movie"}]}}}
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    with pytest.raises(ValueError, match="No music library section"):
        await plex_bridge._music_section(plex_session.media)


# ── Field mapping (pure functions, no I/O) ──────────────────────────────────


def test_map_song_basic_fields():
    item = {
        "ratingKey": "1001",
        "title": "Track Title",
        "grandparentTitle": "Artist A",
        "parentTitle": "The Album",
        "parentRatingKey": "2001",
        "grandparentRatingKey": "3001",
        "duration": 200_000,
        "index": 3,
        "parentIndex": 1,
        "year": 2020,
        "Genre": [{"tag": "Rock"}],
        "Media": [{"container": "flac", "bitrate": 900}],
        "viewCount": 5,
    }
    song = plex_bridge._map_song(item)
    assert song["id"] == "1001"
    assert song["title"] == "Track Title"
    assert song["artist"] == "Artist A"
    assert song["album"] == "The Album"
    assert song["duration"] == 200
    assert song["track"] == 3
    assert song["discNumber"] == 1
    assert song["year"] == 2020
    assert song["genre"] == "Rock"
    assert song["albumId"] == "2001"
    assert song["artistId"] == "3001"
    assert song["coverArt"] == "2001"  # falls back to the album's id
    assert song["suffix"] == "flac"
    assert song["bitRate"] == 900
    assert song["playCount"] == 5


def test_map_song_cover_art_falls_back_to_own_id_without_album():
    item = {"ratingKey": "1001", "title": "T", "duration": 0}
    song = plex_bridge._map_song(item)
    assert song["coverArt"] == "1001"


def test_map_song_takes_the_artwork_version_from_the_album_s_thumb():
    # Plex writes /thumb/<changed-at>, and a track's cover art is its
    # album's - so the version has to come from the path belonging to the
    # album's own rating key, not from whatever the track carries.
    item = {
        "ratingKey": "1001",
        "title": "T",
        "duration": 0,
        "parentRatingKey": "2001",
        "parentThumb": "/library/metadata/2001/thumb/1699999999",
    }
    assert plex_bridge._map_song(item)["coverArt"] == "2001_1699999999"


def test_map_album_and_artist_take_the_version_from_their_own_thumb():
    album = {"ratingKey": "2001", "title": "A", "thumb": "/library/metadata/2001/thumb/1712345678"}
    assert plex_bridge._map_album(album)["coverArt"] == "2001_1712345678"
    assert plex_bridge._map_artist(album)["coverArt"] == "2001_1712345678"


def test_map_album_ignores_a_thumb_belonging_to_a_different_item():
    # A track's own `thumb` points at its album, and vice versa - taking a
    # version off a path for another rating key would version the wrong item.
    item = {"ratingKey": "2001", "title": "A", "thumb": "/library/metadata/9999/thumb/1699999999"}
    assert plex_bridge._map_album(item)["coverArt"] == "2001"


def test_map_album_ignores_a_thumb_with_no_version_in_it():
    item = {"ratingKey": "2001", "title": "A", "thumb": "/library/metadata/2001/thumb"}
    assert plex_bridge._map_album(item)["coverArt"] == "2001"


def test_map_album_basic_fields():
    item = {
        "ratingKey": "2001",
        "title": "The Album",
        "parentTitle": "Artist A",
        "parentRatingKey": "3001",
        "leafCount": 12,
        "duration": 2_400_000,
        "year": 2019,
        "Genre": [{"tag": "Jazz"}],
    }
    album = plex_bridge._map_album(item)
    assert album["id"] == "2001"
    assert album["name"] == "The Album"
    assert album["artist"] == "Artist A"
    assert album["artistId"] == "3001"
    assert album["songCount"] == 12
    assert album["duration"] == 2400
    assert album["year"] == 2019
    assert album["genre"] == "Jazz"


def test_map_artist_basic_fields():
    item = {"ratingKey": "3001", "title": "Artist A", "childCount": 4}
    artist = plex_bridge._map_artist(item)
    assert artist == {
        "id": "3001",
        "name": "Artist A",
        "coverArt": "3001",
        "albumCount": 4,
    }


def test_map_song_includes_user_rating_converted_from_plex_scale():
    # Plex stores 0-10 (2 units/star); Subsonic's userRating is plain 1-5.
    item = {"ratingKey": "1001", "title": "T", "duration": 0, "userRating": 8}
    assert plex_bridge._map_song(item)["userRating"] == 4


def test_map_song_omits_user_rating_when_unset():
    item = {"ratingKey": "1001", "title": "T", "duration": 0}
    assert "userRating" not in plex_bridge._map_song(item)


def test_map_album_includes_user_rating_converted_from_plex_scale():
    item = {"ratingKey": "2001", "title": "T", "duration": 0, "userRating": 6}
    assert plex_bridge._map_album(item)["userRating"] == 3


def test_map_artist_includes_user_rating_converted_from_plex_scale():
    item = {"ratingKey": "3001", "title": "T", "userRating": 10}
    assert plex_bridge._map_artist(item)["userRating"] == 5


def test_map_all_skips_a_malformed_item_instead_of_failing_the_whole_page():
    # No "ratingKey" at all — every mapper indexes item["ratingKey"]
    # directly, so this one item must be skipped, not abort the batch.
    items = [{"title": "Broken, no ratingKey"}, {"ratingKey": "1001", "title": "Fine"}]
    result = plex_bridge._map_all(plex_bridge._map_song, items)
    assert [s["id"] for s in result] == ["1001"]


# ── JSON handlers ─────────────────────────────────────────────────────────────


def test_get_album_uses_album_id_for_track_cover_art(client, plex_session, monkeypatch):
    # Regression test: /children's per-track Metadata entries don't
    # reliably carry parentRatingKey (confirmed live 2026-08-17) — without
    # this, _map_song()'s own fallback lands on the track's own ratingKey,
    # which has no thumb of its own, so cover art silently went missing
    # for every track in an album's song list.
    fake_client, _calls = _fake_px_client(
        {
            "/library/metadata/2001": {
                "MediaContainer": {"Metadata": [{"ratingKey": "2001", "title": "Album A"}]}
            },
            "/library/metadata/2001/children": {
                "MediaContainer": {
                    "Metadata": [{"ratingKey": "9001", "title": "Track 1", "duration": 0}]
                }
            },
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getAlbum.view?id=2001")
    assert r.status_code == 200
    song = r.json()["subsonic-response"]["album"]["song"][0]
    assert song["coverArt"] == "2001"
    assert song["albumId"] == "2001"


def test_get_album_list2_returns_mapped_albums(client, plex_session, monkeypatch):
    fake_client, calls = _fake_px_client(
        {
            "/library/sections": {
                "MediaContainer": {"Directory": [{"key": "5", "type": "artist"}]}
            },
            "/library/sections/5/all": {
                "MediaContainer": {
                    "Metadata": [
                        {"ratingKey": "2001", "title": "Album A", "parentTitle": "Artist A"}
                    ]
                }
            },
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getAlbumList2.view")
    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "ok"
    assert body["albumList2"]["album"] == [
        {
            "id": "2001",
            "name": "Album A",
            "artist": "Artist A",
            "coverArt": "2001",
            "songCount": 0,
            "duration": 0,
        }
    ]
    # Music section resolved once and reused — not re-fetched.
    assert sum(1 for _method, url, _params in calls if url.endswith("/library/sections")) == 1


def test_get_similar_songs2_returns_mapped_songs(client, plex_session, monkeypatch):
    fake_client, calls = _fake_px_client(
        {
            "/library/metadata/9001/nearest": {
                "MediaContainer": {
                    "Metadata": [
                        {
                            "ratingKey": "9002",
                            "title": "Similar Song",
                            "grandparentTitle": "Artist B",
                            "parentTitle": "Album B",
                            "duration": 200_000,
                        }
                    ]
                }
            },
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getSimilarSongs2.view", params={"id": "9001", "count": "10"})
    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "ok"
    songs = body["similarSongs2"]["song"]
    assert len(songs) == 1
    assert songs[0]["id"] == "9002"
    assert songs[0]["artist"] == "Artist B"
    assert "plexPassRequired" not in body["similarSongs2"]
    assert calls[0][2]["limit"] == "10"


def test_get_similar_songs2_flags_plex_pass_required_on_403(client, plex_session, monkeypatch):
    """Regression for a real live-server finding (2026-08-20): Plex's Sonic
    Analysis feature this endpoint bridges onto is Plex Pass-gated, and a
    non-Pass account gets a clean 403 back — surfaced to the frontend as
    plexPassRequired rather than a thrown error, so stores/playback.ts can
    tell the listener why instead of that just silently doing nothing (Song/
    Artist Radio) or logging a warning forever (Autoplay)."""

    async def fake_request(method, url, headers=None, params=None):
        return httpx.Response(403, request=httpx.Request(method, url))

    fake_client = MagicMock()
    fake_client.request = fake_request
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getSimilarSongs2.view", params={"id": "9001"})
    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "ok"
    assert body["similarSongs2"]["song"] == []
    assert body["similarSongs2"]["plexPassRequired"] is True


def test_get_similar_songs2_requires_id(client, plex_session):
    r = client.get("/rest/getSimilarSongs2.view")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_get_similar_songs2_reraises_a_non_403_http_error(client, plex_session, monkeypatch):
    """Only a 403 (no Plex Pass) is a recognized, graceful case — any other
    HTTP failure (500, connectivity blip, ...) must still surface as a
    real error, not be silently swallowed the same way."""

    async def fake_request(method, url, headers=None, params=None):
        return httpx.Response(500, request=httpx.Request(method, url))

    fake_client = MagicMock()
    fake_client.request = fake_request
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getSimilarSongs2.view", params={"id": "9001"})
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_get_song_returns_mapped_song(client, plex_session, monkeypatch):
    fake_client, _ = _fake_px_client(
        {
            "/library/metadata/1001": {
                "MediaContainer": {"Metadata": [{"ratingKey": "1001", "title": "T", "duration": 0}]}
            }
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getSong.view?id=1001")

    assert r.status_code == 200
    assert r.json()["subsonic-response"]["song"]["id"] == "1001"


def test_get_song_raises_when_not_found(client, plex_session, monkeypatch):
    fake_client, _ = _fake_px_client(
        {"/library/metadata/9999": {"MediaContainer": {"Metadata": []}}}
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getSong.view?id=9999")

    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "failed"
    assert "9999" in body["error"]["message"]


def test_get_album_raises_when_not_found(client, plex_session, monkeypatch):
    fake_client, _ = _fake_px_client(
        {"/library/metadata/9999": {"MediaContainer": {"Metadata": []}}}
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getAlbum.view?id=9999")

    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "failed"
    assert "9999" in body["error"]["message"]


def test_get_artist_derives_counts_instead_of_trusting_summary_fields(
    client, plex_session, monkeypatch
):
    # Regression test: Plex's own childCount/leafCount summary fields came
    # back unreliable in practice (every artist showed "0 albums · 0
    # tracks" despite a real library) — album count and each album's song
    # count must be derived from data actually fetched, not from those
    # fields, even when the raw response *does* include them (as here,
    # deliberately wrong, to prove they're ignored).
    fake_client, _calls = _fake_px_client(
        {
            "/library/metadata/3001": {
                "MediaContainer": {
                    "Metadata": [{"ratingKey": "3001", "title": "Artist A", "childCount": 99}]
                }
            },
            "/library/metadata/3001/children": {
                "MediaContainer": {
                    "Metadata": [
                        {"ratingKey": "2001", "title": "Album A", "leafCount": 99},
                        {"ratingKey": "2002", "title": "Album B", "leafCount": 99},
                    ]
                }
            },
            "/library/metadata/3001/allLeaves": {
                "MediaContainer": {
                    "Metadata": [
                        {"ratingKey": "1", "parentRatingKey": "2001"},
                        {"ratingKey": "2", "parentRatingKey": "2001"},
                        {"ratingKey": "3", "parentRatingKey": "2002"},
                    ]
                }
            },
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getArtist.view?id=3001")
    assert r.status_code == 200
    artist = r.json()["subsonic-response"]["artist"]
    assert artist["albumCount"] == 2
    albums = {a["id"]: a for a in artist["album"]}
    assert albums["2001"]["songCount"] == 2
    assert albums["2002"]["songCount"] == 1


def test_get_artists_buckets_by_first_letter(client, plex_session, monkeypatch):
    fake_client, _calls = _fake_px_client(
        {
            "/library/sections": {
                "MediaContainer": {"Directory": [{"key": "5", "type": "artist"}]}
            },
            "/library/sections/5/all?type=8": {
                "MediaContainer": {
                    "Metadata": [
                        # childCount deliberately wrong/high — must be
                        # ignored (see test_get_artists_derives_album_count
                        # below for the actual regression coverage).
                        {"ratingKey": "1", "title": "Beatles", "childCount": 99},
                        {"ratingKey": "2", "title": "ABBA", "childCount": 99},
                    ]
                }
            },
            "/library/sections/5/all?type=9": {"MediaContainer": {"Metadata": []}},
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getArtists.view")
    assert r.status_code == 200
    index = r.json()["subsonic-response"]["artists"]["index"]
    assert [entry["name"] for entry in index] == ["A", "B"]
    assert index[0]["artist"][0]["name"] == "ABBA"
    assert index[1]["artist"][0]["name"] == "Beatles"


def test_get_artists_derives_album_count_from_bulk_album_listing(client, plex_session, monkeypatch):
    # Regression test: Plex's own childCount came back unreliable in
    # practice (every artist card showed "0 albums" — confirmed live
    # 2026-08-17) — album count must come from a real tally over the
    # bulk album listing instead.
    fake_client, calls = _fake_px_client(
        {
            "/library/sections": {
                "MediaContainer": {"Directory": [{"key": "5", "type": "artist"}]}
            },
            "/library/sections/5/all?type=8": {
                "MediaContainer": {
                    "Metadata": [{"ratingKey": "3001", "title": "Artist A", "childCount": 0}]
                }
            },
            "/library/sections/5/all?type=9": {
                "MediaContainer": {
                    "Metadata": [
                        {"ratingKey": "2001", "title": "Album A", "parentRatingKey": "3001"},
                        {"ratingKey": "2002", "title": "Album B", "parentRatingKey": "3001"},
                        {
                            "ratingKey": "2003",
                            "title": "Other Artist's Album",
                            "parentRatingKey": "9999",
                        },
                    ]
                }
            },
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getArtists.view")
    assert r.status_code == 200
    index = r.json()["subsonic-response"]["artists"]["index"]
    assert index[0]["artist"][0]["albumCount"] == 2
    # Both the artist (type=8) and album (type=9) listings were fetched,
    # against the same section, one call each — not one call per artist.
    all_calls = [c for c in calls if c[1].endswith("/library/sections/5/all")]
    assert len(all_calls) == 2


def test_get_artist_raises_when_not_found(client, plex_session, monkeypatch):
    fake_client, _ = _fake_px_client(
        {"/library/metadata/9999": {"MediaContainer": {"Metadata": []}}}
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getArtist.view?id=9999")

    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "failed"
    assert "9999" in body["error"]["message"]


def test_search3_empty_query_omits_title_filter(client, plex_session, monkeypatch):
    fake_client, calls = _fake_px_client(
        {
            "/library/sections": {
                "MediaContainer": {"Directory": [{"key": "5", "type": "artist"}]}
            },
            "/library/sections/5/all": {"MediaContainer": {"Metadata": []}},
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/search3.view?songCount=10&albumCount=0&artistCount=0")
    assert r.status_code == 200
    all_calls = [c for c in calls if c[1].endswith("/library/sections/5/all")]
    assert len(all_calls) == 1
    assert "title" not in (all_calls[0][2] or {})


def test_search3_with_query_sets_title_filter(client, plex_session, monkeypatch):
    fake_client, calls = _fake_px_client(
        {
            "/library/sections": {
                "MediaContainer": {"Directory": [{"key": "5", "type": "artist"}]}
            },
            "/library/sections/5/all": {"MediaContainer": {"Metadata": []}},
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/search3.view?query=beatles&songCount=10&albumCount=0&artistCount=0")
    assert r.status_code == 200
    all_calls = [c for c in calls if c[1].endswith("/library/sections/5/all")]
    assert all_calls[0][2]["title"] == "beatles"


# ── Ratings ───────────────────────────────────────────────────────────────────


def test_set_rating_converts_star_scale_to_plex_scale(client, plex_session, monkeypatch):
    fake_client, calls = _fake_px_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/setRating.view?id=1001&rating=4")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"
    method, url, params = calls[0]
    assert method == "PUT"
    assert url.endswith("/:/rate")
    assert params == {"key": "1001", "identifier": "com.plexapp.plugins.library", "rating": "8"}


def test_set_rating_zero_clears_rating(client, plex_session, monkeypatch):
    fake_client, calls = _fake_px_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/setRating.view?id=1001&rating=0")
    assert r.status_code == 200
    assert calls[0][2]["rating"] == "-1"


def test_set_rating_requires_id(client, plex_session):
    r = client.get("/rest/setRating.view?rating=3")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_set_rating_rejects_out_of_range(client, plex_session):
    r = client.get("/rest/setRating.view?id=1001&rating=9")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


# ── Play tracking ────────────────────────────────────────────────────────────


def test_scrobble_submission_true_marks_played(client, plex_session, monkeypatch):
    fake_client, calls = _fake_px_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/scrobble.view?id=9001&submission=true")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"
    method, url, params = calls[0]
    assert method == "PUT"
    assert url.endswith("/:/scrobble")
    assert params == {"key": "9001", "identifier": "com.plexapp.plugins.library"}


def test_scrobble_submission_false_is_a_noop(client, plex_session, monkeypatch):
    fake_client, calls = _fake_px_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/scrobble.view?id=9001&submission=false")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"
    assert calls == []


def test_scrobble_requires_id(client, plex_session):
    r = client.get("/rest/scrobble.view?submission=true")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


# ── Playlists ─────────────────────────────────────────────────────────────────


def test_get_playlists_returns_mapped_list(client, plex_session, monkeypatch):
    fake_client, _calls = _fake_px_client(
        {
            "/playlists": {
                "MediaContainer": {
                    "Metadata": [{"ratingKey": "5001", "title": "Road Trip", "leafCount": 10}]
                }
            }
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getPlaylists.view")
    assert r.status_code == 200
    playlist = r.json()["subsonic-response"]["playlists"]["playlist"][0]
    assert playlist["id"] == "5001"
    assert playlist["name"] == "Road Trip"
    assert playlist["songCount"] == 10


def test_get_playlist_includes_entries(client, plex_session, monkeypatch):
    fake_client, _calls = _fake_px_client(
        {
            "/playlists/5001": {
                "MediaContainer": {"Metadata": [{"ratingKey": "5001", "title": "Road Trip"}]}
            },
            "/playlists/5001/items": {
                "MediaContainer": {
                    "Metadata": [{"ratingKey": "9001", "title": "Track 1", "duration": 0}]
                }
            },
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getPlaylist.view?id=5001")
    assert r.status_code == 200
    playlist = r.json()["subsonic-response"]["playlist"]
    assert playlist["id"] == "5001"
    assert playlist["entry"][0]["id"] == "9001"


def test_get_playlist_raises_when_not_found(client, plex_session, monkeypatch):
    fake_client, _ = _fake_px_client({"/playlists/9999": {"MediaContainer": {"Metadata": []}}})
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getPlaylist.view?id=9999")

    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "failed"
    assert "9999" in body["error"]["message"]


def test_create_playlist_builds_server_uri(client, plex_session, monkeypatch):
    plex_session.media.machine_identifier = "machine-abc"
    fake_client, calls = _fake_px_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/createPlaylist.view?name=Road+Trip&songId=1&songId=2")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"
    method, url, params = calls[0]
    assert method == "POST"
    assert url.endswith("/playlists")
    assert params["title"] == "Road Trip"
    assert params["uri"] == (
        "server://machine-abc/com.plexapp.plugins.library/library/metadata/1,2"
    )


def test_create_playlist_requires_at_least_one_song(client, plex_session):
    r = client.get("/rest/createPlaylist.view?name=Empty")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_create_playlist_requires_machine_identifier(client, plex_session, monkeypatch):
    plex_session.media.machine_identifier = ""
    fake_client, _calls = _fake_px_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/createPlaylist.view?name=X&songId=1")
    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "failed"
    assert "identifier" in body["error"]["message"]


def test_update_playlist_adds_songs(client, plex_session, monkeypatch):
    plex_session.media.machine_identifier = "machine-abc"
    fake_client, calls = _fake_px_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/updatePlaylist.view?playlistId=5001&songIdToAdd=1")
    assert r.status_code == 200
    method, url, params = calls[0]
    assert method == "PUT"
    assert url.endswith("/playlists/5001/items")
    assert "metadata/1" in params["uri"]


def test_update_playlist_removes_by_index(client, plex_session, monkeypatch):
    fake_client, calls = _fake_px_client(
        {
            "/playlists/5001/items": {
                "MediaContainer": {
                    "Metadata": [
                        {"ratingKey": "9001", "playlistItemID": 111},
                        {"ratingKey": "9002", "playlistItemID": 112},
                    ]
                }
            }
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/updatePlaylist.view?playlistId=5001&songIndexToRemove=1")
    assert r.status_code == 200
    delete_calls = [c for c in calls if c[0] == "DELETE"]
    assert len(delete_calls) == 1
    assert delete_calls[0][1].endswith("/playlists/5001/items/112")


def test_update_playlist_renames(client, plex_session, monkeypatch):
    fake_client, calls = _fake_px_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/updatePlaylist.view?playlistId=5001&name=New+Name")
    assert r.status_code == 200
    method, url, params = calls[0]
    assert method == "PUT"
    assert url.endswith("/playlists/5001")
    assert params["title"] == "New Name"


def test_update_playlist_requires_some_change(client, plex_session):
    r = client.get("/rest/updatePlaylist.view?playlistId=5001")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_delete_playlist(client, plex_session, monkeypatch):
    fake_client, calls = _fake_px_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/deletePlaylist.view?id=5001")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"
    assert calls[0] == ("DELETE", "http://plex:32400/playlists/5001", {})


def test_unhandled_path_returns_not_supported_envelope(client, plex_session):
    r = client.get("/rest/star.view?id=1")
    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "failed"
    assert "not supported on Plex yet" in body["error"]["message"]


def test_stream_view_streams_binary(client, plex_session, monkeypatch):
    monkeypatch.setattr(
        plex_session.media,
        "get_stream_url",
        lambda track_id: "http://plex:32400/library/parts/999/file.mp3?X-Plex-Token=tok",
    )
    mock_client, captured = _mock_binary_httpx_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: mock_client)

    r = client.get("/rest/stream.view?id=9001")
    assert r.status_code == 200
    assert r.content == b"abc"
    assert captured["url"] == "http://plex:32400/library/parts/999/file.mp3?X-Plex-Token=tok"


def test_stream_view_requires_id(client, plex_session):
    r = client.get("/rest/stream.view")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


# ── Binary passthrough (getCoverArt.view) ────────────────────────────────────


def _mock_binary_httpx_client():
    captured: dict = {}
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.headers = {"content-type": "image/jpeg"}

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


def test_get_cover_art_streams_binary(client, plex_session, monkeypatch):
    mock_client, captured = _mock_binary_httpx_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: mock_client)

    r = client.get("/rest/getCoverArt.view?id=2001")
    assert r.status_code == 200
    assert r.content == b"abc"
    assert "/library/metadata/2001/thumb" in captured["url"]


def test_get_cover_art_requires_id(client, plex_session):
    r = client.get("/rest/getCoverArt.view")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_get_cover_art_fails_cleanly_when_no_art_url_is_available(
    client, plex_session, monkeypatch
):
    monkeypatch.setattr(plex_session.media, "get_cover_art_url", lambda *a, **k: None)

    r = client.get("/rest/getCoverArt.view?id=2001")

    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_stream_view_forwards_range_header(client, plex_session, monkeypatch):
    monkeypatch.setattr(
        plex_session.media, "get_stream_url", lambda track_id: "http://plex/file.mp3"
    )
    mock_client, captured = _mock_binary_httpx_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: mock_client)

    r = client.get("/rest/stream.view?id=9001", headers={"Range": "bytes=0-100"})

    assert r.status_code == 200
    assert captured["headers"]["Range"] == "bytes=0-100"


def test_binary_handler_exception_returns_failed_envelope_not_500(
    client, plex_session, monkeypatch
):
    """Same as jellyfin_bridge.py's identical guard — a Plex connectivity
    blip mid cover-art-load or mid-stream must degrade like every other
    endpoint here instead of surfacing as a raw 500."""

    async def broken_stream_binary(request, url, media):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(plex_bridge, "_stream_binary", broken_stream_binary)

    r = client.get("/rest/getCoverArt.view?id=2001")

    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "failed"


def test_create_playlist_with_id_reorders_by_moving_after_another_entry(
    client, plex_session, monkeypatch
):
    """The Plex half of the same "replace the song list" call the Jellyfin
    bridge implements — Plex places an entry by naming the one it should
    follow rather than by index."""
    fake_client, calls = _fake_px_client(
        {
            "/playlists/5001/items": {
                "MediaContainer": {
                    "Metadata": [
                        {"ratingKey": "1", "playlistItemID": 11},
                        {"ratingKey": "2", "playlistItemID": 12},
                        {"ratingKey": "3", "playlistItemID": 13},
                    ]
                }
            }
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    # Track 1 dragged to the end.
    r = client.get("/rest/createPlaylist.view?playlistId=5001&songId=2&songId=3&songId=1")
    assert r.status_code == 200
    assert r.json()["subsonic-response"]["status"] == "ok"

    assert not [c for c in calls if c[0] == "DELETE"]
    moves = [c for c in calls if c[0] == "PUT"]
    assert len(moves) == 1
    _method, url, params = moves[0]
    assert url.endswith("/playlists/5001/items/11/move")
    assert params == {"after": "13"}


def test_create_playlist_with_id_moving_to_the_front_sends_no_anchor(
    client, plex_session, monkeypatch
):
    # Plex's own way of saying "first": no `after` at all. Sending one
    # would put the track second instead.
    fake_client, calls = _fake_px_client(
        {
            "/playlists/5001/items": {
                "MediaContainer": {
                    "Metadata": [
                        {"ratingKey": "1", "playlistItemID": 11},
                        {"ratingKey": "2", "playlistItemID": 12},
                    ]
                }
            }
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/createPlaylist.view?playlistId=5001&songId=2&songId=1")
    assert r.status_code == 200
    move = next(c for c in calls if c[0] == "PUT")
    assert move[1].endswith("/playlists/5001/items/12/move")
    assert move[2] == {}


def test_create_playlist_with_id_removes_one_entry_at_a_time(client, plex_session, monkeypatch):
    # Unlike Jellyfin, Plex has no bulk delete — one request per dropped
    # entry.
    fake_client, calls = _fake_px_client(
        {
            "/playlists/5001/items": {
                "MediaContainer": {
                    "Metadata": [
                        {"ratingKey": "1", "playlistItemID": 11},
                        {"ratingKey": "2", "playlistItemID": 12},
                        {"ratingKey": "3", "playlistItemID": 13},
                    ]
                }
            }
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/createPlaylist.view?playlistId=5001&songId=2")
    assert r.status_code == 200
    deleted = [c[1] for c in calls if c[0] == "DELETE"]
    assert len(deleted) == 2
    assert deleted[0].endswith("/playlists/5001/items/11")
    assert deleted[1].endswith("/playlists/5001/items/13")


# The shape of a real Plex lyric stream, taken verbatim from a live server
# (2026-08-27): lines already timed in milliseconds, each split into spans
# that Plex uses for per-word timing.
_LYRIC_STREAM = {
    "MediaContainer": {
        "size": 1,
        "Lyrics": [
            {
                "provider": "com.plexapp.agents.localmedia",
                "timed": True,
                "Line": [
                    {
                        "startOffset": 13000,
                        "endOffset": 16310,
                        "Span": [{"text": "Common love isn't for us", "startOffset": 13000}],
                    },
                    {
                        "startOffset": 16310,
                        "Span": [{"text": "We created something "}, {"text": "phenomenal"}],
                    },
                ],
            }
        ],
    }
}


def _track_with_lyric_stream(stream_key: str = "/library/streams/21182") -> dict:
    return {
        "MediaContainer": {
            "Metadata": [
                {
                    "ratingKey": "2978",
                    "Media": [
                        {
                            "Part": [
                                {
                                    "Stream": [
                                        {"id": 1744, "streamType": 2, "codec": "mp3"},
                                        {"id": 21182, "streamType": 4, "key": stream_key},
                                    ]
                                }
                            ]
                        }
                    ],
                }
            ]
        }
    }


def test_get_lyrics_reads_the_tracks_own_lyric_stream(client, plex_session, monkeypatch):
    fake_client, _calls = _fake_px_client(
        {
            "/library/metadata/2978": _track_with_lyric_stream(),
            "/library/streams/21182": _LYRIC_STREAM,
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getLyricsBySongId.view?id=2978")
    assert r.status_code == 200
    lyrics = r.json()["subsonic-response"]["lyricsList"]["structuredLyrics"]
    assert lyrics[0]["synced"] is True
    # Plex times lines in milliseconds already, and a line's spans join back
    # into the one string per line the Subsonic extension expects.
    assert lyrics[0]["line"] == [
        {"start": 13000, "value": "Common love isn't for us"},
        {"start": 16310, "value": "We created something phenomenal"},
    ]


def test_get_lyrics_is_empty_for_a_track_without_a_lyric_stream(client, plex_session, monkeypatch):
    fake_client, _calls = _fake_px_client(
        {
            "/library/metadata/21929": {
                "MediaContainer": {
                    "Metadata": [{"Media": [{"Part": [{"Stream": [{"id": 1, "streamType": 2}]}]}]}]
                }
            }
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getLyricsBySongId.view?id=21929")
    assert r.status_code == 200
    body = r.json()["subsonic-response"]
    assert body["status"] == "ok"
    assert body["lyricsList"] == {}


def test_get_lyrics_survives_a_stream_whose_file_is_gone(client, plex_session, monkeypatch):
    """Deleting the .lrc leaves the stream listed on the track, serving
    nothing, until Plex re-examines it (seen live 2026-08-27). That must
    read as "no lyrics", not as a failure."""
    fake_client, _calls = _fake_px_client(
        {
            "/library/metadata/2978": _track_with_lyric_stream(),
            "/library/streams/21182": {"MediaContainer": {"size": 0}},
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getLyricsBySongId.view?id=2978")
    assert r.json()["subsonic-response"]["lyricsList"] == {}


def test_get_lyrics_marks_untimed_lyrics_as_unsynced(client, plex_session, monkeypatch):
    fake_client, _calls = _fake_px_client(
        {
            "/library/metadata/2978": _track_with_lyric_stream(),
            "/library/streams/21182": {
                "MediaContainer": {
                    "Lyrics": [{"timed": False, "Line": [{"Span": [{"text": "Just words"}]}]}]
                }
            },
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    lyrics = client.get("/rest/getLyricsBySongId.view?id=2978").json()["subsonic-response"][
        "lyricsList"
    ]["structuredLyrics"]
    assert lyrics[0]["synced"] is False
    # No start key at all rather than a made-up 0.
    assert lyrics[0]["line"] == [{"value": "Just words"}]


def test_get_user_reads_admin_from_what_the_server_allows(client, plex_session, monkeypatch):
    """Plex has no role to read: a server has exactly one owner and
    everyone else is a shared user. What separates them is what the server
    lets them call, so asking for its own settings *is* the test."""
    fake_client, calls = _fake_px_client({"/:/prefs": {"MediaContainer": {"Setting": []}}})
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getUser.view?username=thomas")
    assert r.json()["subsonic-response"]["user"] == {"username": "thomas", "adminRole": True}
    assert calls[0][1].endswith("/:/prefs")


def test_get_user_treats_a_refused_settings_call_as_not_admin(client, plex_session, monkeypatch):
    fake_client, _calls = _fake_px_client()
    original = fake_client.request

    async def forbidden(method, url, headers=None, params=None):
        response = await original(method, url, headers=headers, params=params)
        if url.endswith("/:/prefs"):
            request = httpx.Request(method, url)
            response.raise_for_status = MagicMock(
                side_effect=httpx.HTTPStatusError(
                    "403", request=request, response=httpx.Response(403, request=request)
                )
            )
        return response

    fake_client.request = forbidden
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/getUser.view?username=shared")
    # A clean answer, not an error: the frontend uses this to decide whether
    # to offer a rescan at all.
    assert r.json()["subsonic-response"]["user"]["adminRole"] is False


def test_start_scan_refreshes_the_music_section_only(client, plex_session, monkeypatch):
    """Everything else in a Plex library (films, series) is none of
    Beacon's business."""
    fake_client, calls = _fake_px_client(
        {"/library/sections": {"MediaContainer": {"Directory": [{"key": "5", "type": "artist"}]}}}
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    r = client.get("/rest/startScan.view")
    assert r.json()["subsonic-response"]["scanStatus"] == {"scanning": True}
    assert any(c[1].endswith("/library/sections/5/refresh") for c in calls)


_MUSIC_SECTION = {"MediaContainer": {"Directory": [{"key": "5", "type": "artist"}]}}


def test_scan_status_reports_a_running_section_scan(client, plex_session, monkeypatch):
    fake_client, _calls = _fake_px_client(
        {
            "/library/sections": _MUSIC_SECTION,
            "/activities": {
                "MediaContainer": {
                    "Activity": [
                        {"type": "library.update.item.metadata", "progress": -1},
                        {
                            "type": "library.update.section",
                            "progress": 42,
                            "Context": {"librarySectionID": "5"},
                        },
                    ]
                }
            },
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    status = client.get("/rest/getScanStatus.view").json()["subsonic-response"]["scanStatus"]
    assert status == {"scanning": True, "progress": 42}


def test_scan_status_omits_a_progress_plex_cannot_state(client, plex_session, monkeypatch):
    # -1 is Plex's own "no idea how far along this is".
    fake_client, _calls = _fake_px_client(
        {
            "/library/sections": _MUSIC_SECTION,
            "/activities": {
                "MediaContainer": {"Activity": [{"type": "library.update.section", "progress": -1}]}
            },
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    status = client.get("/rest/getScanStatus.view").json()["subsonic-response"]["scanStatus"]
    assert status == {"scanning": True}


def test_scan_status_ignores_a_scan_of_another_library(client, plex_session, monkeypatch):
    """A film library being scanned is not this scan — Beacon would
    otherwise report a scan it never started and poll until that one ends."""
    fake_client, _calls = _fake_px_client(
        {
            "/library/sections": _MUSIC_SECTION,
            "/activities": {
                "MediaContainer": {
                    "Activity": [
                        {
                            "type": "library.update.section",
                            "progress": 10,
                            "Context": {"librarySectionID": "9"},
                        }
                    ]
                }
            },
        }
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    status = client.get("/rest/getScanStatus.view").json()["subsonic-response"]["scanStatus"]
    assert status == {"scanning": False}


def test_scan_status_reports_an_idle_server_as_finished(client, plex_session, monkeypatch):
    fake_client, _calls = _fake_px_client(
        {"/library/sections": _MUSIC_SECTION, "/activities": {"MediaContainer": {}}}
    )
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    status = client.get("/rest/getScanStatus.view").json()["subsonic-response"]["scanStatus"]
    assert status == {"scanning": False}
