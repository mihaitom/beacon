"""What party guests look up in the library while the host casts: search,
an album, a song's title for the queue. Asked of the host's media server
directly, so it works while the host's window sleeps (see
docs/plans/party-mode-server-side.md). Without a cast, the window answers
these itself, out of the library it has loaded (routes/party.py relays
them there).

Answers come back in the shape the window's own answers have (see
src/renderer/src/services/remoteControl/commands.ts's songs-request,
albums-request and album-request), so routes/party.py treats both alike.
"""

import asyncio

from media import jellyfin_bridge, plex_bridge
from media.jellyfin import JellyfinClient
from media.plex import PlexClient


async def _subsonic(media, endpoint: str, **params: str) -> dict:
    """One Subsonic call to whichever server the session talks to: Navidrome
    directly, Jellyfin and Plex through their bridges."""
    if isinstance(media, JellyfinClient):
        return await jellyfin_bridge.call(endpoint, params, media)
    if isinstance(media, PlexClient):
        return await plex_bridge.call(endpoint, params, media)
    return await asyncio.to_thread(media._get, endpoint, **params)


def _song(song: dict) -> dict:
    return {
        "id": song.get("id"),
        "title": song.get("title"),
        "artist": song.get("artist"),
        "album": song.get("album"),
        "duration": song.get("duration"),
        "cover_art_id": song.get("coverArt"),
    }


def _album(album: dict) -> dict:
    return {
        "id": album.get("id"),
        "name": album.get("name"),
        "artist": album.get("artist"),
        "year": album.get("year"),
        "cover_art_id": album.get("coverArt"),
    }


async def search_songs(media, search: str, offset: int, limit: int) -> dict:
    data = await _subsonic(
        media,
        "search3.view",
        query=search,
        songCount=str(limit),
        songOffset=str(offset),
        albumCount="0",
        artistCount="0",
    )
    songs = [_song(s) for s in (data.get("searchResult3") or {}).get("song") or []]
    # search3 does not say how many there are in all; the guest page only
    # reads the items anyway.
    return {"items": songs, "total": offset + len(songs)}


async def search_albums(media, search: str, offset: int, limit: int) -> dict:
    data = await _subsonic(
        media,
        "search3.view",
        query=search,
        albumCount=str(limit),
        albumOffset=str(offset),
        songCount="0",
        artistCount="0",
    )
    albums = [_album(a) for a in (data.get("searchResult3") or {}).get("album") or []]
    return {"items": albums, "total": offset + len(albums)}


async def get_album(media, album_id: str) -> dict:
    data = await _subsonic(media, "getAlbum.view", id=album_id)
    album = data.get("album")
    if not album:
        return {"album": None, "songs": []}
    return {"album": _album(album), "songs": [_song(s) for s in album.get("song") or []]}


async def get_song(media, song_id: str) -> dict:
    track = await asyncio.to_thread(media.get_track, song_id)
    return {
        "id": track.id,
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "duration": track.duration,
        "cover_art_id": track.cover_art_id,
    }
