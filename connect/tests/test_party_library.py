"""core/party_library.py: guests' library lookups answered by the media
server itself while the host casts - Navidrome directly, Jellyfin and Plex
through their bridges - in the shape the host's window answers them in."""

import pytest

from core import party_library
from media import jellyfin_bridge, plex_bridge
from media.base import Track
from media.jellyfin import JellyfinClient
from media.plex import PlexClient
from media.subsonic import SubsonicClient

SEARCH_RESULT = {
    "searchResult3": {
        "song": [
            {
                "id": "s1",
                "title": "Harbor Lights",
                "artist": "The Tide",
                "album": "Low Water",
                "duration": 201,
                "coverArt": "al-1",
            }
        ],
        "album": [
            {
                "id": "al-1",
                "name": "Low Water",
                "artist": "The Tide",
                "year": 2019,
                "coverArt": "al-1",
            }
        ],
    }
}


@pytest.fixture
def navidrome(monkeypatch):
    media = SubsonicClient("http://navidrome:4533", user="u", password="p")
    asked = []

    def fake_get(endpoint, **params):
        asked.append((endpoint, params))
        if endpoint == "getAlbum.view":
            return {
                "album": {
                    **SEARCH_RESULT["searchResult3"]["album"][0],
                    "song": SEARCH_RESULT["searchResult3"]["song"],
                }
            }
        return SEARCH_RESULT

    monkeypatch.setattr(media, "_get", fake_get)
    return media, asked


async def test_songs_come_back_as_the_window_would_answer(navidrome):
    media, asked = navidrome
    result = await party_library.search_songs(media, "harbor", 30, 10)
    assert result["items"] == [
        {
            "id": "s1",
            "title": "Harbor Lights",
            "artist": "The Tide",
            "album": "Low Water",
            "duration": 201,
            "cover_art_id": "al-1",
        }
    ]
    endpoint, params = asked[0]
    assert endpoint == "search3.view"
    assert params["query"] == "harbor"
    assert (params["songCount"], params["songOffset"]) == ("10", "30")
    # Only songs: an album or artist list nobody shows is work for nothing.
    assert (params["albumCount"], params["artistCount"]) == ("0", "0")


async def test_albums_come_back_as_the_window_would_answer(navidrome):
    media, asked = navidrome
    result = await party_library.search_albums(media, "low", 0, 20)
    assert result["items"] == [
        {
            "id": "al-1",
            "name": "Low Water",
            "artist": "The Tide",
            "year": 2019,
            "cover_art_id": "al-1",
        }
    ]
    assert asked[0][1]["songCount"] == "0"


async def test_an_album_comes_with_its_songs(navidrome):
    media, _ = navidrome
    result = await party_library.get_album(media, "al-1")
    assert result["album"]["name"] == "Low Water"
    assert [s["title"] for s in result["songs"]] == ["Harbor Lights"]


@pytest.mark.parametrize(
    ("bridge", "media"),
    [
        (jellyfin_bridge, JellyfinClient("http://jf:8096", token="t", user_id="u")),
        (plex_bridge, PlexClient("http://plex:32400", token="t")),
    ],
)
async def test_jellyfin_and_plex_answer_through_their_bridges(monkeypatch, bridge, media):
    asked = []

    async def fake_search3(params, client):
        asked.append((params, client))
        return SEARCH_RESULT

    monkeypatch.setitem(bridge._HANDLERS, "search3.view", fake_search3)
    result = await party_library.search_songs(media, "harbor", 0, 10)
    assert [s["title"] for s in result["items"]] == ["Harbor Lights"]
    assert asked[0][1] is media
    assert asked[0][0]["query"] == "harbor"


async def test_a_song_is_looked_up_by_id(monkeypatch):
    media = SubsonicClient("http://navidrome:4533", user="u", password="p")
    monkeypatch.setattr(
        media, "get_track", lambda song_id: Track(id=song_id, title="T", artist="A", duration=3)
    )
    song = await party_library.get_song(media, "z")
    assert (song["id"], song["title"], song["artist"]) == ("z", "T", "A")
