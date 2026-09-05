"""routes/radio.py — GET /radio-favicon, POST /radio-favicon/batch,
GET /radio-browser/search, GET /radio-browser/countries,
POST /radio-browser/click/{stationuuid}, POST /radio-metadata/start,
POST /radio-metadata/stop, GET /radio-metadata

Internet radio stations are Navidrome's own resource (createInternetRadioStation
etc., proxied straight through routes/proxy.py) and have no favicon concept of
their own. This fetches one directly from a station's homepage_url on the
frontend's behalf — an <img src> can't do this itself (the station's homepage is
on a third-party host with no CORS allowance for this app, and a direct browser
fetch would also leak the browsing user's own IP to every radio station's host on
every single radio list render, not just once from here). The optional `hint`
query param is an already-known favicon URL (Radio Browser hands one back with
every search result — see core/radio_browser.py) to try before falling back
to scraping the homepage, still through this same proxy for the identical
IP-leak reason. /radio-favicon/batch answers the same question for a whole
list in one request — see its own docstring for why a per-station <img src>
is a problem worth solving even though each individual request is correct.
Resolved icons survive a restart (see _disk_load()/_disk_store()), which
matters more here than for any other cache in this backend: the packaged
desktop app spawns its own copy of connect, so every app launch would
otherwise re-scrape every saved station's homepage from scratch.

The /radio-browser/* group is unrelated to any of that — a thin HTTP wrapper
around core/radio_browser.py's lookup against the public Radio Browser
directory, for RadioView.vue's "browse stations" dialog: /search to find a
station to add in the first place (rather than requiring a stream URL typed
in by hand), /countries to back that dialog's country filter dropdown with
values Radio Browser actually recognizes (see core/radio_browser.py's own
docstring for why there is no equivalent /languages).

/radio-metadata/* is unrelated to either of those too — a thin wrapper
around core/session.py's start_radio_metadata_watch()/
stop_radio_metadata_watch(), for a station's ICY "now playing" tag (see
core/icy_metadata.py's own docstring for the protocol and why a plain
HTML5 `<audio>` element can never read it itself). /start and /stop are
called explicitly by the frontend for every radio play/stop, local
playback included — /play-url already starts one for casting on its own,
but local playback never calls that at all, so it has no other hook to
piggyback on."""

import asyncio
import base64
import binascii
import codecs
import hashlib
import io
import json
import logging
import os
import time
import weakref
from collections import OrderedDict
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import unquote_to_bytes, urljoin, urlparse

import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, Response
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from core.auth import require_token
from core.playlist_url import resolve_stream_url
from core.radio_browser import list_countries, register_click, search_stations
from core.session import SessionState, require_authenticated_session

logger = logging.getLogger("connect.radio")
router = APIRouter(dependencies=[Depends(require_token)])

# Shared client, same reasoning as routes/proxy.py's _get_client() — reused
# across requests instead of paying a fresh connection setup per favicon.
_client = httpx.AsyncClient(follow_redirects=True, timeout=5.0)

# Generous for an icon (even a high-res one is a few hundred KB at most) —
# caps how much of a clearly wrong response (e.g. a misconfigured host
# serving its full homepage HTML instead of an actual image) this reads
# into memory.
_MAX_BYTES = 512 * 1024

# How many icons a single request may actually download while looking for
# one that meets min_size. Only reached when candidate after candidate
# turns out to be too small or dead — the common case is one fetch (a
# hint, or the first declared icon) — but a page is free to declare an
# arbitrarily long list of them, and waiting on all of those is worse for
# the caller than answering with the best of the first few.
_MAX_FETCHES = 5

# A hard stop on how much of a homepage is read looking for <link
# rel="icon"> tags, for the case where <head> never ends (a misconfigured
# streaming response, a page with no closing tag at all): the read normally
# stops at </head> instead, see _discover_candidates().
#
# Only a safety net, so it is deliberately far above what any real <head>
# needs. It used to be the *primary* limit at 256KB, on the reasoning that
# a <head> is always well within that — hitradion1.de disagrees, inlining
# a ~300KB stylesheet ahead of its icon declarations, which put them out of
# reach and left the station with no findable logo at all.
_MAX_HTML_BYTES = 4 * 1024 * 1024

_CACHE_CONTROL = "public, max-age=604800"

# What "this station has no usable icon" is cached as. Shorter than a
# successful lookup deliberately: a station that has no icon today may put
# one up tomorrow, and unlike a hit there is nothing on screen to tell the
# user their logo is stale.
#
# That this exists at all is the point. A 404 with no cache directive is
# re-requested on every single render, so every station without a findable
# icon became a permanent, repeating 404 — one per station, per view, per
# reload. A burst of those, each under its own one-off URL, is precisely
# the shape an IPS/WAF probe scenario counts (CrowdSec's http-probing
# leaks a bucket of 4xx responses per source IP), and it is what got a
# legitimate user's own IP banned after RADIO_FAVICON_CACHE_VERSION was
# raised and every previously cached hit turned into a miss at once. See
# docs/playback-bugs/radio-favicon-4xx-ban.md.
_NEGATIVE_CACHE_CONTROL = "public, max-age=21600"

# rel values that plausibly point at a usable icon. Deliberately broad
# (mask-icon is normally a monochrome SVG meant for Safari's pinned-tab
# UI, not a real "logo", but a station with nothing better is still better
# served by it than by nothing) — ranked against each other by declared
# size (see _parse_sizes()/_select() below), not filtered out here.
_ICON_RELS = {
    "icon",
    "shortcut icon",
    "apple-touch-icon",
    "apple-touch-icon-precomposed",
    "mask-icon",
}


