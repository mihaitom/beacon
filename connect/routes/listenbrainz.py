"""routes/listenbrainz.py — GET /listenbrainz/songs

Machine-to-machine (CONNECT_TOKEN), not session-scoped: like
routes/lastfm.py and routes/recommendations.py, nothing here touches
session.media. The answer is a list of title/artist names (plus display
fields where ListenBrainz knows them) straight from ListenBrainz — finding
the ones that exist in the library is the renderer's job (see
core/listenbrainz.py's docstring for why).

No API key and no configuration: ListenBrainz's stats, popularity and
collaborative-filtering endpoints are public, so a username is all a query
needs. There is deliberately no /status or /api-key counterpart to
routes/lastfm.py's.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from core import listenbrainz
from core.auth import require_token

logger = logging.getLogger("connect.listenbrainz")
router = APIRouter(prefix="/listenbrainz", dependencies=[Depends(require_token)])

# The stats ranges ListenBrainz accepts. Validated here rather than passed
# through so a typo comes back as a 422 naming the alternatives, instead of
# ListenBrainz's own generic 400.
Period = Literal["week", "month", "quarter", "half_yearly", "year", "all_time"]


# "songs" rather than "tracks" in the path for the reason routes/lastfm.py
# gives: ad-blocker filter lists block a /tracks segment.
@router.get("/songs")
async def tracks(
    op: Literal["charts", "genre", "artist", "mytop", "recommended"],
    limit: int = Query(default=50, ge=1, le=500),
    artist: str = "",
    tag: str = "",
    username: str = "",
    period: Period = "month",
) -> dict:
    try:
        if op == "charts":
            result = await listenbrainz.get_sitewide_top_recordings(period, limit)
        elif op == "genre":
            if not tag:
                raise HTTPException(status_code=422, detail="genre needs a tag")
            result = await listenbrainz.get_tag_recordings(tag, limit)
        elif op == "artist":
            if not artist:
                raise HTTPException(status_code=422, detail="artist needs an artist name")
            result = await listenbrainz.get_artist_top_recordings(artist, limit)
        elif op == "mytop":
            if not username:
                raise HTTPException(status_code=422, detail="mytop needs a ListenBrainz username")
            result = await listenbrainz.get_user_top_recordings(username, period, limit)
        else:
            if not username:
                raise HTTPException(
                    status_code=422, detail="recommended needs a ListenBrainz username"
                )
            result = await listenbrainz.get_recommendations(username, limit)
    except listenbrainz.ListenbrainzError as e:
        # 404 for something the listener can correct (an unknown username or
        # artist), 502 for anything upstream they cannot.
        raise HTTPException(status_code=404 if e.not_found else 502, detail=str(e)) from e

    return {"tracks": result}


@router.get("/artists")
async def artists(username: str, limit: int = Query(default=30, ge=1, le=100)) -> dict:
    """The artists behind the listener's recommended recordings — Home's
    personalized shelf. Same shape as routes/recommendations.py's
    similar-artists ({name, mbid, score}), so the frontend reuses its
    enrichment and shelf component unchanged."""
    try:
        result = await listenbrainz.get_recommended_artists(username, limit)
    except listenbrainz.ListenbrainzError as e:
        raise HTTPException(status_code=404 if e.not_found else 502, detail=str(e)) from e

    return {"artists": result}
