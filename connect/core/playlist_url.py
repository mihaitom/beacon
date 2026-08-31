"""core/playlist_url.py — turns a radio "stream" URL that is really a
playlist file into the audio URL inside it.

A great many stations are published as a .m3u or .pls rather than as the
stream itself (Bayerischer Rundfunk's own b5aktuell_2.m3u, for one): the URL
answers with a couple of lines of text naming where the audio actually
lives. Nothing downstream can play that. A Sonos hands it back as `UPnP
Error 800`, and a browser's own <audio> element simply fails to load it —
neither is told *why*, because as far as either is concerned it asked for
audio and got a text file.

Radio Browser already solves this for stations added through the discover
dialog, by publishing a resolved URL alongside the submitted one (see
core/radio_browser.py's `url_resolved`). This is the same job for every
other station: one typed in by hand, or already in the library from before.

Deliberately keyed off the URL's own extension rather than fetching
everything to see what comes back — the overwhelmingly common case is a
real stream, and that case should cost nothing at all. A station whose
playlist URL hides behind an extensionless path stays unsupported; it can
be added by its real stream URL, same as today."""

import logging
import re

import httpx

logger = logging.getLogger("connect.playlist_url")

# Extensions worth looking inside. Note the absence of `.m3u8`: an HLS
# playlist looks superficially like an M3U but is *not* an indirection to
# be resolved away — it is the live format itself, continuously rewritten
# by the server, and players consume it as such. Picking the first segment
# URL out of one would produce a few seconds of audio that then stops.
_PLAYLIST_EXTENSIONS = (".m3u", ".pls", ".asx", ".xspf")

# Plenty for the handful of lines these files hold; a URL that answers with
# something enormous is not a playlist, whatever it is called.
_MAX_BYTES = 64 * 1024

_TIMEOUT = 5.0

_URL_RE = re.compile(r"https?://[^\s\"'<>]+")


def _is_playlist_url(url: str) -> bool:
    # Matched against the path only, so a query string (`?ext=.m3u`, a
    # cache-buster, an auth token) can neither trigger nor mask this.
    path = httpx.URL(url).path.lower()
    return path.endswith(_PLAYLIST_EXTENSIONS)


def _first_stream_url(body: str) -> str | None:
    """The first real audio URL in a playlist file, whichever of the four
    formats it is written in.

    One line-oriented pass rather than a parser per format: M3U lists bare
    URLs, PLS wraps them in `FileN=`, and ASX/XSPF bury them in an
    attribute or an element — but in all four the URL is the only http(s)
    text on its own line, so finding it needs no knowledge of the format.
    M3U's `#EXTINF`/`#EXTM3U` comments are the one thing that has to be
    understood, since a comment is free to mention a URL (a station
    homepage, most often) that is emphatically not the stream."""
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = _URL_RE.search(line)
        if match:
            return match.group(0)
    return None


async def resolve_stream_url(url: str, client: httpx.AsyncClient | None = None) -> str:
    """The playable audio URL behind `url`, or `url` itself.

    Returns the input unchanged for anything that isn't a playlist by
    extension, and *also* whenever resolving one fails — an unreachable or
    unparseable playlist leaves the caller exactly where it would have been
    without this, rather than turning a station that might still somehow
    work into one that provably can't."""
    if not _is_playlist_url(url):
        return url

    owned = client is None
    client = client or httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True)
    try:
        response = await client.get(url)
        response.raise_for_status()
        # Read a bounded prefix rather than the whole body: `content` is
        # already in memory here, so this only caps what gets *decoded* and
        # scanned, but the URL is always in the first line or two anyway.
        resolved = _first_stream_url(response.content[:_MAX_BYTES].decode("utf-8", "replace"))
    except httpx.HTTPError as e:
        logger.info(f"[playlist-url] {url} unreachable: {type(e).__name__}: {e}")
        return url
    finally:
        if owned:
            await client.aclose()

    if not resolved:
        logger.info(f"[playlist-url] {url} contained no stream URL")
        return url
    logger.info(f"[playlist-url] {url} → {resolved}")
    return resolved
