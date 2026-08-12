"""simpmusic.py — SimpMusic lyrics provider.

Port of src/main/features/core/lyrics/simpmusic.ts.
"""

import logging
from typing import Any

import httpx

from .shared import USER_AGENT, order_search_results

logger = logging.getLogger("connect.lyrics")

API_URL = "https://api-lyrics.simpmusic.org/v1"

# See lrclib.py — observed slow on some networks, so a short timeout causes
# spurious failures.
TIMEOUT = 15.0


async def get_lyrics_by_song_id(song_id: str) -> str | None:
    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}
        ) as client:
            r = await client.get(f"{API_URL}/{song_id}")
            r.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning(f"[simpmusic] lyrics request failed: {type(e).__name__}: {e}")
        return None

    data = r.json().get("data") or []
    first = data[0] if data else None
    if not first:
        return None

    return first.get("syncedLyrics") or first.get("plainLyric") or None


async def get_search_results(params: dict[str, Any]) -> list[dict[str, Any]] | None:
    name = params.get("name")
    if not name:
        return None

    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}
        ) as client:
            r = await client.get(f"{API_URL}/search", params={"q": name})
            r.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning(f"[simpmusic] search request failed: {type(e).__name__}: {e}")
        return None

    songs = r.json().get("data")
    if not songs:
        return None

    results = [
        {
            "artist": song["artistName"],
            "id": song["videoId"],
            "isSync": bool(song.get("syncedLyrics")),
            "name": song["songTitle"],
            "source": "SimpMusic",
            "duration": song.get("durationSeconds"),
        }
        for song in songs
    ]

    return order_search_results(params, results)
