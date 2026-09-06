"""core/radio_relay.py — the shared radio-to-cast relay.

One instance per session, owned by core/session.py (SessionState.radio_relay),
started when radio casting begins (routes/playback.py's /play-url, unless
the listener opted into PlayUrlRequest.cast_directly — see that field's own
comment) and stopped on station change, /stop, or session reap.

Exists so that casting a station costs exactly one fetch of it, instead of
the up to three independent connections "direct to device" means today: the
device's own connection, core/icy_metadata.py's completely separate ICY
watch for the now-playing title, and (only once a device has demonstrably
refused the raw stream) routes/playback.py's retry_radio_via_proxy() —
itself re-fetching the station again, once per target, every time a device
reconnects. This relay fetches the station once (with `Icy-MetaData: 1`,
same as icy_metadata.py's own watch()), demultiplexes the ICY metadata
inline via IcyDemuxer — shared with icy_metadata.py so the metaint-parsing
logic exists exactly once — and feeds the pure audio bytes into one ffmpeg
process with a single output:

    ffmpeg -readrate 1 ... -i pipe:0 -vn -map 0:a <device args> pipe:1

`-readrate` (core/streamer.py's own pacing, reused as-is — see
_start_ffmpeg()'s comment) is what keeps this real-time: nothing upstream
paces the station fetch itself, and a server flushing its own send buffer
in bursts would otherwise run straight through to the device as a burst
too.

`pipe:1` (device audio — copy-tier MP3 when the station already is MP3,
re-encoded 192k MP3 otherwise, see _device_output_args()) is fanned out to
however many cast targets are subscribed (subscribe_audio()/
unsubscribe_audio() — multi-target casting already exists, see
PlayUrlRequest.targets, and without a fan-out "one fetch" would only be
true for a single target). The fan-out reads from a queue that lives on
the RadioRelay instance itself, not from a specific ffmpeg run's pipe
directly — so a subscriber added before a reconnect keeps receiving data
automatically once _run_once() reconnects and starts draining into that
very same queue, no special handling needed on either side.

This used to have a second, PCM output feeding core/audio_analysis.py's
AudioAnalyzer for the radio visualizer, fanned out the same "always
drained, subscriber or not" way as this device-audio side still is —
necessarily so, since both outputs came from the *same* ffmpeg process,
and a PCM side nobody drained filled its small OS pipe buffer and blocked
ffmpeg's writes entirely within about a second, stalling *device* audio
too (confirmed live 2026-09-01: a Sonos casting Antenne Bayern with no
visualizer open reported ERROR_LOST_CONNECTION roughly 10s later). That
"always drained" requirement turned out to be a standing liability rather
than a one-time fix, though: every bug in the visualizer's own decode/
pacing logic (see core/audio_analysis.py's and core/visualizer_feed.py's
own change history, 2026-09-02/03) was one step away from stalling this
side of the same pipe again, and repeatedly did. Removed 2026-09-03 —
the radio visualizer still taps this relay's device-audio fan-out
(subscribe_audio()/unsubscribe_audio() above, `lossy=True`), the same
bytes the cast target gets, but decodes them through its own, completely
separate ffmpeg process (core/audio_analysis.py's `source_queue` path)
instead of ever touching this module's own ffmpeg or its stdout pipe. A
full analysis queue now just drops its oldest buffered chunk to make room
for the newest one instead of blocking anything upstream (see
_fan_out_audio()'s own comment), so a bug in that analyzer can at worst
make its own visualizer wrong or laggy — it has no
pipe left in common with device audio to ever stall again.

Verified against a real station (ROCK ANTENNE, 2026-09-01): -acodec copy
loses nothing measurable (624000 bytes of station audio in, 623639 out —
the difference is one truncated trailing frame).
"""

import asyncio
import logging
import time
from collections import deque
from collections.abc import Callable
from contextlib import suppress

import httpx

from lyrics.shared import USER_AGENT

from .icy_metadata import IcyDemuxer, parse_bitrate, parse_codec
from .streamer import _READRATE_ARGS

logger = logging.getLogger("connect.radio_relay")

