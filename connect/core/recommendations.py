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
   Its scores are session counts, comparable only within one seed's own
   results, which is what rank_similar() exists to deal with.

A third, independent lookup (get_artist_images()) enriches whichever of
those turn out *not* to be in the library (HomeView.vue's own job to
figure out — this module has no idea what's in anyone's library) with a
real photo + a link somewhere more inviting than MusicBrainz's bare
metadata page: Deezer's public search API (api.deezer.com/search/artist),
also no API key. MusicBrainz stays as the fallback link (via the mbid
get_similar_artists() already returned) for whatever Deezer doesn't have.

A fourth (get_artist_links()) is unrelated to any of the above and doesn't
care whether an artist is in the library at all — it reuses resolve_mbid()
to pull the artist's own MusicBrainz page plus whichever of Spotify/Apple
Music/TIDAL/YouTube/Discogs it has on file, out of MusicBrainz's own
url-rels relations, for an artist page ArtistDetailView.vue is already
showing, via a second MusicBrainz call beyond the name search (see
_fetch_artist_links()).

All four are cached to disk (see _load_cache()/_save_cache(), persisted
the same CONNECT_DATA_DIR way as delivery/credentials.py/
core/radio_stations.py) — an artist's MBID never changes, and neither
similarity, a Deezer artist photo, nor these streaming links shift
meaningfully faster than _SIMILAR_TTL_SECONDS would matter for (they aren't
even time-checked — cached once, kept until the cache file itself is
cleared). Without this, every single Home refresh would re-resolve and
re-fetch the same handful of artists from scratch.

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
from urllib.parse import urlparse

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

# Host -> our own short service key, for get_artist_links() below.
# MusicBrainz's own relation `type` doesn't reliably distinguish these —
# confirmed live against a real artist (Radiohead's MBID): "free streaming"
# covers both Spotify and Deezer, "streaming" covers Apple Music/Amazon/
# TIDAL/Qobuz together, and Apple Music can *also* show up a second time
# under "purchase for download". The URL's own host is the only thing that
# actually tells them apart. www. is stripped before matching (see
# _fetch_artist_links()), so listing both forms here isn't needed.
_LINK_HOSTS = {
    "open.spotify.com": "spotify",
    "music.apple.com": "apple_music",
    "tidal.com": "tidal",
    "youtube.com": "youtube",
    "discogs.com": "discogs",
}
# One of a fixed enum ListenBrainz Labs validates against — confirmed live
# (the API 400s and lists every valid value otherwise; not something to
# guess from memory, and not documented anywhere obvious). The longest
# lookback (7500 days) with the lowest contribution/threshold floor, for
# the broadest possible result set on a self-hosted library that's likely
# seeded from relatively few, possibly niche, artists.
_LB_ALGORITHM = (
    "session_based_days_7500_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30"
)

# Was 30 days — HomeView.vue's own seed selection is now randomized (see
# pickSeedArtistNames()'s comment), so "Reroll" already varies the *seeds*
# each time; a day-long TTL here means the *similarity results themselves*
# stay reasonably fresh too, without re-hitting ListenBrainz Labs on every
# single Home load for seeds that keep recurring.
_SIMILAR_TTL_SECONDS = 24 * 60 * 60  # 24 hours
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
    rate-limited MusicBrainz call on every single Home refresh. That's a
    *genuine* negative only — a real search response with zero matches —
    not a network/HTTP failure: those return None too but are deliberately
    never written to the cache (see the early return below), so a
    transient MusicBrainz outage isn't indistinguishable from "this name
    really has no MBID" forever after. Confirmed live as a real, not just
    theoretical, bug: a burst of MusicBrainz 503s permanently poisoned
    several artists' entries this way before this guard existed."""
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
            return None
        finally:
            _mb_last_call = time.monotonic()

    artists = data.get("artists") or []
    mbid = artists[0].get("id") if artists else None

    mbid_by_name[key] = mbid
    _save_cache(cache)
    return mbid


def _musicbrainz_artist_url(mbid: str) -> str:
    return f"https://musicbrainz.org/artist/{mbid}"


