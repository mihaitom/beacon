"""routes/recommendations.py — GET /recommendations/similar-artists,
GET /recommendations/artist-images

Machine-to-machine (CONNECT_TOKEN), not session-scoped — neither touches
session.media, both are pure MusicBrainz/ListenBrainz/Deezer lookups keyed
on whatever artist names the frontend already knows (see
core/recommendations.py). Opt-out lives entirely in the frontend (a
localStorage toggle — see stores/recommendations.ts): if the setting is
off, HomeView.vue just never calls either of these at all.
"""

from fastapi import APIRouter, Depends, Query

from core.auth import require_token
from core.recommendations import get_artist_images, get_similar_artists

router = APIRouter(prefix="/recommendations", dependencies=[Depends(require_token)])


@router.get("/similar-artists")
async def similar_artists(seed: list[str] = Query(default=[]), limit: int = 100):
    artists = await get_similar_artists(seed, limit=limit)
    return {"artists": artists}


@router.get("/artist-images")
async def artist_images(name: list[str] = Query(default=[])):
    images = await get_artist_images(name)
    return {"images": images}
