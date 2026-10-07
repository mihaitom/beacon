"""core/party_broadcast.py — listening along: one live stream of what the
party's host hears, for guests who are not in the room.

Nothing changes for the host, who casts or plays locally as always. This
follows them instead (docs/plans/party-listen-along.md):

- **Follow.** `hearing_fn` says what the host hears right now - song,
  position, playing - from the cast session or the host window's snapshot
  (core/party.py's host_hearing()).
- **Decode.** One ffmpeg per song decodes it from the media server to raw
  PCM, starting where the host is. Unpaced: the pipe holds it back.
- **Pace and encode.** The PCM is written by the wall clock into a single
  encoder that runs for the whole broadcast, so song changes need no new
  encode - no encoder gaps at the joins, and no lead that grows with every
  song the way chaining per-track ffmpegs with -readrate_initial_burst would.
- **Silence** while the host pauses, between songs and while a source fails,
  so a guest's connection never breaks for it.
- **Catch up.** A different song, or a position too far from the host's,
  restarts the decoder where the host is. Near a song's end the next one in
  the host's queue is opened early so the change is seamless.

The encoder's output goes to every guest through core/audio_fanout.py, the
same fan-out the radio relay serves a station with.

**Stream time** is samples written so far. The timeline says which song
plays from which stream time on, and every chunk handed to a guest is tagged
with the stream time it starts at, so a guest page can tell from its own
`audio.currentTime` which song and position it is hearing.
"""

import asyncio
import logging
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import numpy as np

from .audio_analysis import (
    _FFT_SIZE,
    _HOP_SIZE,
    _SMOOTHING_TIME_CONSTANT,
    _smooth_bands,
    analyze_pcm,
)
from .audio_fanout import AudioFanout
from .ffmpeg import FFMPEG_BIN
from .streamer import _HTTP_RECONNECT_ARGS, lossy_encode_args

logger = logging.getLogger("connect.party_broadcast")

SAMPLE_RATE = 44100
# Bytes per sample frame: s16le, stereo.
_FRAME_BYTES = 4
# Samples per AAC frame, and the encoder's priming delay: ffmpeg's aac
# encoder emits one frame of lead-in first, and ADTS has no way to tell a
# decoder to drop it, so the audio in frame k is input from frame k-1 on.
_AAC_FRAME_SAMPLES = 1024
_ENCODER_DELAY_SAMPLES = 1024

BITRATES_KBPS = (128, 192, 256)

# How far the writes run ahead of the wall clock: enough that the encoder
# never waits on the next write, small enough not to matter to anyone.
_LEAD_SECONDS = 0.5
_TICK_SECONDS = 0.05
# A stall of the event loop longer than this is dropped rather than caught up
# on, so a guest's stream skips ahead instead of arriving in a burst.
_MAX_CATCH_UP_SECONDS = 2.0
# How far the stream's position may drift from the host's before the decoder
# is restarted. Above what a snapshot's arrival jitter (~0.5s) can cause, so
# an ordinary song never restarts, below what anyone notices in a seek.
_RESYNC_SECONDS = 2.0
# How long before a song's end the next one is opened.
_PREOPEN_SECONDS = 8.0
# Decoded audio held per source, at most. A decoder runs ahead freely up to
# this, which is what lets a slow media server go unheard for a moment.
_SOURCE_BUFFER_SECONDS = 10.0
# After the stream moved on to the next song by itself, how long the host
# may still report the previous one before that is taken as the host going
# back to it. Covers the host window's own lag in reporting the change.
_ADVANCE_GRACE_SECONDS = 5.0
# A song whose source produced nothing is not retried for this long, or a
# broken file would be restarted on every tick.
_FAILED_RETRY_SECONDS = 10.0
# A seek this close to a song's end has nothing left to play.
_END_MARGIN_SECONDS = 0.5
# What a new listener is handed up front, the same cushion the radio relay
# gives a phone on mobile data (see core/radio_relay.py's _BURST_SECONDS).
_BURST_SECONDS = 6.0
_BURST_MAX_BYTES = 1_000_000
# Stream time the timeline keeps, for guests up to that far behind.
_TIMELINE_KEEP_SECONDS = 180.0
# Nobody listening for this long ends the broadcast.
ORPHAN_TIMEOUT_SECONDS = 90.0
_ORPHAN_CHECK_SECONDS = 5.0
# Visualizer batches held per watching guest. A batch is one produce() call,
# so this is several seconds; a guest that cannot keep up loses the oldest.
_BANDS_QUEUE_BATCHES = 64


