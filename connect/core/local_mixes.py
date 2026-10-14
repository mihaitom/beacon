"""core/local_mixes.py — the mixes playing in Beacon's own players.

With transitions on, a browser tab plays a mix (core/mix_engine.py) the way
a speaker does: one continuous stream through song after song. A session
is a login, not a device - a phone and a desktop on the same account share
one - so each tab's mix is keyed by a player id of its own as well.

Unlike a cast, the queue lives in the tab: it sends the songs coming up
(`songs`, in play order from the current one) and keeps them current, and
the mix takes its next song from that list. A tab that stops asking about
its mix - closed, gone to sleep - has it stopped after a while.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from .mix_engine import MixEngine, MixItem, song_label
from .mix_hls import MixHls
from .transition_planner import Settings

logger = logging.getLogger("connect.mix")

# How long a mix nobody listens to or asks about is kept. Long enough to
# ride out a tab reloading or a phone switching networks; a paused one gets
# far longer, since somebody may well come back to it.
ORPHAN_SECONDS = 90.0
PAUSED_ORPHAN_SECONDS = 1800.0
_REAP_INTERVAL_SECONDS = 15.0


@dataclass
class SongEntry:
    """A song as the tab describes it - see routes/local_mix.py's MixSong."""

    id: str
    queue_index: int
    gain: float = 1.0
    duration: float = 0.0
    album_id: str | None = None
    disc: int | None = None
    track: int | None = None
    bpm: float | None = None
    artist: str | None = None
    title: str | None = None

    def item(self) -> MixItem:
        return MixItem(
            song_id=self.id,
            queue_index=self.queue_index,
            gain=self.gain,
            duration=self.duration,
            album_id=self.album_id,
            disc=self.disc,
            track=self.track,
            bpm=self.bpm,
            label=song_label(self.artist, self.title),
        )


@dataclass
class LocalMix:
    session_id: str
    player: str
    engine: MixEngine
    songs: list[SongEntry]
    repeat_mode: str = "off"
    touched: float = field(default_factory=time.monotonic)
    # The run as HLS, for a WebKit tab (core/mix_hls.py).
    hls: MixHls | None = None
    # A preview of excerpts (core/preview.py): its list is fixed, and the
    # tab's queue has nothing to say about it.
    preview: bool = False

    def touch(self) -> None:
        self.touched = time.monotonic()

    def hls_for(self, fmt: str, codec_args: list[str]) -> MixHls:
        """The run's HLS encode in this quality, replacing one in another -
        the tab switched quality."""
        current = self.hls
        if (
            current is None
            or current.closed
            or (current.fmt, current.codec_args) != (fmt, codec_args)
        ):
            if current is not None:
                current.close()
            self.hls = MixHls(self.engine, fmt, codec_args)
            self.hls.start()
        return self.hls

    def close(self) -> None:
        if self.hls is not None:
            self.hls.close()
            self.hls = None
        self.engine.stop()

    def next_item(self, current: MixItem) -> MixItem | None:
        """The song after `current` in the tab's list. The list starts at
        whatever the tab was hearing when it sent it, which the mix may
        already be past - so `current` is looked up, not assumed first."""
        if self.repeat_mode == "one":
            return current
        here = self._locate(current)
        if here is None or here + 1 >= len(self.songs):
            return None
        return self.songs[here + 1].item()

    def _locate(self, current: MixItem) -> int | None:
        """Where `current` is in the list. A queue edit before it (a removal,
        shuffle, a drag) moves its queue_index while its deck still has the
        old one, so failing an exact match, the nearest place with the same
        song is it - as mix_cast.locate() does for a cast."""
        places = [i for i, song in enumerate(self.songs) if song.id == current.song_id]
        for i in places:
            if self.songs[i].queue_index == current.queue_index:
                return i
        if not places:
            return None
        was = current.queue_index or 0
        return min(places, key=lambda i: abs(self.songs[i].queue_index - was))


_mixes: dict[tuple[str, str], LocalMix] = {}
_reaper: asyncio.Task | None = None


def get(session_id: str, player: str) -> LocalMix | None:
    """This tab's mix - None, and stopped, if its HLS encode failed: the
    run is unplayable then, and gone is what makes the tab start it over."""
    mix = _mixes.get((session_id, player))
    if mix is not None and mix.hls is not None and mix.hls.failed:
        logger.warning(f"[mix] HLS encode for player {player} failed — stopping its mix")
        stop(session_id, player)
        return None
    return mix


def start(
    session_id: str,
    player: str,
    songs: list[SongEntry],
    index: int,
    position: float,
    repeat_mode: str,
    url_fn: Callable[[MixItem], Awaitable[str | None]],
    lead_seconds: float,
    settings: Settings | None = None,
    paused: bool = False,
) -> LocalMix:
    """A new mix for this tab from songs[index] at `position`, replacing
    whatever it had - frozen from the start if `paused`, for a tab that
    loads it without playing."""
    stop(session_id, player)
    holder: list[LocalMix] = []

    async def next_fn(current: MixItem) -> MixItem | None:
        return holder[0].next_item(current) if holder else None

    engine = MixEngine(
        songs[index].item(),
        position,
        url_fn,
        next_fn,
        lead_seconds=lead_seconds,
        settings=settings,
    )
    if paused:
        engine.freeze()
    mix = LocalMix(session_id, player, engine, songs[index:], repeat_mode)
    holder.append(mix)
    return _install(mix)


def start_preview(
    session_id: str,
    player: str,
    first: MixItem,
    next_fn: Callable[[MixItem], Awaitable[MixItem | None]],
    url_fn: Callable[[MixItem], Awaitable[str | None]],
    lead_seconds: float,
    settings: Settings,
) -> LocalMix:
    """A preview for this tab from the excerpt `first` on, the rest from
    `next_fn` - replacing whatever it had, a mix included."""
    stop(session_id, player)
    engine = MixEngine(
        first, first.start, url_fn, next_fn, lead_seconds=lead_seconds, settings=settings
    )
    return _install(LocalMix(session_id, player, engine, [], preview=True))


def _install(mix: LocalMix) -> LocalMix:
    _mixes[(mix.session_id, mix.player)] = mix
    mix.engine.start()
    _ensure_reaper()
    return mix


def stop(session_id: str, player: str) -> None:
    mix = _mixes.pop((session_id, player), None)
    if mix is not None:
        mix.close()


def stop_session(session_id: str) -> None:
    for key in [k for k in _mixes if k[0] == session_id]:
        stop(*key)


def stop_all() -> None:
    for key in list(_mixes):
        stop(*key)


def reap_once(now: float | None = None) -> list[tuple[str, str]]:
    now = time.monotonic() if now is None else now
    reaped = []
    for key, mix in list(_mixes.items()):
        if mix.engine.listeners > 0:
            mix.touch()
            continue
        limit = PAUSED_ORPHAN_SECONDS if mix.engine.paused else ORPHAN_SECONDS
        if mix.engine.stopped or now - mix.touched > limit:
            logger.info(f"[mix] Local mix for player {key[1]} unused for a while — stopping it")
            stop(*key)
            reaped.append(key)
    return reaped


def _ensure_reaper() -> None:
    global _reaper
    if _reaper is not None and not _reaper.done():
        return

    async def run() -> None:
        while _mixes:
            await asyncio.sleep(_REAP_INTERVAL_SECONDS)
            reap_once()

    _reaper = asyncio.create_task(run())
