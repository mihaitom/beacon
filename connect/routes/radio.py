"""routes/radio.py — GET /radio-favicon, GET /radio-browser/search,
GET /radio-browser/countries, POST /radio-browser/click/{stationuuid},
POST /radio-metadata/start, POST /radio-metadata/stop, GET /radio-metadata

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
IP-leak reason.

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
import io
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import unquote_to_bytes, urljoin, urlparse

import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, Response
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel

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

# How much of the homepage's own HTML is read looking for <link rel="icon">
# tags — favicon declarations live in <head>, which on virtually every real
# site is well within this, so there's no need to risk reading (and every
# caller waiting on) an entire multi-MB page just to find them.
_MAX_HTML_BYTES = 256 * 1024

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
    _ICON_RELS. Not head-aware (doesn't track whether it's actually still
    inside <head>): a stray matching <link> in <body> is vanishingly rare
    in practice and harmless to pick up anyway, not worth the extra state
    to exclude."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str, bool]] = []  # (href, sizes, is_mask_icon)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "link":
            return
        values = {k.lower(): v for k, v in attrs if v is not None}
        rel = (values.get("rel") or "").strip().lower()
        href = values.get("href")
        if rel in _ICON_RELS and href:
            self.links.append((href, values.get("sizes", ""), rel == "mask-icon"))


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

    parsed = urlparse(homepage_url)
    root = f"{parsed.scheme}://{parsed.netloc}"
    candidates: list[_Candidate] = []

    try:
        async with _client.stream("GET", homepage_url) as resp:
            if resp.headers.get("content-type", "").split(";")[0].strip() in (
                "text/html",
                "application/xhtml+xml",
            ):
                chunks = []
                read = 0
                async for chunk in resp.aiter_bytes():
                    chunks.append(chunk)
                    read += len(chunk)
                    if read >= _MAX_HTML_BYTES:
                        break
                html = b"".join(chunks).decode("utf-8", errors="ignore")
                parser = _IconLinkParser()
                parser.feed(html)
                for href, sizes, is_mask_icon in parser.links:
                    # urljoin parses `href` and raises for a malformed one
                    # ("Invalid IPv6 URL" for a stray "//[", say). One
                    # broken <link> in a station's HTML is no reason to
                    # fail the whole lookup — skip it like any other dead
                    # candidate and keep the good ones.
                    try:
                        resolved = urljoin(homepage_url, href)
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
    candidates.append(_Candidate(url=f"{root}/favicon.ico", size=1, is_declared_size=False))

    _candidate_cache[homepage_url] = (time.monotonic(), candidates)
    return candidates


# Below this fraction of pixels being meaningfully transparent (alpha <
# 32), an image counts as opaque for _has_transparency() below — a handful
# of antialiased edge pixels shouldn't flip NowPlayingView.vue's whole
# presentation (see its radioIconIsTransparent) into "logo floating on
# transparency" mode.
_MIN_TRANSPARENT_RATIO = 0.05


def _has_transparency(content: bytes) -> bool:
    """True if `content` decodes as an image with a real, meaningfully-used
    alpha channel — computed server-side (not by having the frontend sample
    a canvas) because this backend already has the raw bytes in hand with
    no CORS/tainted-canvas considerations to work around at all, and
    because decoding untrusted third-party image bytes is exactly the kind
    of thing worth keeping off the renderer regardless. Any failure
    (unrecognized format, corrupt data, ...) reads as "no transparency" —
    NowPlayingView.vue's own card treatment for a normal opaque image is a
    perfectly reasonable fallback for "couldn't tell"."""
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
            "X-Has-Transparency": "true" if _has_transparency(fetched.content) else "false",
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
    # Same http(s)-only restriction as /play-url's radio URL (routes/
    # playback.py) — this backend has LAN access (that's its whole job),
    # so fetching an arbitrary caller-supplied URL server-side is treated
    # with the same care there as here, not a new/different trust level.
    # Only enforced when a homepage was actually given — see `url`'s own
    # comment above for why an empty one is valid too.
    if url and (not url.lower().startswith(("http://", "https://")) or not urlparse(url).netloc):
        return Response(status_code=400)

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
            return _favicon_response(best)

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
                return _favicon_response(fetched)
            # Nothing meets the request yet — hold on to the largest, so
            # the answer is the closest thing available rather than
            # whichever dead-end happened to come last.
            if best is None or fetched.pixels > best.pixels:
                best = fetched

    if best is not None:
        return _favicon_response(best)

    return Response(status_code=404)


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
    return {"title": session.radio_title}