@dataclass
class _Candidate:
    url: str
    size: int  # 0 = unknown/unspecified
    # False only for the implicit /favicon.ico fallback below — its size=1
    # exists purely to sort it after every *declared* icon (see
    # _discover_candidates()'s own comment), not as a real claim about its
    # dimensions, so the "already have something at least this big" skip in
    # radio_favicon() below must never treat it as one.
    is_declared_size: bool = True
    # True for a <link rel="mask-icon"> — see _ICON_RELS' own comment: a
    # monochrome silhouette meant to be recolored by Safari's own CSS
    # masking, not a real likeness of the station's logo at all. Read by
    # _try_candidate() to keep it from claiming _SCALABLE_PIXELS the way a
    # genuine logo SVG does — being vector doesn't make a silhouette a
    # *good* result, just a scalable one.
    is_mask_icon: bool = False


def _parse_sizes(sizes: str) -> int:
    """ "16x16 32x32 48x48" -> 48 (the largest declared). "any" (SVG, scales
    losslessly to whatever's needed) counts as larger than any raster size
    actually likely to be declared alongside it."""
    best = 0
    for token in sizes.lower().split():
        if token == "any":
            return 100_000
        width = token.split("x", 1)[0]
        if width.isdigit():
            best = max(best, int(width))
    return best


