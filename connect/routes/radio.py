"""routes/radio.py — GET /radio-favicon

Internet radio stations are Navidrome's own resource (createInternetRadioStation
etc., proxied straight through routes/proxy.py) and have no favicon concept of
their own. This fetches one directly from a station's homepage_url on the
frontend's behalf — an <img src> can't do this itself (the station's homepage is
on a third-party host with no CORS allowance for this app, and a direct browser
fetch would also leak the browsing user's own IP to every radio station's host on
every single radio list render, not just once from here).
"""

import io
import logging
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError

from core.auth import require_token

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

# How much of the homepage's own HTML is read looking for <link rel="icon">
# tags — favicon declarations live in <head>, which on virtually every real
# site is well within this, so there's no need to risk reading (and every
# caller waiting on) an entire multi-MB page just to find them.
_MAX_HTML_BYTES = 256 * 1024

# Browser-side cache only — this backend doesn't keep its own copy of the
# actual image, so there's nothing to invalidate here if a station's
# homepage favicon changes; the browser will just refetch after this
# expires.
_CACHE_CONTROL = "public, max-age=604800"

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
        self.links: list[tuple[str, str]] = []  # (href, sizes)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "link":
            return
        values = {k.lower(): v for k, v in attrs if v is not None}
        rel = (values.get("rel") or "").strip().lower()
        href = values.get("href")
        if rel in _ICON_RELS and href:
            self.links.append((href, values.get("sizes", "")))


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
                for href, sizes in parser.links:
                    candidates.append(
                        _Candidate(
                            url=urljoin(homepage_url, href), size=_parse_sizes(sizes)
                        )
                    )
    except httpx.HTTPError as e:
        logger.info(f"[radio-favicon] {homepage_url} unreachable: {e}")

    # The implicit browser convention (no <link> needed) — always included
    # as the last resort, even when the HTML fetch above found nothing (or
    # failed outright): plenty of sites rely on this working without ever
    # declaring it. Rated as size 1, not 0, so it still sorts after every
    # *declared* icon (even ones with no `sizes` attribute — declaring the
    # tag at all is a slightly stronger signal of being an intentional,
    # reasonable-quality icon than the bare convention path is) but is
    # never mistaken for "no candidate at all".
    candidates.append(_Candidate(url=f"{root}/favicon.ico", size=1))

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
    except (UnidentifiedImageError, OSError, ValueError):
        return False


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


@router.get("/radio-favicon")
async def radio_favicon(
    url: str = Query(...), min_size: int = Query(default=0)
) -> Response:
    # Same http(s)-only restriction as /play-url's radio URL (routes/
    # playback.py) — this backend has LAN access (that's its whole job),
    # so fetching an arbitrary caller-supplied URL server-side is treated
    # with the same care there as here, not a new/different trust level.
    if not url.lower().startswith(("http://", "https://")):
        return Response(status_code=400)
    if not urlparse(url).netloc:
        return Response(status_code=400)

    candidates = await _discover_candidates(url)

    # Cascades through every candidate (best match for min_size first) —
    # one dead link (a declared icon that 404s, an oversized/wrong-type
    # response, ...) shouldn't sink the whole lookup when there's another
    # perfectly good candidate right behind it.
    for candidate in _select(candidates, min_size):
        try:
            resp = await _client.get(candidate.url)
        except httpx.HTTPError as e:
            logger.info(f"[radio-favicon] {candidate.url} unreachable: {e}")
            continue

        content_type = resp.headers.get("content-type", "")
        if (
            resp.status_code != 200
            or len(resp.content) > _MAX_BYTES
            or not content_type.startswith("image/")
        ):
            continue

        return Response(
            content=resp.content,
            media_type=content_type,
            headers={
                "Cache-Control": _CACHE_CONTROL,
                "X-Has-Transparency": "true"
                if _has_transparency(resp.content)
                else "false",
            },
        )

    return Response(status_code=404)