async def _fetch_artist_links(mbid: str) -> dict[str, str] | None:
    """One MusicBrainz url-rels lookup for `mbid` — a second, separate call
    from resolve_mbid()'s own search request, since MusicBrainz's search
    endpoint doesn't support inc=url-rels, only a direct lookup-by-id does.
    Shares resolve_mbid()'s _mb_lock/_mb_last_call rate limiting — both hit
    musicbrainz.org, one shared budget, not a fresh one each.

    See _LINK_HOSTS' own comment for why matching is host-based rather than
    trusting MusicBrainz's own relation `type`.

    Returns None on a network/HTTP failure specifically — not a dict, even
    an incomplete one — so _get_links_for_mbid() below can tell "MusicBrainz
    is genuinely down/rate-limiting right now" apart from "a successful
    response that just doesn't have any of these five services on file",
    and only cache the latter. See resolve_mbid()'s identical fix for the
    same class of bug, confirmed live: a burst of 503s here previously got
    cached as this mbid's *permanent* answer (just the musicbrainz
    self-link, everything else silently missing forever after), long after
    MusicBrainz itself had recovered."""
    global _mb_last_call
    async with _mb_lock:
        wait = _MB_MIN_INTERVAL - (time.monotonic() - _mb_last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            r = await _client.get(
                f"{_MB_SEARCH_URL}{mbid}", params={"inc": "url-rels", "fmt": "json"}
            )
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPError as e:
            logger.warning(f"[recommendations] MusicBrainz url-rels lookup failed for {mbid}: {e}")
            return None
        finally:
            _mb_last_call = time.monotonic()

    # MusicBrainz's own artist page — not from url-rels (an artist has no
    # relation *to itself*), just the same MBID this whole lookup already
    # required, same URL shape HomeView.vue's own fallback link already
    # builds client-side for artists not yet in the library. Always
    # present in a *successful* response, regardless of whether any of the
    # five services below matched.
    links: dict[str, str] = {"musicbrainz": _musicbrainz_artist_url(mbid)}
    for rel in data.get("relations", []):
        url = (rel.get("url") or {}).get("resource")
        if not url:
            continue
        host = urlparse(url).netloc.lower().removeprefix("www.")
        service = _LINK_HOSTS.get(host)
        # First match wins — an artist can have more than one URL under the
        # same generic MusicBrainz relation type (e.g. two "streaming"
        # entries that both happen to be Apple Music, regional storefronts),
        # and there's no signal here for which one is more "correct" than
        # the other.
        if service and service not in links:
            links[service] = url
    return links


async def _get_links_for_mbid(mbid: str) -> dict[str, str]:
    """Cache-first wrapper around _fetch_artist_links() for one mbid —
    shared by get_artist_links() and get_artist_links_by_mbid() below.

    A fresh load/mutate/save around just this one mbid, not a shared cache
    dict loaded once up front for a whole batch and saved once at the end
    (the more obvious-looking shape, matching get_artist_images()'s own
    batch) — when called from get_artist_links(), resolve_mbid() (called
    per name, right before this) does its own independent load/save cycle
    for the same underlying file. Holding a long-lived dict across those
    calls would go stale the moment resolve_mbid() persists a newly-
    resolved MBID mid-loop, and this function's own eventual save would
    silently overwrite that with its own now-outdated snapshot — undoing
    the very lookup that just happened.

    A None from _fetch_artist_links() (a transient failure, see its own
    comment) is deliberately never written to the cache — this returns a
    one-off musicbrainz-only result for *this* call so the page still shows
    something, but the next lookup for the same mbid gets a real retry
    instead of being stuck with that incomplete answer forever."""
    cache = _load_cache()
    links_by_mbid = cache.setdefault("links_by_mbid", {})
    if mbid in links_by_mbid:
        return links_by_mbid[mbid]
    links = await _fetch_artist_links(mbid)
    if links is None:
        return {"musicbrainz": _musicbrainz_artist_url(mbid)}
    links_by_mbid[mbid] = links
    _save_cache(cache)
    return links


async def get_artist_links(names: list[str]) -> dict[str, dict[str, str]]:
    """MusicBrainz's own artist page plus whichever of Spotify/Apple Music/
    TIDAL/YouTube/Discogs it has on file, for each of `names`, cache-first
    (keyed by MBID, since that's the stable identity — resolve_mbid()
    already handles the name -> MBID half with its own cache), keyed back
    out by the exact name string passed in, same convention as
    get_artist_images(). A name with no MBID at all comes back as `{}` — no
    musicbrainz link either, since there's nothing to link to; a resolved
    MBID always has at least the musicbrainz entry, even if MusicBrainz has
    none of the other five on file for it."""
    results: dict[str, dict[str, str]] = {}
    for name in names:
        mbid = await resolve_mbid(name)
        results[name] = await _get_links_for_mbid(mbid) if mbid else {}
    return results


async def get_artist_links_by_mbid(mbids: list[str]) -> dict[str, dict[str, str]]:
    """Same cache/fetch mechanism as get_artist_links(), for callers that
    already have a trusted MBID and shouldn't pay for a redundant
    resolve_mbid() name-search round trip to re-derive one — HomeView.vue's
    "New to explore" shelf gets these straight from ListenBrainz Labs' own
    similar-artists response (SimilarArtist.mbid), which is strictly better
    to trust than re-resolving from a name search that could, in principle,
    land on a different (mis-tagged, or just ambiguously-named) artist
    entirely. Keyed back out by MBID rather than name, since that's what
    the caller already has on hand here — no name to key by at all."""
    results: dict[str, dict[str, str]] = {}
    for mbid in mbids:
        results[mbid] = await _get_links_for_mbid(mbid)
    return results


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
        if m not in similar_by_mbid
        or now - similar_by_mbid[m]["fetched_at"] >= _SIMILAR_TTL_SECONDS
    ]
    if stale_or_missing:
        fresh = await _fetch_similar_batch(stale_or_missing)
        for mbid, similar in fresh.items():
            similar_by_mbid[mbid] = {"fetched_at": now, "similar": similar}
        _save_cache(cache)

    seed_names_lower = {n.strip().lower() for n in seed_names}
    per_seed = [similar_by_mbid.get(mbid, {}).get("similar", []) for mbid in seed_mbids]
    return rank_similar(per_seed, seed_names_lower, limit)


