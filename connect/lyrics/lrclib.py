"""lrclib.py — lrclib.net lyrics provider.

Port of src/main/features/core/lyrics/lrclib.ts.
Credits to https://github.com/tranxuanthang/lrcget for the API.
"""

import logging
import time
from typing import Any

import httpx

from .shared import USER_AGENT, order_search_results

logger = logging.getLogger("connect.lyrics")

FETCH_URL = "https://lrclib.net/api/get"
SEARCH_URL = "https://lrclib.net/api/search"

# lrclib.net's API has been observed taking 6-12s to respond on some
# networks, so a short timeout causes spurious failures.
TIMEOUT = 20.0

# Shared client so repeated requests reuse the same TCP/TLS connection
# instead of paying a new handshake every time.
_client = httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})


async def get_lyrics_by_song_id(song_id: str) -> str | None:
    start = time.perf_counter()
    try:
        r = await _client.get(f"{FETCH_URL}/{song_id}")
        r.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning(
            f"[lrclib] lyrics request failed for song_id={song_id}: {type(e).__name__}: {e}"
        )
        return None

    logger.info(
        f"[lrclib] fetched lyrics for song_id={song_id} in {time.perf_counter() - start:.2f}s"
    )

    data = r.json()
    return data.get("syncedLyrics") or data.get("plainLyrics") or None


async def get_search_results(params: dict[str, Any]) -> list[dict[str, Any]] | None:
    name = params.get("name")
    artist = params.get("artist")
    if not name and not artist:
        return None

    query = " ".join(p for p in (name, artist) if p)

    start = time.perf_counter()
    try:
        r = await _client.get(SEARCH_URL, params={"q": query})
        r.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning(
            f"[lrclib] search request failed for query={query!r}: {type(e).__name__}: {e}"
        )
        return None

    logger.info(
        f"[lrclib] fetched search results for query={query!r} in {time.perf_counter() - start:.2f}s"
    )

    songs = r.json()
    if not isinstance(songs, list):
        return None

    results = [
        {
            "artist": song["artistName"],
            "id": str(song["id"]),
            "isSync": bool(song.get("syncedLyrics")),
            "name": song["name"],
            "source": "lrclib.net",
            "duration": song.get("duration"),
        }
        for song in songs
    ]

    return order_search_results(params, results)
