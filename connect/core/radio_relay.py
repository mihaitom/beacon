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
from collections.abc import Callable
from contextlib import suppress

import httpx

from lyrics.shared import USER_AGENT

from .icy_metadata import IcyDemuxer
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

    def __init__(self, url: str, content_type: str, on_title_change: Callable[[str], None]) -> None:
        self.url = url
        self._device_args, self.device_content_type = _device_output_args(content_type)
        self._on_title_change = on_title_change
        self._proc: asyncio.subprocess.Process | None = None
        self._fetch_task: asyncio.Task | None = None
        self._audio_fanout_task: asyncio.Task | None = None
        self._audio_subscribers: list[asyncio.Queue[bytes | None]] = []
        # id() of the subscribers that asked for `lossy` — an asyncio.Queue
        # isn't hashable-by-value in a way that would make a set of the
        # queues themselves any clearer, and identity is exactly the
        # question being asked.
        self._lossy_subscribers: set[int] = set()
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

    def subscribe_audio(self, *, lossy: bool = False) -> "asyncio.Queue[bytes | None]":
        """One more reader of the same audio the devices get — see
        routes/stream.py's radio_stream(). A `None` read from the queue
        means the relay has stopped for good; there is nothing more to
        send.

        `lossy` is for a subscriber that wants the live edge rather than
        every byte: it gets a small queue whose *oldest* entries are
        dropped when it can't keep up, instead of a large one whose newest
        are. Only the visualizer's analyzer asks for this — see
        _ANALYSIS_QUEUE_MAXSIZE. A device never does: a gap in its audio is
        audible."""
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
            metaint = int(resp.headers.get("icy-metaint") or "0")
            demuxer = IcyDemuxer(metaint, self._on_title_change) if metaint > 0 else None

            proc = await self._start_ffmpeg()
            self.connected = True
            self._started.set()
            assert proc.stdout is not None and proc.stdin is not None
            self._audio_fanout_task = asyncio.create_task(self._fan_out_audio(proc.stdout))
            try:
                async for chunk in resp.aiter_bytes():
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
