"""routes/deezer.py — GET /deezer/songs, /playlists, /preview, /album and /genres

Machine-to-machine (CONNECT_TOKEN), like routes/listenbrainz.py: no session,
no key, nothing to configure. See core/deezer.py.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from core import deezer
from core.auth import require_token

logger = logging.getLogger("connect.deezer")
router = APIRouter(prefix="/deezer", dependencies=[Depends(require_token)])


# "songs", not "tracks": ad-blocker lists block a /tracks segment (see
# routes/lastfm.py).
@router.get("/songs")
async def songs(
    op: Literal["charts", "artist", "radio", "playlist"],
    limit: int = Query(default=50, ge=1, le=200),
    genre: int = 0,
    artist: str = "",
    playlist: int = 0,
) -> dict:
    try:
        if op == "charts":
            result = await deezer.get_chart(genre, limit)
        elif op == "playlist":
            if not playlist:
                raise HTTPException(status_code=422, detail="playlist needs a playlist id")
            result = await deezer.get_playlist_tracks(playlist)
        else:
            if not artist.strip():
                raise HTTPException(status_code=422, detail=f"{op} needs an artist name")
            fetch = deezer.get_artist_top if op == "artist" else deezer.get_artist_radio
            result = await fetch(artist.strip(), limit)
    except deezer.DeezerError as e:
        raise HTTPException(status_code=404 if e.not_found else 502, detail=str(e)) from e
    return {"tracks": result}


@router.get("/playlists")
async def playlists(q: str = "") -> dict:
    """The builder's playlist picker: popular playlists, a search, or the
    playlist behind a pasted Deezer link."""
    try:
        result = await deezer.search_playlists(q)
    except deezer.DeezerError as e:
        raise HTTPException(status_code=404 if e.not_found else 502, detail=str(e)) from e
    return {"playlists": result}


@router.get("/preview")
async def preview(artist: str = "", title: str = "", id: int = 0) -> dict:
    """Which Deezer track a 30-second preview can be played of, by Deezer
    track id or by artist and title. id 0 when Deezer has none - an
    ordinary answer for a track it does not carry, not an error."""
    if not id and not (artist.strip() and title.strip()):
        raise HTTPException(status_code=422, detail="preview needs an id or artist and title")
    try:
        result = await deezer.get_preview(artist.strip(), title.strip(), id)
    except deezer.DeezerError as e:
        if not e.not_found:
            raise HTTPException(status_code=502, detail=str(e)) from e
        result = None
    return result or {"id": 0, "link": ""}


@router.get("/album")
async def album(artist: str = "", title: str = "") -> dict:
    """The largest Deezer edition of an album, for the album page's missing
    tracks. `album` null when Deezer does not carry it - an ordinary answer,
    like /preview's id 0."""
    if not (artist.strip() and title.strip()):
        raise HTTPException(status_code=422, detail="album needs an artist and a title")
    try:
        result = await deezer.get_album(artist.strip(), title.strip())
    except deezer.DeezerError as e:
        if not e.not_found:
            raise HTTPException(status_code=502, detail=str(e)) from e
        result = None
    return {"album": result}


@router.get("/genres")
async def genres(lang: str = "") -> dict:
    """`lang` is the app's language, so the genre picker reads in it."""
    try:
        result = await deezer.get_genres(lang)
    except deezer.DeezerError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"genres": result}