class _IconLinkParser(HTMLParser):
    """Collects every <link rel="icon"-ish> tag's (href, sizes) — see
    _ICON_RELS.

    `head_done` is what lets _discover_candidates() stop reading at the end
    of <head> rather than at a byte count: icon declarations live there, so
    everything past it is the page itself and no icon of interest can still
    be coming. A page that never closes its <head> gives itself away by
    opening <body> instead; one that does neither is caught by
    _MAX_HTML_BYTES."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str, bool]] = []  # (href, sizes, is_mask_icon)
        self.head_done = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "body":
            self.head_done = True
            return
        if tag != "link":
            return
        values = {k.lower(): v for k, v in attrs if v is not None}
        rel = (values.get("rel") or "").strip().lower()
        href = values.get("href")
        if rel in _ICON_RELS and href:
            self.links.append((href, values.get("sizes", ""), rel == "mask-icon"))

    def handle_endtag(self, tag: str) -> None:
        if tag in ("head", "html"):
            self.head_done = True


# Parsed candidate lists (not the image bytes themselves — those still go
# through the browser's own HTTP cache via _CACHE_CONTROL) are cached
# briefly so requesting the same station's icon at several different
# min_size values (RadioView's list, PlayerBar, NowPlayingView all want
# different sizes of the *same* station's logo — see faviconUrl() callers)
# doesn't re-fetch-and-parse that station's homepage HTML from scratch
# every time.
_CANDIDATE_CACHE_TTL = 3600.0
_candidate_cache: dict[str, tuple[float, list[_Candidate]]] = {}


async def _discover_candidates(homepage_url: str) -> list[_Candidate]:
    cached = _candidate_cache.get(homepage_url)
    if cached and time.monotonic() - cached[0] < _CANDIDATE_CACHE_TTL:
        return cached[1]

    # What the icon hrefs below are actually relative to: the URL the
    # response came back from, which is not necessarily the one asked for.
    # einslive.de redirects to www1.wdr.de/radio/1live/, so resolving its
    # "/radio/1live/.../apple-touch-icon.png" against the *requested* URL
    # pointed every candidate at a host that never had them - and at one
    # answering 200-with-HTML for any path at all, so even the implicit
    # /favicon.ico below came back as a page instead of a visible 404 and
    # the station ended up with no findable icon whatsoever. Stays the
    # requested URL when the fetch never got far enough to have a final one.
    base_url = homepage_url
    candidates: list[_Candidate] = []

    try:
        async with _client.stream("GET", homepage_url) as resp:
            base_url = str(resp.url)
            if resp.headers.get("content-type", "").split(";")[0].strip() in (
                "text/html",
                "application/xhtml+xml",
            ):
                # Parsed as it arrives rather than buffered whole, so
                # reading far enough to clear an oversized <head> (see
                # _MAX_HTML_BYTES) costs no more memory than reading a
                # small one. An incremental decoder because a chunk
                # boundary lands wherever the network puts it, which is
                # readily in the middle of a multi-byte character.
                parser = _IconLinkParser()
                decoder = codecs.getincrementaldecoder("utf-8")(errors="ignore")
                read = 0
                async for chunk in resp.aiter_bytes():
                    parser.feed(decoder.decode(chunk))
                    read += len(chunk)
                    if parser.head_done or read >= _MAX_HTML_BYTES:
                        break
                for href, sizes, is_mask_icon in parser.links:
                    # urljoin parses `href` and raises for a malformed one
                    # ("Invalid IPv6 URL" for a stray "//[", say). One
                    # broken <link> in a station's HTML is no reason to
                    # fail the whole lookup — skip it like any other dead
                    # candidate and keep the good ones.
                    try:
                        resolved = urljoin(base_url, href)
                    except ValueError:
                        logger.info(f"[radio-favicon] {homepage_url}: unusable icon href {href!r}")
                        continue
                    candidates.append(
                        _Candidate(
                            url=resolved, size=_parse_sizes(sizes), is_mask_icon=is_mask_icon
                        )
                    )
    except httpx.HTTPError as e:
        logger.info(f"[radio-favicon] {homepage_url} unreachable: {type(e).__name__}: {e}")

    # The implicit browser convention (no <link> needed) — always included
    # as the last resort, even when the HTML fetch above found nothing (or
    # failed outright): plenty of sites rely on this working without ever
    # declaring it. Rated as size 1, not 0, so it still sorts after every
    # *declared* icon (even ones with no `sizes` attribute — declaring the
    # tag at all is a slightly stronger signal of being an intentional,
    # reasonable-quality icon than the bare convention path is) but is
    # never mistaken for "no candidate at all".
    parsed = urlparse(base_url)
    root = f"{parsed.scheme}://{parsed.netloc}"
    candidates.append(_Candidate(url=f"{root}/favicon.ico", size=1, is_declared_size=False))

    _candidate_cache[homepage_url] = (time.monotonic(), candidates)
    return candidates


# Below this fraction of pixels being meaningfully transparent (alpha <
# 32), an image counts as opaque for _has_transparency() below — a handful
# of antialiased edge pixels shouldn't flip NowPlayingView.vue's whole
# presentation (see its radioIconIsTransparent) into "logo floating on
# transparency" mode.
_MIN_TRANSPARENT_RATIO = 0.05


def _has_transparency(content: bytes, content_type: str = "") -> bool:
    """True if `content` decodes as an image with a real, meaningfully-used
    alpha channel — computed server-side (not by having the frontend sample
    a canvas) because this backend already has the raw bytes in hand with
    no CORS/tainted-canvas considerations to work around at all, and
    because decoding untrusted third-party image bytes is exactly the kind
    of thing worth keeping off the renderer regardless. Any failure
    (unrecognized format, corrupt data, ...) reads as "no transparency" —
    NowPlayingView.vue's own card treatment for a normal opaque image is a
    perfectly reasonable fallback for "couldn't tell"."""
    # An SVG is transparent wherever it does not paint. There is no canvas
    # underneath to be opaque, unlike a raster format which has a value for
    # every pixel — so the question the decode below asks does not apply,
    # and PIL cannot answer it anyway: rasterizing SVG needs a renderer
    # this backend deliberately does not carry. Left to the generic
    # "couldn't tell" fallback, every vector logo came back as opaque and
    # was framed like a square cover; tomorrowland.com's, four <path>
    # elements and nothing else, is exactly that case.
    #
    # An SVG that does paint its own full-bleed background is called
    # transparent here too, and loses NowPlayingView's shadow as a result.
    # That is the deliberate cheaper end of the trade: such an icon already
    # supplies its own backdrop, so it still reads as a filled square, and
    # the alternative is guessing at covering <rect>s in someone else's
    # markup — a guess whose own failure is the framed-logo bug this exists
    # to fix.
    if content_type.startswith("image/svg"):
        return True

    try:
        with Image.open(io.BytesIO(content)) as img:
            if img.mode not in ("RGBA", "LA", "PA") and not (
                img.mode == "P" and "transparency" in img.info
            ):
                return False
            alpha = img.convert("RGBA").getchannel("A")
            histogram = alpha.histogram()
            transparent = sum(histogram[:32])
            return transparent / (img.width * img.height) >= _MIN_TRANSPARENT_RATIO
    # DecompressionBombError is none of the three (it subclasses Exception
    # directly) and is exactly what a hostile or just badly-made icon
    # triggers — a station's favicon must never be able to 500 this route.
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return False


def _decode_data_uri(uri: str) -> tuple[bytes, str] | None:
    """Decodes a `data:` URI favicon (RFC 2397) declared directly in a
    station's homepage HTML — some sites embed a small SVG/PNG icon inline
    instead of linking to a separate file. There's nothing to *fetch* for
    one of these (the bytes are already in the URI itself), which the main
    loop below used to not account for at all: handing a data: URI to
    httpx.get() just fails ("missing a protocol"), logged and skipped like
    any other dead candidate — silently never finding what was actually
    sitting right there in the HTML. Returns None for anything malformed
    (no comma separating the header from the payload, bad base64/percent-
    encoding), same "just skip this candidate" contract as a failed fetch."""
    header, sep, data = uri[len("data:") :].partition(",")
    if not sep:
        return None
    is_base64 = header.endswith(";base64")
    media_type = (header[: -len(";base64")] if is_base64 else header).split(";")[0]
    try:
        content = base64.b64decode(data) if is_base64 else unquote_to_bytes(data)
    except (binascii.Error, ValueError):
        return None
    return content, media_type or "application/octet-stream"


# What an SVG counts as when ranking fetched icons by size — it scales
# losslessly to whatever is asked for, so it satisfies any min_size. Same
# value _parse_sizes() gives a declared sizes="any" for the same reason.
_SCALABLE_PIXELS = 100_000


def _pixel_size(content: bytes, content_type: str, scalable: bool = True) -> int:
    """The real edge length of a fetched icon, as opposed to whatever size
    its <link> tag claimed (or, for a Radio Browser `hint`, claimed
    nothing at all). Reads only the image header, so it costs nothing
    beyond what is already in memory.

    `scalable=False` (only ever passed for a mask-icon — see
    _Candidate.is_mask_icon) keeps an SVG from claiming _SCALABLE_PIXELS:
    that bonus exists because a vector image satisfies any min_size, which
    is true of a mask-icon's geometry too, but it is a monochrome
    silhouette by convention, not a real likeness of the station's logo at
    any resolution. Without this, one being fetched anywhere in the
    cascade (see radio_favicon()) short-circuited the whole search the
    moment it was measured — instantly "meeting" even a very large
    min_size and winning over an actual full-color icon already in hand,
    which is what a station's colorful logo looked like it had lost all
    its color to. Reported live 2026-09-03.

    0 for anything undecodable, and for a non-scalable SVG — an unknown
    size must never beat a known one when picking the best icon below, and
    _select()'s ordering already treats 0 as the weakest candidate."""
    if content_type.startswith("image/svg"):
        return _SCALABLE_PIXELS if scalable else 0
    try:
        with Image.open(io.BytesIO(content)) as img:
            return max(img.width, img.height)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return 0


