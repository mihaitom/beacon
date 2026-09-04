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
import os
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


# metaint for DEVICE_METAINT below — see that constant's own comment for why
# Beacon picks its own value rather than reusing whatever the original
# station used.
DEVICE_METAINT = 8192

# A zero-width space, appended to (and then removed from) the real title on
# alternating pulses — see pulsed_title(). Zero-width specifically: this text
# is what a Sonos shows on its own display and in its app, and the point is
# to give the *protocol* something that changed without giving a listener
# anything to see. Also survives routes/upnp.py's parse path unharmed —
# str.strip() does not consider U+200B whitespace, so an echo comes back
# carrying it.
_PULSE_MARK = "\u200b"

# How often that mark flips. The whole reason it exists: a device only
# reports its current ICY title on its own AVTransport eventing, and only
# when something makes it send an event at all. A real station changes title
# every few minutes, and between those changes Sonos can go half a minute
# without emitting anything — measured live 2026-09-05, a routine
# state=PLAYING NOTIFY 26s after the previous event turned into a nonsense
# 16.63s "round trip" for a device whose real buffer is under five.
# scripts/icy_sync_probe.py did not have that problem because it injected
# its own markers continuously: 36 markers, 29 reported back, spread 0.039s.
# This reproduces that during an ordinary cast.
#
# Comfortably longer than any device buffer this has been measured against
# (Chromecast, the largest, at ~11s, is not a device that asks for ICY at
# all; Sonos sits under 5s), so an echo for one pulse always lands before
# the next pulse replaces what is pending.
ICY_PULSE_SECONDS = 8.0

# ...and whether it happens at all. Off by default, which is a reversal.
#
# The pulse was added to give the ICY round-trip measurement a steady supply
# of samples, because that measurement was driving the radio visualizer's
# clock. It no longer is: measured against a real Sonos on 2026-09-05 it
# produced 16.63s, 3.48s, 3.01s and 1.43s across four runs, and shifted
# again after a station restart, while the fixed estimate stayed the closest
# match by ear — so core/visualizer_feed.py's _FirstByteClock stopped
# reading it (see that class for the full account).
#
# With nothing steering off the samples, pulsing only buys a metadata update
# pushed to every connected device every 8 seconds and a UPnP event back
# from each: real network chatter and log noise for a number nothing
# consumes. Worse, more samples actively hurt while it *was* steering — each
# one is biased low, so the running minimum sank as they accumulated.
#
# Kept rather than deleted, because it is the only way to get more than one
# round-trip sample per song out of an ordinary station, and that is exactly
# what anyone re-investigating this would want. Turning it on is one
# environment variable.
ICY_PULSE_ENV = "BEACON_ICY_PULSE"


def _pulse_enabled() -> bool:
    """Whether pulsed_title() marks at all — see ICY_PULSE_ENV. Read per
    call so it can be switched on mid-session while chasing something."""
    return os.environ.get(ICY_PULSE_ENV, "").strip().lower() in ("1", "true", "yes", "on")


