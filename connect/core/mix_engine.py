"""core/mix_engine.py — one continuous stream through song after song.

With transitions on, songs are not handed to a listener one file at a
time: each is decoded to PCM on a **deck**, and the engine writes them
one after another into a single stream, sample-exact at the join. Every
listener reads that one stream (core/mix_output.py), and the timeline
(core/mix_timeline.py) says which song plays at which stream time.

- **Decks.** One ffmpeg per song decodes it from the media server, unpaced;
  the pipe holds it back once a deck has buffered enough. Near a song's
  end the next one is asked for (`next_fn`, which knows the queue, repeat
  and autoplay) and opened, so its first samples are there when the
  current one runs out.
- **Pacing.** The engine renders a fixed lead ahead of the wall clock - the
  listener's head start - and no further. Paused, the clock stands still
  and so does rendering.
- **Gain** (ReplayGain) is applied here, per deck, not in the decoder: a
  join between a quiet and a loud song is then two decks at two gains,
  with nothing restarted.
- **A deck that falls behind** is waited for while the lead lasts. Only when
  it is used up does silence go out - a speaker that is starved drops the
  connection - and the timeline holds the song's position until audio
  comes back, so nothing is skipped and the mapping stays exact.

With crossfade on, the songs are not just joined but blended
(core/transition_planner.py plans how, from an analysis of both songs'
ends, core/beat_analysis.py). Rendering then runs in floating point: each
song through a band splitter (core/mix_dsp.py) whose bands follow the
plan's gain lanes, the incoming one stretched to the outgoing tempo where
the plan says so (core/timestretch.py), summed, limited and dithered. The
splitter delays everything by its half length, so in that mode the
timeline is marked that much later than the samples are written.

One engine is one run of the mix ("epoch"). A seek or a skip by hand is a
new engine: the speaker has seconds of the old run buffered, so changing
course inside the stream would be heard seconds late.
"""

import asyncio
import logging
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np

from .beat_analysis import RegionAnalysis, analyse_region
from .ffmpeg import FFMPEG_BIN
from .mix_dsp import DELAY_FRAMES, BandSplitter, Dither, pcm_to_float, soft_limit
from .mix_output import FRAME_BYTES, MixConnection, PcmRing
from .mix_timeline import SAMPLE_RATE, Timeline
from .streamer import _HTTP_RECONNECT_ARGS
from .timestretch import HOP as _STRETCH_HOP
from .timestretch import Wsola
from .transition_planner import (
    BANDS,
    Settings,
    SongFacts,
    TransitionPlan,
    crossfade_from,
    plan_transition,
    rate_at,
    rate_integral,
)

logger = logging.getLogger("connect.mix")

# Rendered per step at most; a step is cheap, the cap keeps one from
# holding the event loop when a lot is due at once (the first burst).
_BLOCK_FRAMES = SAMPLE_RATE // 4
_TICK_SECONDS = 0.05
# Decoded audio a deck holds ahead of the render head at most.
_DECK_BUFFER_SECONDS = 20.0
# Below this much lead, a deck that has nothing yet is covered with silence
# rather than waited for. Enough for a speaker's own buffer to bridge the
# moment silence starts, not more.
_STARVE_LEAD_SECONDS = 1.0
# When the next song is asked for, by the current one's remaining length.
# A decoder that has read its whole file asks too, whatever the length says.
_PREOPEN_SECONDS = 30.0
# With crossfade, earlier: the end of this song and the start of the next
# are analysed before the transition is planned, and a beatmix may begin
# up to ~45 s before the end.
_PREOPEN_CROSSFADE_SECONDS = 90.0
# Rendered per tick at most in crossfade mode - see step().
_MAX_DSP_FRAMES_PER_STEP = 2 * SAMPLE_RATE
# How much of each song's end/start is analysed for a transition.
_ANALYSE_SECONDS = 60.0
# While a stretched song eases back to its own tempo, how often its rate
# is written into the timeline.
_RATE_MARK_SECONDS = 1.0
# Rendered audio kept behind the listener's position for a reconnect.
_RETAIN_SECONDS = 60.0
# Songs in a row whose source produced nothing before the mix gives up -
# a broken file on repeat-one would otherwise be retried forever.
_MAX_FAILED_IN_A_ROW = 3