@dataclass
class _Fetched:
    """One icon that was actually retrieved and measured, kept as data
    rather than turned into a Response straight away so the caller can
    still compare it against a later, larger one before committing."""

    content: bytes
    content_type: str
    #: Edge length in pixels: what the bytes actually measure, falling back
    #: to what the candidate's <link sizes> declared when they can't be
    #: measured at all (an image format PIL doesn't know). Measuring only
    #: overrules a declaration when it genuinely knows better — a format we
    #: can't read is no reason to distrust what the page said about it.
    pixels: int
    #: Filled in on first ask by _transparency() below, not at construction:
    #: _has_transparency() decodes the whole image, and a resolved icon is
    #: kept (see _result_cache) and asked for repeatedly — once per single
    #: response and once per batch entry it appears in.
    transparent: bool | None = None


def _transparency(fetched: _Fetched) -> bool:
    """Whether this icon is a logo floating on transparency rather than a
    filled rectangle — NowPlayingView.vue drops the card treatment (shadow,
    background box) for one that is, see its radioIconIsTransparent.
    Memoized on the icon itself, since resolved icons are cached and reused."""
    if fetched.transparent is None:
        fetched.transparent = _has_transparency(fetched.content, fetched.content_type)
    return fetched.transparent


def _cache_headers(cache_control: str) -> dict[str, str]:
    """The headers every answer from this route carries, hit or miss.

    Both parts matter, and a miss needs them just as much as a hit does: a
    404 nothing is allowed to cache is re-asked on every render, which is
    what turned a station without a findable icon into a permanent stream
    of 4xx from one IP (see _NEGATIVE_CACHE_CONTROL)."""
    return {
        "Cache-Control": cache_control,
        # Set here rather than left to CORSMiddleware, which only adds it
        # when the request carried an Origin at all. Anything that fetches
        # this URL without one — an <img src>, a non-browser client — got a
        # cacheable 200 with no Vary and no Access-Control-Allow-Origin, and
        # the browser is then entitled to serve that same entry to a later
        # fetch() from the app, which fails it as "No
        # 'Access-Control-Allow-Origin' header is present" without a request
        # ever leaving the machine. Against a week of max-age, one such
        # fetch poisoned the station's logo for a week, survived every
        # reload (a normal one reads the disk cache) and looked for all the
        # world like a CORS misconfiguration on a backend that was answering
        # correctly.
        #
        # A request that *does* carry an Origin ends up with
        # "Vary: Origin, Origin", since CORSMiddleware appends its own.
        # Harmless — a repeated field value is well-formed and every cache
        # reads it as the single field name it repeats — and preferable to
        # the alternative, which is making this response depend on
        # inspecting the request to guess what the middleware is about to
        # do.
        "Vary": "Origin",
    }


def _favicon_response(fetched: _Fetched) -> Response:
    return Response(
        content=fetched.content,
        media_type=fetched.content_type,
        headers={
            **_cache_headers(_CACHE_CONTROL),
            "X-Has-Transparency": "true" if _transparency(fetched) else "false",
        },
    )


def _no_favicon_response(status_code: int) -> Response:
    """A lookup that found nothing (404) or was asked something malformed
    (400). Cacheable on purpose — see _NEGATIVE_CACHE_CONTROL."""
    return Response(status_code=status_code, headers=_cache_headers(_NEGATIVE_CACHE_CONTROL))


def _select(candidates: list[_Candidate], min_size: int) -> list[_Candidate]:
    """Orders candidates best-first for the requested min_size: the
    smallest one that still meets it (no point downloading a 512px icon
    for a 24px list row), then every other size-meeting candidate, then
    every remaining (too-small) candidate largest-first — so a request
    that can't be satisfied still ends up trying the closest thing
    available rather than the worst one, before finally giving up."""
    meets = sorted((c for c in candidates if c.size >= min_size), key=lambda c: c.size)
    remainder = sorted(
        (c for c in candidates if c.size < min_size), key=lambda c: c.size, reverse=True
    )
    return meets + remainder


async def _try_candidate(candidate: _Candidate) -> _Fetched | None:
    """Fetches, validates and measures one candidate, or None for anything
    wrong with it (unreachable, too large, not actually an image) — the
    shared shape both the cascade below and the Radio Browser favicon hint
    use, so a dead link is handled exactly one way regardless of which list
    it came from."""
    if candidate.url.startswith("data:"):
        # Nothing to fetch — see _decode_data_uri()'s own comment.
        decoded = _decode_data_uri(candidate.url)
        if decoded is None:
            return None
        content, content_type = decoded
        if len(content) > _MAX_BYTES or not content_type.startswith("image/"):
            return None
        pixels = _pixel_size(content, content_type, scalable=not candidate.is_mask_icon)
        return _Fetched(content, content_type, pixels or candidate.size)

    try:
        resp = await _client.get(candidate.url)
    # InvalidURL is deliberately not an httpx.HTTPError, so it needs naming
    # separately — a candidate URL httpx refuses to even build a request
    # from is just another dead candidate, not a reason to fail the lookup.
    except (httpx.HTTPError, httpx.InvalidURL) as e:
        logger.info(f"[radio-favicon] {candidate.url} unreachable: {type(e).__name__}: {e}")
        return None

    content_type = resp.headers.get("content-type", "")
    if (
        resp.status_code != 200
        or len(resp.content) > _MAX_BYTES
        or not content_type.startswith("image/")
    ):
        return None

    pixels = _pixel_size(resp.content, content_type, scalable=not candidate.is_mask_icon)
    return _Fetched(resp.content, content_type, pixels or candidate.size)


# ── resolving a station's icon, and keeping the answer ───────────────────
#
# Everything below this line exists to answer the same question — "what is
# this station's logo?" — for two callers with very different shapes: a
# single <img src> (GET /radio-favicon) and a whole list at once (POST
# /radio-favicon/batch). They share one resolver, one cache and one
# concurrency budget, so which one a screen happens to use changes only how
# many HTTP requests cross the network, never how much work this backend or
# a station's own server does.


