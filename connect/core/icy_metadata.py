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
_client = httpx.AsyncClient(timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT})

_TITLE_RE = re.compile(rb"StreamTitle='(.*?)';", re.DOTALL)

# How long to wait before reconnecting after a stream drop - not the same
# situation as audioEngine.ts's own reconnect-on-drop (that one's fighting
# to keep audio from cutting out for the person listening); nobody's
# waiting on this one to resume within any particular time, so there's no
# reason for it to hammer a struggling server.
_RECONNECT_DELAY_SECONDS = 5.0


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

        buf = bytearray()
        async for chunk in resp.aiter_bytes():
            buf.extend(chunk)
            while len(buf) >= metaint + 1:
                length = buf[metaint] * 16
                if len(buf) < metaint + 1 + length:
                    break
                if length:
                    match = _TITLE_RE.search(bytes(buf[metaint + 1 : metaint + 1 + length]))
                    if match:
                        title = match.group(1).decode("utf-8", errors="replace").strip()
                        if title:
                            on_title_change(title)
                del buf[: metaint + 1 + length]
    return True


async def watch(url: str, on_title_change: Callable[[str], None]) -> None:
    """Runs until cancelled — see SessionState.start_radio_metadata_watch()/
    stop_radio_metadata_watch() for the lifecycle that starts and cancels
    this. `on_title_change` is called with a fresh, non-empty title every
    time the stream's own tag changes; never called at all for a station
    with no ICY support."""
    while True:
        try:
            worth_retrying = await _watch_once(url, on_title_change)
        except httpx.HTTPError as e:
            logger.info(f"[icy-metadata] {url} unreachable: {type(e).__name__}: {e}")
            worth_retrying = True
        if not worth_retrying:
            return
        await asyncio.sleep(_RECONNECT_DELAY_SECONDS)
