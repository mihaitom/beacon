"""core/stream_format.py — what content type to announce to a device for a
radio stream.

A cast device is told what to expect before it connects (Sonos in the DIDL
`protocolInfo`, see delivery/sonos.py). Get it wrong and the device refuses
the stream on the spot — `ERROR_UNSUPPORTED_FORMAT` from a Sonos, for a
stream it is perfectly capable of playing.

This used to be guessed from the URL's file extension alone, which is right
often enough to look solved and wrong in exactly the cases that matter.
`OWR_INTERNATIONAL_ADP.aac` is served as `audio/aacp` — HE-AAC, the
SHOUTcast-era type — and announcing the `.aac` extension's `audio/aac`
instead is what the speaker rejected. No extension can distinguish those
two; only the server can.

So the server is asked. One request, once, when a radio play starts, whose
response body is never read: the answer is in the headers. The extension
guess stays as the fallback for a station that can't be reached or won't
say, which is exactly the behaviour this replaces — never worse than
before, and right in the cases it can be."""

import logging
import os
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

logger = logging.getLogger("connect.stream_format")

# Kept in step with what deliveries actually accept — see delivery/sonos.py's
# protocolInfo. Only used when the server can't be asked.
_CONTENT_TYPE_FOR_EXTENSION = {
    ".mp3": "audio/mpeg",
    ".aac": "audio/aac",
    ".adts": "audio/aac",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
}

FALLBACK_CONTENT_TYPE = "audio/mpeg"

# Short on purpose: this sits directly in front of "the speaker starts
# playing", and a station too slow to answer this is better served by the
# extension guess than by a listener waiting.
_TIMEOUT = 3.0


def content_type_from_extension(url: str) -> str:
    """The pre-probe behaviour, kept as the fallback. Reads the path only,
    so a query string (a token, a cache-buster) can't be mistaken for one."""
    suffix = os.path.splitext(urlparse(url).path)[1].lower()
    return _CONTENT_TYPE_FOR_EXTENSION.get(suffix, FALLBACK_CONTENT_TYPE)


# Streaming servers name the same codec several ways; devices are far less
# forgiving about which one they are handed. A Sonos answers `UPnP Error
# 714: Illegal MIME-Type` for a DIDL protocolInfo it doesn't recognise —
# which is what probing alone produced for `OWR_INTERNATIONAL_ADP.aac`:
# the station really is HE-AAC and really does say `audio/aacp`, and
# repeating that verbatim was refused where the plain `audio/aac` the file
# extension implies is not.
#
# So the probe decides *what the format is* and this decides *what to call
# it*. Only aliases for formats already in _CONTENT_TYPE_FOR_EXTENSION are
# listed: a type nothing here recognises is still passed through, since a
# device refusing an accurate name it doesn't know is no worse than being
# handed a guess, and the re-encode fallback (see routes/playback.py's
# retry_radio_via_proxy) covers either outcome.
_CANONICAL_CONTENT_TYPES = {
    "audio/aacp": "audio/aac",
    "audio/x-aac": "audio/aac",
    "audio/x-hx-aac-adts": "audio/aac",
    "audio/mp3": "audio/mpeg",
    "audio/mpeg3": "audio/mpeg",
    "audio/x-mpeg": "audio/mpeg",
    "audio/x-mpegaudio": "audio/mpeg",
    "audio/vorbis": "audio/ogg",
    "audio/x-ogg": "audio/ogg",
    "audio/opus": "audio/ogg",
    "audio/x-flac": "audio/flac",
    "audio/wave": "audio/wav",
    "audio/x-wav": "audio/wav",
}


def _usable(content_type: str) -> str | None:
    """The name to announce for what the server said it sends, else None.

    Parameters are dropped (`audio/aacp;charset=UTF-8`), aliases are folded
    onto the spelling devices actually accept (see
    _CANONICAL_CONTENT_TYPES), and anything not `audio/*` is refused rather
    than passed on: an Icecast mount that hasn't been configured answers
    `application/octet-stream`, and handing that to a device as the
    announced format is strictly worse than the guess."""
    bare = content_type.split(";")[0].strip().lower()
    if not bare.startswith("audio/"):
        return None
    return _CANONICAL_CONTENT_TYPES.get(bare, bare)


