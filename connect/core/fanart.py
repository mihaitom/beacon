"""core/fanart.py — artist banners and backgrounds from Fanart.tv.

Fanart.tv is keyed on MusicBrainz artist ids, which Beacon already resolves
by name (core/recommendations.py's resolve_mbid()), so a lookup is that
search plus one request. A collaboration credit ("Cardi B & Bruno Mars") has
no MusicBrainz artist of its own, so it falls back to its first performer -
who is who the track gets dressed with. Its images fill the gap the Deezer
artist photo leaves: a wide banner and a background, up to ten candidates
of each (see _top_urls() for which).

Two keys, as Fanart.tv's terms require of a publicly available program: a
project ("client") key that identifies Beacon, set once for the project (see
_PROJECT_KEY), and a personal API key each installation enters for itself
(core/api_keys.py's "fanart" entry). Both are sent together, and the project
key is never something a user is asked for. Without the personal key every
lookup is a quiet None.

Both caches are on disk under CONNECT_DATA_DIR, unlike the rest of the app's
artwork caches: Fanart.tv is a third party on the far side of the internet,
so an in-memory cache lost on every restart means re-asking it (and
MusicBrainz) for the same artists again. The metadata (which images an
artist has, keyed by MBID) is a small JSON file; the image bytes are files
under fanart_images/. Both are kept for _TTL and pruned as they are
rewritten, so neither grows without bound. Only the shown image is fetched
before the page gets its answer; the other backgrounds follow slowly in the
background (_prefetch_backgrounds()), for the cycle button.

A failure here is never surfaced to the caller. This only ever enriches an
artist page that works without it, so "no art" and "Fanart.tv is down" both
come back as None rather than an error nobody could act on.
"""

import asyncio
import hashlib
import json
import logging
import os
import random
import time

import httpx

from core import api_keys
from core.recommendations import first_artist, resolve_mbid
from lyrics.shared import USER_AGENT

logger = logging.getLogger("connect.fanart")

_BASE_URL = "https://webservice.fanart.tv/v3/music/{mbid}"
_TIMEOUT = 15.0
_client = httpx.AsyncClient(timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT})

# Beacon's own Fanart.tv project ("client") key, sent as `client_key`
# alongside the installation's personal `api_key` - Fanart.tv's terms require
# a publicly available program to identify itself this way. Public by
# design, not a secret: it names the app, not a person, and every Fanart.tv
# client ships it (there is no way to send it from the app and keep it
# hidden). It does work on its own, so if it ever gets abused, rotate it in
# Fanart.tv's dashboard and update this constant.
_PROJECT_KEY = "eb67b9a1286ff6d2f5598f3b2c63889c"

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_CACHE_PATH = os.path.join(_DATA_DIR, "fanart_cache.json")
_IMAGE_DIR = os.path.join(_DATA_DIR, "fanart_images")

# Which images an artist has barely changes, and a miss (an artist Fanart.tv
# does not have) is worth remembering too - unlike a MusicBrainz name miss,
# this is the directory's own answer, not a hiccup. A failed *request* is
# not cached at all, so it is retried on the next visit. A month matches the
# app's other artwork caches (see routes/coverart.py's own _CACHE_TTL); an
# artist's images can change, just not on any timescale worth re-asking for.
_TTL = 30 * 86400.0

# How many of an artist's images to keep per kind, and how they are chosen.
# Fanart.tv's `likes` are few (most images have under ten) and accumulate
# with age, so ranking by likes alone would never surface a newer upload.
# Most slots go to the most liked, the rest to the newest of what is left -
# a nudge towards fresh images, not a replacement of the community's pick.
_KEEP_BY_LIKES = 7
_KEEP_NEWEST = 3

# Bumped whenever _pick() chooses differently, so metadata cached by an
# older version is re-fetched instead of lingering for the rest of _TTL.
_CACHE_VERSION = 2

# The background candidates beyond the one shown are downloaded one at a
# time with this pause between them: they are only needed once someone
# cycles, and Fanart.tv's CDN does not need a burst of ten 1 MB images.
_PREFETCH_GAP = 2.0

# The in-memory half, filled from disk on a miss and written through on a
# fetch: it saves the file read on every artist page open within a session.
# {mbid: (expires_at, art_or_none)}, wall-clock, since it is written to disk.
_cache: dict[str, tuple[float, dict | None]] = {}


