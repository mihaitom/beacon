"""lights/controller.py — when the light show runs, and for what.

The lights follow one playback at a time: whatever this connect casts, or
else the local playback of a device that reports it (a computer or a tablet,
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
import colorsys
import contextlib
import logging
import time
from dataclasses import dataclass

from core import deezer
from core.state import TEST_TONE_TRACK_ID, list_target_pairs

from . import config as lights_config
from . import hue, show
from .analysis import (
    RGB,
    AnalysisCache,
    PictureColours,
    SongLights,
    cover_colours,
    fanart_colours,
)

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
# After a failed song lookup or cover fetch: most likely a hiccup of the
# media server, so worth another go - but not on every tick.
_LOOKUP_RETRY_SECONDS = 15.0
# How long a song's new colour takes to replace the last one's.
_COLOUR_FADE_SECONDS = 1.5
# Heard beats for one full turn of the colour wheel in the "rotate"
# colours: half a minute at 128 BPM, slow enough to read as drifting rather
# than cycling. Counted in beats, not seconds, so it stands still through a
# breakdown and with nothing playing - the lights move only with the music.
ROTATION_BEATS = 64


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
        # Fire-and-forget lookups: the loop only holds a task weakly, so
        # one nobody else holds can be collected half-way.
        self._jobs: set[asyncio.Task] = set()
        self._local: dict[str, LocalReport] = {}
        self._analysis = AnalysisCache()
        self._song_meta: dict[str, tuple[str, str | None]] = {}  # id -> (stream url, cover url)
        self._song_meta_pending: set[str] = set()
        self._lookup_retry: dict[str, float] = {}  # song id -> not before
        self._covers: dict[str, PictureColours] = {}  # song id -> cover colours
        self._cover_art_ids: dict[str, str] = {}  # song id -> the server's cover art id
        # The picture an app's Now Playing shows behind a song instead of
        # its cover (a Fanart.tv artist background), and its colours.
        self._pictures: dict[str, str | None] = {}  # song id -> image url
        self._picture_colours: dict[str, PictureColours | None] = {}  # url -> colours
        self._stream: hue.DtlsStream | None = None
        self._streaming_area: str | None = None
        self._channels: tuple[hue.Channel, ...] = ()
        self._source: Source | None = None
        self._source_at = 0.0
        # The song the lights followed last, for the dialog's cover colours.
        self._last_song_id: str | None = None
        self._last_seen_source = 0.0
        self._retry_after = 0.0
        self._palette: tuple[RGB, ...] = (hex_colour(lights_config.DEFAULT_THEME_COLOUR),)
        # The rotation's position on the wheel (0..1), moved on by the
        # beats heard in the song counted in _heard.
        self._turn = 0.0
        self._heard: tuple[str, int] | None = None
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

    def _spawn(self, job) -> None:
        task = asyncio.create_task(job)
        self._jobs.add(task)
        task.add_done_callback(self._jobs.discard)

    def notify(self) -> None:
        """Something changed (settings, a report) - look again now."""
        if self._wake is not None:
            self._wake.set()

    @property
    def streaming(self) -> bool:
        return self._stream is not None

    @property
    def picture(self) -> dict | None:
        """The picture of the song the lights followed last - which one, and
        its colours (none for a black-and-white one) and the app's accent
        for it (None for the theme's) - once looked at."""
        song_id = self._last_song_id
        if song_id is None:
            return None
        colours = self._palette_of(song_id)
        if colours is None:
            return None
        url = self._pictures.get(song_id)
        artist = bool(url) and self._picture_colours.get(url) is not None
        return {
            "source": "artist" if artist else "cover",
            "url": url if artist else None,
            "cover_art_id": None if artist else self._cover_art_ids.get(song_id),
            "colours": [to_hex(c) for c in colours.palette],
            "accent": to_hex(colours.accent) if colours.accent else None,
        }

    # ── inputs ─────────────────────────────────────────────────────────

    def report_local(self, session_id: str, song_id: str, position: float, playing: bool) -> None:
        self._local[session_id] = LocalReport(
            session_id, song_id, max(0.0, position), playing, time.monotonic()
        )
        self.notify()

    def set_picture(self, song_id: str, url: str | None) -> None:
        """What is in the foreground for `song_id`: an artist picture, or
        None for the cover. The lights take their colours from it."""
        self._pictures[song_id] = url
        _trim(self._pictures)
        if url and url not in self._picture_colours:
            self._picture_colours[url] = None
            _trim(self._picture_colours)
            self._spawn(self._load_picture(url))
        self.notify()

    async def _load_picture(self, url: str) -> None:
        self._picture_colours[url] = await fanart_colours(url)

    def _palette_of(self, song_id: str) -> PictureColours | None:
        """The song's colours: its picture's while one is shown and known,
        else its cover's (None while that is still being looked at)."""
        url = self._pictures.get(song_id)
        picture = self._picture_colours.get(url) if url else None
        return picture if picture is not None else self._covers.get(song_id)

    def preview_song(self, session_id: str, song_id: str) -> tuple[str, SongLights | None]:
        """A song's analysis for the dialog's preview - "ready", "pending"
        (set going now if it was not) or "failed". The same cache as the
        show's, so a song the lights follow is not decoded twice."""
        if self._analysis.has(song_id):
            song = self._analysis.get(song_id)
            return ("ready", song) if song is not None else ("failed", None)
        self._prepare(Source(session_id, song_id, 0.0))
        return "pending", None

    def retry_now(self) -> None:
        """The settings changed - a start that failed under the old ones
        should not hold back one under the new."""
        self._retry_after = 0.0
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

        if self._render_task is not None and self._render_task.done():
            # The render loop gave up (the bridge stopped taking the
            # stream): hand the area back, so the next start is a fresh one
            # rather than the lights staying dark while this says playing.
            await self._stop_stream()

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
        cover_missing = meta is not None and meta[1] is not None and song_id not in self._covers
        if (
            (meta is None or cover_missing)
            and song_id not in self._song_meta_pending
            and time.monotonic() >= self._lookup_retry.get(song_id, 0.0)
        ):
            self._song_meta_pending.add(song_id)
            self._spawn(self._resolve(source))
        if meta is None:
            return
        stream_url, _ = meta
        if stream_url:
            self._analysis.request(song_id, stream_url)

    async def _resolve(self, source: Source) -> None:
        """The song's stream and cover, then the cover's colours. Each is
        kept once known, and only what failed is tried again later: a
        cover that will not load must not hold back the beat."""
        from core.session import registry

        song_id = source.song_id
        failed = False
        try:
            meta = self._song_meta.get(song_id)
            if meta is None:
                session = registry.get(source.session_id)
                if session is None:
                    return
                stream_url, cover_url, cover_art_id = await _look_up(session, song_id)
                meta = (stream_url, cover_url)
                self._song_meta[song_id] = meta
                _trim(self._song_meta)
                if cover_art_id:
                    self._cover_art_ids[song_id] = cover_art_id
                    _trim(self._cover_art_ids)
            colours = await cover_colours(meta[1])
            if colours is None:
                failed = True
            else:
                self._covers[song_id] = colours
                _trim(self._covers)
        except Exception as e:
            logger.info(f"[lights] Could not look up {song_id}: {e}")
            failed = True
        finally:
            self._song_meta_pending.discard(song_id)
        if failed:
            self._lookup_retry[song_id] = time.monotonic() + _LOOKUP_RETRY_SECONDS
            _trim(self._lookup_retry)
        else:
            self._lookup_retry.pop(song_id, None)
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
        position = source.position + (now - self._source_at) + cfg.lead_ms / 1000
        song = self._analysis.get(source.song_id)
        self._turn_with(source.song_id, show.heard_beats_at(song, position))
        wanted = palette_for(cfg, self._palette_of(source.song_id), len(self._channels), self._turn)
        self._palette = _fade(self._palette, wanted, (1 / SEND_HZ) / _COLOUR_FADE_SECONDS)
        return show.frame(position, song, self._palette, self._channels, cfg.style, brightness)

    def _turn_with(self, song_id: str, heard: int | None) -> None:
        """Moves the rotation on by the beats heard since the last frame.
        A new song, or a seek back, starts counting afresh without a jump."""
        if heard is None:
            return
        if self._heard is not None and self._heard[0] == song_id and heard > self._heard[1]:
            self._turn = (self._turn + (heard - self._heard[1]) / ROTATION_BEATS) % 1.0
        self._heard = (song_id, heard)

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
            # _tick() notices the loop is gone and hands the area back.
            self.last_error = str(e)
            self._retry_after = time.monotonic() + _RETRY_SECONDS
            logger.warning(f"[lights] Render loop stopped: {e}")
            self.notify()


async def _look_up(session, song_id: str) -> tuple[str, str | None, str | None]:
    """(stream url, cover url, cover art id) of a song; raises when the
    server fails."""
    if deezer.is_preview_id(song_id):
        return (await deezer.preview_stream_url(song_id) or "", None, None)
    media = session.media
    stream_url = await asyncio.to_thread(media.get_stream_url, song_id)
    track = await asyncio.to_thread(media.get_track, song_id)
    cover_id = track.cover_art_id or None
    cover_url = media.get_cover_art_url(cover_id, internal=True) if cover_id else None
    return (stream_url or "", cover_url, cover_id)


def _trim(cache: dict, keep: int = 32) -> None:
    """Drops the oldest entries past `keep`."""
    while len(cache) > keep:
        cache.pop(next(iter(cache)))


def palette_for(
    cfg: lights_config.LightsConfig,
    picture: PictureColours | None,
    lights: int = 1,
    turn: float = 0.0,
) -> tuple[RGB, ...]:
    """The colours the settings ask for. `picture` is the song's picture's
    (see _palette_of): None while it is still being looked at, an empty
    palette for one without colour - the theme's colour stands in for both. `lights`
    and `turn` (0..1 round the wheel) are for the rotation."""
    theme = hex_colour(cfg.theme_colour)
    if cfg.colour_mode == "theme":
        # The app's accent follows the picture: the colour it takes on Now
        # Playing, which for a grey or dark picture is the theme's own.
        if cfg.theme_follows_picture and picture and picture.accent:
            return (picture.accent,)
        return (theme,)
    if cfg.colour_mode == "fixed":
        return (hex_colour(cfg.fixed_colour),)
    colours = (picture.palette if picture else ()) or (theme,)
    if cfg.colour_mode == "rotate":
        return rotation(colours[0], lights, turn)
    return colours


def rotation(start: RGB, lights: int, turn: float) -> tuple[RGB, ...]:
    """A colour per light, evenly round the wheel from `start`'s hue,
    turned on by `turn` (a whole turn is 1)."""
    first = colorsys.rgb_to_hsv(*start)[0] + turn
    n = max(lights, 1)
    return tuple(colorsys.hsv_to_rgb((first + i / n) % 1.0, 1.0, 1.0) for i in range(n))


def to_hex(colour: RGB) -> str:
    return "#" + "".join(f"{round(max(0.0, min(1.0, c)) * 255):02x}" for c in colour)


def hex_colour(value: str) -> RGB:
    try:
        n = int(value.lstrip("#"), 16)
    except ValueError:
        n = int(lights_config.DEFAULT_THEME_COLOUR.lstrip("#"), 16)
    return ((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255)


def _fade(current: tuple[RGB, ...], wanted: tuple[RGB, ...], amount: float) -> tuple[RGB, ...]:
    """One step from `current` towards `wanted`, colour by colour; a
    palette of another length is matched up by repeating the old one."""
    return tuple(
        show.blend(current[i % len(current)], colour, amount) for i, colour in enumerate(wanted)
    )


controller = LightController()