def _homepage_is_usable(url: str) -> bool:
    """Same http(s)-only restriction as /play-url's radio URL (routes/
    playback.py) — this backend has LAN access (that's its whole job), so
    fetching an arbitrary caller-supplied URL server-side is treated with
    the same care there as here, not a new/different trust level."""
    return url.lower().startswith(("http://", "https://")) and bool(urlparse(url).netloc)


async def _resolve_favicon(url: str, hint: str, min_size: int) -> _Fetched | None:
    """The actual lookup: the best icon at least min_size across the hint
    and the homepage's own declarations, the largest thing found if nothing
    reaches it, or None if there is nothing at all."""
    # Best icon retrieved so far, kept across both stages below so a
    # too-small one is still returned when nothing better turns up.
    best: _Fetched | None = None

    # `hint` is Radio Browser's own `favicon` field (see core/radio_browser.py's
    # _to_station()) — it already named the right icon, so there's no reason
    # to pay for scraping `url`'s homepage at all when it is big enough.
    # Still routed through this same backend rather than a direct <img src>
    # in RadioView.vue: that would leak the browsing user's own IP to the
    # station's favicon host, exactly what this whole proxy exists to avoid
    # for the homepage-scrape path below.
    if hint.lower().startswith(("http://", "https://")):
        best = await _try_candidate(_Candidate(url=hint, size=0))
        # Radio Browser's field carries no size with it, and what it points
        # at is very often a 16/32px browser favicon — fine for a list row,
        # visibly soft blown up to NowPlayingView's artwork. Measuring it
        # (rather than taking it on trust, as this used to) is what makes
        # the homepage worth scraping for something better. With the
        # default min_size=0 nothing is ever "too small", so a caller that
        # doesn't care still pays for exactly one fetch, as before.
        if best is not None and best.pixels >= min_size:
            return best

    if url:
        # Cascades through the candidates (best declared match for min_size
        # first) — one dead link (a declared icon that 404s, an oversized/
        # wrong-type response, ...) shouldn't sink the whole lookup when
        # there's another perfectly good candidate right behind it.
        #
        # Keeps going past the first *usable* one until one actually meets
        # min_size, since a declared sizes="" (or a plain /favicon.ico,
        # which declares nothing at all) says nothing about what the file
        # really is. Bounded by _MAX_FETCHES so a page declaring a long
        # list of dead icons can't turn one request into a dozen fetches.
        fetches = 0
        for candidate in _select(await _discover_candidates(url), min_size):
            if fetches >= _MAX_FETCHES:
                break
            # Its own <link sizes> already promises nothing better than
            # what is in hand — downloading it could only confirm that.
            # Only skippable because the declaration is a *claim about a
            # size*: a candidate that declares nothing (size 0), or whose
            # size is a sort-order sentinel rather than a real claim (the
            # implicit /favicon.ico fallback — see _Candidate.is_declared_size),
            # says nothing about being smaller either, so it still gets
            # fetched and measured.
            if (
                best is not None
                and candidate.is_declared_size
                and 0 < candidate.size <= best.pixels
            ):
                continue
            fetches += 1
            fetched = await _try_candidate(candidate)
            if fetched is None:
                continue
            if fetched.pixels >= min_size:
                return fetched
            # Nothing meets the request yet — hold on to the largest, so
            # the answer is the closest thing available rather than
            # whichever dead-end happened to come last.
            if best is None or fetched.pixels > best.pixels:
                best = fetched

    return best


# How long a resolved icon is kept in memory. Matches _CACHE_CONTROL: the
# browser is told a hit is good for a week, so there is nothing to be
# gained by expiring our own copy sooner — and a miss is kept for the
# shorter _NEGATIVE_CACHE_CONTROL window, same reasoning as there.
#
# Unlike the browser's cache this one is shared by every client and every
# icon size, which is what makes the batch endpoint below cheap: a list of
# fifty stations resolves each station's homepage once, not once per client
# and not again on the next visit.
_RESULT_CACHE_TTL = 604800.0
_RESULT_NEGATIVE_TTL = 21600.0

# Icons are small (_MAX_BYTES caps one at 512 KB) but a large library of
# stations at several sizes each is not, so the cache is bounded by what it
# actually holds rather than by a count, and gives up its least recently
# used entries first.
_RESULT_CACHE_MAX_BYTES = 24 * 1024 * 1024

# How many station lookups may run at once. Each one can mean a homepage
# fetch plus up to _MAX_FETCHES icon fetches against a third-party host, so
# this is as much politeness towards the stations as it is protection for
# this backend: a batch of fifty must not become fifty simultaneous
# scrapes.
_MAX_CONCURRENT_RESOLVES = 8

_ResultKey = tuple[str, str, int]

_result_cache: OrderedDict[_ResultKey, tuple[float, _Fetched | None]] = OrderedDict()
_result_cache_bytes = 0
# One in-flight resolution per key, so the same station asked for by two
# screens (or two clients) at the same moment is looked up once.
_inflight: dict[_ResultKey, asyncio.Task[_Fetched | None]] = {}

# Per event loop, not one module-level Semaphore: a Semaphore binds itself
# to the loop it first has to wait on, and this module is imported once
# while a test suite runs a short-lived loop per request. Weak-keyed so a
# finished loop takes its semaphore with it.
_resolve_slots: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    weakref.WeakKeyDictionary()
)


def _slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    semaphore = _resolve_slots.get(loop)
    if semaphore is None:
        semaphore = asyncio.Semaphore(_MAX_CONCURRENT_RESOLVES)
        _resolve_slots[loop] = semaphore
    return semaphore


def _cache_drop(key: _ResultKey) -> None:
    global _result_cache_bytes
    entry = _result_cache.pop(key, None)
    if entry is not None and entry[1] is not None:
        _result_cache_bytes -= len(entry[1].content)