@dataclass(frozen=True)
class MixItem:
    """A song as the mix needs to know it."""

    song_id: str
    queue_index: int | None
    gain: float = 1.0
    duration: float = 0.0  # seconds, 0 when unknown
    album_id: str | None = None
    disc: int | None = None
    track: int | None = None
    bpm: float | None = None
    # The owner's own object for the song (the cast path's Track).
    payload: Any = None


def decode_cmd(url: str, start: float) -> list[str]:
    seek = ["-ss", f"{start:.3f}"] if start > 0 else []
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
        "-ac",
        "2",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "s16le",
        "pipe:1",
    ]


class DeckLike(Protocol):
    item: MixItem
    produced: bool
    decoder_done: bool

    @property
    def position(self) -> float: ...
    @property
    def finished(self) -> bool: ...
    @property
    def available(self) -> int: ...
    def open(self) -> None: ...
    def close(self) -> None: ...
    def take(self, frames: int) -> bytes: ...
    def discard(self, frames: int) -> None: ...


class Deck:
    """One song decoding from `start` seconds on."""

    def __init__(
        self, item: MixItem, start: float, url_fn: Callable[[MixItem], Awaitable[str | None]]
    ) -> None:
        self.item = item
        self.start = start
        self._url_fn = url_fn
        self._buf = bytearray()
        self._consumed = 0
        self._skip = 0  # frames still to drop as they arrive
        self._room = asyncio.Event()
        self._room.set()
        self.produced = False
        # The decoder has read the whole song (or given up): what is in the
        # buffer is all there will be.
        self.decoder_done = False
        self._proc: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task | None = None

    @property
    def position(self) -> float:
        return self.start + self._consumed / SAMPLE_RATE

    @property
    def finished(self) -> bool:
        return self.decoder_done and not self._buf

    @property
    def available(self) -> int:
        """Frames decoded and not yet taken."""
        return len(self._buf) // FRAME_BYTES

    def open(self) -> None:
        self._task = asyncio.create_task(self._run())

    def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
        if self._proc is not None and self._proc.returncode is None:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass

    def take(self, frames: int) -> bytes:
        n = min(frames * FRAME_BYTES, len(self._buf))
        n -= n % FRAME_BYTES
        out = bytes(self._buf[:n])
        del self._buf[:n]
        self._consumed += n // FRAME_BYTES
        self._room.set()
        return out

    def discard(self, frames: int) -> None:
        """Skip `frames` ahead: what is buffered now, the rest on arrival."""
        self._skip += max(frames, 0)
        self._consumed += max(frames, 0)
        self._drop_skipped()

    def _drop_skipped(self) -> None:
        n = min(self._skip * FRAME_BYTES, len(self._buf))
        n -= n % FRAME_BYTES
        if n:
            del self._buf[:n]
            self._skip -= n // FRAME_BYTES
            self._room.set()

    async def _run(self) -> None:
        limit = int(_DECK_BUFFER_SECONDS * SAMPLE_RATE) * FRAME_BYTES
        try:
            url = await self._url_fn(self.item)
            if url is None:
                return
            self._proc = await asyncio.create_subprocess_exec(
                *decode_cmd(url, self.start),
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
                self._drop_skipped()
                if len(self._buf) >= limit:
                    self._room.clear()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.info(f"[mix] decoding {self.item.song_id} failed: {e}")
        finally:
            self.decoder_done = True
            if self._proc is not None and self._proc.returncode is None:
                try:
                    self._proc.kill()
                except ProcessLookupError:
                    pass


def apply_gain(pcm: bytes, gain: float) -> bytes:
    """`pcm` scaled by `gain`, clipped. Untouched at 1, so a join between
    two songs without gain is bit-exact."""
    if gain == 1.0 or not pcm:
        return pcm
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) * gain
    return np.clip(np.rint(samples), -32768, 32767).astype("<i2").tobytes()


DeckFactory = Callable[[MixItem, float], DeckLike]
AnalyseFn = Callable[[MixItem, float, float], Awaitable[RegionAnalysis | None]]


def _facts(item: MixItem) -> SongFacts:
    return SongFacts(item.duration, item.album_id, item.disc, item.track)


