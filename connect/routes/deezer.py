"""routes/deezer.py — GET /deezer/songs and /deezer/genres

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
    op: Literal["charts", "artist"],
    limit: int = Query(default=50, ge=1, le=200),
    genre: int = 0,
    artist: str = "",
) -> dict:
    try:
        if op == "charts":
            result = await deezer.get_chart(genre, limit)
        else:
            if not artist.strip():
                raise HTTPException(status_code=422, detail="artist needs an artist name")
            result = await deezer.get_artist_top(artist.strip(), limit)
    except deezer.DeezerError as e:
        raise HTTPException(status_code=404 if e.not_found else 502, detail=str(e)) from e
    return {"tracks": result}


@router.get("/genres")
async def genres(lang: str = "") -> dict:
    """`lang` is the app's language, so the genre picker reads in it."""
    try:
        result = await deezer.get_genres(lang)
    except deezer.DeezerError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"genres": result}
