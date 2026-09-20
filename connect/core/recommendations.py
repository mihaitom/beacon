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
_fetch_url_rels()).

A fifth (get_artist_bio()) rides on that same url-rels response: the
Wikidata item MusicBrainz links there names the artist's Wikipedia article
in every language, and Wikipedia's summary endpoint hands back its opening
paragraph for the artist page.

All five are cached to disk (see _load_cache()/_save_cache(), persisted
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
import re
import time
from urllib.parse import quote, unquote, urlparse

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
_WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php"
_WIKIPEDIA_SUMMARY_URL = "https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}"

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
# Unlike an MBID or a streaming link, an article's opening gets edited - a
# new album, a death, a split - so a bio is re-read now and then rather
# than kept for good.
_BIO_TTL_SECONDS = 30 * 24 * 60 * 60
# The language ends up in a hostname (see _WIKIPEDIA_SUMMARY_URL), so only a
# plain language code gets through; anything else falls back to English.
_WIKI_LANG_RE = re.compile(r"^[a-z]{2,3}$")
_WIKI_FALLBACK_LANG = "en"
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


# What joins several performers into one credit. Kept in step with the
# frontend's services/artistCredits.ts, so both halves of the app agree on
# what "one artist" means. Deliberately not exhaustive: "x" and "with" are
# left out ("x" matches inside far too much, and an artist named "With..." is
# likelier than a page missing one collaboration).
_ARTIST_SEPARATOR = re.compile(
    r"\s*(?:&|;|/|\+|,|\b(?:featuring|feat|ft|vs)\.?(?=\s))\s*", re.IGNORECASE
)


def first_artist(name: str) -> str | None:
    """The first performer named in a credit, or None when the credit is a
    single name. "Cardi B & Bruno Mars" -> "Cardi B".

    A band whose own name contains a separator ("Simon & Garfunkel") splits
    too, which is why callers try the whole name first and only fall back to
    this - the whole resolves for the band, and only a genuine collaboration
    (which has no MusicBrainz artist of its own) needs the first name."""
    parts = [part.strip() for part in _ARTIST_SEPARATOR.split(name) if part.strip()]
    if len(parts) <= 1:
        return None
    return parts[0]


async def resolve_mbid(name: str) -> str | None:
    """Artist name -> MusicBrainz ID, cache-first (see this module's own
    docstring). Only a *positive* result is cached. A response with no
    artists is deliberately not remembered: a MusicBrainz hiccup returning
    HTTP 200 with an empty list looks exactly like a name that genuinely has
    no MBID, and caching one poisoned real artists ("Dua Lipa", "The
    Notorious B.I.G.") permanently. Resolution is user-triggered rather than
    a background pass, so a miss is simply looked up again on the next call
    instead of being kept for a fixed period. A network/HTTP failure writes
    nothing either (see the early return below). A legacy bare `null` in an
    existing cache is ignored and re-resolved, so those self-heal."""
    cache = _load_cache()
    # The "_v2" bucket is deliberate: the first version took MusicBrainz's
    # top hit unchecked, which resolved "Bush" to Kate Bush (her name
    # contains the word) and cached it. A fresh key drops those wrong
    # resolutions without a migration.
    mbid_by_name = cache.setdefault("mbid_by_name_v2", {})
    key = name.strip().lower()
    # Only a string is a hit; a legacy `null` (or any other shape) is treated
    # as absent and re-resolved — see the docstring.
    cached = mbid_by_name.get(key)
    if isinstance(cached, str):
        return cached

    global _mb_last_call
    async with _mb_lock:
        wait = _MB_MIN_INTERVAL - (time.monotonic() - _mb_last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            r = await _client.get(
                _MB_SEARCH_URL, params={"query": f'artist:"{name}"', "fmt": "json", "limit": "5"}
            )
            r.raise_for_status()
            data = r.json()
        except httpx.HTTPError as e:
            logger.warning(f"[recommendations] MusicBrainz search failed for {name!r}: {e}")
            return None
        finally:
            _mb_last_call = time.monotonic()

    artists = data.get("artists") or []
    # MusicBrainz's Lucene query matches the name as a word anywhere in an
    # artist's name, so the top hit for "Bush" is "Kate Bush" (score 100)
    # while the band actually called "Bush" sits second. Prefer a result
    # whose name is exactly what was asked for; fall back to the top hit only
    # when nothing matches exactly, which covers a differently spelled name
    # ("Beatles" for "The Beatles").
    wanted = name.strip().casefold()
    exact = next(
        (a for a in artists if (a.get("name") or "").strip().casefold() == wanted),
        None,
    )
    chosen = exact or (artists[0] if artists else None)
    mbid = chosen.get("id") if chosen else None

    # Only a positive is written — see the docstring. A miss costs one
    # rate-limited call next time, which is the honest price of not
    # remembering a hiccup as "this artist does not exist".
    if mbid:
        mbid_by_name[key] = mbid
        _save_cache(cache)
    return mbid


def _musicbrainz_artist_url(mbid: str) -> str:
    return f"https://musicbrainz.org/artist/{mbid}"


async def _fetch_url_rels(mbid: str) -> list[str] | None:
    """Every URL MusicBrainz has on file for `mbid` - one url-rels lookup, a
    second, separate call from resolve_mbid()'s own search request, since
    MusicBrainz's search endpoint doesn't support inc=url-rels, only a
    direct lookup-by-id does. Shares resolve_mbid()'s _mb_lock/_mb_last_call
    rate limiting - both hit musicbrainz.org, one shared budget.

    Returns None on a network/HTTP failure specifically - not a list, even
    an empty one - so callers can tell "MusicBrainz is down/rate-limiting
    right now" apart from "a successful response with nothing useful in
    it", and only cache the latter. See resolve_mbid()'s identical fix:
    a burst of 503s here was once cached as this mbid's *permanent* answer
    (just the musicbrainz self-link, everything else missing forever
    after), long after MusicBrainz itself had recovered."""
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

    # Not every relation is a URL one (e.g. "member of band" points at
    # another artist entity), so a missing resource is skipped, not an error.
    urls = [(rel.get("url") or {}).get("resource") for rel in data.get("relations", [])]
    return [url for url in urls if url]


def _links_from_urls(mbid: str, urls: list[str]) -> dict[str, str]:
    """See _LINK_HOSTS' own comment for why matching is host-based rather
    than trusting MusicBrainz's own relation `type`."""
    # MusicBrainz's own artist page - not from url-rels (an artist has no
    # relation to itself), same URL shape HomeView.vue's own fallback link
    # builds client-side. Always present, whether or not anything matched.
    links: dict[str, str] = {"musicbrainz": _musicbrainz_artist_url(mbid)}
    for url in urls:
        host = urlparse(url).netloc.lower().removeprefix("www.")
        service = _LINK_HOSTS.get(host)
        # First match wins - an artist can have several URLs for the same
        # service (regional Apple Music storefronts), with no signal for
        # which one is more "correct".
        if service and service not in links:
            links[service] = url
    return links


def _wiki_ref_from_urls(urls: list[str]) -> dict[str, str | None]:
    """Where get_artist_bio() finds the artist's article. MusicBrainz links
    Wikidata almost everywhere now and Wikipedia itself only on older
    entries, so the Wikidata item is the main route (it knows the article
    in every language) and a direct Wikipedia link is the fallback."""
    ref: dict[str, str | None] = {"wikidata": None, "wikipedia": None}
    for url in urls:
        parsed = urlparse(url)
        host = parsed.netloc.lower()
        if host == "www.wikidata.org" and parsed.path.startswith("/wiki/Q"):
            ref["wikidata"] = ref["wikidata"] or parsed.path.removeprefix("/wiki/")
        elif host.endswith(".wikipedia.org") and parsed.path.startswith("/wiki/"):
            ref["wikipedia"] = ref["wikipedia"] or url
    return ref


async def _refresh_url_rels(mbid: str) -> tuple[dict[str, str], dict] | None:
    """One url-rels lookup, feeding both caches that are built from it -
    the external links and the Wikipedia reference - so neither ever costs
    a second rate-limited MusicBrainz call for the same artist.

    The cache is loaded *after* the fetch, not before: resolve_mbid() and
    other requests save the same file while this one waits for its turn
    under _mb_lock, and a copy loaded before that wait would overwrite
    whatever they wrote in the meantime."""
    urls = await _fetch_url_rels(mbid)
    if urls is None:
        return None
    links = _links_from_urls(mbid, urls)
    wiki = _wiki_ref_from_urls(urls)
    cache = _load_cache()
    cache.setdefault("links_by_mbid", {})[mbid] = links
    cache.setdefault("wiki_by_mbid", {})[mbid] = wiki
    _save_cache(cache)
    return links, wiki


async def _get_links_for_mbid(mbid: str) -> dict[str, str]:
    """Cache-first external links for one mbid - shared by
    get_artist_links() and get_artist_links_by_mbid() below.

    A failed lookup (see _fetch_url_rels()) is never cached - this returns
    a one-off musicbrainz-only result for *this* call so the page still
    shows something, and the next lookup gets a real retry."""
    cached = _load_cache().get("links_by_mbid", {}).get(mbid)
    if cached is not None:
        return cached
    refreshed = await _refresh_url_rels(mbid)
    if refreshed is None:
        return {"musicbrainz": _musicbrainz_artist_url(mbid)}
    return refreshed[0]


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


async def _wikipedia_title_from_wikidata(qid: str, lang: str) -> tuple[str, str] | None:
    """(language, article title) for Wikidata item `qid` - the article in
    `lang` if there is one, the English one otherwise. Raises on a
    network/HTTP failure so the caller doesn't cache it as "no article"."""
    sites = [f"{lang}wiki", f"{_WIKI_FALLBACK_LANG}wiki"]
    r = await _client.get(
        _WIKIDATA_API_URL,
        params={
            "action": "wbgetentities",
            "ids": qid,
            "props": "sitelinks",
            "sitefilter": "|".join(sites),
            "format": "json",
        },
    )
    r.raise_for_status()
    sitelinks = ((r.json().get("entities") or {}).get(qid) or {}).get("sitelinks") or {}
    for site in sites:
        title = (sitelinks.get(site) or {}).get("title")
        if title:
            return site.removesuffix("wiki"), title
    return None


def _wikipedia_title_from_url(url: str) -> tuple[str, str] | None:
    parsed = urlparse(url)
    lang = parsed.netloc.lower().removesuffix(".wikipedia.org").removeprefix("www.")
    title = unquote(parsed.path.removeprefix("/wiki/"))
    if not _WIKI_LANG_RE.match(lang) or not title:
        return None
    return lang, title


async def _fetch_wikipedia_summary(lang: str, title: str) -> dict | None:
    """The article's opening paragraph as plain text, plus the article's own
    URL for the attribution link Wikipedia's licence asks for. None for a
    missing article or a disambiguation page - the latter is a list of
    other articles, not a description of anyone."""
    r = await _client.get(
        _WIKIPEDIA_SUMMARY_URL.format(lang=lang, title=quote(title.replace(" ", "_"), safe=""))
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    data = r.json()
    text = (data.get("extract") or "").strip()
    if data.get("type") != "standard" or not text:
        return None
    url = ((data.get("content_urls") or {}).get("desktop") or {}).get("page")
    return {"text": text, "url": url, "lang": lang}


async def _get_wiki_ref(mbid: str) -> dict | None:
    """Cache-first - see _refresh_url_rels(). None only when MusicBrainz
    couldn't be reached."""
    cached = _load_cache().get("wiki_by_mbid", {}).get(mbid)
    if cached is not None:
        return cached
    refreshed = await _refresh_url_rels(mbid)
    return refreshed[1] if refreshed else None


async def get_artist_bio(name: str, lang: str) -> dict | None:
    """The opening paragraph of `name`'s Wikipedia article, in `lang` where
    that Wikipedia has one and in English otherwise: `{text, url, lang}`,
    `lang` being the one the text is actually in. None when there's nothing
    to show - no MBID, no article, or a lookup that failed.

    Cached per artist *and* requested language, since a German reader and
    an English one get different articles for the same artist. A failed
    lookup is not cached (same rule as resolve_mbid()); a genuine "no
    article" is, for _BIO_TTL_SECONDS like any other answer."""
    if not _WIKI_LANG_RE.match(lang):
        lang = _WIKI_FALLBACK_LANG
    mbid = await resolve_mbid(name)
    if not mbid:
        return None

    cached = _load_cache().get("bio_by_mbid", {}).get(mbid, {}).get(lang)
    if cached and time.time() - cached["fetched_at"] < _BIO_TTL_SECONDS:
        return cached["bio"]

    ref = await _get_wiki_ref(mbid)
    if ref is None:
        return None
    try:
        article = None
        if ref.get("wikidata"):
            article = await _wikipedia_title_from_wikidata(ref["wikidata"], lang)
        if article is None and ref.get("wikipedia"):
            article = _wikipedia_title_from_url(ref["wikipedia"])
        bio = await _fetch_wikipedia_summary(*article) if article else None
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(f"[recommendations] Wikipedia lookup failed for {name!r}: {e}")
        return None

    cache = _load_cache()
    cache.setdefault("bio_by_mbid", {}).setdefault(mbid, {})[lang] = {
        "fetched_at": time.time(),
        "bio": bio,
    }
    _save_cache(cache)
    return bio


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
    # Two sizes, because the two places this is shown want different ones:
    # a 160px card (250px covers it, even on a 2x display) and the artwork
    # viewer, which fills most of a window and made 250px look like exactly
    # what it is. Deezer publishes both, so this is a field to carry rather
    # than an image to resize.
    return {"image": image, "image_large": best.get("picture_xl"), "link": link}


# Deezer's CDN puts the size in the path
# (…/artist/<hash>/250x250-000000-80-0-0.jpg), so the large variant of an
# already-stored URL is a substitution rather than another lookup. Needed
# because the cache below has no expiry at all — every artist looked up
# before there was a second size would otherwise stay soft in the viewer
# forever, and re-fetching all of them to add one field is a poor trade
# against a rule we already know, for URLs this module produced itself.
_DEEZER_MEDIUM_SEGMENT = "/250x250-"
_DEEZER_XL_SEGMENT = "/1000x1000-"


def _with_large_image(entry: dict | None) -> dict | None:
    """`entry` guaranteed to carry an `image_large`, deriving one for a
    cache entry written before the field existed. Falls back to the medium
    image rather than to nothing: a slightly soft picture beats none."""
    if entry is None or entry.get("image_large"):
        return entry
    image = entry.get("image") or ""
    large = (
        image.replace(_DEEZER_MEDIUM_SEGMENT, _DEEZER_XL_SEGMENT)
        if _DEEZER_MEDIUM_SEGMENT in image
        else image or None
    )
    return {**entry, "image_large": large}


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

    # Applied on the way out rather than on the way into the cache, so an
    # entry stored before the field existed is answered correctly without
    # rewriting a cache file nothing else needed to touch.
    return {name: _with_large_image(entry) for name, entry in results.items()}