@dataclass(frozen=True)
class Hearing:
    """What the host hears, as of the moment it is asked."""

    song_id: str | None
    position: float
    playing: bool
    duration: float = 0.0
    next_song_id: str | None = None
    gain: float = 1.0
    # A station instead of a song: decoded live, no position to follow.
    radio_url: str | None = None


@dataclass(frozen=True)
class TimelineEntry:
    """From `stream_time` on, the stream plays `song_id` from `position` -
    or holds it there, while not `playing`."""

    stream_time: float
    song_id: str | None
    position: float
    playing: bool


def encoder_cmd(bitrate_kbps: int) -> list[str]:
    args, _ = lossy_encode_args("aac", bitrate_kbps)
    return [
        FFMPEG_BIN,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-f",
        "s16le",
        "-ar",
        str(SAMPLE_RATE),
        "-ac",
        "2",
        "-i",
        "pipe:0",
        *args,
        "-flush_packets",
        "1",
        "pipe:1",
    ]


def decoder_cmd(url: str, start: float, gain: float) -> list[str]:
    seek = ["-ss", f"{start:.3f}"] if start > 0 else []
    volume = ["-af", f"volume={gain}"] if gain != 1.0 else []
    http = _HTTP_RECONNECT_ARGS if url.startswith(("http://", "https://")) else []
    return [
        FFMPEG_BIN,
        "-hide_banner",
        "-loglevel",
        "error",
        *http,
        *seek,
        "-i",
        url,
        "-vn",
        *volume,
        "-ac",
        "2",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "s16le",
        "pipe:1",
    ]


def split_adts(buf: bytearray) -> tuple[int, int]:
    """(bytes, AAC frames) of the whole ADTS frames at the start of `buf`."""
    pos = frames = 0
    while len(buf) - pos >= 7:
        if buf[pos] != 0xFF or buf[pos + 1] & 0xF0 != 0xF0:
            # ffmpeg's own output never needs this; skipping a byte is only
            # there so a broken frame cannot wedge the stream for good.
            pos += 1
            continue
        length = ((buf[pos + 3] & 0x03) << 11) | (buf[pos + 4] << 3) | (buf[pos + 5] >> 5)
        if length < 7:
            pos += 1
            continue
        if len(buf) - pos < length:
            break
        frames += (buf[pos + 6] & 0x03) + 1
        pos += length
    return pos, frames


