"""routes/coverart.py — batched cover-art fetch for the browser.

A library view can settle with dozens of covers on screen at once (see
CoverArt.vue's own MAX_CONCURRENT_LOADS comment for the outage that came out
of firing that many proxied requests independently — mid-track-drop-
reverse-proxy-403.md). This collapses however many a moment groups together
into one request instead, cutting both the raw request volume and its worst
symptom for a deployment sitting behind a WAF/IPS bouncer on its reverse
proxy: a burst of a dozen-plus requests, each to a different id-bearing URL,
looks a lot like the path/request-diversity a probe or crawl scenario is
built to catch — even though every one of them is the same authenticated
client fetching art for what's already on its own screen (a real CrowdSec
ban this traffic shape triggered against a legitimate external user is what
prompted this).

Dispatches per backend rather than going through a single shared client: the
existing per-backend browser-facing cover-art paths (routes/proxy.py's
_proxy() for Subsonic, media/jellyfin_bridge.py's and media/plex_bridge.py's
own _handle_binary()) already each have a working, pooled httpx client and
URL-construction for exactly this fetch — reusing those instead of adding a
fourth connection pool of this endpoint's own.

Response is base64 JSON rather than a binary/multipart reply, deliberately:
it keeps the wire format one plain object callers already know how to parse,
at the cost of ~33% more bytes than raw binary would be - a fine trade for
thumbnail-sized images, not one worth making for the full audio stream this
specifically doesn't touch.
"""

import asyncio
import base64
import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from core.auth import require_token
from core.session import SessionState, require_authenticated_session
from media import JellyfinClient, PlexClient, jellyfin_bridge, plex_bridge
from routes.proxy import _get_client as _get_subsonic_client

logger = logging.getLogger("connect.coverart")

router = APIRouter(dependencies=[Depends(require_token)])

# One screenful of covers, generously - well above what a real batch (grouped
# by ~20ms client-side, see coverArtBatch.ts) ever actually contains. This
# only guards against a malformed/adversarial request, not real usage.
_MAX_IDS = 200
# Mirrors CoverArt.vue's own MAX_CONCURRENT_LOADS - same reasoning: bound how
# many origin requests one batch fires at once, not the batch's total size.
_CONCURRENCY = 12
_DEFAULT_SIZE = 300


class CoverArtBatchRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)
    size: int = _DEFAULT_SIZE


@router.post("/cover-art/batch")
async def cover_art_batch(
    body: CoverArtBatchRequest,
    session: SessionState = Depends(require_authenticated_session),
) -> dict:
    ids = body.ids[:_MAX_IDS]
    semaphore = asyncio.Semaphore(_CONCURRENCY)

    async def fetch_one(cover_id: str) -> tuple[str, str | None]:
        async with semaphore:
            return cover_id, await _fetch_data_url(session, cover_id, body.size)

    results = await asyncio.gather(*(fetch_one(cover_id) for cover_id in ids))
    return {"results": dict(results)}


async def _fetch_data_url(session: SessionState, cover_id: str, size: int) -> str | None:
    media = session.media
    if isinstance(media, JellyfinClient):
        client = jellyfin_bridge._get_client()
    elif isinstance(media, PlexClient):
        client = plex_bridge._get_client()
    else:
        client = _get_subsonic_client()

    # internal=True: same reasoning as the cast-device fetches that already
    # use this method (see MediaClient.get_cover_art_url's docstring) — this
    # request originates from connect itself, not the browser, so it should
    # reach the media server the shortest way available rather than
    # round-tripping through whatever public URL the browser logged in with.
    url = media.get_cover_art_url(cover_id, internal=True, size=size)
    if not url:
        return None
    headers = media.auth_headers() if hasattr(media, "auth_headers") else {}
    try:
        response = await client.get(url, headers=headers, timeout=10)
        response.raise_for_status()
    except Exception as e:
        logger.debug(f"[cover-art-batch] {cover_id}: {e}")
        return None

    content_type = response.headers.get("content-type", "")
    if not content_type.startswith("image/"):
        return None
    encoded = base64.b64encode(response.content).decode("ascii")
    return f"data:{content_type};base64,{encoded}"
