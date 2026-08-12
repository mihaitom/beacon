"""netease.py — NetEase lyrics provider.

Port of src/main/features/core/lyrics/netease.ts. The translated-lyrics
merge (enableNeteaseTranslation) is an Electron-only setting and not exposed
via Connect, so this only returns the original lyrics.
"""

import logging
from typing import Any

import httpx

from .shared import USER_AGENT, order_search_results

logger = logging.getLogger("connect.lyrics")

SEARCH_URL = "https://music.163.com/api/search/get"
LYRICS_URL = "https://music.163.com/api/song/lyric"

# See lrclib.py — observed slow on some networks, so a short timeout causes
# spurious failures.
TIMEOUT = 15.0


async def get_lyrics_by_song_id(song_id: str) -> str | None:
    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}
        ) as client:
            r = await client.get(
                LYRICS_URL, params={"id": song_id, "kv": "-1", "lv": "-1", "tv": "-1"}
            )
            r.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning(f"[netease] lyrics request failed: {type(e).__name__}: {e}")
        return None

    data = r.json()
    return data.get("lrc", {}).get("lyric") or None


async def get_search_results(params: dict[str, Any]) -> list[dict[str, Any]] | None:
    name = params.get("name")
    artist = params.get("artist")
    search_query = " ".join(p for p in (artist, name) if p)
    if not search_query:
        return None

    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}
        ) as client:
            r = await client.get(
                SEARCH_URL,
                params={"limit": 5, "offset": 0, "s": search_query, "type": "1"},
            )
            r.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning(f"[netease] search request failed: {type(e).__name__}: {e}")
        return None

    songs = r.json().get("result", {}).get("songs")
    if not songs:
        return None

    results = [
        {
            "artist": ", ".join(a["name"] for a in song.get("artists", [])),
            "id": str(song["id"]),
            "isSync": None,
            "name": song["name"],
            "source": "NetEase",
            # NetEase's own duration is milliseconds, unlike the other two
            # sources — normalized to seconds here so the frontend doesn't
            # need to know which source it came from to display it.
            "duration": song["duration"] / 1000 if song.get("duration") is not None else None,
        }
        for song in songs
    ]

    return order_search_results(params, results)