class Source:
    """One song decoding, from `start` on. Its position moves with the
    stream whether or not audio arrives: what the decoder could not deliver
    in time is played as silence and then skipped, so a slow start or a
    hiccup at the media server never leaves the stream behind the host."""

    def __init__(
        self,
        song_id: str,
        start: float,
        url_fn: Callable[[], Awaitable[str | None]],
        gain: float,
        radio: bool = False,
    ):
        self.song_id = song_id
        # A station: live, so what arrives late is simply skipped, which
        # keeps the stream at the live edge.
        self.radio = radio
        self.start = start
        self.gain = gain
        self._url_fn = url_fn
        self._buf = bytearray()
        self._consumed = 0  # sample frames handed out or skipped
        self._skip = 0  # sample frames still to discard on arrival
        self._room = asyncio.Event()
        self._room.set()
        self.produced = False
        self.eof = False
        self._proc: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task | None = None

    @property
    def position(self) -> float:
        return self.start + self._consumed / SAMPLE_RATE

    def open(self) -> None:
        self._task = asyncio.create_task(self._run())

    def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
        if self._proc is not None:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass

    def take(self, frames: int) -> bytes:
        """Up to `frames` sample frames of what has arrived."""
        self._discard_skipped()
        n = min(frames * _FRAME_BYTES, len(self._buf))
        n -= n % _FRAME_BYTES
        out = bytes(self._buf[:n])
        del self._buf[:n]
        self._consumed += n // _FRAME_BYTES
        self._room.set()
        return out

    def skip(self, frames: int) -> None:
        """`frames` went out as silence; drop as much audio once it arrives."""
        self._skip += frames
        self._consumed += frames
        self._discard_skipped()

    @property
    def finished(self) -> bool:
        return self.eof and not self._buf

    def _discard_skipped(self) -> None:
        if not self._skip or not self._buf:
            return
        n = min(self._skip * _FRAME_BYTES, len(self._buf))
        n -= n % _FRAME_BYTES
        del self._buf[:n]
        self._skip -= n // _FRAME_BYTES
        self._room.set()

    async def _run(self) -> None:
        limit = int(_SOURCE_BUFFER_SECONDS * SAMPLE_RATE) * _FRAME_BYTES
        try:
            url = await self._url_fn()
            if url is None:
                return
            self._proc = await asyncio.create_subprocess_exec(
                *decoder_cmd(url, self.start, self.gain),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            assert self._proc.stdout is not None
            while True:
                await self._room.wait()
                chunk = await self._proc.stdout.read(65536)
                if not chunk:
                    return
                self.produced = True
                self._buf += chunk
                self._discard_skipped()
                if len(self._buf) >= limit:
                    self._room.clear()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.info(f"[party-broadcast] decoding {self.song_id} failed: {e}")
        finally:
            self.eof = True
            if self._proc is not None:
                try:
                    self._proc.kill()
                except ProcessLookupError:
                    pass


class Broadcaster:
    def __init__(
        self,
        bitrate_kbps: int,
        hearing_fn: Callable[[], Hearing | None],
        url_fn: Callable[[str], Awaitable[str | None]],
        on_timeline: Callable[[], None] | None = None,
        on_stopped: Callable[["Broadcaster"], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.bitrate_kbps = bitrate_kbps
        # Stream times start over with every broadcast; a guest holding one
        # from another can tell by this.
        self.epoch = secrets.token_urlsafe(6)
        self._hearing_fn = hearing_fn
        self._url_fn = url_fn
        self._on_timeline = on_timeline
        self._on_stopped = on_stopped
        self._clock = clock
        self.fanout = AudioFanout(lambda: (_BURST_SECONDS, _BURST_MAX_BYTES))
        self.timeline: list[TimelineEntry] = [TimelineEntry(0.0, None, 0.0, False)]
        self._written = 0  # sample frames
        # Frames of the produce() call under way that are already decided,
        # so a song change halfway through one is marked where it happens.
        self._cursor = 0
        self._t0 = 0.0
        self._source: Source | None = None
        self._next: Source | None = None
        # The song the stream moved on from by itself, and until when the
        # host may still report it (see _ADVANCE_GRACE_SECONDS).
        self._advanced_from: str | None = None
        self._advance_grace_until = 0.0
        self._failed: dict[str, float] = {}
        self._encoder: asyncio.subprocess.Process | None = None
        self._tasks: list[asyncio.Task] = []
        self.stopped = False
        # The visualizer, from the very PCM the stream is encoded from, so
        # every frame carries its exact stream time (see watch_bands()).
        self._band_watchers: list[asyncio.Queue] = []
        self._analysis = bytearray()  # mono s16le, not analysed yet
        self._analysis_time = 0.0  # stream time of its first sample
        self._smoothed: list[float] | None = None

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        self._encoder = await asyncio.create_subprocess_exec(
            *encoder_cmd(self.bitrate_kbps),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._t0 = self._clock()
        self._tasks = [
            asyncio.create_task(self._pump()),
            asyncio.create_task(self._read_encoder()),
            asyncio.create_task(self._watch_for_orphan()),
        ]
        logger.info(f"[party-broadcast] started at {self.bitrate_kbps}k")

    def stop(self) -> None:
        if self.stopped:
            return
        self.stopped = True
        current = asyncio.current_task()
        for task in self._tasks:
            if task is not current:
                task.cancel()
        for source in (self._source, self._next):
            if source is not None:
                source.close()
        self._source = self._next = None
        if self._encoder is not None:
            try:
                self._encoder.kill()
            except ProcessLookupError:
                pass
        self.fanout.stop()
        for q in self._band_watchers:
            if q.full():
                q.get_nowait()
            q.put_nowait(None)
        self._band_watchers.clear()
        logger.info("[party-broadcast] stopped")
        if self._on_stopped is not None:
            self._on_stopped(self)

    def subscribe(self, lossy: bool = False) -> "asyncio.Queue[bytes | None]":
        return self.fanout.subscribe(lossy=lossy, burst=not lossy)

    def unsubscribe(self, q: "asyncio.Queue[bytes | None]") -> None:
        self.fanout.unsubscribe(q)

    def start_time(self, q: "asyncio.Queue[bytes | None]") -> float | None:
        """Stream time at which `q`'s audio begins."""
        return self.fanout.start_tag(q)

    @property
    def listeners(self) -> int:
        return self.fanout.listeners

    def watch_bands(self) -> asyncio.Queue:
        """Visualizer frames as lists of (stream time, bands), one list per
        stretch of the stream written. A guest shows each frame once it
        hears that stream time, wherever its own buffer has it. None means
        the broadcast has ended."""
        q: asyncio.Queue = asyncio.Queue(maxsize=_BANDS_QUEUE_BATCHES)
        if self.stopped:
            q.put_nowait(None)
            return q
        if not self._band_watchers:
            self._analysis.clear()
            self._analysis_time = self.stream_time
            self._smoothed = None
        self._band_watchers.append(q)
        return q

    def unwatch_bands(self, q: asyncio.Queue) -> None:
        if q in self._band_watchers:
            self._band_watchers.remove(q)

    @property
    def band_watchers(self) -> int:
        return len(self._band_watchers)

    @property
    def stream_time(self) -> float:
        return self._written / SAMPLE_RATE

    # ── Pacing ───────────────────────────────────────────────────────────

    async def _pump(self) -> None:
        try:
            while not self.stopped:
                now = self._clock()
                due = int((now - self._t0 + _LEAD_SECONDS) * SAMPLE_RATE) - self._written
                cap = int(_MAX_CATCH_UP_SECONDS * SAMPLE_RATE)
                if due > cap:
                    # Fell behind (a stalled event loop): give up the time
                    # rather than writing it all at once.
                    self._t0 += (due - cap) / SAMPLE_RATE
                    due = cap
                if due > 0:
                    pcm = self.produce(due, now)
                    assert self._encoder is not None and self._encoder.stdin is not None
                    self._encoder.stdin.write(pcm)
                    await self._encoder.stdin.drain()
                await asyncio.sleep(_TICK_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"[party-broadcast] encoder input failed: {e}")
            self.stop()

    def produce(self, frames: int, now: float) -> bytes:
        """The next `frames` sample frames of the stream, after bringing it
        in line with the host."""
        airs_in = self._t0 + self._written / SAMPLE_RATE - now
        self._cursor = 0
        self._reconcile(now, airs_in)
        out = bytearray()
        remaining = frames
        while remaining > 0:
            source = self._source
            if source is None:
                break
            got = source.take(remaining)
            out += got
            remaining -= len(got) // _FRAME_BYTES
            self._cursor = frames - remaining
            if remaining == 0:
                break
            if source.finished:
                self._song_ended(now)
                continue
            # The decoder has not caught up: silence now, skipped later.
            source.skip(remaining)
            break
        out += bytes((frames * _FRAME_BYTES) - len(out))
        self._written += frames
        self._cursor = 0
        pcm = bytes(out)
        if self._band_watchers:
            self._analyse(pcm)
        return pcm

    def _analyse(self, pcm: bytes) -> None:
        """The visualizer's bands for what was just written, one frame per
        _HOP_SIZE samples, the same analysis the cast visualizer runs."""
        stereo = np.frombuffer(pcm, dtype="<i2").reshape(-1, 2).astype(np.int32)
        self._analysis += ((stereo[:, 0] + stereo[:, 1]) // 2).astype("<i2").tobytes()
        window = _FFT_SIZE * 2
        hop = _HOP_SIZE * 2
        frames: list[tuple[float, list[float]]] = []
        while len(self._analysis) >= window:
            bands = analyze_pcm(bytes(self._analysis[:window]))
            bands = _smooth_bands(self._smoothed, bands, _SMOOTHING_TIME_CONSTANT)
            self._smoothed = bands
            frames.append((self._analysis_time, bands))
            del self._analysis[:hop]
            self._analysis_time += _HOP_SIZE / SAMPLE_RATE
        if not frames:
            return
        for q in self._band_watchers:
            if q.full():
                q.get_nowait()
            q.put_nowait(frames)

    # ── Following the host ───────────────────────────────────────────────

    def _reconcile(self, now: float, airs_in: float) -> None:
        hearing = self._hearing_fn()
        source = self._source
        if hearing is not None and hearing.radio_url and hearing.playing:
            self._play_radio(hearing.radio_url, now)
            return
        if hearing is None or hearing.song_id is None or not hearing.playing:
            song_id = hearing.song_id if hearing is not None else None
            position = hearing.position if hearing is not None else 0.0
            entry = self._current_entry()
            if source is not None or entry.playing or entry.song_id != song_id:
                self._drop_sources()
                self._mark(song_id, position, playing=False)
            return
        # Where the host will be when the next sample written here airs.
        wanted = hearing.position + airs_in
        if source is not None and source.song_id == hearing.song_id:
            if abs(source.position - wanted) > _RESYNC_SECONDS:
                self._play(hearing, wanted, now)
            else:
                self._maybe_preopen(hearing, source)
            return
        if hearing.song_id == self._advanced_from and now < self._advance_grace_until:
            return  # the host has not reported moving on yet
        upcoming = self._next
        if (
            upcoming is not None
            and upcoming.song_id == hearing.song_id
            and wanted <= _RESYNC_SECONDS
        ):
            # The host moved on a moment before this stream's song ran out:
            # take the song already opened rather than opening it again.
            if source is not None:
                source.close()
            self._source, self._next = upcoming, None
            self._mark(upcoming.song_id, upcoming.position, playing=True)
            return
        self._play(hearing, wanted, now)

    def _play(self, hearing: Hearing, position: float, now: float) -> None:
        self._drop_sources()
        self._advanced_from = None
        song_id = hearing.song_id
        assert song_id is not None
        position = max(position, 0.0)
        failed_until = self._failed.get(song_id)
        if (failed_until is not None and failed_until > now) or self._past_end(hearing, position):
            self._mark(song_id, position, playing=False)
            return
        self._source = self._open(song_id, position, hearing.gain)
        self._mark(song_id, position, playing=True)
        self._maybe_preopen(hearing, self._source)

    def _play_radio(self, url: str, now: float) -> None:
        key = f"radio:{url}"
        source = self._source
        if source is not None and source.song_id == key:
            return
        failed_until = self._failed.get(key)
        if failed_until is not None and failed_until > now:
            if source is not None:
                self._drop_sources()
                self._mark(None, 0.0, playing=False)
            return
        self._drop_sources()

        async def station() -> str:
            return url

        self._source = Source(key, 0.0, station, 1.0, radio=True)
        self._source.open()
        self._mark(None, 0.0, playing=True)

    def _maybe_preopen(self, hearing: Hearing, source: Source) -> None:
        if self._next is not None or not hearing.next_song_id or hearing.duration <= 0:
            return
        if hearing.duration - source.position > _PREOPEN_SECONDS:
            return
        # The next song's gain is not known yet; the catch-up after the host
        # reports it does not restart for a gain alone.
        self._next = self._open(hearing.next_song_id, 0.0, 1.0)

    def _song_ended(self, now: float) -> None:
        ended = self._source
        assert ended is not None
        if not ended.produced:
            self._failed[ended.song_id] = now + _FAILED_RETRY_SECONDS
        self._source, self._next = self._next, None
        self._advanced_from = ended.song_id
        self._advance_grace_until = now + _ADVANCE_GRACE_SECONDS
        if self._source is not None:
            self._mark(self._source.song_id, 0.0, playing=True)
        elif ended.radio:
            self._mark(None, 0.0, playing=False)
        else:
            self._mark(ended.song_id, ended.position, playing=False)

    def _past_end(self, hearing: Hearing, position: float) -> bool:
        return hearing.duration > 0 and position >= hearing.duration - _END_MARGIN_SECONDS

    def _open(self, song_id: str, start: float, gain: float) -> Source:
        source = Source(song_id, start, lambda: self._url_fn(song_id), gain)
        source.open()
        return source

    def _drop_sources(self) -> None:
        for source in (self._source, self._next):
            if source is not None:
                source.close()
        self._source = self._next = None

    # ── Timeline ─────────────────────────────────────────────────────────

    def _current_entry(self) -> TimelineEntry:
        return self.timeline[-1]

    def _mark(self, song_id: str | None, position: float, playing: bool) -> None:
        last = self.timeline[-1]
        if not playing and not last.playing and last.song_id == song_id:
            return  # still held, which the last entry already says
        at = (self._written + self._cursor) / SAMPLE_RATE
        entry = TimelineEntry(at, song_id, position, playing)
        if last.stream_time == entry.stream_time:
            self.timeline[-1] = entry
        else:
            self.timeline.append(entry)
        cutoff = self.stream_time - _TIMELINE_KEEP_SECONDS
        while len(self.timeline) > 1 and self.timeline[1].stream_time <= cutoff:
            self.timeline.pop(0)
        if self._on_timeline is not None:
            self._on_timeline()

    # ── Output ───────────────────────────────────────────────────────────

    async def _read_encoder(self) -> None:
        assert self._encoder is not None and self._encoder.stdout is not None
        buf = bytearray()
        frames = 0
        try:
            while True:
                data = await self._encoder.stdout.read(8192)
                if not data:
                    break
                buf += data
                size, count = split_adts(buf)
                if not size:
                    continue
                start = max(frames * _AAC_FRAME_SAMPLES - _ENCODER_DELAY_SAMPLES, 0)
                self.fanout.publish(bytes(buf[:size]), tag=start / SAMPLE_RATE)
                del buf[:size]
                frames += count
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"[party-broadcast] encoder output failed: {e}")
        if not self.stopped:
            logger.warning("[party-broadcast] the encoder ended")
            self.stop()

    async def _watch_for_orphan(self) -> None:
        while not self.stopped:
            await asyncio.sleep(_ORPHAN_CHECK_SECONDS)
            if self.fanout.orphaned_for() >= ORPHAN_TIMEOUT_SECONDS:
                logger.info("[party-broadcast] nobody is listening any more")
                self.stop()
                return