@dataclass
class _Transition:
    """A blend under way: `frame` counts frames since the overlap began."""

    plan: TransitionPlan
    incoming: DeckLike
    in_splitter: BandSplitter
    wsola: Wsola | None
    start_out: int  # ring frame the overlap's first frame was written at
    frame: int = 0
    swapped: bool = False
    next_rate_mark: int = 0

    @property
    def overlap_frames(self) -> int:
        return round(self.plan.overlap * SAMPLE_RATE)

    @property
    def swap_frame(self) -> int:
        return round(self.plan.swap_at * SAMPLE_RATE)

    @property
    def stretch_end_frame(self) -> int:
        """Where the incoming song is back at its own tempo - and one more
        stretch step, which hands it back without a seam (Wsola.handover)."""
        if not self.plan.in_rate:
            return 0
        return round(self.plan.in_rate[-1][0] * SAMPLE_RATE) + 2 * _STRETCH_HOP

    def output_frame(self, frame: int) -> int:
        return self.start_out + frame + DELAY_FRAMES


class MixEngine:
    def __init__(
        self,
        first: MixItem,
        position: float,
        url_fn: Callable[[MixItem], Awaitable[str | None]],
        next_fn: Callable[[MixItem], Awaitable[MixItem | None]],
        lead_seconds: float = 15.0,
        clock: Callable[[], float] = time.monotonic,
        deck_factory: DeckFactory | None = None,
        on_change: Callable[["MixEngine"], None] | None = None,
        settings: Settings | None = None,
        analyse_fn: AnalyseFn | None = None,
    ) -> None:
        self.epoch = secrets.token_urlsafe(6)
        self.first = first
        self.start_position = max(position, 0.0)
        self._url_fn = url_fn
        self._next_fn = next_fn
        self.lead_frames = int(lead_seconds * SAMPLE_RATE)
        self._clock = clock
        self._deck_factory = deck_factory or (lambda item, start: Deck(item, start, url_fn))
        self._on_change = on_change
        self.ring = PcmRing()
        self.timeline = Timeline()
        self._deck: DeckLike | None = None
        self._next: DeckLike | None = None
        # Whether the song after the current one has been asked for: None
        # not yet, "pending" while next_fn runs, "done" once answered (with
        # self._next holding its deck, or None for the end of the queue).
        self._next_state: str | None = None
        self._next_generation = 0
        self._holding = False
        self._failed_in_a_row = 0
        # The wall clock that stream time is paced against. Set when the
        # first audio is rendered, not when the engine starts: a speaker
        # waits for the decoder's first samples either way, and counting
        # that wait would eat the head start.
        self._t0: float | None = None
        self._paused_at: float | None = None
        self._connections: list[MixConnection] = []
        self._task: asyncio.Task | None = None
        self._resolve_task: asyncio.Task | None = None
        self.stopped = False
        self.settings = settings or Settings()
        self._analyse_fn = analyse_fn or self._analyse_source
        # Crossfade renders in floating point (see the module docstring);
        # gapless stays on the byte path, where a join is bit-exact. Fixed
        # for the engine's life: a setting changed mid-run applies from the
        # next run on.
        self._dsp = self.settings.mode == "crossfade"
        self._shared = BandSplitter()
        self._dither = Dither()
        # Input left over from a stretch, played before the deck itself.
        self._pending = np.zeros((0, 2), dtype=np.float32)
        self._plan: TransitionPlan | None = None
        self._plan_task: asyncio.Task | None = None
        self._tx: _Transition | None = None
        # Marked before start(): a mix set up paused still answers what it
        # would play.
        self.timeline.mark(
            0,
            first.song_id,
            first.queue_index,
            self.start_position,
            playing=True,
            payload=first,
            starts=True,
        )

    # ── Lifecycle ────────────────────────────────────────────────────────

    def start(self) -> None:
        self._deck = self._open(self.first, self.start_position)
        self._task = asyncio.create_task(self._run())
        logger.info(
            f"[mix] {self.epoch} started at {self.first.song_id}@{self.start_position:.1f}s"
        )

    def stop(self) -> None:
        if self.stopped:
            return
        self.stopped = True
        try:
            current = asyncio.current_task()
        except RuntimeError:  # stopped from outside any event loop
            current = None
        for task in (self._task, self._resolve_task, self._plan_task):
            if task is not None and task is not current:
                task.cancel()
        if self._tx is not None:
            self._tx.incoming.close()
            self._tx = None
        for deck in (self._deck, self._next):
            if deck is not None:
                deck.close()
        self._deck = self._next = None
        for connection in self._connections:
            connection.close()
        self._connections.clear()
        if not self.ring.closed:
            self.ring.close()
        logger.info(f"[mix] {self.epoch} stopped")

    @property
    def listeners(self) -> int:
        """Connections reading this mix right now."""
        return sum(1 for c in self._connections if not c.closed)

    @property
    def started(self) -> bool:
        return self._task is not None

    @property
    def ended(self) -> bool:
        return self.timeline.end_frame is not None

    @property
    def end_stream_time(self) -> float | None:
        end = self.timeline.end_frame
        return None if end is None else end / SAMPLE_RATE

    @property
    def rendered_time(self) -> float:
        return self.ring.head / SAMPLE_RATE

    # ── Control ──────────────────────────────────────────────────────────

    def freeze(self) -> None:
        """Paused: the stream's clock stands still, and so does rendering."""
        if self._paused_at is None:
            self._paused_at = self._clock()

    def unfreeze(self) -> None:
        if self._paused_at is None:
            return
        if self._t0 is not None:
            self._t0 += self._clock() - self._paused_at
        self._paused_at = None

    @property
    def paused(self) -> bool:
        return self._paused_at is not None

    def queue_changed(self) -> None:
        """The queue after the current song may be different now. A next
        song already opened is dropped and asked for again; the current one
        plays on."""
        if self._tx is not None:
            return  # the next song is already blending in
        self._next_generation += 1
        for task in (self._resolve_task, self._plan_task):
            if task is not None and not task.done():
                task.cancel()
        if self._next is not None:
            self._next.close()
            self._next = None
        self._next_state = None
        self._plan = None

    async def connect(self, start_time: float, output_args: list[str]) -> MixConnection:
        """A listener's encode from `start_time` (stream seconds) on."""
        connection = MixConnection(self.ring, round(start_time * SAMPLE_RATE), output_args)
        await connection.open()
        self._connections = [c for c in self._connections if not c.closed]
        self._connections.append(connection)
        return connection

    # ── Rendering ────────────────────────────────────────────────────────

    async def _run(self) -> None:
        try:
            while not self.stopped:
                self.step()
                if self.ended:
                    return
                await asyncio.sleep(_TICK_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(f"[mix] {self.epoch} rendering failed")
            self.stop()

    def step(self) -> None:
        """Render whatever is due, and look ahead to the next song. The
        render loop's body, callable directly from a test."""
        self._maybe_ask_for_next()
        due = self._target_frame() - self.ring.head
        if self._dsp:
            # A blend costs ~18 ms per second of audio; a whole head start
            # rendered in one go would hold the event loop that long times
            # twenty. The rest follows on the next ticks.
            due = min(due, _MAX_DSP_FRAMES_PER_STEP)
        render = self._render_dsp if self._dsp else self._render
        while due > 0 and not self.ended and not self.stopped:
            written = render(min(due, _BLOCK_FRAMES))
            if written == 0:
                break
            due -= written
        if self.ended and not self.ring.closed:
            # Only now: the block that reached the end has been written.
            self.ring.close()
        self._trim()

    def _now(self) -> float:
        return self._paused_at if self._paused_at is not None else self._clock()

    def _wall_frame(self) -> int | None:
        """Stream frame the listener is at by the wall clock, or None before
        any audio went out."""
        if self._t0 is None:
            return None
        return int((self._now() - self._t0) * SAMPLE_RATE)

    def _target_frame(self) -> int:
        wall = self._wall_frame()
        if wall is None:
            # Nothing rendered yet: render as soon as there is audio.
            return self.lead_frames
        target = wall + self.lead_frames
        open_connections = [c for c in self._connections if not c.closed]
        if open_connections:
            # A listener that stopped reading holds rendering back rather
            # than letting audio pile up for it.
            target = min(target, max(c.fed_frame for c in open_connections) + self.lead_frames)
        return target

    def _render(self, frames: int) -> int:
        """Up to `frames` frames into the ring; how many were written."""
        out = bytearray()
        remaining = frames
        while remaining > 0:
            deck = self._deck
            if deck is None:
                break
            position = deck.position
            pcm = deck.take(remaining)
            if pcm:
                if self._holding:
                    self._resume_from_hold(len(out) // FRAME_BYTES, position)
                if self._t0 is None:
                    self._t0 = self._clock()
                self._failed_in_a_row = 0
                out += apply_gain(pcm, deck.item.gain)
                remaining -= len(pcm) // FRAME_BYTES
                continue
            if deck.finished:
                if not self._advance(self.ring.head + len(out) // FRAME_BYTES):
                    break  # the next song is not known yet
                continue
            break
        if remaining > 0 and self._deck is not None and self._starving(len(out)):
            # Out of lead: silence, with the song held where it stands.
            if not self._holding:
                self._holding = True
                self.timeline.mark(
                    self.ring.head + len(out) // FRAME_BYTES,
                    self._deck.item.song_id,
                    self._deck.item.queue_index,
                    self._deck.position,
                    playing=False,
                    payload=self._deck.item,
                )
            out += bytes(remaining * FRAME_BYTES)
            remaining = 0
        if out:
            self.ring.append(bytes(out))
        return len(out) // FRAME_BYTES

    # ── Rendering a crossfade ────────────────────────────────────────────

    def _render_dsp(self, frames: int) -> int:
        """_render() for crossfade: floats, splitters, lanes, limiter."""
        parts: list[np.ndarray] = []
        written = 0
        while written < frames and not self.ended:
            if self._tx is None:
                self._maybe_begin_transition(written)
            if self._tx is not None:
                n = self._render_transition(frames - written, parts, written)
            else:
                n = self._render_single(frames - written, parts, written)
            if n is None:
                continue  # moved on to the next song without writing
            if n == 0:
                break
            written += n
        if written < frames and self._deck is not None and self._starving(written * FRAME_BYTES):
            self._hold_at(self.ring.head + written + DELAY_FRAMES)
            parts.append(np.zeros((frames - written, 2), dtype=np.float32))
            written = frames
        if parts:
            self.ring.append(self._dither.to_int16(soft_limit(np.concatenate(parts))))
        return written

    def _render_single(self, frames: int, parts: list[np.ndarray], written: int) -> int | None:
        deck = self._deck
        if deck is None:
            return 0
        limit = frames
        plan = self._plan
        if self._next is not None and plan is not None and plan.kind != "gapless":
            until = int(np.ceil((plan.out_start - deck.position) * SAMPLE_RATE))
            if until > 0:
                limit = min(limit, until)
        if len(self._pending):
            x, self._pending = self._pending[:limit], self._pending[limit:]
        else:
            n = min(limit, deck.available)
            if n == 0:
                if deck.finished:
                    return self._advance_dsp(parts, written)
                return 0
            x = pcm_to_float(deck.take(n)) * np.float32(deck.item.gain)
        self._audio_flowing(written)
        parts.append(self._shared.process(x, split=False)[0])
        return len(x)

    def _advance_dsp(self, parts: list[np.ndarray], written: int) -> int | None:
        """_advance() for crossfade: the next song joins through the same
        splitter, which is what keeps a join without a fade seamless."""
        ended = self._deck
        assert ended is not None
        if self._next_state != "done":
            self._maybe_ask_for_next(force=True)
            return 0
        if not ended.produced:
            self._failed_in_a_row += 1
            logger.warning(f"[mix] {self.epoch} {ended.item.song_id} produced no audio")
        ended.close()
        nxt, self._next = self._next, None
        self._next_state = None
        self._plan = None
        self._holding = False
        if nxt is None or self._failed_in_a_row >= _MAX_FAILED_IN_A_ROW:
            if nxt is not None:
                nxt.close()
            # What the splitter still holds is the end of the last song.
            parts.append(
                self._shared.process(np.zeros((DELAY_FRAMES, 2), dtype=np.float32), split=False)[0]
            )
            end = self.ring.head + written + DELAY_FRAMES
            self._deck = None
            self.timeline.mark_end(end)
            logger.info(f"[mix] {self.epoch} ended at {end / SAMPLE_RATE:.2f}s")
            self._changed()
            return DELAY_FRAMES
        self._deck = nxt
        frame = self.ring.head + written + DELAY_FRAMES
        self.timeline.mark(
            frame,
            nxt.item.song_id,
            nxt.item.queue_index,
            nxt.position,
            playing=True,
            payload=nxt.item,
            starts=True,
        )
        logger.info(
            f"[mix] {self.epoch} → {nxt.item.song_id} at {frame / SAMPLE_RATE:.2f}s (gapless)"
        )
        self._changed()
        return None

    def _maybe_begin_transition(self, written: int) -> None:
        deck, nxt = self._deck, self._next
        if deck is None or nxt is None or self._next_state != "done" or len(self._pending):
            return
        plan = self._plan
        if plan is None:
            # The analysis has not answered by the last moment a crossfade
            # can still start: go ahead on the metadata alone.
            latest = deck.item.duration - self.settings.crossfade_seconds - 1.0
            if deck.item.duration <= 0 or deck.position < latest:
                return
            if self._plan_task is not None:
                self._plan_task.cancel()
            plan = self._plan = plan_transition(self.settings, _facts(deck.item), _facts(nxt.item))
            logger.info(f"[mix] {self.epoch} no analysis in time - {plan.kind} on metadata")
        if plan.kind == "gapless" or deck.position < plan.out_start - 0.5 / SAMPLE_RATE:
            return
        if deck.position > plan.out_start + 0.25:
            # Planned for a moment already played: fade from here instead.
            late = crossfade_from(self.settings, deck.position, plan.out_end, plan.in_start)
            if late is None:
                self._plan = TransitionPlan("gapless", plan.out_end, plan.out_end, plan.in_start)
                return
            plan = self._plan = late
        self._begin_transition(plan, written)

    def _begin_transition(self, plan: TransitionPlan, written: int) -> None:
        incoming = self._next
        assert incoming is not None
        self._next = None
        self._next_state = None
        incoming.discard(round((plan.in_start - incoming.position) * SAMPLE_RATE))
        self._tx = _Transition(
            plan=plan,
            incoming=incoming,
            in_splitter=BandSplitter(),
            wsola=Wsola() if plan.in_rate else None,
            start_out=self.ring.head + written,
        )
        bpm = (
            f", {plan.bpm_out:.1f} → {plan.bpm_in:.1f} BPM"
            if plan.bpm_out is not None and plan.bpm_in is not None
            else ""
        )
        logger.info(
            f"[mix] {self.epoch} {plan.kind} into {incoming.item.song_id} over "
            f"{plan.overlap:.1f}s{bpm}"
        )

    def _render_transition(self, frames: int, parts: list[np.ndarray], written: int) -> int:
        tx = self._tx
        deck = self._deck
        assert tx is not None and deck is not None
        plan = tx.plan
        in_overlap = tx.frame < tx.overlap_frames
        n = frames
        if in_overlap:
            n = min(n, tx.overlap_frames - tx.frame)
            if not deck.finished:
                n = min(n, deck.available)
        if not tx.swapped and tx.frame < tx.swap_frame:
            n = min(n, tx.swap_frame - tx.frame)
        if n <= 0:
            return 0
        x_in = self._incoming_audio(tx, n)
        n = len(x_in)
        if n == 0:
            return 0
        if in_overlap:
            x_out = pcm_to_float(deck.take(n)) * np.float32(deck.item.gain)
            if len(x_out) < n:  # the outgoing song ran out before the plan said
                x_out = np.concatenate([x_out, np.zeros((n - len(x_out), 2), dtype=np.float32)])
            # The splitters delay by DELAY_FRAMES; the lanes follow the
            # delayed signal.
            t = (tx.frame + np.arange(n) - DELAY_FRAMES) / SAMPLE_RATE
            out_bands = self._shared.process(x_out)
            in_bands = tx.in_splitter.process(x_in)
            y = np.zeros((n, 2), dtype=np.float32)
            for i, band in enumerate(BANDS):
                out_lane, in_lane = plan.out_lanes[band], plan.in_lanes[band]
                y += out_bands[i] * np.interp(t, out_lane.times, out_lane.gains)[:, None]
                y += in_bands[i] * np.interp(t, in_lane.times, in_lane.gains)[:, None]
        else:
            y = tx.in_splitter.process(x_in, split=False)[0]
        self._audio_flowing(written)
        parts.append(y.astype(np.float32))
        tx.frame += n

        if not tx.swapped and tx.frame >= tx.swap_frame:
            tx.swapped = True
            t = plan.swap_at
            item = tx.incoming.item
            frame = tx.output_frame(tx.swap_frame)
            self.timeline.mark(
                frame,
                item.song_id,
                item.queue_index,
                plan.in_start + rate_integral(plan.in_rate, t),
                playing=True,
                rate=rate_at(plan.in_rate, t),
                payload=item,
                starts=True,
            )
            tx.next_rate_mark = tx.swap_frame + round(_RATE_MARK_SECONDS * SAMPLE_RATE)
            logger.info(f"[mix] {self.epoch} → {item.song_id} at {frame / SAMPLE_RATE:.2f}s")
            self._changed()
        if in_overlap and tx.frame >= tx.overlap_frames:
            deck.close()
            self._deck = tx.incoming
            self._shared = tx.in_splitter
        if tx.wsola is not None and tx.swapped:
            while tx.frame >= tx.next_rate_mark and tx.next_rate_mark < tx.stretch_end_frame:
                t = tx.next_rate_mark / SAMPLE_RATE
                item = tx.incoming.item
                self.timeline.mark(
                    tx.output_frame(tx.next_rate_mark),
                    item.song_id,
                    item.queue_index,
                    plan.in_start + rate_integral(plan.in_rate, t),
                    playing=True,
                    rate=rate_at(plan.in_rate, t),
                    payload=item,
                )
                tx.next_rate_mark += round(_RATE_MARK_SECONDS * SAMPLE_RATE)
        stretching = tx.wsola is not None and tx.frame < tx.stretch_end_frame
        if tx.frame >= tx.overlap_frames and not stretching:
            if tx.wsola is not None:
                ready, rest = tx.wsola.handover()
                self._pending = np.concatenate([ready, rest]).astype(np.float32)
            self._tx = None
        return n

    def _incoming_audio(self, tx: _Transition, frames: int) -> np.ndarray:
        """Up to `frames` of the incoming song, stretched if the plan says."""
        deck = tx.incoming
        gain = np.float32(deck.item.gain)
        if tx.wsola is None:
            n = min(frames, deck.available)
            if n == 0 and deck.finished:
                return np.zeros((frames, 2), dtype=np.float32)
            return pcm_to_float(deck.take(n)) * gain
        plan = tx.plan
        made: list[np.ndarray] = []
        total = 0
        while total < frames:

            def rate(k: int, done: int = total) -> float:
                return rate_at(plan.in_rate, (tx.frame + done + k) / SAMPLE_RATE)

            missing = tx.wsola.needed(rate(0))
            if missing > 0:
                if deck.available == 0:
                    if not deck.finished:
                        break
                    tx.wsola.push(np.zeros((missing, 2), dtype=np.float32))
                    continue
                take = min(deck.available, missing + _STRETCH_HOP * 4)
                tx.wsola.push(pcm_to_float(deck.take(take)) * gain)
                continue
            got = tx.wsola.pull(frames - total, rate)
            if len(got) == 0:
                break
            made.append(got)
            total += len(got)
        return np.concatenate(made) if made else np.zeros((0, 2), dtype=np.float32)

    def _audio_flowing(self, written: int) -> None:
        if self._t0 is None:
            self._t0 = self._clock()
        self._failed_in_a_row = 0
        self._unhold_at(self.ring.head + written + DELAY_FRAMES)

    def _hold_at(self, frame: int) -> None:
        if self._holding:
            return
        heard = self.timeline.at(frame)
        if heard is None or heard.song_id is None:
            return
        self._holding = True
        entry = heard.entry
        self.timeline.mark(
            frame,
            entry.song_id,
            entry.queue_index,
            heard.position,
            playing=False,
            payload=entry.payload,
        )

    def _unhold_at(self, frame: int) -> None:
        if not self._holding:
            return
        self._holding = False
        last = self.timeline.last
        assert last is not None
        self.timeline.mark(
            max(frame, last.frame),
            last.song_id,
            last.queue_index,
            last.position,
            playing=True,
            payload=last.payload,
        )

    def _starving(self, pending_bytes: int) -> bool:
        wall = self._wall_frame()
        if wall is None:
            return False
        lead = self.ring.head + pending_bytes // FRAME_BYTES - wall
        return lead < _STARVE_LEAD_SECONDS * SAMPLE_RATE

    def _resume_from_hold(self, pending_frames: int, position: float) -> None:
        self._holding = False
        deck = self._deck
        assert deck is not None
        self.timeline.mark(
            self.ring.head + pending_frames,
            deck.item.song_id,
            deck.item.queue_index,
            position,
            playing=True,
            payload=deck.item,
        )

    def _advance(self, frame: int) -> bool:
        """The current deck ran out at `frame`. False while the next song is
        still being asked for."""
        ended = self._deck
        assert ended is not None
        if self._next_state != "done":
            self._maybe_ask_for_next(force=True)
            return False
        if not ended.produced:
            self._failed_in_a_row += 1
            logger.warning(f"[mix] {self.epoch} {ended.item.song_id} produced no audio")
        ended.close()
        self._holding = False
        nxt, self._next = self._next, None
        self._next_state = None
        if nxt is None or self._failed_in_a_row >= _MAX_FAILED_IN_A_ROW:
            if nxt is not None:
                nxt.close()
            self._deck = None
            self.timeline.mark_end(frame)
            logger.info(f"[mix] {self.epoch} ended at {frame / SAMPLE_RATE:.2f}s")
        else:
            self._deck = nxt
            self.timeline.mark(
                frame,
                nxt.item.song_id,
                nxt.item.queue_index,
                0.0,
                playing=True,
                payload=nxt.item,
                starts=True,
            )
            logger.info(
                f"[mix] {self.epoch} → {nxt.item.song_id} at {frame / SAMPLE_RATE:.2f}s (gapless)"
            )
        self._changed()
        return True

    # ── The next song ────────────────────────────────────────────────────

    def _maybe_ask_for_next(self, force: bool = False) -> None:
        deck = self._deck
        if deck is None or self._next_state is not None or self._tx is not None:
            return
        remaining = deck.item.duration - deck.position if deck.item.duration > 0 else None
        ahead = _PREOPEN_CROSSFADE_SECONDS if self._dsp else _PREOPEN_SECONDS
        if not (force or deck.decoder_done or (remaining is not None and remaining <= ahead)):
            return
        self._next_state = "pending"
        generation = self._next_generation
        self._resolve_task = asyncio.create_task(self._ask_for_next(deck.item, generation))

    async def _ask_for_next(self, current: MixItem, generation: int) -> None:
        try:
            item = await self._next_fn(current)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(f"[mix] {self.epoch} finding the next song failed")
            item = None
        if generation != self._next_generation or self.stopped:
            return
        self._next = self._open(item, 0.0) if item is not None else None
        self._next_state = "done"
        if self._dsp and item is not None:
            self._plan = None
            self._plan_task = asyncio.create_task(self._make_plan(current, item, generation))

    async def _make_plan(self, out_item: MixItem, in_item: MixItem, generation: int) -> None:
        out_facts, in_facts = _facts(out_item), _facts(in_item)
        plan = plan_transition(self.settings, out_facts, in_facts)
        if plan.kind != "gapless" and out_item.duration > 0:
            try:
                out_region, in_region = await asyncio.gather(
                    self._analyse_fn(
                        out_item,
                        max(0.0, out_item.duration - _ANALYSE_SECONDS),
                        _ANALYSE_SECONDS + 5.0,
                    ),
                    self._analyse_fn(in_item, 0.0, _ANALYSE_SECONDS),
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(f"[mix] {self.epoch} analysing the transition failed")
                out_region = in_region = None
            plan = plan_transition(self.settings, out_facts, in_facts, out_region, in_region)
        if generation != self._next_generation or self.stopped:
            return
        self._plan = plan
        logger.info(
            f"[mix] {self.epoch} planned {plan.kind} {out_item.song_id} → {in_item.song_id}"
            + (f" at {plan.out_start:.1f}s over {plan.overlap:.1f}s" if plan.overlap else "")
        )

    async def _analyse_source(
        self, item: MixItem, start: float, duration: float
    ) -> RegionAnalysis | None:
        url = await self._url_fn(item)
        if url is None:
            return None
        return await analyse_region(url, start, duration, item.bpm)

    def _open(self, item: MixItem, start: float) -> DeckLike:
        deck = self._deck_factory(item, start)
        deck.open()
        return deck

    # ── Housekeeping ─────────────────────────────────────────────────────

    def _trim(self) -> None:
        wall = self._wall_frame()
        if wall is None:
            return
        keep_from = wall - int(_RETAIN_SECONDS * SAMPLE_RATE)
        open_connections = [c for c in self._connections if not c.closed]
        if open_connections:
            keep_from = min(keep_from, min(c.fed_frame for c in open_connections))
        self.ring.trim(keep_from)
        self.timeline.prune_behind(self.ring.head)

    def _changed(self) -> None:
        if self._on_change is not None:
            try:
                self._on_change(self)
            except Exception:
                logger.exception("[mix] change callback failed")