@dataclass(frozen=True)
class ProbedStream:
    """What the probe learned about a station.

    `refused` separates "the station itself said no" from every other
    reason a probe can come back empty. Only the handful of status codes
    that mean exactly that set it (see _REFUSED_STATUSES) — a timeout, a
    refused connection or a 5xx leave it False, because a station can be
    slow or briefly broken and still play fine a moment later, and
    refusing to try would be worse than trying and failing.

    `detail` is what the station actually answered, for the line under the
    message a listener reads."""

    content_type: str
    refused: bool = False
    detail: str = ""


# Answers that mean the station itself is the problem, not the moment.
# Seen live: a stored station answering 403 to everything, which reached a
# listener as the speaker's own ERROR_ACCESS_DENIED and then, once the
# re-encode fallback fetched the same 403, as ERROR_CORRUPT_FILE — two
# messages about the speaker for a problem that was never the speaker's.
_REFUSED_STATUSES = frozenset({401, 403, 404, 410})


async def probe_stream(url: str, client: httpx.AsyncClient | None = None) -> ProbedStream:
    """Ask the station what it sends, and whether it is serving at all.

    Deliberately a streaming GET rather than a HEAD: plenty of Icecast and
    SHOUTcast mounts answer HEAD with a 404 or an empty 200 while serving
    GET perfectly well. The body is never read — the context manager closes
    the connection as soon as the headers are in, so this costs the station
    one connection setup and nothing more."""
    owned = client is None
    client = client or httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True)
    try:
        async with client.stream("GET", url) as response:
            status = response.status_code
            response.raise_for_status()
            probed = _usable(response.headers.get("content-type", ""))
    except httpx.HTTPError as e:
        fallback = content_type_from_extension(url)
        status = e.response.status_code if isinstance(e, httpx.HTTPStatusError) else 0
        refused = status in _REFUSED_STATUSES
        logger.info(
            f"[stream-format] {url} could not be probed "
            f"({type(e).__name__}: {e}) — announcing {fallback}"
        )
        return ProbedStream(fallback, refused=refused, detail=f"HTTP {status}" if refused else "")
    finally:
        if owned:
            await client.aclose()

    if not probed:
        fallback = content_type_from_extension(url)
        logger.info(f"[stream-format] {url} declared no audio type — announcing {fallback}")
        return ProbedStream(fallback)
    logger.info(f"[stream-format] {url} → {probed}")
    return ProbedStream(probed)


async def resolve_content_type(url: str, client: httpx.AsyncClient | None = None) -> str:
    """Just the content type — for callers that have no use for whether the
    station is reachable."""
    return (await probe_stream(url, client)).content_type


def radio_content_type(radio_info: dict) -> str:
    """What to announce for a radio station already playing.

    Reuses whatever /play-url probed off the station itself when it
    started, rather than probing again — the station hasn't changed. Every
    path that reconnects to or joins a live station goes through here
    (/resume, /seek, /join, device add), so a device arriving late is told
    the same thing the first one was; before this they each fell back to
    play()'s own `audio/mpeg` default and an AAC station refused the
    joiner while happily playing on the original.

    Falls back to the extension guess for a session whose radio_info was
    written before the type was recorded, which is what every caller did
    unconditionally until now.

    A relayed station (radio_info["relayed"] — see core/radio_relay.py) is
    always MP3 on the device side regardless of what the station itself
    sends: RadioRelay's own ffmpeg always muxes into an MP3 container,
    whether or not it also re-encodes into one (see its _device_output_args()).
    The probed content_type recorded below is the *station's* real type,
    not what a relayed device actually receives — reusing it here for a
    relayed station would tell a device connecting to /stream/radio that
    it's getting, say, AAC, when it never does."""
    if radio_info.get("relayed"):
        return "audio/mpeg"
    return radio_info.get("content_type") or content_type_from_extension(radio_info["url"])