_TIMEOUT = httpx.Timeout(10.0, read=None)
# follow_redirects — same reasoning as icy_metadata.py's own client: a
# station's published URL is very often a load balancer that redirects to
# whichever node answers today.
_client = httpx.AsyncClient(
    timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT}, follow_redirects=True
)

# Same backoff shape as icy_metadata.py's watch() — this fetch loop runs for
# as long as the radio plays, so a struggling station shouldn't be hammered.
_RECONNECT_DELAY_SECONDS = 5.0
_MAX_RECONNECT_DELAY_SECONDS = 60.0

# How long the station may go quiet — connection still open, nothing
# arriving — before _run_once() below treats it as a drop and _run()
# reconnects.
#
# _TIMEOUT above deliberately carries no read timeout, because a live stream
# never "finishes" reading and httpx's own would fire on a perfectly healthy
# one. That left the *common* radio failure unhandled: a station's server,
# or something between it and here, stops writing to a connection it never
# closes. Nothing raises, nothing is logged, aiter_bytes() simply never
# yields again — and this relay would sit on that dead connection for as
# long as the radio was left playing, with every subscriber (a speaker, the
# app's own player) left to notice on its own, much later, from silence.
#
# Ten seconds rather than two or three: this fetch is paced from the far end
# by ffmpeg's own -readrate (see _start_ffmpeg()), so the read loop spends
# most of its time blocked on drain() rather than on the station, and the
# gap this measures is only ever the tail end of that. Ten is well inside
# what a listener is willing to wait through and well outside anything a
# working station produces.
_STALL_TIMEOUT_SECONDS = 10.0

# How much already-relayed audio a *listening* subscriber is handed the
# moment it subscribes, and how much of it this keeps around to be able to.
#
# The problem it answers is *late* arrival, and only that. ffmpeg's own
# -readrate_initial_burst (see core/streamer.py's _READRATE_ARGS) already
# hands whoever is subscribed when a relay starts a head start of
# LOOKAHEAD_SECONDS, so the listener who pressed play has a cushion. Nobody
# who joins afterwards does: from then on this relay emits strictly one
# second of audio per second, so a player connecting mid-stream — the
# element retrying after a drop, a second device, a reload — starts at the
# live edge with nothing in hand, and the next few seconds of no signal are
# heard rather than absorbed. That matters most in the case relaying is most
# useful in, listening away from home, where a handover or a tunnel is a
# routine few seconds of nothing. An Icecast server solves it with the same
# rolling buffer; this is that, on this side.
#
# Held as (when, bytes) and trimmed by *age*, not by size: at 1x pacing the
# wall-clock age of a chunk is its playing time, whatever the station's
# bitrate, so this is six seconds of sound for a 320kbps station and for a
# 64kbps one alike. A size-only cap would be half a minute of audio for the
# latter. Trimming by age also empties it by itself while the station is
# down, so a reconnecting listener is never handed audio from before the
# outage.
#
# Six seconds is a compromise, not a maximum: it is what a subscriber ends
# up *behind* live, and the now-playing title is read at the live edge (see
# _run_once()), so a bigger cushion means the title changing further ahead
# of the song being heard.
_BURST_SECONDS = 6.0

# A hard ceiling on the same buffer, for the case the pacing assumption
# above does not hold — a station bursting through a restarted ffmpeg, say.
# Far above six seconds of any real radio bitrate (320kbps is 240KB), so it
# is a backstop against unbounded memory rather than a second policy.
_BURST_MAX_BYTES = 1_000_000


# Device-audio output. Deliberately not core/streamer.py's full tier ladder
# (resolve_output_format()) — that one exists for library tracks, weighing
# ReplayGain, device sample-rate/bit-depth limits, and a lossless source
# re-encoded to FLAC losslessly; none of that applies to a live radio
# station (no gain to apply, and a station is never lossless PCM/FLAC in
# practice). The one real distinction worth making is the same one
# retry_radio_via_proxy() already draws: a station already served as MP3
# goes through byte-for-byte, anything else becomes the existing 192k MP3
# fallback — same content type devices already accept from
# /stream/radio today.
#
# -flush_packets 1: without it, ffmpeg's muxer holds packets back and
# writes to pipe:1 in bursts rather than as each one is ready — fine for a
# file, audible as stutter for a live restream feeding a queue-based
# fan-out downstream (see _AUDIO_QUEUE_MAXSIZE's own comment: a burst
# large enough to fill that queue means real audio bytes get dropped, not
# just delayed). Reported live 2026-09-01 as "stottert recht arg" while
# casting, with local playback (which never goes through this relay at
# all) unaffected.
_COPY_ARGS = ["-acodec", "copy", "-f", "mp3", "-flush_packets", "1"]
_FALLBACK_DEVICE_ARGS = [
    "-acodec",
    "libmp3lame",
    "-ab",
    "192k",
    "-ar",
    "44100",
    "-f",
    "mp3",
    "-flush_packets",
    "1",
]
_MP3_CONTENT_TYPE = "audio/mpeg"