def rank_similar(per_seed: list[list[dict]], seed_names_lower: set[str], limit: int) -> list[dict]:
    """Merges one similar-artists list per seed into a single ranking.

    ListenBrainz's raw score is a count of listening sessions, so it says
    nothing comparable across seeds: measured live (2026-08-27), Queen's
    *worst* similar artist scored 736 while Toto's *best* scored 348. Rank
    those together as they come and the whole list belongs to whichever
    seed is most listened-to overall — the top 10 for those two seeds were
    ten Queen results and no Toto ones at all.

    So each seed's scores are put on their own 0-1 scale first, which makes
    "closest to this artist" mean the same thing whoever the artist is.
    Then an artist appearing under several seeds *adds* those scores up
    rather than keeping the best one: turning up next to two of somebody's
    artists is a better reason to recommend them than being a near-perfect
    match for one.

    Duplicates within a single seed's own list are collapsed first —
    ListenBrainz returns the same act more than once when MusicBrainz
    holds several entries for it (34 of Toto's 134 results), and without
    this those would count two or three times over."""
    merged: dict[str, dict] = {}
    for similar in per_seed:
        best_per_name: dict[str, dict] = {}
        for artist in similar:
            name = (artist.get("name") or "").strip()
            if not name or name.lower() in seed_names_lower:
                continue
            key = name.lower()
            existing = best_per_name.get(key)
            if not existing or artist["score"] > existing["score"]:
                best_per_name[key] = artist
        if not best_per_name:
            continue

        top = max(artist["score"] for artist in best_per_name.values()) or 1
        for key, artist in best_per_name.items():
            entry = merged.get(key)
            if not entry:
                # `score` is the merged, normalized one from here on — the
                # raw count has served its purpose and would only invite
                # comparing numbers that aren't comparable.
                entry = {**artist, "score": 0.0}
                merged[key] = entry
            entry["score"] += artist["score"] / top

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
