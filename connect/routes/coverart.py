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
at the cost of ~33% more bytes than raw binary would be - a fine trade
for thumbnail-sized images, not one worth making for the full audio stream
this specifically doesn't touch.

Answers are cached in memory (see _cache below), which is what a POST costs
this endpoint that the plain image GET it replaced got for free: a POST is
never cached by the browser, by a reverse proxy, or by anything else on the
way, so without a cache here every re-visit of a view re-fetched every cover
from the media server. The cache is shared by every session, so a second
client (or a browser reload, which starts with an empty in-page cache — the
shape this was most visible in on the Docker deployment) is answered from
memory rather than from the media server.

`image_urls` covers the other half of the app's artwork: artist photos,
which the media server hands out as ready-made URLs, frequently on a
third-party CDN. Those used to go straight into an <img> tag, one request
per artist to a foreign host, uncancellable and outside every limit this
endpoint exists to impose. Fetching them here puts them under the same
batching, the same cache and the same concurrency ceiling as everything
else.
"""

import asyncio
import base64
import ipaddress
import logging
import os
import socket
import time
import weakref
from collections import OrderedDict

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from core.auth import require_token
from core.session import SessionState, require_authenticated_session
from media import (
    JellyfinClient,
    MediaClient,
    PlexClient,
    jellyfin_bridge,
    plex_bridge,
    server_type_name,
)
from routes.proxy import _get_client as _get_subsonic_client

logger = logging.getLogger("connect.coverart")

router = APIRouter(dependencies=[Depends(require_token)])

# One screenful of covers, generously - well above what a real batch (grouped
# by ~20ms client-side, see coverArtBatch.ts) ever actually contains. This
# only guards against a malformed/adversarial request, not real usage.
# Applied to each of the two lists separately.
_MAX_IDS = 200
# Mirrors CoverArt.vue's own MAX_CONCURRENT_LOADS - same reasoning: bound how
# many origin requests are in flight at once, not the batch's total size.
# Process-wide rather than per request, so three clients browsing at the same
# time still add up to this and not to three times it.
_CONCURRENCY = 12
_DEFAULT_SIZE = 300

# How long a fetched image is kept. Long, because expiry is not what keeps
# artwork current: a cover art id carries the version of the picture behind
# it (Navidrome's own ids do, and media/base.py's artwork_id gives Jellyfin's
# and Plex's the same property), so re-tagging an album produces a *different*
# id — fetched immediately because nothing has ever seen it, while the entry
# here ages out unused. What the expiry actually covers is the case where
# that doesn't hold: a Subsonic-compatible server with unversioned ids, or an
# id a bridge could only build without its version. A month is short enough
# to be a real backstop for those and long enough that normal use never
# re-fetches a cover it already has. Matches the Cache-Control the proxied
# image path hands the browser (media/__init__.py's _IMAGE_CACHE_CONTROL) —
# there is nothing to gain from expiring our own copy sooner than the copy
# the browser is allowed to keep.
_CACHE_TTL = 30 * 86400.0
# A miss is kept far more briefly: "this album has no art" is frequently a
# library scan that hasn't finished yet, and remembering it for a day would
# hide artwork that appeared minutes later. Long enough to stop a view full
# of art-less songs from re-asking the media server on every render, short
# enough to notice.
_NEGATIVE_CACHE_TTL = 600.0
# Bounded by what it actually holds rather than by a count, since one entry
# is anything from a 5 KB thumbnail to a full-size artist photo, and gives
# up its least recently used entries first.
#
# 128 MB of base64 is roughly 96 MB of image data — around eight thousand
# grid-sized thumbnails, which covers a large library's albums outright
# rather than only the ones recently looked at. Configurable because this is
# the one number here that costs a self-hosted install something real: it is
# resident memory in this process, and an installation on a small NAS may
# want less, while one serving several people at once may want more.
_DEFAULT_CACHE_MB = 128
# Floor rather than allowing 0: an eviction loop that has to keep one entry
# either way (see _cache_put) can't express "no cache at all" honestly, and
# the setting is about how much memory to spend, not about switching the
# endpoint's whole reason for existing off.
_MIN_CACHE_MB = 1


def _cache_budget_mb() -> int:
    """COVER_CACHE_MB, or the default for anything unusable. Read
    defensively because this is a documented, user-facing env var (see the
    README and docker-compose.yaml) and a bare int() would take the whole
    backend down at import time over a typo — or over `COVER_CACHE_MB=`
    with no value, which is exactly what a Compose file produces for a
    variable someone left blank."""
    raw = (os.getenv("COVER_CACHE_MB") or "").strip()
    if not raw:
        return _DEFAULT_CACHE_MB
    try:
        value = int(raw)
    except ValueError:
        logger.warning(f"[cover-art-batch] COVER_CACHE_MB={raw!r} is not a number — using default")
        return _DEFAULT_CACHE_MB
    if value < _MIN_CACHE_MB:
        logger.warning(
            f"[cover-art-batch] COVER_CACHE_MB={value} is below {_MIN_CACHE_MB} — raised"
        )
        return _MIN_CACHE_MB
    return value


_CACHE_MAX_BYTES = _cache_budget_mb() * 1024 * 1024
# What a cached *miss* is counted as against the budget above. A miss holds
# no image, so counting it by length would make it free — and a library
# whose items mostly have no artwork (a scan that hasn't got there yet, at
# four sizes each) would then fill the dict with hundreds of thousands of
# entries the eviction loop never looks at, since the byte total it watches
# never moves. Roughly what the key tuple, the entry tuple and their dict
# slots actually cost; the exact number matters far less than the fact that
# a miss costs something.
_NEGATIVE_ENTRY_BYTES = 256

# Foreign artist photos, which no media-server client covers. Same reasoning
# as routes/proxy.py's own client: one pooled client instead of a connection
# setup per image.
#
# Redirects are followed by hand rather than by httpx (see
# _fetch_image_url): every hop has to be checked against
# _points_somewhere_internal() on its own, and a client that follows them
# itself would only ever show us the first URL and the last response.
_image_client = httpx.AsyncClient(follow_redirects=False, timeout=10.0)
# Enough for the CDN chains these URLs really do take (a media server's
# redirect to fanart/last.fm/Deezer, plus that host's own to its edge),
# short enough that a redirect loop ends as one rather than as a hang.
_MAX_IMAGE_REDIRECTS = 5

# What an entry is keyed by: (scope, ref, size). `scope` separates one media
# server's cover ids from another's (they are only unique within a server),
# and _URL_SCOPE holds the artist photos, whose full URL is already globally
# unique and whose size we don't get to choose.
_URL_SCOPE = "url"
_Key = tuple[str, str, int]


class _FetchUnavailable(Exception):
    """This image could not be fetched for a reason that says nothing about
    whether it exists — the media server was unreachable, timed out, or
    answered with something other than a definite "there is no such image".
    Kept apart from a plain `None` all the way out to the browser, since the
    two lead to opposite behaviour there: a miss is remembered (in memory,
    on disk and here), a failure is retried."""


class _FetchFailed:
    """What _fetch_and_store() resolves to for a _FetchUnavailable. A
    sentinel rather than an exception because the fetch is shared between
    every request asking for the same key (see _resolution) and must never
    raise into whichever of them happens to be awaiting it."""

    __slots__ = ()


_FAILED = _FetchFailed()
_Resolved = str | None | _FetchFailed

_cache: OrderedDict[_Key, tuple[float, str | None]] = OrderedDict()
_cache_bytes = 0
# One in-flight fetch per key, so the same cover asked for by two clients at
# the same moment (or by two views of the same session) is fetched once.
_inflight: dict[_Key, asyncio.Task[_Resolved]] = {}

# Per event loop, not one module-level Semaphore: a Semaphore binds itself to
# the loop it first has to wait on, and this module is imported once while a
# test suite runs a short-lived loop per request. Weak-keyed so a finished
# loop takes its semaphore with it.
_fetch_slots: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    weakref.WeakKeyDictionary()
)


class CoverArtBatchRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)
    # Ready-made image URLs (artist photos) — resolved by this backend
    # rather than by the browser, see the module docstring.
    image_urls: list[str] = Field(default_factory=list)
    size: int = _DEFAULT_SIZE


@router.post("/cover-art/batch")
async def cover_art_batch(
    body: CoverArtBatchRequest,
    session: SessionState = Depends(require_authenticated_session),
) -> dict:
    scope = _scope(session.media)
    media = session.media
    size = body.size

    async def by_id(cover_id: str) -> tuple[str, _Resolved]:
        key = (scope, cover_id, size)
        return cover_id, await _cached(key, lambda: _fetch_cover(media, cover_id, size))

    async def by_url(url: str) -> tuple[str, _Resolved]:
        key = (_URL_SCOPE, url, 0)
        return url, await _cached(key, lambda: _fetch_image_url(url, media))

    results, image_results = await asyncio.gather(
        _resolve_all(by_id, body.ids[:_MAX_IDS]),
        _resolve_all(by_url, body.image_urls[:_MAX_IDS]),
    )
    return {"results": results, "image_results": image_results}


async def _resolve_all(resolve, refs: list[str]) -> dict[str, str | None]:
    """What each ref resolved to — `null` for "there is no such image", and
    left out of the answer entirely for one that could not be fetched just
    now (see _FetchUnavailable). The caller tells the two apart by presence,
    which is what stops a media server being briefly unreachable from
    blanking a whole screen of covers for the rest of the session (see
    coverArtBatch.ts's own deliver())."""
    resolved = await asyncio.gather(*(resolve(ref) for ref in refs))
    return {ref: value for ref, value in resolved if not isinstance(value, _FetchFailed)}


def _scope(media: MediaClient) -> str:
    """What makes a cover id unique. Cover ids are per media server, so two
    servers' `al-1` must not answer each other's requests — but the same
    server asked by two different sessions may share, since cover art is the
    same picture whoever is logged in."""
    return f"{server_type_name(media)}|{getattr(media, 'base_url', '')}"


def _slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    semaphore = _fetch_slots.get(loop)
    if semaphore is None:
        semaphore = asyncio.Semaphore(_CONCURRENCY)
        _fetch_slots[loop] = semaphore
    return semaphore


def _now() -> float:
    """The clock the TTLs above are measured on.

    An indirection purely so a test can move time on without reaching for
    time.monotonic() itself: that one is also asyncio's event-loop clock, so
    pinning it while a loop is running (which a TestClient request does)
    makes the loop's own timers fire early, late or never — a hang or a
    flake rather than an honest failure."""
    return time.monotonic()


def _entry_bytes(value: str | None) -> int:
    """What an entry costs the budget — see _NEGATIVE_ENTRY_BYTES for why a
    miss is not free."""
    return len(value) if value is not None else _NEGATIVE_ENTRY_BYTES


def _cache_drop(key: _Key) -> None:
    global _cache_bytes
    entry = _cache.pop(key, None)
    if entry is not None:
        _cache_bytes -= _entry_bytes(entry[1])


def _cache_get(key: _Key) -> tuple[bool, str | None]:
    """(whether this key is cached at all, what it resolved to) — the two
    have to be separate, since a cached *miss* is a real answer worth
    keeping and is also None."""
    entry = _cache.get(key)
    if entry is None:
        return False, None
    expires, value = entry
    if _now() >= expires:
        _cache_drop(key)
        return False, None
    _cache.move_to_end(key)
    return True, value


def _cache_put(key: _Key, value: str | None) -> None:
    global _cache_bytes
    _cache_drop(key)
    ttl = _CACHE_TTL if value is not None else _NEGATIVE_CACHE_TTL
    _cache[key] = (_now() + ttl, value)
    _cache_bytes += _entry_bytes(value)
    while _cache_bytes > _CACHE_MAX_BYTES and len(_cache) > 1:
        _cache_drop(next(iter(_cache)))


async def _fetch_and_store(key: _Key, fetch) -> _Resolved:
    try:
        async with _slots():
            data_url = await fetch()
    except _FetchUnavailable as e:
        # Deliberately not cached: a failure here says nothing about whether
        # this image exists, and remembering it as "no" would blank the
        # cover for the whole negative TTL over one bad moment — and, since
        # the browser remembers a "no" of its own (coverArtBatch.ts's
        # `cached`), for the rest of that session too. Routine enough on a
        # media server that blinks to be worth a quiet log rather than a
        # stack trace.
        logger.debug(f"[cover-art-batch] fetching {key[1]} failed: {e}")
        return _FAILED
    except Exception:
        logger.exception(f"[cover-art-batch] fetching {key[1]} failed")
        return _FAILED
    finally:
        _inflight.pop(key, None)
    _cache_put(key, data_url)
    return data_url


def _resolution(key: _Key, fetch) -> asyncio.Task[_Resolved]:
    """The task fetching this key, started if nobody else has. Never raises,
    so a caller that walks away (a disconnected client) leaves a task that
    still finishes and still fills the cache."""
    task = _inflight.get(key)
    if task is None:
        task = asyncio.ensure_future(_fetch_and_store(key, fetch))
        _inflight[key] = task
    return task


async def _cached(key: _Key, fetch) -> _Resolved:
    hit, value = _cache_get(key)
    if hit:
        return value
    # Shielded: this awaits a task that may be shared with other requests,
    # and one client giving up must not cancel the fetch the others are
    # still waiting on.
    return await asyncio.shield(_resolution(key, fetch))


async def _fetch_cover(media: MediaClient, cover_id: str, size: int) -> str | None:
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
    return await _get_data_url(client, url, headers, cover_id)


async def _fetch_image_url(url: str, media: MediaClient) -> str | None:
    """An artist photo, fetched from wherever the media server said it
    lives. Restricted to http(s) so this can't be talked into reading a
    `file:` URL or anything else httpx would otherwise accept, and pointed
    away from this machine's own network (see _points_somewhere_internal).

    Redirects are followed here rather than by httpx: a check on the URL the
    client asked for is worth nothing if the answer is a 302 to somewhere
    else, so every hop goes through the same guard."""
    current = url
    for _ in range(_MAX_IMAGE_REDIRECTS + 1):
        if not current.startswith(("http://", "https://")):
            return None
        if await _points_somewhere_internal(current, media):
            logger.warning(f"[cover-art-batch] refusing internal image URL: {current}")
            return None
        try:
            response = await _image_client.get(current, timeout=10)
        except Exception as e:
            raise _FetchUnavailable(f"{url}: {e}") from e
        if not response.is_redirect:
            return _decode_image(response, url)
        location = response.headers.get("location")
        if not location:
            return None
        current = str(response.url.join(location))
    logger.warning(f"[cover-art-batch] too many redirects for image URL: {url}")
    return None


def _media_host(media: MediaClient) -> str:
    return (httpx.URL(getattr(media, "base_url", "") or "").host or "").lower()


async def _points_somewhere_internal(url: str, media: MediaClient) -> bool:
    """Whether `url` resolves to an address on this machine or its own
    network — which nothing reachable through here has any business asking
    for.

    `image_urls` is the one thing this endpoint fetches from a host it was
    handed rather than one it configured: the browser only ever puts foreign
    URLs on that list (see CoverArt.vue's fetchCandidate(), which sends
    anything on our own proxy down a different path), but nothing on the
    wire enforces that, so any authenticated client could otherwise use this
    backend to probe `http://127.0.0.1:…`, a Docker-internal service or a
    cloud metadata endpoint — and read the answer back, base64-encoded,
    whenever it happens to look like an image.

    The media server's own host stays allowed even when it is on the LAN
    (the common case for a self-hosted install): a Subsonic server that
    hands out artist photos on its own address, not through our proxy, is a
    real and legitimate shape, and it is a host this backend already talks
    to on every other request.

    A hostname is resolved to decide this. That leaves the usual gap between
    checking and connecting — a DNS answer can change in between — which is
    not worth closing here (it would mean pinning the connection to an
    address ourselves); this is a bound on what can be *asked for*, not a
    sandbox."""
    host = (httpx.URL(url).host or "").lower()
    if not host:
        return True
    if host == _media_host(media):
        return False
    try:
        addresses = [ipaddress.ip_address(host.strip("[]"))]
    except ValueError:
        try:
            resolved = await _resolve_addresses(host)
        except OSError as e:
            # Unresolvable is not "internal" — it is a fetch that cannot
            # happen, and reporting it as a settled "no image" would cache a
            # DNS hiccup for the whole negative TTL.
            raise _FetchUnavailable(f"{url}: {e}") from e
        addresses = [ipaddress.ip_address(address) for address in resolved]
    return any(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_multicast
        or address.is_unspecified
        for address in addresses
    )


async def _resolve_addresses(host: str) -> list[str]:
    """Every address `host` resolves to. In a thread because getaddrinfo
    blocks, and its own function as much as a seam: a test of the guard
    above must not depend on what real DNS says today."""
    infos = await asyncio.to_thread(socket.getaddrinfo, host, None, 0, socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


async def _get_data_url(client, url: str, headers: dict[str, str], ref: str) -> str | None:
    try:
        response = await client.get(url, headers=headers, timeout=10)
    except Exception as e:
        raise _FetchUnavailable(f"{ref}: {e}") from e
    return _decode_image(response, ref)


# The only answers that actually say "there is no such image". Everything
# else a server can reply with — 401/403 (our credentials, not this image),
# 429, any 5xx — is about the server or the moment, and must not be
# remembered as a missing cover: see _FetchUnavailable.
_MISSING_STATUS = (404, 410)


def _decode_image(response: httpx.Response, ref: str) -> str | None:
    if response.status_code in _MISSING_STATUS:
        return None
    if response.status_code >= 400:
        raise _FetchUnavailable(f"{ref}: HTTP {response.status_code}")
    content_type = response.headers.get("content-type", "")
    if not content_type.startswith("image/"):
        # A settled answer, not a failure: the server replied, and what it
        # replied with is not a picture (a Subsonic error document, an
        # HTML placeholder page).
        logger.debug(f"[cover-art-batch] {ref}: not an image ({content_type!r})")
        return None
    encoded = base64.b64encode(response.content).decode("ascii")
    return f"data:{content_type};base64,{encoded}"


def _reset_cache() -> None:
    """Test seam — the cache outlives any one request, so a test that
    doesn't clear it is answered by the previous one's fixtures."""
    global _cache_bytes
    _cache.clear()
    _cache_bytes = 0
    _inflight.clear()
