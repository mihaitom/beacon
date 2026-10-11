"""lrcred.py — lrc.red lyrics provider.

A lyrics database keyed by ISRC, whose own docs say "The lrc.red API is
free for the public to use". Its search only lists tracks it has lyrics
for, so an instrumental gets no hit at all rather than an empty sheet.

A song whose tags carry an ISRC is looked up by it directly: that names the
recording itself, where a title search only finds songs called the same.
"""

import asyncio
import logging
import re
from typing import Any
from urllib.parse import quote

import httpx

from .shared import USER_AGENT, order_search_results, parse_lyrics

logger = logging.getLogger("connect.lyrics")

BASE_URL = "https://lrc.red"
TIMEOUT = 15.0

# The search answers 24 hits a page, most of them covers and karaoke takes
# of the same song. The picker fetches the sheet of every candidate it
# lists (routes/lyrics.py's _fetch_missing_sheets), so this bounds that.
MAX_SEARCH_RESULTS = 10

# Shared client so repeated requests reuse the same TCP/TLS connection.
_client = httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})

# Per-word timing ("[00:58.00]<00:58.00>In <00:58.34>the"). Nothing here
# highlights single words, and the parsers on both sides would show the
# tags as text.
_WORD_TIMESTAMP = re.compile(r"<\d{1,3}:\d{2}(?:\.\d{1,3})?>")
_HEADER_TAG = re.compile(r"^\[(ti|ar|length):([^\]]*)\]\s*$", re.MULTILINE)


def _without_word_timing(sheet: str) -> str:
    return "\n".join(_WORD_TIMESTAMP.sub("", line).rstrip() for line in sheet.splitlines())


def _length_seconds(value: str | None) -> float | None:
    """`[length:05:18]` -> 318.0."""
    if not value:
        return None
    minutes, _, seconds = value.strip().partition(":")
    try:
        return int(minutes) * 60 + float(seconds)
    except ValueError:
        return None


async def get_lyrics_by_song_id(song_id: str) -> str | None:
    """None means lrc.red has no sheet under this ISRC. A failed request
    raises, so it is not mistaken for that (see routes/lyrics.py)."""
    try:
        r = await _client.get(f"{BASE_URL}/s/{quote(song_id, safe='')}.lrc")
        if r.status_code == 404:
            return None
        r.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning(f"[lrcred] lyrics request failed: {type(e).__name__}: {e}")
        raise
    return _without_word_timing(r.text).strip() or None


async def _by_isrc(isrc: str) -> dict[str, Any] | None:
    sheet = await get_lyrics_by_song_id(isrc)
    if not sheet:
        return None
    tags = dict(_HEADER_TAG.findall(sheet))
    return {
        "artist": tags.get("ar", "").strip(),
        "id": isrc,
        "isSync": parse_lyrics(sheet)[0],
        "name": tags.get("ti", "").strip(),
        "source": "lrc.red",
        "duration": _length_seconds(tags.get("length")),
        "_lyrics": sheet,
        # The very recording, whatever its title reads like - see
        # order_search_results().
        "_exact": True,
    }


async def _search(query: str) -> list[dict[str, Any]]:
    try:
        r = await _client.get(f"{BASE_URL}/search.json", params={"q": query})
        r.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning(f"[lrcred] search request failed: {type(e).__name__}: {e}")
        raise
    return [
        {
            "artist": hit["artist"],
            "id": hit["isrc"],
            # Only known once the sheet is fetched.
            "isSync": None,
            "name": hit["title"],
            "source": "lrc.red",
            "duration": hit.get("duration"),
        }
        for hit in r.json().get("hits") or []
    ]


async def get_search_results(params: dict[str, Any]) -> list[dict[str, Any]] | None:
    name = params.get("name")
    artist = params.get("artist")
    isrcs = params.get("isrc") or []
    query = " ".join(p for p in (artist, name) if p)
    if not query and not isrcs:
        return None

    exact = [hit for hit in await asyncio.gather(*(_by_isrc(i) for i in isrcs)) if hit]
    # Searched even after an exact hit: the picker offers the alternatives.
    found = await _search(query) if query else []
    known = {hit["id"] for hit in exact}
    searched = order_search_results(params, [hit for hit in found if hit["id"] not in known])
    results = exact + searched[:MAX_SEARCH_RESULTS]
    if not results:
        return None
    return order_search_results(params, results)