# Generous on purpose, now that a burst is possible (see -flush_packets
# above for why one shouldn't normally happen any more, and this is the
# backstop for whatever burst still gets through it): at the 8KiB chunks
# _fan_out_audio() reads, a queue this size holds roughly 33MB — about
# twenty minutes of 192kbps audio — before a subscriber that is never
# coming back starts costing memory instead of just falling behind. The
# old, much smaller value (64 - a few seconds) is what let a single burst
# overflow it and start dropping real audio bytes, which reads as
# stutter, not silence.
_AUDIO_QUEUE_MAXSIZE = 4000

# The same fan-out, for a subscriber that would rather skip forward than
# fall behind: the visualizer's analyzer (core/visualizer_feed.py). A
# device must never lose a byte, so its queue is sized to outlast any
# burst — but for analysis, old audio is worthless. Buffering minutes of
# it and then racing to "catch up" is actively harmful: the catch-up runs
# with no pacing at all (_read_pcm()'s own lookahead cap only throttles
# running *ahead*, and a backlog is the other direction), so it decodes
# and FFTs at full CPU speed for as long as the backlog lasts, starving
# the event loop that device audio is also being paced on. Reported live
# 2026-09-03: a 10s device scan was enough to put the analyzer behind, and
# the recovery from it produced audible dropouts on the speaker plus a
# visualizer that stayed frozen — every frame it computed afterwards was
# minutes late and got dropped by _release_frames().
#
# A few seconds is all analysis can use. Beyond that the oldest bytes are
# dropped, not the newest (see _fan_out_audio()), so this subscriber stays
# at the live edge instead of accumulating a debt it can never usefully
# repay.
_ANALYSIS_QUEUE_MAXSIZE = 48


# How long start() waits for the first connection attempt to resolve one
# way or the other before giving up on it. Not a timeout on the fetch
# itself — _run() keeps retrying in the background either way — only on
# how long /play-url is willing to block for it, and it has to be bounded:
# that call holds session.play_lock, so a station that accepts the TCP
# connection and then never sends its response headers (an overloaded
# Icecast; _TIMEOUT deliberately has no read timeout, since a live stream
# legitimately never "finishes" reading) would otherwise hang every
# subsequent /play and /play-url on the session behind it, indefinitely.
_START_TIMEOUT_SECONDS = 10.0


def _send_sentinel(q: "asyncio.Queue[bytes | None]") -> None:
    """Hand a subscriber the `None` that means "the relay has stopped for
    good". Has to arrive even on a queue that is already full, or the
    subscriber blocked on it never learns to stop waiting — and a full
    queue is an entirely expected state here, not an anomaly:
    _fan_out_audio() lets a slow subscriber's queue fill rather than
    stalling everyone else behind it. Dropping the oldest
    chunk to make room costs a reader that is already that far behind
    nothing it could still have played in time. (`get_nowait()` cannot
    fail after `full()` — there is no await between them for anything else
    to drain the queue.)"""
    if q.full():
        q.get_nowait()
    q.put_nowait(None)


def _device_output_args(content_type: str) -> tuple[list[str], str]:
    """(ffmpeg args, Content-Type) for the device-audio output."""
    if content_type == _MP3_CONTENT_TYPE:
        return _COPY_ARGS, _MP3_CONTENT_TYPE
    return _FALLBACK_DEVICE_ARGS, _MP3_CONTENT_TYPE


