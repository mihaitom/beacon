"""routes/lastfm.py — GET /lastfm/songs

Machine-to-machine (CONNECT_TOKEN), not session-scoped: like
routes/recommendations.py, nothing here touches session.media. The answer
is a list of title/artist names straight from Last.fm — finding the ones
that exist in the library is the renderer's job (see core/lastfm.py's
docstring for why).

The key this needs is read from core/api_keys.py; managing it (status,
storing, clearing) lives in routes/api_keys.py for every keyed service at
once, not here.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from core import lastfm
from core.auth import require_token

logger = logging.getLogger("connect.lastfm")
router = APIRouter(prefix="/lastfm", dependencies=[Depends(require_token)])

# The period values user.getTopTracks accepts. Validated here rather than
# passed through so a typo comes back as a 422 naming the alternatives,
# instead of Last.fm's generic "invalid parameters" error 6.
Period = Literal["overall", "7day", "1month", "3month", "6month", "12month"]


# The path says "songs" while everything else here says "tracks": ad-blocker
# filter lists flag a /tracks segment as a tracker endpoint, which had the
# web build's requests blocked before they reached connect. The payload is a
# track list either way.
@router.get("/songs")
async def tracks(
    op: Literal["charts", "genre", "artist", "mytop"],
    limit: int = Query(default=50, ge=1, le=500),
    country: str = "",
    tag: str = "",
    artist: str = "",
    username: str = "",
    period: Period = "1month",
) -> dict:
    if not lastfm.is_configured():
        raise HTTPException(
            status_code=503,
            detail="No Last.fm API key configured for this installation",
        )

    try:
        if op == "charts":
            # No country means the global chart; the frontend sends one or
            # the other rather than a separate op for each.
            if country:
                result = await lastfm.get_geo_top_tracks(country, limit)
            else:
                result = await lastfm.get_global_top_tracks(limit)
        elif op == "genre":
            if not tag:
                raise HTTPException(status_code=422, detail="genre needs a tag")
            result = await lastfm.get_tag_top_tracks(tag, limit)
        elif op == "artist":
            if not artist:
                raise HTTPException(status_code=422, detail="artist needs an artist name")
            result = await lastfm.get_artist_top_tracks(artist, limit)
        else:
            if not username:
                raise HTTPException(status_code=422, detail="mytop needs a Last.fm username")
            result = await lastfm.get_user_top_tracks(username, period, limit)
    except lastfm.LastfmError as e:
        # 404 for something the user can correct (an unknown username,
        # artist or tag), 502 for anything upstream they cannot.
        raise HTTPException(status_code=404 if e.not_found else 502, detail=str(e)) from e

    return {"tracks": result}