def _cache_get(key: _ResultKey) -> tuple[bool, _Fetched | None]:
    """(whether this key is cached at all, what it resolved to) — the two
    have to be separate, since a cached *miss* is a real answer worth
    keeping and is also None.

    Every lookup, single and batch alike, comes through here first, which
    is what makes it the place to fault in last run's answers (_disk_load()
    returns immediately after the first call)."""
    _disk_load()
    entry = _result_cache.get(key)
    if entry is None:
        return False, None
    expires, value = entry
    if time.monotonic() >= expires:
        _cache_drop(key)
        return False, None
    _result_cache.move_to_end(key)
    return True, value


def _cache_put(key: _ResultKey, value: _Fetched | None, expires: float | None = None) -> None:
    """`expires` (monotonic, as _cache_get() reads it) only for an entry
    restored from disk, which has already spent part of its life — a fresh
    resolution takes the full TTL from now."""
    global _result_cache_bytes
    _cache_drop(key)
    if expires is None:
        ttl = _RESULT_CACHE_TTL if value is not None else _RESULT_NEGATIVE_TTL
        expires = time.monotonic() + ttl
    _result_cache[key] = (expires, value)
    if value is not None:
        _result_cache_bytes += len(value.content)
    while _result_cache_bytes > _RESULT_CACHE_MAX_BYTES and len(_result_cache) > 1:
        _cache_drop(next(iter(_result_cache)))


# ── keeping resolved icons across restarts ───────────────────────────────
#
# Everything above this point is lost when the process ends, which for most
# of this backend is the right trade: cover art comes off the media server
# on the LAN, so rebuilding that cache is cheap and bothers nobody. A radio
# logo does not. Finding one means fetching a stranger's homepage over the
# internet and reading it to the end of its <head> — a few hundred KB for
# sites like hitradion1.de — and then fetching the icon it names, once per
# saved station. The packaged desktop app spawns its own connect (see
# src/main/index.ts), so without this every launch pays that again for
# every station in the list, against every one of those third-party hosts.
#
# One small file per entry rather than a single index: a resolution writes
# only its own file, so a batch resolving fifty stations doesn't rewrite a
# growing file fifty times, and a file that ends up corrupt (a power cut
# mid-write) costs exactly one station's logo rather than all of them.
_DISK_DIR = os.path.join(
    os.environ.get("CONNECT_DATA_DIR")
    or os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "radio-favicons",
)

# Far below the in-memory budget on purpose. This holds what a real station
# list actually needs (a handful of KB per station per size), not a slice of
# the whole directory — anything past it is a station nobody has, which is
# cheaper to look up again than to carry around forever.
_DISK_CACHE_MAX_BYTES = 3 * 1024 * 1024

_disk_loaded = False
_disk_bytes = 0


def _disk_path(key: _ResultKey) -> str:
    url, hint, min_size = key
    digest = hashlib.sha256("\0".join((url, hint, str(min_size))).encode()).hexdigest()
    return os.path.join(_DISK_DIR, f"{digest[:32]}.json")


def _disk_load() -> None:
    """Restores what the last run resolved, once, on the first lookup of
    this one. Stored expiries are wall-clock (a monotonic clock means
    nothing to the next process) and converted back on the way in, so an
    entry that ran out while nothing was running does not come back."""
    global _disk_loaded, _disk_bytes
    if _disk_loaded:
        return
    _disk_loaded = True

    try:
        names = os.listdir(_DISK_DIR)
    except FileNotFoundError:
        return
    except OSError as e:
        logger.warning(f"[radio-favicon] disk cache unreadable: {e}")
        return

    now_wall, now_monotonic = time.time(), time.monotonic()
    restored = 0
    for name in names:
        path = os.path.join(_DISK_DIR, name)
        try:
            with open(path, encoding="utf-8") as f:
                entry = json.load(f)
            remaining = float(entry["expires"]) - now_wall
            if remaining <= 0:
                os.remove(path)
                continue
            key = (str(entry["url"]), str(entry["hint"]), int(entry["min_size"]))
            encoded = entry["content"]
            fetched = None
            if encoded is not None:
                fetched = _Fetched(
                    content=base64.b64decode(encoded),
                    content_type=str(entry["content_type"]),
                    pixels=int(entry["pixels"]),
                    # Carried rather than recomputed, because it is a
                    # full image decode (_has_transparency()) that this
                    # already paid for once — except for an SVG, whose
                    # answer costs a string comparison and whose *stored*
                    # answer may predate the rule that produces it now (an
                    # entry written before SVGs were recognised as
                    # transparent at all says false, and would keep a logo
                    # framed for the rest of the week the entry is good
                    # for). None means "ask again", see _transparency().
                    transparent=(
                        None
                        if str(entry["content_type"]).startswith("image/svg")
                        else bool(entry["transparent"])
                    ),
                )
            _cache_put(key, fetched, expires=now_monotonic + remaining)
            _disk_bytes += os.path.getsize(path)
            restored += 1
        # A truncated, hand-edited or half-written file is one station's
        # logo, not a reason to start with nothing — drop it and move on.
        except (OSError, ValueError, KeyError, TypeError, binascii.Error) as e:
            logger.info(f"[radio-favicon] discarding cache file {name}: {type(e).__name__}: {e}")
            try:
                os.remove(path)
            except OSError:
                pass
    if restored:
        logger.info(f"[radio-favicon] restored {restored} cached icons ({_disk_bytes // 1024} KB)")