def _load_cache() -> dict:
    try:
        with open(_CACHE_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:
        logger.warning(f"[fanart] Could not read the metadata cache: {e}")
        return {}


def _save_cache(cache: dict) -> None:
    """Writes the whole cache back, dropping whatever has expired on the way
    - the only thing that ever prunes it, and enough to keep a JSON file of
    artist records small."""
    now = time.time()
    live = {k: v for k, v in cache.items() if isinstance(v, dict) and v.get("expires", 0) > now}
    try:
        os.makedirs(os.path.dirname(_CACHE_PATH), exist_ok=True)
        with open(_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(live, f)
    except Exception as e:
        logger.error(f"[fanart] Could not write the metadata cache: {e}")


def _number(value: object) -> int:
    """Fanart.tv sends `likes` and `id` as strings ("15"); compared as
    strings, "9" outranks "15"."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _top_urls(entries: object) -> list[str]:
    """The images worth keeping from one Fanart.tv array, best first: the
    most liked, then the newest of the rest (see _KEEP_BY_LIKES). Fanart.tv's
    own ordering is neither, and an entry without a url is nothing to show.
    `id` grows with every upload, so it stands in for the upload date the
    API does not send."""
    if not isinstance(entries, list):
        return []
    usable = [e for e in entries if isinstance(e, dict) and e.get("url")]
    usable.sort(key=lambda e: (_number(e.get("likes")), _number(e.get("id"))), reverse=True)
    liked = usable[:_KEEP_BY_LIKES]
    rest = sorted(usable[_KEEP_BY_LIKES:], key=lambda e: _number(e.get("id")), reverse=True)
    return [e["url"] for e in liked + rest[:_KEEP_NEWEST]]


def _pick(data: dict) -> dict | None:
    """The candidate images the artist page can use, each from whichever of
    its Fanart.tv names is present - a banner is `artistbanner` on most
    mirrors and `musicbanner` on some, and a logo is `hdmusiclogo` where a
    high-resolution one exists. Lists of URLs, best first; _choose() makes
    the actual pick."""
    banner = _top_urls(data.get("artistbanner") or data.get("musicbanner"))
    background = _top_urls(data.get("artistbackground"))
    logo = _top_urls(data.get("hdmusiclogo") or data.get("musiclogo"))
    if not (banner or background or logo):
        return None
    return {"banner": banner, "background": background, "logo": logo}


def _first(urls: list[str]) -> str | None:
    """The image to show: a random one of those already on disk, so a
    returning artist varies without waiting on a download, else the best
    one - the only download the page then waits for."""
    if not urls:
        return None
    cached = [url for url in urls if is_image_cached(url)]
    return random.choice(cached) if cached else urls[0]


def _choose(art: dict | None) -> dict | None:
    """One image of each kind - what actually gets shown - plus the full
    background candidate list, so a client can offer another one without
    asking Fanart.tv again. Kept out of the cache on purpose: caching the
    choice would freeze one image for the whole _TTL."""
    if not art:
        return None
    backgrounds = art.get("background") or []
    return {
        "banner": _first(art.get("banner") or []),
        "background": _first(backgrounds),
        "backgrounds": list(backgrounds),
        "logo": _first(art.get("logo") or []),
    }


# The background downloads under way, by artist: opening the same artist
# again mid-way does not start a second run, and holding the task here keeps
# it from being garbage-collected before it finishes.
_prefetching: dict[str, asyncio.Task] = {}


async def _prefetch_backgrounds(mbid: str, urls: list[str]) -> None:
    """Downloads the background candidates not on disk yet, so the cycle
    button finds them there. Best-effort: a failed one is simply fetched on
    demand later."""
    try:
        for url in urls:
            if is_image_cached(url):
                continue
            fetched = await fetch_image(url)
            if fetched:
                store_image(url, fetched[0])
            await asyncio.sleep(_PREFETCH_GAP)
    finally:
        _prefetching.pop(mbid, None)


def _answer(mbid: str, art: dict | None) -> dict | None:
    """_choose(), plus the background download of the candidates it did not
    pick. The shown one is left to the image route, which the page requests
    right away - fetching it here too would download it twice."""
    chosen = _choose(art)
    if chosen and mbid not in _prefetching:
        rest = [url for url in chosen["backgrounds"] if url != chosen["background"]]
        if rest:
            _prefetching[mbid] = asyncio.create_task(_prefetch_backgrounds(mbid, rest))
    return chosen


async def get_artist_art(name: str) -> dict | None:
    """{banner, background, backgrounds, logo} for an artist, or None when
    there is nothing to show (no MBID, no art) or Fanart.tv could not be
    reached. Cache-first, memory then disk.

    A personal key is not required: Beacon's own project key fetches the
    images on its own, just with Fanart.tv's slower project-level cache. An
    installation's personal key (core/api_keys.py's "fanart" entry) is sent
    instead when one is set, which identifies the listener and gets fresher
    artwork - and keeps the requests off the shared project key's rate
    limit."""
    mbid = await resolve_mbid(name)
    if not mbid:
        # A collaboration credit ("Cardi B & Bruno Mars") has no MusicBrainz
        # artist of its own, so nothing resolves and the track would go
        # undressed. The first performer named is who it gets dressed with;
        # the whole name is tried first, so a band called "Simon & Garfunkel"
        # stays itself.
        main = first_artist(name)
        if main:
            mbid = await resolve_mbid(main)
    if not mbid:
        return None

    now = time.time()
    cached = _cache.get(mbid)
    if cached and now < cached[0]:
        return _answer(mbid, cached[1])

    cache = _load_cache()
    entry = cache.get(mbid)
    if (
        isinstance(entry, dict)
        and entry.get("version") == _CACHE_VERSION
        and now < entry.get("expires", 0)
    ):
        art = entry.get("art")
        _cache[mbid] = (entry["expires"], art)
        return _answer(mbid, art)

    personal = api_keys.get("fanart")
    try:
        # The personal key is the API key when there is one (Fanart.tv's own
        # documented arrangement, and what gets the fresher cache); without
        # one the project key is, and it needs no client_key.
        params = {"api_key": personal or _PROJECT_KEY}
        if personal and _PROJECT_KEY:
            params["client_key"] = _PROJECT_KEY
        r = await _client.get(_BASE_URL.format(mbid=mbid), params=params)
        if r.status_code == 404:
            result = None
        else:
            r.raise_for_status()
            result = _pick(r.json())
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(f"[fanart] Lookup failed for {name!r} ({mbid}): {e}")
        return _answer(mbid, cached[1]) if cached else None

    expires = now + _TTL
    _cache[mbid] = (expires, result)
    cache[mbid] = {"expires": expires, "version": _CACHE_VERSION, "art": result}
    _save_cache(cache)
    return _answer(mbid, result)


# ── image bytes ──────────────────────────────────────────────────────────────

# Only Fanart.tv's own image hosts may be fetched through get_image() below.
# The URLs come from Fanart.tv's API, but the route that serves them is
# reachable by anyone with the token, and an open image proxy is an SSRF
# hole (a caller passing http://169.254.169.254/...). An allowlist is the
# cheap fix; the Fanart.tv CDN has been assets.fanart.tv, and this tolerates
# a subdomain change.
_ALLOWED_IMAGE_SUFFIX = ".fanart.tv"


def is_allowed_image_url(url: str) -> bool:
    """Whether this is a Fanart.tv image URL this backend may fetch."""
    try:
        parsed = httpx.URL(url)
    except (httpx.InvalidURL, ValueError):
        return False
    if parsed.scheme != "https":
        return False
    host = parsed.host or ""
    return host == _ALLOWED_IMAGE_SUFFIX.lstrip(".") or host.endswith(_ALLOWED_IMAGE_SUFFIX)


def _image_path(url: str) -> str:
    return os.path.join(_IMAGE_DIR, hashlib.sha256(url.encode("utf-8")).hexdigest())


def content_type_for(url: str) -> str:
    path = httpx.URL(url).path.lower()
    if path.endswith(".png"):
        return "image/png"
    if path.endswith(".webp"):
        return "image/webp"
    return "image/jpeg"


def is_image_cached(url: str) -> bool:
    """Whether `url`'s bytes are on disk and still within _TTL."""
    try:
        return time.time() - os.path.getmtime(_image_path(url)) <= _TTL
    except OSError:
        return False


def get_cached_image(url: str) -> bytes | None:
    """The stored bytes for `url`, or None if it was never fetched or has
    aged past _TTL."""
    path = _image_path(url)
    try:
        if time.time() - os.path.getmtime(path) > _TTL:
            return None
        with open(path, "rb") as f:
            return f.read()
    except FileNotFoundError:
        return None
    except Exception as e:
        logger.warning(f"[fanart] Could not read a cached image: {e}")
        return None


def store_image(url: str, data: bytes) -> None:
    """Writes `url`'s bytes, and prunes the expired files beside it - the
    only place this cache is ever cleaned, so it stays bounded."""
    try:
        os.makedirs(_IMAGE_DIR, exist_ok=True)
        with open(_image_path(url), "wb") as f:
            f.write(data)
    except Exception as e:
        logger.error(f"[fanart] Could not store an image: {e}")
        return
    cutoff = time.time() - _TTL
    try:
        for name in os.listdir(_IMAGE_DIR):
            path = os.path.join(_IMAGE_DIR, name)
            if os.path.getmtime(path) < cutoff:
                os.unlink(path)
    except Exception as e:
        logger.warning(f"[fanart] Could not prune the image cache: {e}")


async def fetch_image(url: str) -> tuple[bytes, str] | None:
    """Fetches an allowed Fanart.tv image, or None when the URL is not one
    this backend will fetch or the request failed."""
    if not is_allowed_image_url(url):
        return None
    try:
        r = await _client.get(url)
        r.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning(f"[fanart] Image fetch failed for {url!r}: {e}")
        return None
    return r.content, r.headers.get("content-type") or content_type_for(url)
