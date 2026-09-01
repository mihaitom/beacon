"""core/icy_metadata.py — reads a radio stream's ICY "now playing" tag
(StreamTitle) in the background, for RadioView.vue/PlayerBar's now-playing
display.

ICY metadata (the SHOUTcast-era protocol, still what Icecast/Shoutcast
servers speak today) is interleaved directly into the audio byte stream, not
carried in a header or a separate request: a client asks for it with an
`Icy-MetaData: 1` request header, the server answers with its own
`icy-metaint` response header (how many audio bytes separate one metadata
block from the next), and every `icy-metaint` bytes there's a one-byte
length (in units of 16 bytes) followed by that many bytes of
`StreamTitle='Artist - Track';...` text. A plain HTML5 `<audio>` element has
no API for any of this — it just plays the audio and silently drops
whatever's interleaved into it — so this reads the stream itself, purely to
watch for the tag; core/session.py owns the actual start/stop lifecycle
(see its own comment on why that has to be explicit and player-agnostic:
local playback never involves this backend at all otherwise, only casting
does through /play-url).

Not every station declares `icy-metaint` at all - watch() below gives up for
good on one that doesn't rather than polling forever for a tag that will
never arrive."""

import asyncio
import logging
import re
from collections.abc import Callable

import httpx

from lyrics.shared import USER_AGENT

logger = logging.getLogger("connect.icy_metadata")

_TIMEOUT = httpx.Timeout(10.0, read=None)  # metadata trickles in for as long as the station plays
# follow_redirects, unlike most of this codebase's other httpx clients: a
# station's published URL is very often a load balancer that 302s to
# whichever node answers today (rockantenne.de's own mp3channels host hands
# out s1/s2/s5/s6-webradio.* per request). Without this, every single
# connection attempt raises on the redirect instead of ever reaching the
# audio, so a perfectly working station looks permanently unreachable.
_client = httpx.AsyncClient(
    timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT}, follow_redirects=True
)

_TITLE_RE = re.compile(rb"StreamTitle='(.*?)';", re.DOTALL)

# How long to wait before reconnecting after a stream drop - not the same
# situation as audioEngine.ts's own reconnect-on-drop (that one's fighting
# to keep audio from cutting out for the person listening); nobody's
# waiting on this one to resume within any particular time, so there's no
# reason for it to hammer a struggling server.
_RECONNECT_DELAY_SECONDS = 5.0

# ...and how far that backs off while the failures keep coming. A station
# that can't be reached now is usually still unreachable in five seconds,
# and this watch runs for as long as the radio plays - potentially hours.
_MAX_RECONNECT_DELAY_SECONDS = 60.0


class IcyDemuxer:
    """Incremental ICY demultiplexer: feed it raw response chunks
    (audio and metadata interleaved every `metaint` bytes, per the ICY
    protocol — see this module's own docstring), get pure audio bytes back
    and `on_title_change` fired for each StreamTitle actually found.

    Split out of what used to be _watch_once()'s own inline loop so
    core/radio_relay.py's RadioRelay — which needs the audio bytes this
    module has only ever thrown away — can reuse the exact same metaint-
    parsing logic instead of a second, drifting copy of it."""

    def __init__(self, metaint: int, on_title_change: Callable[[str], None]) -> None:
        self._metaint = metaint
        self._on_title_change = on_title_change
        self._buf = bytearray()

    def feed(self, chunk: bytes) -> bytes:
        """Returns the audio bytes now ready to emit — not simply `chunk`
        itself, since the audio/metadata boundary rarely lands on a chunk
        edge; some of it may still be held back in the internal buffer
        until a later feed() completes the block currently in progress."""
        self._buf.extend(chunk)
        audio = bytearray()
        while len(self._buf) >= self._metaint + 1:
            length = self._buf[self._metaint] * 16
            if len(self._buf) < self._metaint + 1 + length:
                break
            audio += self._buf[: self._metaint]
            if length:
                match = _TITLE_RE.search(
                    bytes(self._buf[self._metaint + 1 : self._metaint + 1 + length])
                )
                if match:
                    title = match.group(1).decode("utf-8", errors="replace").strip()
                    if title:
                        self._on_title_change(title)
            del self._buf[: self._metaint + 1 + length]
        return bytes(audio)


async def _watch_once(url: str, on_title_change: Callable[[str], None]) -> bool:
    """One connection attempt. Returns False when the station never even
    declared `icy-metaint` (nothing to retry - it isn't going to start
    mid-stream), True when metadata was seen but the connection then ended
    or dropped (worth reconnecting)."""
    async with _client.stream("GET", url, headers={"Icy-MetaData": "1"}) as resp:
        resp.raise_for_status()
        metaint = int(resp.headers.get("icy-metaint") or "0")
        if metaint <= 0:
            return False

        demuxer = IcyDemuxer(metaint, on_title_change)
        async for chunk in resp.aiter_bytes():
            demuxer.feed(chunk)  # audio bytes discarded — this watch only wants titles
    return True


def _reconnect_delay(consecutive_failures: int) -> float:
    """How long to wait before the next attempt. The backoff applies to a
    run of *failures* only: a stream that connected fine and simply ended
    (a station restarting its encoder, say) waits the base delay every
    time, however often it happens. The exponent is capped before the
    shift rather than after, so an hours-long outage doesn't compute
    2**(very large) just to throw the result away."""
    steps = min(max(consecutive_failures - 1, 0), 10)
    return min(_RECONNECT_DELAY_SECONDS * 2**steps, _MAX_RECONNECT_DELAY_SECONDS)


async def watch(url: str, on_title_change: Callable[[str], None]) -> None:
    """Runs until cancelled — see SessionState.start_radio_metadata_watch()/
    stop_radio_metadata_watch() for the lifecycle that starts and cancels
    this. `on_title_change` is called with a fresh, non-empty title every
    time the stream's own tag changes; never called at all for a station
    with no ICY support."""
    failures = 0
    last_failure: str | None = None
    while True:
        try:
            worth_retrying = await _watch_once(url, on_title_change)
            failures = 0
            last_failure = None
        except httpx.HTTPError as e:
            # First line only: httpx's own HTTPStatusError message is three
            # lines long (the status, the redirect target, a docs link), and
            # this is a routine background retry, not something anyone needs
            # a paragraph about.
            failure = f"{type(e).__name__}: {str(e).splitlines()[0]}"
            # A run of identical failures is one piece of information, not
            # one per attempt - a station that is down stays down, and this
            # keeps retrying for the whole time the radio plays. Only the
            # first of a run is worth an INFO line; the repeats stay
            # available at debug level for anyone actually chasing one.
            logger.log(
                logging.DEBUG if failure == last_failure else logging.INFO,
                f"[icy-metadata] {url} unreachable: {failure}",
            )
            last_failure = failure
            failures += 1
            worth_retrying = True
        if not worth_retrying:
            return
        await asyncio.sleep(_reconnect_delay(failures))
