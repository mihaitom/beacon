"""core/recommendations.py — real "similar artists" via MusicBrainz +
ListenBrainz, for HomeView.vue's Discover shelf and its "New to explore"
one (see routes/recommendations.py).

Neither Subsonic nor Jellyfin exposes any MBIDs in what Beacon already
pulls from them (see types/library.ts on the frontend) — everything here
starts from a plain artist *name*. Two hops:

1. MusicBrainz's own artist search resolves a name to its MBID
   (musicbrainz.org/ws/2/artist) — MusicBrainz is the canonical identifier
   space ListenBrainz is built on top of; it has no name-search of its own.
2. ListenBrainz Labs' similar-artists endpoint
   (labs.api.listenbrainz.org/similar-artists) takes MBIDs and returns
   community-listening-derived similar artists — no per-user account or
   auth needed at all, unlike a personalized recommendation would require.

A third, independent lookup (get_artist_images()) enriches whichever of
those turn out *not* to be in the library (HomeView.vue's own job to
figure out — this module has no idea what's in anyone's library) with a
real photo + a link somewhere more inviting than MusicBrainz's bare
metadata page: Deezer's public search API (api.deezer.com/search/artist),
also no API key. MusicBrainz stays as the fallback link (via the mbid
get_similar_artists() already returned) for whatever Deezer doesn't have.

All three are cached to disk (see _load_cache()/_save_cache(), persisted
the same CONNECT_DATA_DIR way as delivery/credentials.py/
core/radio_stations.py) — an artist's MBID never changes, and neither
similarity nor a Deezer artist photo shifts meaningfully faster than
_SIMILAR_TTL_SECONDS. Without this, every single Home refresh would
re-resolve and re-fetch the same handful of artists from scratch.

MusicBrainz's own documented etiquette caps clients at roughly 1
request/second, identified by User-Agent — _mb_lock/_mb_last_call enforce
that; neither ListenBrainz Labs (a whole batch of MBIDs can go in one
call, see _fetch_similar_batch()'s own comment) nor Deezer's search
endpoint documents a comparable limit, so neither is rate-limited here.
"""

import asyncio
import json
import logging
import os
import time

import httpx

from lyrics.shared import USER_AGENT

logger = logging.getLogger("connect.recommendations")

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_PATH = os.path.join(_DATA_DIR, "recommendations_cache.json")

_MB_SEARCH_URL = "https://musicbrainz.org/ws/2/artist/"
_LB_SIMILAR_URL = "https://labs.api.listenbrainz.org/similar-artists/json"
_DEEZER_SEARCH_URL = "https://api.deezer.com/search/artist"
# One of a fixed enum ListenBrainz Labs validates against — confirmed live
# (the API 400s and lists every valid value otherwise; not something to
# guess from memory, and not documented anywhere obvious). The longest
# lookback (7500 days) with the lowest contribution/threshold floor, for
# the broadest possible result set on a self-hosted library that's likely
# seeded from relatively few, possibly niche, artists.
_LB_ALGORITHM = (
    "session_based_days_7500_session_300_contribution_3_threshold_10_"
    "limit_100_filter_True_skip_30"
)

_SIMILAR_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days
_TIMEOUT = 15.0

_client = httpx.AsyncClient(timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT})

_MB_MIN_INTERVAL = 1.1
_mb_lock = asyncio.Lock()
_mb_last_call = 0.0


