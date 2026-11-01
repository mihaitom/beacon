"""lights/controller.py — when the light show runs, and for what.

The lights follow one playback at a time: whatever this connect casts, or
else the local playback of a device that reports it (the desktop app,
POST /lights/local). Casts come first: they play in a room, which is what
the lights are in.

A supervisor checks a few times a second what should be playing on the
lights and starts or stops the stream to match; while it runs, a render
loop sends a frame every 20 ms. Polling rather than hooking into play,
pause, seek and track changes, for the reason core/visualizer_feed.py
gives: every one of those paths would otherwise have to remember this too.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass

from core import deezer
from core.state import TEST_TONE_TRACK_ID, list_target_pairs

from . import config as lights_config
from . import hue, show
from .analysis import DEFAULT_COLOUR, RGB, AnalysisCache, cover_colours

logger = logging.getLogger("connect.lights")

# The bridge forwards about 25 updates a second; twice that keeps a lost
# datagram from showing.
SEND_HZ = 50
_SUPERVISE_SECONDS = 0.25
# A pause, a skip or a stalled report shorter than this keeps the stream
# open, so the lights do not drop back to their own state between songs.
_GRACE_SECONDS = 3.0
# A device's local report older than this no longer counts as playing:
# the app reports every few seconds while playing, so a closed tab or a
# phone gone to sleep goes quiet within this.
LOCAL_REPORT_TTL = 8.0
# After a failed start (bridge away, area taken by another app), wait
# before trying again rather than hammering it every tick.
_RETRY_SECONDS = 15.0
# How long a song's new colour takes to replace the last one's.
_COLOUR_FADE_SECONDS = 1.5


async def _cancel(task: asyncio.Task | None) -> None:
    if task is None:
        return
    task.cancel()
    # A task from a loop that is gone (a restarted app, a test client) can
    # only be dropped, not waited for.
    if task.get_loop() is asyncio.get_running_loop():
        with contextlib.suppress(asyncio.CancelledError):
            await task


@dataclass
class LocalReport:
    session_id: str
    song_id: str
    position: float
    playing: bool
    at: float


@dataclass(frozen=True)
class Source:
    """What the lights follow right now."""

    session_id: str
    song_id: str
    position: float


class LightController:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._render_task: asyncio.Task | None = None
        # Made in start(): an Event belongs to the loop it was first used
        # on, and the app (and every test client) brings its own.
        self._wake: asyncio.Event | None = None
        self._local: dict[str, LocalReport] = {}
        self._analysis = AnalysisCache()
        self._song_meta: dict[str, tuple[str, str | None]] = {}  # id -> (stream url, cover url)
        self._song_meta_pending: set[str] = set()
        self._covers: dict[str, tuple[RGB, ...]] = {}  # song id -> cover palette
        self._stream: hue.DtlsStream | None = None
        self._streaming_area: str | None = None
        self._channels: tuple[hue.Channel, ...] = ()
        self._source: Source | None = None
        self._source_at = 0.0
        # The song the lights followed last, for the dialog's cover colours.
        self._last_song_id: str | None = None
        self._last_seen_source = 0.0
        self._retry_after = 0.0
        self._palette: tuple[RGB, ...] = (DEFAULT_COLOUR,)
        self.last_error: str | None = None

    # ── lifecycle ──────────────────────────────────────────────────────

    def start(self) -> None:
        if self._task is None:
            self._wake = asyncio.Event()
            self._task = asyncio.create_task(self._supervise())

    async def stop(self) -> None:
        task, self._task = self._task, None
        await _cancel(task)
        await self._stop_stream()
        self._analysis.cancel_all()

    def notify(self) -> None:
        """Something changed (settings, a report) - look again now."""
        if self._wake is not None:
            self._wake.set()

    @property
    def streaming(self) -> bool:
        return self._stream is not None

    @property
    def cover_palette(self) -> tuple[RGB, ...] | None:
        """The colours of the cover the lights followed last, once known."""
        if self._last_song_id is None:
            return None
        return self._covers.get(self._last_song_id)

    # ── inputs ─────────────────────────────────────────────────────────

    def report_local(self, session_id: str, song_id: str, position: float, playing: bool) -> None:
        self._local[session_id] = LocalReport(
            session_id, song_id, max(0.0, position), playing, time.monotonic()
        )
        self.notify()

    def forget_local(self, session_id: str) -> None:
        if self._local.pop(session_id, None) is not None:
            self.notify()

    # ── what to follow ────────────────────────────────────────────────

    def _cast_source(self) -> Source | None:
        from core.session import compute_position, registry

        best: tuple[float, Source] | None = None
        for session in registry.all():
            st = session.state
            if not st.is_streaming or st.clock.is_paused or not st.clock.play_start_time:
                continue
            if not list_target_pairs(st.active_delivery):
                continue
            if st.mix is not None:
                heard = st.mix.timeline.at_time(max(st.clock.elapsed(), 0.0))
                if heard is None or not heard.song_id:
                    continue
                song_id, position = heard.song_id, heard.position
            elif st.current_track is not None:
                song_id, position = st.current_track.id, compute_position(session)
            else:
                continue  # radio: no song to analyse ahead
            if song_id == TEST_TONE_TRACK_ID:
                continue
            # Two casts at once: the one started last.
            started = st.clock.play_start_time or 0.0
            if best is None or started > best[0]:
                best = (started, Source(session.session_id, song_id, position))
        return best[1] if best else None

    def _local_source(self, now: float) -> Source | None:
        fresh = [r for r in self._local.values() if r.playing and now - r.at <= LOCAL_REPORT_TTL]
        if not fresh:
            return None
        r = max(fresh, key=lambda r: r.at)
        return Source(r.session_id, r.song_id, r.position + (now - r.at))

    def current_source(self) -> Source | None:
        cfg = lights_config.get()
        if not cfg.ready:
            return None
        return self._cast_source() or self._local_source(time.monotonic())

    # ── supervisor ─────────────────────────────────────────────────────

    async def _supervise(self) -> None:
        try:
            while True:
                try:
                    await self._tick()
                except Exception as e:
                    logger.warning(f"[lights] {e}")
                wake = self._wake
                if wake is None:
                    return
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(wake.wait(), _SUPERVISE_SECONDS)
                wake.clear()
        except asyncio.CancelledError:
            pass

    async def _tick(self) -> None:
        now = time.monotonic()
        cfg = lights_config.get()
        source = self.current_source()
        self._source, self._source_at = source, now
        if source is not None:
            self._last_seen_source = now
            self._last_song_id = source.song_id
            self._prepare(source)

        wanted = (
            cfg.area_id if cfg.ready and now - self._last_seen_source < _GRACE_SECONDS else None
        )
        if self._streaming_area != wanted:
            await self._stop_stream()
            if wanted is not None and now >= self._retry_after:
                await self._start_stream(cfg)

    def _prepare(self, source: Source) -> None:
        """Gets the song's analysis and colour going, once each."""
        song_id = source.song_id
        meta = self._song_meta.get(song_id)
        if meta is None:
            if song_id not in self._song_meta_pending:
                self._song_meta_pending.add(song_id)
                asyncio.create_task(self._resolve(source))
            return
        stream_url, _ = meta
        if stream_url:
            self._analysis.request(song_id, stream_url)

    async def _resolve(self, source: Source) -> None:
        from core.session import registry

        song_id = source.song_id
        stream_url: str | None = None
        cover_url: str | None = None
        try:
            session = registry.get(source.session_id)
            if session is None:
                return
            if deezer.is_preview_id(song_id):
                stream_url = await deezer.preview_stream_url(song_id)
            else:
                media = session.media
                stream_url = await asyncio.to_thread(media.get_stream_url, song_id)
                track = await asyncio.to_thread(media.get_track, song_id)
                if track.cover_art_id:
                    cover_url = media.get_cover_art_url(track.cover_art_id, internal=True)
        except Exception as e:
            logger.info(f"[lights] Could not look up {song_id}: {e}")
        finally:
            self._song_meta_pending.discard(song_id)
        self._song_meta[song_id] = (stream_url or "", cover_url)
        if len(self._song_meta) > 32:
            self._song_meta.pop(next(iter(self._song_meta)))
        self._covers[song_id] = await cover_colours(cover_url)
        if len(self._covers) > 32:
            self._covers.pop(next(iter(self._covers)))
        self.notify()

    # ── the stream ─────────────────────────────────────────────────────

    async def _start_stream(self, cfg: lights_config.LightsConfig) -> None:
        bridge = hue.Bridge(cfg.bridge_host, cfg.bridge_id)
        pairing = hue.Pairing(cfg.username, cfg.clientkey, cfg.app_id)
        try:
            area = await hue.get_area(bridge, pairing, cfg.area_id)
            await hue.set_streaming(bridge, pairing, cfg.area_id, True)
            stream = hue.DtlsStream(cfg.bridge_host, cfg.app_id, bytes.fromhex(cfg.clientkey))
            try:
                await asyncio.to_thread(stream.handshake)
            except Exception:
                stream.close()
                with contextlib.suppress(hue.HueError):
                    await hue.set_streaming(bridge, pairing, cfg.area_id, False)
                raise
        except Exception as e:
            self.last_error = str(e)
            self._retry_after = time.monotonic() + _RETRY_SECONDS
            logger.warning(f"[lights] Could not start the light show: {e}")
            return
        self.last_error = None
        self._stream = stream
        self._streaming_area = cfg.area_id
        self._channels = area.channels
        self._render_task = asyncio.create_task(self._render())
        logger.info(f"[lights] Playing along in {area.name!r} ({len(area.channels)} lights)")

    async def _stop_stream(self) -> None:
        task, self._render_task = self._render_task, None
        await _cancel(task)
        stream, self._stream = self._stream, None
        area, self._streaming_area = self._streaming_area, None
        if stream is None:
            return
        stream.close()
        cfg = lights_config.get()
        if cfg.paired and area:
            # Hands the lights back to the bridge, which restores what
            # they showed before.
            with contextlib.suppress(hue.HueError):
                await hue.set_streaming(
                    hue.Bridge(cfg.bridge_host, cfg.bridge_id),
                    hue.Pairing(cfg.username, cfg.clientkey, cfg.app_id),
                    area,
                    False,
                )
        logger.info("[lights] Light show stopped")

    def _frame(self, now: float) -> dict[int, RGB]:
        cfg = lights_config.get()
        brightness = cfg.brightness / 100
        source = self._source
        if source is None:
            # The grace period between songs: hold the colours, dimmed.
            return show.frame(0.0, None, self._palette, self._channels, brightness=brightness * 0.5)
        wanted = palette_for(cfg, self._covers.get(source.song_id))
        self._palette = _fade(self._palette, wanted, (1 / SEND_HZ) / _COLOUR_FADE_SECONDS)
        position = source.position + (now - self._source_at) + cfg.lead_ms / 1000
        song = self._analysis.get(source.song_id)
        return show.frame(position, song, self._palette, self._channels, cfg.style, brightness)

    async def _render(self) -> None:
        interval = 1 / SEND_HZ
        seq = 0
        next_at = time.monotonic()
        try:
            while self._stream is not None:
                now = time.monotonic()
                colours = self._frame(now)
                self._stream.send(hue.stream_message(seq, self._streaming_area or "", colours))
                seq += 1
                next_at += interval
                delay = next_at - time.monotonic()
                if delay < -interval:
                    # Fell behind (a stalled loop): pick up from now rather
                    # than sending a burst to catch up.
                    next_at = time.monotonic()
                    delay = 0
                await asyncio.sleep(max(0.0, delay))
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"[lights] Render loop stopped: {e}")


def palette_for(cfg: lights_config.LightsConfig, cover: tuple[RGB, ...] | None) -> tuple[RGB, ...]:
    """The colours the settings ask for. `cover` is None while the song's
    cover is still being looked at."""
    if cfg.colour_mode == "fixed":
        return (hex_colour(cfg.fixed_colour),)
    cover = cover or (DEFAULT_COLOUR,)
    return cover if cfg.colour_mode == "palette" else cover[:1]


def to_hex(colour: RGB) -> str:
    return "#" + "".join(f"{round(max(0.0, min(1.0, c)) * 255):02x}" for c in colour)


def hex_colour(value: str) -> RGB:
    try:
        n = int(value.lstrip("#"), 16)
    except ValueError:
        return DEFAULT_COLOUR
    return ((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255)


def _fade(current: tuple[RGB, ...], wanted: tuple[RGB, ...], amount: float) -> tuple[RGB, ...]:
    """One step from `current` towards `wanted`, colour by colour; a
    palette of another length is matched up by repeating the old one."""
    return tuple(
        show.blend(current[i % len(current)], colour, amount) for i, colour in enumerate(wanted)
    )


controller = LightController()