def pulsed_title(title: str | None, now: float) -> str | None:
    """`title` with the pulse mark appended on every other
    ICY_PULSE_SECONDS window, so a device sees the title "change" on a
    steady cadence even while the station's own has not.

    Derived from the clock rather than counted, deliberately: there is one
    IcyMuxer per device connection (see that class), and a counter would
    give each connection its own phase, so several connections would inject
    conflicting titles and the round-trip measurement would pair an
    injection from one with an echo belonging to another. Every caller
    reading the same clock agrees by construction, with no shared state to
    keep in step and no timer task to own.

    None/empty passes straight through — there is nothing to pulse yet, and
    a bare mark on its own would be a title where the station has none."""
    if not title or not _pulse_enabled():
        return title
    if int(now // ICY_PULSE_SECONDS) % 2:
        return title + _PULSE_MARK
    return title


def strip_pulse(title: str) -> str:
    """`title` without the pulse mark, for comparing an echo that came back
    from a device that dropped it — see routes/upnp.py. A device that
    normalises the mark away simply stops producing extra measurement
    points; it must not also lose the ones a *real* title change produces."""
    return title.removesuffix(_PULSE_MARK)


class IcyMuxer:
    """The mirror image of IcyDemuxer: injects ICY metadata blocks into an
    otherwise-plain audio byte stream, for routes/stream.py's own re-served
    radio endpoints (/stream/radio/<session>, both the relayed and the
    direct-re-encode fallback) to answer a device's `Icy-MetaData: 1`
    request header the same way the original station would, instead of
    silently ignoring it.

    Why this exists at all: Beacon's own re-served stream used to carry no
    ICY signalling whatsoever, even when the source station did and Beacon
    was already parsing it (core/radio_relay.py's own IcyDemuxer use, for
    the now-playing title). A device deciding how much to buffer a stream
    plausibly uses exactly this signal to tell "genuine live radio" apart
    from an ordinary bounded audio file it can afford to buffer
    conservatively — reported live 2026-09-04 as Sonos specifically
    dropping out every 1-2s while relayed through Beacon (never direct to
    the station, never on Chromecast/DLNA relayed through the very same
    path), and confirmed by the listener's own A/B: telling Sonos it's
    live radio (dispatching the *station's* URL directly, ICY intact) gets
    it to size its buffer generously on its own; Beacon's own re-served
    copy, with no ICY at all, apparently did not. Unverified against real
    Sonos hardware by this change itself — the mechanism is the listener's
    own, well-evidenced theory, not something provable from the source
    alone the way core/visualizer_feed.py's baseline bug was.

    One instance per device connection, not shared across
    core/radio_relay.py's subscribers: each connection's own byte count
    since its last metadata block is independent of every other
    connection's, since delivery pacing/backpressure differs per
    subscriber (a slow subscriber and a fast one must not be forced to the
    same metadata cadence).

    `title_fn` is read fresh on every block, not captured once at
    construction — the whole point is to reflect whatever the station's
    now-playing title currently is (core/session.py's own
    `SessionState.radio_title`, kept live by the exact same ICY watch this
    class's title ends up mirroring back out).

    `on_inject`, when given, fires with the title text every time a real
    (non-empty, changed) StreamTitle block actually goes out — not on the
    far more common zero-length "nothing changed" ones. routes/stream.py
    uses it to record (title, time.monotonic()) on the session
    (SessionState.radio_icy_pending_injection), so routes/upnp.py's own
    AVTransport NOTIFY handler can recognise the same title coming back
    from the device and turn the gap between the two into a real,
    continuously-refreshed measurement of this device's own buffering
    delay — the live counterpart to what scripts/icy_sync_probe.py
    validated as a one-off probe. See core/visualizer_feed.py's
    _FirstByteClock for the reader."""

    def __init__(
        self,
        metaint: int,
        title_fn: Callable[[], str | None],
        on_inject: Callable[[str], None] | None = None,
    ) -> None:
        self._metaint = metaint
        self._title_fn = title_fn
        self._on_inject = on_inject
        self._since_block = 0
        # The title actually sent in the last non-empty block — compared
        # against on every boundary so a block is only ever a real
        # StreamTitle payload when the title has *changed*, the same
        # "0 = nothing changed" convention real stations use (and the one
        # IcyDemuxer.feed() above already expects on the way in).
        self._last_sent: str | None = None

    def feed(self, audio: bytes) -> bytes:
        """Returns `audio` with metadata blocks spliced in at every
        `metaint`-byte boundary. Boundaries are tracked across calls (a
        chunk from the relay's own fan-out rarely lines up with one), same
        shape as IcyDemuxer.feed()'s own buffering, just running the other
        direction — this never needs to buffer *audio* though, since
        splicing in a block never has to wait on more bytes arriving the
        way demultiplexing one back out does."""
        out = bytearray()
        pos = 0
        while pos < len(audio):
            room = self._metaint - self._since_block
            take = min(room, len(audio) - pos)
            out += audio[pos : pos + take]
            pos += take
            self._since_block += take
            if self._since_block >= self._metaint:
                out += self._block()
                self._since_block = 0
        return bytes(out)

    def _block(self) -> bytes:
        title = self._title_fn()
        if title == self._last_sent:
            return b"\x00"  # a length byte of 0 — the "nothing changed" block
        self._last_sent = title
        if title and self._on_inject is not None:
            self._on_inject(title)
        payload = f"StreamTitle='{title or ''}';".encode("utf-8", errors="replace")
        # The ICY length byte counts 16-byte units, so a block tops out at
        # 255*16 = 4080 bytes and anything longer has to be truncated rather
        # than encoded. Not merely theoretical: IcyDemuxer accepts blocks up
        # to that same 4080-byte ceiling and decodes their titles with
        # errors="replace", which turns each invalid source byte into U+FFFD
        # — three bytes again on the way back out here. A station sending a
        # near-maximum title with any invalid UTF-8 in it therefore lands
        # above 255 units, and bytes([units]) raises ValueError from inside
        # routes/stream.py's response generator, killing that device's audio
        # mid-stream over a metadata block.
        units = min(255, -(-len(payload) // 16))  # ceil(len / 16), no float involved
        payload = payload[: units * 16]
        return bytes([units]) + payload.ljust(units * 16, b"\x00")


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