def _disk_evict() -> None:
    """Drops least-recently-written files until back inside the budget.
    Modification time rather than the in-memory LRU order, since the point
    is to bound what a *previous* run left behind as much as this one."""
    global _disk_bytes
    try:
        entries = []
        for name in os.listdir(_DISK_DIR):
            path = os.path.join(_DISK_DIR, name)
            stat = os.stat(path)
            entries.append((stat.st_mtime, stat.st_size, path))
        entries.sort()
        total = sum(size for _, size, _ in entries)
        while total > _DISK_CACHE_MAX_BYTES and entries:
            _, size, path = entries.pop(0)
            os.remove(path)
            total -= size
        _disk_bytes = total
    except OSError as e:
        logger.warning(f"[radio-favicon] disk cache eviction failed: {e}")


def _disk_store(key: _ResultKey, fetched: _Fetched | None) -> None:
    """Mirrors one resolution. Written through a temporary file and renamed,
    so a reader (the next process) only ever sees a whole entry. Never
    raises: a cache that can't be written is slower, not broken."""
    global _disk_bytes
    url, hint, min_size = key
    ttl = _RESULT_CACHE_TTL if fetched is not None else _RESULT_NEGATIVE_TTL
    entry = {
        "url": url,
        "hint": hint,
        "min_size": min_size,
        "expires": time.time() + ttl,
        "content_type": fetched.content_type if fetched else None,
        "pixels": fetched.pixels if fetched else 0,
        # Resolved here rather than left as None: a restored entry that
        # still had to decode its own image on first ask would give back
        # the one thing this file is meant to have finished with.
        "transparent": _transparency(fetched) if fetched else False,
        "content": base64.b64encode(fetched.content).decode("ascii") if fetched else None,
    }
    path = _disk_path(key)
    tmp = f"{path}.tmp"
    try:
        os.makedirs(_DISK_DIR, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(entry, f)
        os.replace(tmp, path)
        _disk_bytes += os.path.getsize(path)
        if _disk_bytes > _DISK_CACHE_MAX_BYTES:
            _disk_evict()
    except OSError as e:
        logger.warning(f"[radio-favicon] caching {url or hint} to disk failed: {e}")
        try:
            os.remove(tmp)
        except OSError:
            pass


async def _resolve_and_store(key: _ResultKey) -> _Fetched | None:
    url, hint, min_size = key
    try:
        async with _slots():
            fetched = await _resolve_favicon(url, hint, min_size)
    except Exception:
        # Deliberately not cached: an unexpected failure says nothing about
        # whether this station has an icon, and caching it as "no" would
        # hide the logo for the whole negative TTL over one bad moment.
        logger.exception(f"[radio-favicon] resolving {url or hint} failed")
        return None
    finally:
        _inflight.pop(key, None)
    _cache_put(key, fetched)
    _disk_store(key, fetched)
    return fetched


def _resolution(key: _ResultKey) -> asyncio.Task[_Fetched | None]:
    """The task resolving this key, started if nobody else has. Never
    raises, so a caller that walks away (a disconnected client, a batch
    that hit its deadline) leaves a task that still finishes and still
    fills the cache, rather than one whose exception nobody retrieves."""
    task = _inflight.get(key)
    if task is None:
        task = asyncio.ensure_future(_resolve_and_store(key))
        _inflight[key] = task
    return task


async def _resolve_cached(key: _ResultKey) -> _Fetched | None:
    hit, value = _cache_get(key)
    if hit:
        return value
    # Shielded: this awaits a task that may be shared with other requests,
    # and one client giving up must not cancel the lookup the others are
    # still waiting on.
    return await asyncio.shield(_resolution(key))


@router.get("/radio-favicon")
async def radio_favicon(
    # Optional: a station played straight out of the discover dialog
    # without being added can carry a `hint` but no homepage at all (see
    # RadioStation.favicon's own comment in types/library.ts) — `hint` alone
    # is still enough to resolve a favicon for one of those, see below.
    url: str = Query(default=""),
    min_size: int = Query(default=0),
    hint: str = Query(default=""),
) -> Response:
    # Only enforced when a homepage was actually given — see `url`'s own
    # comment above for why an empty one is valid too.
    if url and not _homepage_is_usable(url):
        return _no_favicon_response(400)

    fetched = await _resolve_cached((url, hint, min_size))
    if fetched is None:
        return _no_favicon_response(404)
    return _favicon_response(fetched)


# One screenful of station rows, generously — the same cap and the same
# reasoning as routes/coverart.py's _MAX_IDS, which this endpoint is
# modelled on.
_MAX_BATCH_STATIONS = 200

# How long a batch waits for the icons it had to look up before answering
# with what it has. Long enough that a station whose homepage responds
# promptly makes it into the first answer, short enough that one dead host
# (which costs the full 5s client timeout, possibly several times over)
# can never hold up the rest of the list.
#
# Whatever misses the deadline is not thrown away: its lookup keeps running
# and lands in _result_cache, so the caller's follow-up batch is a cache
# hit rather than a repeat of the work.
_BATCH_DEADLINE = 2.5


class FaviconBatchStation(BaseModel):
    """One station in a batch. `key` is the caller's own handle for it and
    is echoed back verbatim — the client groups its own pending requests by
    it (see services/connect/radioFaviconBatch.ts), and nothing here needs
    to know how it is built."""

    key: str
    url: str = ""
    hint: str = ""
    min_size: int = 0


class FaviconBatchRequest(BaseModel):
    stations: list[FaviconBatchStation] = Field(default_factory=list)


def _batch_entry(fetched: _Fetched | None) -> dict[str, object] | None:
    if fetched is None:
        return None
    encoded = base64.b64encode(fetched.content).decode("ascii")
    return {
        "data_url": f"data:{fetched.content_type};base64,{encoded}",
        # Carried in the payload rather than left to a second request for
        # the header version of the same answer (services/
        # imageTransparency.ts): that request exists only to read one
        # response header, and it is a per-station round trip this endpoint
        # is specifically here to remove.
        "transparent": _transparency(fetched),
    }


@router.post("/radio-favicon/batch")
async def radio_favicon_batch(request: FaviconBatchRequest) -> JSONResponse:
    """Resolves a whole list of station logos in one request.

    Why this exists: a radio list renders one <img> per station, each under
    its own one-off URL carrying that station's homepage. Fifty of those in
    the second after a view opens is a burst of fifty distinct paths from
    one IP — the shape a probe/crawl detector is built to catch, and the
    one that got a real user banned by the reverse proxy's IPS (see
    _NEGATIVE_CACHE_CONTROL, and routes/coverart.py for the same story on
    cover art). One POST is one path, whatever the list holds.

    `results` maps each caller key to its icon, or to null for a station
    that genuinely has none. `pending` lists the keys whose lookup did not
    finish inside _BATCH_DEADLINE and are worth asking for again shortly —
    the work continues in the background, so the next ask is a cache hit.
    A key appears in exactly one of the two."""
    results: dict[str, dict[str, object] | None] = {}
    started: dict[str, asyncio.Task[_Fetched | None]] = {}

    for station in request.stations[:_MAX_BATCH_STATIONS]:
        # A repeated key is the caller asking twice for one thing; one
        # answer settles both (see the client's own per-key grouping).
        if station.key in results or station.key in started:
            continue
        url = station.url if _homepage_is_usable(station.url) else ""
        if not url and not station.hint:
            # Nothing to go on at all — a definite "no icon", not an error,
            # and worth saying so rather than leaving the caller to retry.
            results[station.key] = None
            continue
        key = (url, station.hint, station.min_size)
        hit, value = _cache_get(key)
        if hit:
            results[station.key] = _batch_entry(value)
            continue
        started[station.key] = _resolution(key)

    if started:
        # Not asyncio.gather: the point is to wait *up to* the deadline and
        # leave whatever is still running running. wait() cancels nothing.
        await asyncio.wait(started.values(), timeout=_BATCH_DEADLINE)

    pending = []
    for caller_key, task in started.items():
        if task.done() and not task.cancelled():
            results[caller_key] = _batch_entry(task.result())
        else:
            pending.append(caller_key)

    return JSONResponse({"results": results, "pending": pending})


@router.get("/radio-browser/search")
async def radio_browser_search(
    name: str = Query(default=""),
    limit: int = Query(default=30),
    # Repeatable (?countrycode=DE&countrycode=FR) — RadioView.vue's country
    # select is multi-select, and search_stations() fans a list of more
    # than one of these out into its own request per code (see that
    # function's own docstring for why).
    countrycode: list[str] = Query(default=[]),
    order: str = Query(default="votes"),
):
    # No early return for a blank name here — see search_stations()'s own
    # docstring for why that's a real, intended request (the dialog's
    # initial "browse top stations" view before anyone has typed anything),
    # not something to short-circuit the way it would be for a local filter
    # field.
    stations = await search_stations(
        name.strip(), limit=limit, countrycodes=countrycode or None, order=order
    )
    if stations is None:
        # Every mirror was unreachable — distinct from a real, empty
        # result (see search_stations()'s own docstring), and worth a
        # different message in RadioView.vue's dialog than "no stations
        # found for that name".
        return JSONResponse({"error": "Radio Browser is unreachable"}, status_code=502)
    return {"stations": stations}


@router.get("/radio-browser/countries")
async def radio_browser_countries():
    countries = await list_countries()
    if countries is None:
        return JSONResponse({"error": "Radio Browser is unreachable"}, status_code=502)
    return {"countries": countries}


@router.post("/radio-browser/click/{stationuuid}")
async def radio_browser_click(stationuuid: str) -> dict:
    # Fire-and-forget from the caller's perspective — see register_click()'s
    # own docstring for why nothing here is worth failing the request over.
    await register_click(stationuuid)
    return {"ok": True}


@router.get("/radio-stream-url")
async def radio_stream_url(url: str = Query(...)) -> dict:
    """The playable audio URL behind a station's own URL - see
    core/playlist_url.py for why a station published as a .m3u/.pls needs
    one at all. Called by the frontend before *local* playback, which never
    otherwise reaches this backend and so has nowhere else to have this
    done; the casting path resolves it inside /play-url itself.

    Always answers with a URL, never an error: a playlist that can't be
    read hands back the original, so the caller is exactly where it would
    have been without asking."""
    return {"url": await resolve_stream_url(url)}


class RadioMetadataStartRequest(BaseModel):
    url: str


@router.post("/radio-metadata/start")
async def start_radio_metadata(
    body: RadioMetadataStartRequest,
    session: SessionState = Depends(require_authenticated_session),
) -> dict:
    session.start_radio_metadata_watch(body.url)
    return {"status": "ok"}


@router.post("/radio-metadata/stop")
async def stop_radio_metadata(
    session: SessionState = Depends(require_authenticated_session),
) -> dict:
    session.stop_radio_metadata_watch()
    return {"status": "ok"}


@router.get("/radio-metadata")
async def get_radio_metadata(
    session: SessionState = Depends(require_authenticated_session),
) -> dict:
    """The station's current title, every title it has played this session
    (newest first, see SessionState.radio_title_log()), and what the
    station declares it broadcasts at (kbps, or null - see
    SessionState.radio_bitrate).

    The log has to be built here rather than accumulated by the frontend
    from these very answers: this is polled every 8s and only while
    services/connect/pollGate.ts allows it at all (it pauses on a hidden
    window and during a proxy backoff), so a client-side log would have
    holes exactly where nobody was watching — and a different set of them
    on every device."""
    return {
        "title": session.radio_title,
        "history": session.radio_title_log(),
        "bitrate": session.radio_bitrate,
        "codec": session.radio_codec,
    }
