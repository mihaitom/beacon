"""core/radio_station_info.py - what RadioView.vue's rows say about a saved
station beyond its name: Radio Browser's tags, country, codec and bitrate
for it, and the last title this session heard on it.

A saved station lives on the media server with only a name, a stream URL
and a homepage, so the directory facts are looked up: by Radio Browser id
where the frontend knows one (a station added from Discover, see its
services/radioBrowserLinks.ts) - all of those in one request - and by
exact stream URL for the rest. A station the directory does not know just
has no tags; nothing is guessed from its name.

The answers are kept on disk for _FOUND_TTL: a station's tags and codec
change on the order of never, and the page asks for every station each
time it opens. "Not in the directory" is kept too, but for less long
(_MISSING_TTL), since a station can be submitted later. A lookup that
failed outright (every mirror down) is not kept at all - that says nothing
about the station.

The last title comes from the session's own title log (core/
radio_history.py), so it is "what you heard there", like the log itself.
"""

import asyncio
import json
import logging
import os
import time

from core import radio_ads, radio_browser, radio_history
from core.playlist_url import _is_playlist_url, resolve_stream_url

logger = logging.getLogger("connect.radio_station_info")

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_PATH = os.path.join(_DATA_DIR, "radio_station_info_cache.json")

_FOUND_TTL = 14 * 24 * 3600.0
_MISSING_TTL = 3 * 24 * 3600.0

# Chips under a row, not a tag cloud: Radio Browser's tags are whatever a
# submitter typed, and past the first few they are mostly cities and
# frequencies.
MAX_TAGS = 3

# Lookups by URL are one request per station; this keeps a first visit to a
# long list from becoming a burst against a volunteer-run directory.
_URL_LOOKUPS_AT_ONCE = 4

_cache: dict[str, dict] | None = None
# Playlist URL -> the stream behind it, which is what the title log is
# keyed by for such a station (playback resolves it before playing).
_resolved: dict[str, str] = {}


def _load() -> dict[str, dict]:
    global _cache
    if _cache is None:
        try:
            with open(_PATH, encoding="utf-8") as f:
                data = json.load(f)
            _cache = data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save() -> None:
    try:
        tmp = f"{_PATH}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_load(), f)
        os.replace(tmp, _PATH)
    except OSError as e:
        logger.warning(f"[radio-station-info] could not store cache: {e}")


def clean_tags(raw: str, country: str) -> list[str]:
    """The first MAX_TAGS distinct tags, the country left out - it is shown
    on its own already."""
    seen = {country.strip().casefold()} if country else set()
    tags = []
    for tag in raw.split(","):
        tag = tag.strip()
        if not tag or tag.casefold() in seen:
            continue
        seen.add(tag.casefold())
        tags.append(tag)
        if len(tags) == MAX_TAGS:
            break
    return tags


def _details(station: dict) -> dict:
    codec = station.get("codec") or ""
    return {
        "tags": clean_tags(station.get("tags") or "", station.get("country") or ""),
        "country": station.get("country") or "",
        "codec": "" if codec.upper() == "UNKNOWN" else codec,
        "bitrate": station.get("bitrate") or None,
    }


def _best(matches: list[dict]) -> dict | None:
    """The same station submitted twice is common; the better-voted entry
    is the one somebody looked after."""
    return max(matches, key=lambda s: s.get("votes") or 0) if matches else None


def _cached(url: str, now: float) -> tuple[bool, dict | None]:
    entry = _load().get(url)
    if not isinstance(entry, dict):
        return False, None
    details = entry.get("details")
    ttl = _FOUND_TTL if details else _MISSING_TTL
    if now - (entry.get("at") or 0) > ttl:
        return False, None
    return True, details


async def directory_details(stations: list[tuple[str, str | None]]) -> dict[str, dict | None]:
    """Radio Browser's facts per stream URL, for (url, directory id or None)
    pairs. A URL the directory could not be asked about is left out."""
    now = time.time()
    result: dict[str, dict | None] = {}
    by_uuid: dict[str, str] = {}
    by_url: list[str] = []
    for url, uuid in stations:
        hit, details = _cached(url, now)
        if hit:
            result[url] = details
        elif uuid:
            by_uuid[uuid] = url
        else:
            by_url.append(url)

    fresh: dict[str, dict | None] = {}
    if by_uuid:
        found = await radio_browser.stations_by_uuid(list(by_uuid))
        if found is not None:
            for uuid, url in by_uuid.items():
                match = _best([s for s in found if s["stationuuid"] == uuid])
                fresh[url] = _details(match) if match else None

    slots = asyncio.Semaphore(_URL_LOOKUPS_AT_ONCE)

    async def lookup(url: str) -> None:
        async with slots:
            found = await radio_browser.stations_by_url(url)
        if found is not None:
            match = _best(found)
            fresh[url] = _details(match) if match else None

    await asyncio.gather(*(lookup(url) for url in by_url))

    if fresh:
        cache = _load()
        for url, details in fresh.items():
            cache[url] = {"details": details, "at": now}
        _save()
    result.update(fresh)
    return result


async def _history_url(url: str) -> str:
    try:
        if not _is_playlist_url(url):
            return url
    except Exception:
        # Not a URL httpx can parse: nothing to resolve, and no log under
        # any other name either.
        return url
    if url not in _resolved:
        _resolved[url] = await resolve_stream_url(url)
    return _resolved[url]


async def last_title(session_id: str, url: str) -> dict | None:
    """The newest title this session's log holds for the station, adverts
    passed over the way the log itself shows them."""
    for candidate in dict.fromkeys([url, await _history_url(url)]):
        entries = radio_history.load_station(session_id, candidate, 50)
        for entry in reversed(entries):
            if not radio_ads.looks_like_advert(entry["title"]):
                return {"title": entry["title"], "at": entry["at"]}
    return None


async def station_info(session_id: str, stations: list[tuple[str, str | None]]) -> dict:
    details, titles = await asyncio.gather(
        directory_details(stations),
        asyncio.gather(*(last_title(session_id, url) for url, _ in stations)),
    )
    return {
        url: {**(details.get(url) or {}), "lastTitle": title}
        for (url, _), title in zip(stations, titles, strict=True)
    }
