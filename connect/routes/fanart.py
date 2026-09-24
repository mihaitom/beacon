"""routes/fanart.py — GET /fanart/artist, GET /fanart/image,
POST /fanart/stored-images

Artist images from Fanart.tv (core/fanart.py). Machine-to-machine
(CONNECT_TOKEN), not session-scoped: like routes/recommendations.py, nothing
here touches session.media. An artist Fanart.tv has nothing for comes back as
a null `art` rather than an error - the page works without it.

The image route serves the actual bytes, disk-cached by core/fanart.py, so
the browser can load them with a plain <img>/background-image and cache them
itself (Cache-Control below) instead of fetching the Fanart.tv CDN directly.
The token may ride in the query (require_token accepts it) because an <img>
tag cannot send a header.
"""

import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel

from core import fanart
from core.auth import require_token

router = APIRouter(prefix="/fanart", dependencies=[Depends(require_token)])

# A month, matching the cache's own TTL and the app's other artwork paths.
_CACHE_CONTROL = "public, max-age=2592000"


@router.get("/artist")
async def artist(name: str = Query(...)) -> dict:
    return {"art": await fanart.get_artist_art(name)}


class StoredImagesRequest(BaseModel):
    # None for every artist; a list (a genre's artists) for those only.
    # A body rather than a query string, since a big genre names hundreds.
    artists: list[str] | None = None
    kind: Literal["background", "banner"] = "background"


@router.post("/stored-images")
async def stored_images(body: StoredImagesRequest) -> dict:
    """The images of one kind already downloaded, for the list pages'
    headers to cycle through - see core/fanart.py's stored_images()."""
    # Off the event loop: it reads two cache files and checks every image on
    # disk, and a genre names hundreds of artists - on the loop, that held up
    # the audio streams connect is serving at the same time.
    images = await asyncio.to_thread(fanart.stored_images, body.artists, body.kind)
    return {"images": images}


@router.get("/image")
async def image(url: str = Query(...)) -> Response:
    data = fanart.get_cached_image(url)
    if data is None:
        fetched = await fanart.fetch_image(url)
        if fetched is None:
            # Either not a Fanart.tv URL, or the fetch failed. The page
            # simply shows no image, so a 404 is the honest answer.
            raise HTTPException(status_code=404, detail="Image not available")
        data, _content_type = fetched
        fanart.store_image(url, data)
    return Response(
        content=data,
        media_type=fanart.content_type_for(url),
        headers={
            "Cache-Control": _CACHE_CONTROL,
            # The colour extractor reads these pixels through a canvas, which
            # needs CORS; `*` (rather than echoing the origin) means no
            # Vary: Origin, so the shared cache above stays simple.
            "Access-Control-Allow-Origin": "*",
        },
    )