class RadioRelay:
    """Not reentrant across stations — core/session.py stops whatever relay
    already exists before starting a new one for a different URL, the same
    division of responsibility it already has for
    start_radio_metadata_watch()."""

    def __init__(
        self,
        url: str,
        content_type: str,
        on_title_change: Callable[[str], None],
        on_stream_info: Callable[[int | None, str | None], None] | None = None,
    ) -> None:
        self.url = url
        self._device_args, self.device_content_type = _device_output_args(content_type)
        self._on_title_change = on_title_change
        self._on_stream_info = on_stream_info
        self._proc: asyncio.subprocess.Process | None = None
        self._fetch_task: asyncio.Task | None = None
        self._audio_fanout_task: asyncio.Task | None = None
        self._audio_subscribers: list[asyncio.Queue[bytes | None]] = []
        # id() of the subscribers that asked for `lossy` — an asyncio.Queue
        # isn't hashable-by-value in a way that would make a set of the
        # queues themselves any clearer, and identity is exactly the
        # question being asked.
        self._lossy_subscribers: set[int] = set()
        # The most recent _BURST_SECONDS of device audio, as (emitted_at,
        # chunk), handed to a listening subscriber the moment it arrives so
        # it starts with a buffer instead of at the live edge. See
        # _BURST_SECONDS.
        self._burst: deque[tuple[float, bytes]] = deque()
        self._burst_bytes = 0
        # Set once the first connection attempt has either produced a
        # running ffmpeg or given up — see start().
        self._started = asyncio.Event()
        # Whether that attempt actually reached a running ffmpeg. False
        # means the relay has nothing to serve yet (the station refused the
        # connection, or never answered in time) — routes/playback.py's
        # /play-url checks this rather than dispatching a device at an
        # endpoint that would answer 200 and then stay silent forever.
        self.connected = False
        self._stopped = False

    async def start(self) -> None:
        """Returns once the first connection attempt has resolved — check
        `connected` for whether it actually produced anything. Bounded by
        _START_TIMEOUT_SECONDS; see that constant for why waiting here
        can't be open-ended."""
        self._fetch_task = asyncio.create_task(self._run())
        try:
            await asyncio.wait_for(self._started.wait(), _START_TIMEOUT_SECONDS)
        except TimeoutError:
            logger.info(
                f"[radio-relay] {self.url} did not answer within "
                f"{_START_TIMEOUT_SECONDS:.0f}s — giving up on waiting for it"
            )

    async def stop(self) -> None:
        """Tears down the fetch, ffmpeg, and every subscriber — for good,
        not for a retry (see _run()'s own reconnect loop, which never
        calls this)."""
        self._stopped = True
        if self._fetch_task:
            self._fetch_task.cancel()
        if self._audio_fanout_task:
            self._audio_fanout_task.cancel()
        if self._proc:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass
        for q in self._audio_subscribers:
            _send_sentinel(q)
        self._audio_subscribers.clear()

    def subscribe_audio(
        self, *, lossy: bool = False, burst: bool = False
    ) -> "asyncio.Queue[bytes | None]":
        """One more reader of the same audio the devices get — see
        routes/stream.py's radio_stream(). A `None` read from the queue
        means the relay has stopped for good; there is nothing more to
        send.

        `lossy` is for a subscriber that wants the live edge rather than
        every byte: it gets a small queue whose *oldest* entries are
        dropped when it can't keep up, instead of a large one whose newest
        are. Only the visualizer's analyzer asks for this — see
        _ANALYSIS_QUEUE_MAXSIZE. A device never does: a gap in its audio is
        audible.

        `burst` is the opposite request, and the two are mutually
        exclusive by nature: hand me the last few seconds up front, so what
        I am playing has a buffer behind it. Asked for by a listener's own
        player (routes/stream.py's /stream/radio-local) and by nothing
        else — see _BURST_SECONDS for why that cushion is worth six
        seconds of being behind live, and why an analyzer must never have
        one."""
        maxsize = _ANALYSIS_QUEUE_MAXSIZE if lossy else _AUDIO_QUEUE_MAXSIZE
        q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=maxsize)
        if self._stopped:
            # Subscribing to an already-stopped relay is a real race, not a
            # caller mistake: radio_stream() reads session.radio_relay and
            # returns a StreamingResponse whose generator only subscribes
            # once it is first iterated, by which point a station change or
            # /stop may have run. stop() has already handed out its
            # sentinels and cleared the list by then, so an ordinary
            # subscription here would wait on a queue nothing will ever
            # feed — the device's connection would hang open forever
            # instead of closing.
            q.put_nowait(None)
            return q
        self._audio_subscribers.append(q)
        if lossy:
            self._lossy_subscribers.add(id(q))
        if burst:
            # Before the append above would matter either way — nothing is
            # fed into this queue until the next chunk arrives — but
            # ordering it after keeps "subscribed" and "primed" from ever
            # being separated by an await that isn't there today.
            self._trim_burst()
            for _, chunk in self._burst:
                with suppress(asyncio.QueueFull):
                    q.put_nowait(chunk)
        return q

    def unsubscribe_audio(self, q: "asyncio.Queue[bytes | None]") -> None:
        if q in self._audio_subscribers:
            self._audio_subscribers.remove(q)
        self._lossy_subscribers.discard(id(q))

    async def _run(self) -> None:
        failures = 0
        while not self._stopped:
            try:
                await self._run_once()
                failures = 0
            except asyncio.CancelledError:
                raise
            except Exception as e:
                failures += 1
                logger.info(f"[radio-relay] {self.url} dropped: {e}")
            finally:
                # Unblocks start() even if this very first attempt failed —
                # a relay that can never reach its station still finishes
                # starting (with nothing to subscribe to), rather than
                # hanging /play-url's dispatch forever.
                self._started.set()
            if self._stopped:
                return
            delay = (
                min(
                    _RECONNECT_DELAY_SECONDS * 2 ** min(failures - 1, 10),
                    _MAX_RECONNECT_DELAY_SECONDS,
                )
                if failures
                else _RECONNECT_DELAY_SECONDS
            )
            await asyncio.sleep(delay)

    async def _run_once(self) -> None:
        async with _client.stream("GET", self.url, headers={"Icy-MetaData": "1"}) as resp:
            resp.raise_for_status()
            # What the station says it is broadcasting, same headers and
            # same handling as core/icy_metadata.py's watch — this relay
            # replaces that watch while it runs (see core/session.py), so
            # without this the one path that re-serves a station to a
            # device would be the one path that never learns it.
            # Deliberately the *source* values, not whatever ffmpeg below
            # re-encodes to: they describe the station, and read the same
            # whether you are listening locally or casting.
            if self._on_stream_info is not None:
                self._on_stream_info(
                    parse_bitrate(resp.headers.get("icy-br")),
                    parse_codec(resp.headers.get("content-type")),
                )
            metaint = int(resp.headers.get("icy-metaint") or "0")
            demuxer = IcyDemuxer(metaint, self._on_title_change) if metaint > 0 else None

            proc = await self._start_ffmpeg()
            self.connected = True
            self._started.set()
            assert proc.stdout is not None and proc.stdin is not None
            self._audio_fanout_task = asyncio.create_task(self._fan_out_audio(proc.stdout))
            try:
                # Read one chunk at a time under a deadline rather than
                # `async for`, which has no way to say "and if nothing
                # arrives, give up" — see _STALL_TIMEOUT_SECONDS for what
                # that silence looks like and why nothing else catches it.
                # Only the wait for the *next* chunk is bounded: the write
                # and drain below are paced on purpose and take as long as
                # real time takes.
                chunks = resp.aiter_bytes()
                while True:
                    try:
                        async with asyncio.timeout(_STALL_TIMEOUT_SECONDS):
                            chunk = await anext(chunks)
                    except StopAsyncIteration:
                        break
                    except TimeoutError as e:
                        # Raised, not returned: _run() treats a raise as a
                        # drop worth reconnecting and a clean return as a
                        # station that simply ended. A stall is the former.
                        raise RuntimeError(f"no data for {_STALL_TIMEOUT_SECONDS:.0f}s") from e
                    audio = demuxer.feed(chunk) if demuxer is not None else chunk
                    if not audio:
                        continue
                    proc.stdin.write(audio)
                    await proc.stdin.drain()
            finally:
                try:
                    proc.stdin.close()
                except Exception as e:
                    logger.debug(f"[radio-relay] closing ffmpeg stdin: {e}")
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                if self._audio_fanout_task:
                    await self._audio_fanout_task

    async def _start_ffmpeg(self) -> asyncio.subprocess.Process:
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "warning",
            # Reduces ffmpeg's own input-side read-ahead buffering for a
            # live, never-ending source — see _COPY_ARGS's own comment
            # (-flush_packets) for the output-side half of the same fix.
            "-fflags",
            "nobuffer",
            # core/streamer.py's own pacing (see _READRATE_ARGS's own long
            # comment there for the full reasoning) — the actual fix for
            # "stottert recht arg" while casting, reported live 2026-09-01
            # (-fflags/-flush_packets above address ffmpeg's own buffering,
            # not this). Nothing upstream of this class paces the station
            # fetch at all: an Icecast/Shoutcast server routinely flushes
            # its own send buffer in bursts rather than a strict per-byte
            # real-time trickle, and without -readrate here that burst runs
            # straight through demux -> stdin -> both outputs -> the
            # device, which is not built to absorb a few seconds of audio
            # arriving all at once followed by a gap. -readrate throttles
            # how fast ffmpeg *reads* pipe:0 to 1x real time (judged by the
            # timestamps it synthesizes for the MP3 elementary stream from
            # its own constant bitrate) — once ffmpeg stops draining stdin
            # that fast, the stdin pipe fills, this class's own
            # `await proc.stdin.drain()` in _run_once() blocks, and that
            # backpressure propagates all the way back to the httpx read
            # loop, which is what actually smooths a bursty source into a
            # steady one rather than merely reformatting the burst.
            *_READRATE_ARGS,
            "-i",
            "pipe:0",
            "-vn",
            "-map",
            "0:a",
            *self._device_args,
            "pipe:1",
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._proc = proc
        return proc

    async def _fan_out_audio(self, stdout: asyncio.StreamReader) -> None:
        """Reads the device-audio output once and copies each chunk to
        every current subscriber — deliberately does *not* push a `None`
        sentinel when this ends: that only happens on a genuine stop()
        (see its own docstring), not when the fetch loop is about to retry
        the station. A subscriber's own GET /stream/radio connection just
        sees a brief gap in that case, not a hard close."""
        try:
            while True:
                chunk = await stdout.read(8192)
                if not chunk:
                    return
                self._remember_for_burst(chunk)
                for q in list(self._audio_subscribers):
                    try:
                        q.put_nowait(chunk)
                    except asyncio.QueueFull:
                        if id(q) not in self._lossy_subscribers:
                            continue  # a slow device falls behind rather than blocking the others
                        # Lossy subscriber: make room by discarding what it
                        # has not read yet, so it resumes at the live edge
                        # instead of working through a backlog. See
                        # _ANALYSIS_QUEUE_MAXSIZE.
                        with suppress(asyncio.QueueEmpty):
                            q.get_nowait()
                        with suppress(asyncio.QueueFull):
                            q.put_nowait(chunk)
        except asyncio.CancelledError:
            pass

    def _remember_for_burst(self, chunk: bytes) -> None:
        """Keeps `chunk` for the next subscriber that asks for a burst —
        see _BURST_SECONDS. Unconditional, whether or not anything is
        subscribed at all: what makes this useful is having the seconds
        already in hand when somebody arrives, which is exactly the moment
        it is too late to start collecting them."""
        self._burst.append((time.monotonic(), chunk))
        self._burst_bytes += len(chunk)
        self._trim_burst()

    def _trim_burst(self) -> None:
        """Drops everything older than _BURST_SECONDS (and anything past
        the byte ceiling). Also on the way *out*, not only on the way in:
        while the station is down nothing new arrives, so age alone is what
        empties this — which is what keeps a listener reconnecting after an
        outage from being handed audio from before it."""
        cutoff = time.monotonic() - _BURST_SECONDS
        while self._burst and (self._burst[0][0] < cutoff or self._burst_bytes > _BURST_MAX_BYTES):
            _, chunk = self._burst.popleft()
            self._burst_bytes -= len(chunk)
