"""routes/recommendations.py — GET /recommendations/similar-artists,
GET /recommendations/artist-images, GET /recommendations/artist-links,
GET /recommendations/artist-links-by-mbid

Machine-to-machine (CONNECT_TOKEN), not session-scoped — none of these
touch session.media, all are pure MusicBrainz/ListenBrainz/Deezer lookups
keyed on whatever artist names (or, for artist-links-by-mbid, MBIDs) the
frontend already knows (see core/recommendations.py). Opt-out lives
entirely in the frontend (a localStorage toggle — see
stores/recommendations.ts): similar-artists and artist-images are only ever
called from HomeView.vue's shelves, which just don't fire when the toggle
is off. artist-links(-by-mbid) is used both there (same toggle, same
shelves) *and* from ArtistDetailView.vue for whichever artist page happens
to be open — independent of the toggle there, since a single on-demand
lookup for the one artist you're actively looking at isn't the kind of
unasked-for background pass the toggle exists to guard against; see that
view's own comment.
"""

from fastapi import APIRouter, Depends, Query

from core.auth import require_token
from core.recommendations import (
    get_artist_images,
    get_artist_links,
    get_artist_links_by_mbid,
    get_similar_artists,
)

router = APIRouter(prefix="/recommendations", dependencies=[Depends(require_token)])


@router.get("/similar-artists")
async def similar_artists(seed: list[str] = Query(default=[]), limit: int = 100):
    artists = await get_similar_artists(seed, limit=limit)
    return {"artists": artists}


@router.get("/artist-images")
async def artist_images(name: list[str] = Query(default=[])):
    images = await get_artist_images(name)
    return {"images": images}


@router.get("/artist-links")
async def artist_links(name: list[str] = Query(default=[])):
    links = await get_artist_links(name)
    return {"links": links}


@router.get("/artist-links-by-mbid")
async def artist_links_by_mbid(mbid: list[str] = Query(default=[])):
    links = await get_artist_links_by_mbid(mbid)
    return {"links": links}
