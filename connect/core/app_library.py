"""core/app_library.py - the library an app with the library right browses.

Asked of the media server with the login the key carries (core/media_login.py),
never through a window: on a server nobody may be signed in. The same
Subsonic calls party guests' lookups make (core/party_library.py), through
the bridges for Jellyfin and Plex.

Field lists of their own, since these answers are part of /device-link/v1/.
"""

from core.party_library import album_fields, get_album, search_songs, song_fields, subsonic_call


def _playlist_fields(playlist: dict) -> dict:
    return {
        "id": playlist.get("id"),
        "name": playlist.get("name"),
        "song_count": playlist.get("songCount") or 0,
        "cover_art_id": playlist.get("coverArt"),
    }


async def playlists(media) -> dict:
    data = await subsonic_call(media, "getPlaylists.view")
    found = (data.get("playlists") or {}).get("playlist") or []
    return {"items": [_playlist_fields(p) for p in found]}


async def playlist(media, playlist_id: str) -> dict | None:
    data = await subsonic_call(media, "getPlaylist.view", id=playlist_id)
    found = data.get("playlist")
    if not found:
        return None
    return {
        "playlist": _playlist_fields(found),
        "songs": [song_fields(s) for s in found.get("entry") or []],
    }


async def albums(media, search: str, offset: int, limit: int) -> dict:
    """By name without a search, so an app can page through all of them."""
    if search:
        data = await subsonic_call(
            media,
            "search3.view",
            query=search,
            albumCount=str(limit),
            albumOffset=str(offset),
            songCount="0",
            artistCount="0",
        )
        found = (data.get("searchResult3") or {}).get("album") or []
    else:
        data = await subsonic_call(
            media,
            "getAlbumList2.view",
            type="alphabeticalByName",
            size=str(limit),
            offset=str(offset),
        )
        found = (data.get("albumList2") or {}).get("album") or []
    return {"items": [album_fields(a) for a in found]}


async def album(media, album_id: str) -> dict | None:
    found = await get_album(media, album_id)
    return found if found["album"] else None


async def songs(media, search: str, offset: int, limit: int) -> dict:
    return {"items": (await search_songs(media, search, offset, limit))["items"]}


async def _stations(media) -> list[dict]:
    data = await subsonic_call(media, "getInternetRadioStations.view")
    return (data.get("internetRadioStations") or {}).get("internetRadioStation") or []


async def radio_station(media, station_id: str) -> dict | None:
    """With its stream address, which the list leaves out: that is only for
    playing it."""
    found = next((s for s in await _stations(media) if s.get("id") == station_id), None)
    if found is None or not found.get("streamUrl"):
        return None
    return {
        "id": found["id"],
        "name": found.get("name") or "Radio",
        "stream_url": found["streamUrl"],
        "home_page_url": found.get("homePageUrl") or None,
    }


async def radio_stations(media) -> dict:
    found = await _stations(media)
    return {
        "items": [
            {
                "id": station.get("id"),
                "name": station.get("name"),
                "home_page_url": station.get("homePageUrl") or None,
            }
            for station in found
        ]
    }