def _load_cache() -> dict:
    try:
        with open(_PATH, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        logger.warning(f"[recommendations] Cache load failed: {e}")
        return {}


def _save_cache(cache: dict) -> None:
    try:
        os.makedirs(os.path.dirname(_PATH), exist_ok=True)
        with open(_PATH, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2)
    except Exception as e:
        logger.error(f"[recommendations] Cache save failed: {e}")


async def resolve_mbid(name: str) -> str | None:
    """Artist name -> MusicBrainz ID, cache-first (see this module's own
    docstring). Caches a negative (None) result too — a mistagged/obscure
    local artist name that doesn't resolve shouldn't cost a fresh,
    rate-limited MusicBrainz call on every single Home refresh."""
    cache = _load_cache()
    mbid_by_name = cache.setdefault("mbid_by_name", {})
    key = name.strip().lower()
    if key in mbid_by_name:
        return mbid_by_name[key]

    global _mb_last_call
    async with _mb_lock:
        wait = _MB_MIN_INTERVAL - (time.monotonic() - _mb_last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            r = await _client.get(
                _MB_SEARCH_URL, params={"query": f'artist:"{name}"', "fmt": "json", "limit": "1"}
            )
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPError as e:
            logger.warning(f"[recommendations] MusicBrainz search failed for {name!r}: {e}")
            data = None
        finally:
            _mb_last_call = time.monotonic()

    mbid = None
    if data:
        artists = data.get("artists") or []
        if artists:
            mbid = artists[0].get("id")

    mbid_by_name[key] = mbid
    _save_cache(cache)
    return mbid


async def _fetch_similar_batch(mbids: list[str]) -> dict[str, list[dict]]:
    """One Labs call covering every mbid in `mbids` at once, keyed back out
    by which seed each result came from (the API's own `reference_mbid`).
    Repeated `artist_mbids=` params, not a comma-joined value — confirmed
    live that ListenBrainz Labs parses a comma-joined value as a single
    (invalid) UUID and 400s, despite that being the more obvious reading of
    an unfamiliar query-param API."""
    if not mbids:
        return {}
    params = [("artist_mbids", m) for m in mbids]
    params.append(("algorithm", _LB_ALGORITHM))
    try:
        r = await _client.get(_LB_SIMILAR_URL, params=params)
        r.raise_for_status()
        items = r.json()
    except httpx.HTTPError as e:
        logger.warning(f"[recommendations] ListenBrainz similar-artists failed: {e}")
        return {}

    by_ref: dict[str, list[dict]] = {m: [] for m in mbids}
    for item in items:
        ref = item.get("reference_mbid")
        if ref in by_ref:
            by_ref[ref].append(
                {
                    "mbid": item.get("artist_mbid"),
                    "name": item.get("name"),
                    "score": item.get("score") or 0,
                }
            )
    return by_ref


async def get_similar_artists(seed_names: list[str], limit: int = 30) -> list[dict]:
    """Real "similar artists" for `seed_names` (artists already in the
    library, e.g. HomeView.vue's most-played) — merges results across every
    seed, dedupes by lowercased name (keeping the higher score on a
    collision), excludes anything matching a seed name itself, sorted by
    ListenBrainz's own score descending."""
    seed_mbids: list[str] = []
    for name in seed_names:
        mbid = await resolve_mbid(name)
        if mbid and mbid not in seed_mbids:
            seed_mbids.append(mbid)

    if not seed_mbids:
        return []

    cache = _load_cache()
    similar_by_mbid = cache.setdefault("similar_by_mbid", {})
    now = time.time()
    stale_or_missing = [
        m
        for m in seed_mbids
        if m not in similar_by_mbid or now - similar_by_mbid[m]["fetched_at"] >= _SIMILAR_TTL_SECONDS
    ]
    if stale_or_missing:
        fresh = await _fetch_similar_batch(stale_or_missing)
        for mbid, similar in fresh.items():
            similar_by_mbid[mbid] = {"fetched_at": now, "similar": similar}
        _save_cache(cache)

    seed_names_lower = {n.strip().lower() for n in seed_names}
    merged: dict[str, dict] = {}
    for mbid in seed_mbids:
        for artist in similar_by_mbid.get(mbid, {}).get("similar", []):
            name = artist.get("name")
            if not name or name.strip().lower() in seed_names_lower:
                continue
            key = name.strip().lower()
            existing = merged.get(key)
            if not existing or artist["score"] > existing["score"]:
                merged[key] = artist

    ranked = sorted(merged.values(), key=lambda a: a["score"], reverse=True)
    return ranked[:limit]


async def _fetch_deezer(name: str) -> dict | None:
    """One Deezer artist search — deliberately not cache-aware itself (see
    get_artist_images(), the only caller, for why: batching several of
    these through asyncio.gather and only reading/writing the cache file
    once *around* the batch, not once per call, avoids a lost-update race
    between concurrent calls each loading, mutating, and saving their own
    stale copy of the same cache dict).

    Deezer's own relevance ranking isn't reliably "the famous one first" —
    confirmed live with "Radiohead": the top hit was an unrelated
    484-fan/0-album entry with Deezer's own placeholder image (the MD5 hash
    of an empty string is a known Deezer "no photo" sentinel baked into the
    URL), with the real ~4M-fan Radiohead second. Filters to exact
    (case-insensitive) name matches and picks the one with the most fans
    instead of trusting result order."""
    try:
        r = await _client.get(_DEEZER_SEARCH_URL, params={"q": name})
        r.raise_for_status()
        data = r.json()
    except httpx.HTTPError as e:
        logger.warning(f"[recommendations] Deezer search failed for {name!r}: {e}")
        return None

    key = name.strip().lower()
    candidates = [
        a for a in (data.get("data") or []) if (a.get("name") or "").strip().lower() == key
    ]
    if not candidates:
        return None
    best = max(candidates, key=lambda a: a.get("nb_fan") or 0)
    image = best.get("picture_medium")
    link = best.get("link")
    if not image and not link:
        return None
    return {"image": image, "link": link}


async def get_artist_images(names: list[str]) -> dict[str, dict | None]:
    """Deezer photo + artist-page link for each of `names` (already the
    "not owned" subset HomeView.vue narrowed get_similar_artists() down to
    — this has no idea what's in anyone's library itself), cache-first,
    keyed by the exact name string passed in so the caller can zip results
    back onto its own list without a second lowercasing pass."""
    cache = _load_cache()
    deezer_cache = cache.setdefault("deezer_by_name", {})

    results: dict[str, dict | None] = {}
    to_fetch: list[str] = []
    for name in names:
        key = name.strip().lower()
        if key in deezer_cache:
            results[name] = deezer_cache[key]
        else:
            to_fetch.append(name)

    if to_fetch:
        fetched = await asyncio.gather(*(_fetch_deezer(name) for name in to_fetch))
        for name, result in zip(to_fetch, fetched):
            deezer_cache[name.strip().lower()] = result
            results[name] = result
        _save_cache(cache)

    return results
