"""routes/mix_cast.py — casting with transitions on.

Without transitions a speaker is handed one song at a time, and every song
change is a new dispatch (routes/stream.py's _advance_or_end()). With them
the speaker is handed one stream for the whole run - a mix
(core/mix_engine.py) - and a song change happens inside it, sample-exact,
without the speaker being told anything.

What that changes for the session:

- **The clock counts stream time.** A device reports how long it has been
  playing its stream, which in a mix spans many songs. The clock is
  calibrated against that exactly as for a single song; the timeline
  turns it into the song and position (core/session.py's
  compute_position()).
- **Song changes are followed, not dispatched.** follow() waits for the
  next change on the timeline and moves current_track/queue_index along
  when the listener actually hears it, and marks the end when the mix runs
  out.
- **Anything done by hand is a new mix** (a seek, a skip, picking a song, a
  resume): the speaker holds seconds of the old run, so a change made
  inside it would be heard that much later. That is also what a pause and
  resume do, which keeps a speaker that dropped its connection while
  paused from mattering.

Every handler that existed before keeps its own path unchanged while
session.state.mix is None.
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import replace
from typing import Literal

from pydantic import BaseModel

from core.mix_engine import MixEngine, MixItem
from core.mix_timeline import SAMPLE_RATE
from core.session import SessionState, build_status_dict
from core.state import playable_codecs, plays_continuous_flac, stream_url
from core.streamer import LOOKAHEAD_SECONDS, OutputFormat, resolve_mix_format
from core.transition_planner import Settings
from media.base import Track

logger = logging.getLogger("connect.mix")

# How close to a song change follow() gets before it applies it. Same idea
# as routes/stream.py's _TRACK_END_TOLERANCE: only as large as it takes not
# to spin on sub-millisecond sleeps.
_FOLLOW_TOLERANCE = 0.05
# The longest follow() sleeps in one go, so a resync correcting the clock
# meanwhile is picked up within this long (POSITION_RESYNC_INTERVAL's 8s).
_FOLLOW_MAX_SLEEP = 8.0
# How often follow() looks again while there is no change ahead yet.
_FOLLOW_IDLE_SLEEP = 1.0


class TransitionSettings(BaseModel):
    mode: Literal["off", "gapless", "crossfade"] = "off"
    crossfade_seconds: float = 10.0


class SongHint(BaseModel):
    """What the frontend knows about a song that connect would otherwise
    have to guess: its ReplayGain, and where it sits on its album."""

    gain: float = 1.0
    album_id: str | None = None
    disc: int | None = None
    track: int | None = None
    bpm: float | None = None


def transitions_on(settings: TransitionSettings | None) -> bool:
    return settings is not None and settings.mode != "off"


def planner_settings(settings: TransitionSettings | None) -> Settings:
    if settings is None or settings.mode == "off":
        return Settings("gapless")
    return Settings(settings.mode, settings.crossfade_seconds)


def mix_item(session: SessionState, track: Track, queue_index: int, gain: float) -> MixItem:
    hint = session.state.song_hints.get(track.id, {})
    return MixItem(
        song_id=track.id,
        queue_index=queue_index,
        gain=hint.get("gain", gain),
        duration=float(track.duration or 0),
        album_id=hint.get("album_id"),
        disc=hint.get("disc"),
        track=hint.get("track"),
        bpm=hint.get("bpm"),
        payload=track,
    )


def locate(queue: list[str], item: MixItem) -> int | None:
    """Where `item` sits in `queue` now. Its own index if the queue still
    has it there; otherwise the nearest place it appears, since a song
    queued twice is two different places and the closer one is the one
    playing."""
    i = item.queue_index
    if i is not None and 0 <= i < len(queue) and queue[i] == item.song_id:
        return i
    places = [j for j, song_id in enumerate(queue) if song_id == item.song_id]
    if not places:
        return None
    return min(places, key=lambda j: abs(j - (i or 0)))


async def next_item(session: SessionState, current: MixItem) -> MixItem | None:
    """The song after `current`, by the session's queue as it is now."""
    from .stream import _maybe_autoplay_topup, _resolve_track

    st = session.state
    if st.repeat_mode == "one":
        return current
    here = locate(st.queue, current)
    following = (here if here is not None else st.queue_index) + 1
    if following >= len(st.queue) and st.repeat_mode == "all" and st.queue:
        following = 0
    if following >= len(st.queue):
        await _maybe_autoplay_topup(session)
    if following >= len(st.queue):
        return None
    track = await _resolve_track(session, st.queue[following], "Mix")
    if track is None:
        return None
    return mix_item(session, track, following, st.current_track_gain)


async def _source_url(session: SessionState, item: MixItem) -> str:
    return await asyncio.to_thread(session.media.get_stream_url, item.song_id)


def new_mix(session: SessionState, first: MixItem, position: float) -> MixEngine:
    async def url_fn(item: MixItem) -> str | None:
        return await _source_url(session, item)

    async def next_fn(current: MixItem) -> MixItem | None:
        return await next_item(session, current)

    return MixEngine(
        first,
        position,
        url_fn,
        next_fn,
        lead_seconds=LOOKAHEAD_SECONDS,
        settings=planner_settings(session.state.transitions),
    )


def mix_output_format(session: SessionState, target, source: OutputFormat | None) -> OutputFormat:
    st = session.state
    return resolve_mix_format(
        source,
        device_codecs=playable_codecs(target),
        max_lossy_format=st.max_lossy_format,
        max_lossy_bitrate_kbps=st.max_lossy_bitrate_kbps,
        continuous_flac=plays_continuous_flac(target),
    )


async def mix_audio(mix: MixEngine, start_time: float, fmt: OutputFormat) -> AsyncIterator[bytes]:
    """One device's stream of the mix from `start_time` on - what
    routes/stream.py's audio_stream() serves instead of a single song."""
    connection = await mix.connect(start_time, fmt.ffmpeg_args)
    try:
        async for chunk in connection.chunks():
            yield chunk
    finally:
        connection.close()


# ── Following the mix ──────────────────────────────────────────────────────


async def follow(session: SessionState, mix: MixEngine) -> None:
    """Moves the session along with the mix: the song the device starts
    playing becomes current_track when it is heard, and the mix's end ends
    playback. Runs for as long as `mix` is the session's mix."""
    st = session.state
    applied = 0
    while st.mix is mix and not mix.stopped:
        change = mix.timeline.next_change(applied)
        if change is None or st.clock.is_paused or not st.is_streaming:
            await asyncio.sleep(_FOLLOW_IDLE_SLEEP)
            continue
        remaining = st.clock.seconds_until(change.stream_time)
        if remaining > _FOLLOW_TOLERANCE:
            await asyncio.sleep(min(remaining, _FOLLOW_MAX_SLEEP))
            continue
        async with session.play_lock:
            if st.mix is not mix:
                return
            applied = change.frame
            if change.song_id is None:
                logger.info("[mix] The mix ran out — marking playback complete")
                st.is_streaming = False
                st.track_ended = True
                await session.event_bus.broadcast(build_status_dict(session))
                return
            item: MixItem = change.payload
            st.current_track = item.payload
            st.current_track_gain = item.gain
            index = locate(st.queue, item)
            if index is not None:
                st.queue_index = index
            track = item.payload
            logger.info(f"[mix] Now playing {track.artist} — {track.title}")
            await session.event_bus.broadcast(build_status_dict(session))


def heard_item(session: SessionState, stream_time: float) -> tuple[MixItem, float] | None:
    """The song and position at `stream_time` of the running mix, or None
    when there is none (the mix has ended there, or there is no mix)."""
    mix = session.state.mix
    if mix is None:
        return None
    heard = mix.timeline.at(round(max(stream_time, 0.0) * SAMPLE_RATE))
    if heard is None or heard.song_id is None:
        return None
    return heard.entry.payload, heard.position


# ── Starting a run ─────────────────────────────────────────────────────────


async def restart(session: SessionState, item: MixItem, position: float) -> dict | None:
    """A new mix from `item` at `position`, dispatched to the session's
    devices - what a seek, a skip or a resume is with transitions on.
    Returns an error body if the device refused, None when it plays.

    Must be called holding session.play_lock."""
    from delivery.errors import delivery_error_response

    from .playback import _apply_position_offset, _resync_position_periodically

    st = session.state
    target = st.active_delivery
    old = st.mix
    mix = new_mix(session, item, position)
    fmt = mix_output_format(session, target, st.current_output_format)
    st.mix = mix
    st.current_track = item.payload
    st.current_track_gain = item.gain
    index = locate(st.queue, item)
    if index is not None:
        st.queue_index = index
    st.current_output_format = fmt
    st.is_streaming = True
    st.track_ended = False
    st.clock.start(0.0)
    mix.start()
    if old is not None:
        old.stop()
    if target is not None:
        track: Track = item.payload
        try:
            await target.play(*dispatch_args(session, track, fmt))
        except Exception as e:
            logger.exception("[mix] Delivery error")
            return delivery_error_response(e, target)
        asyncio.create_task(_apply_position_offset(session, target, st.clock.play_generation))
        asyncio.create_task(
            _resync_position_periodically(session, target, st.clock.play_generation)
        )
    asyncio.create_task(follow(session, mix))
    logger.info(f"[mix] ▶ {item.song_id} from {position:.1f}s")
    await session.event_bus.broadcast(build_status_dict(session))
    return None


def dispatch_args(
    session: SessionState, track: Track, fmt: OutputFormat
) -> tuple[str, str, str, str | None, float | None, str, str]:
    """What target.play() is handed for a mix. The title is the first
    song's; the length is unknown (None), since the stream goes on."""
    return (
        stream_url(session.session_id, fmt.content_type),
        track.title,
        track.artist,
        session.media.get_cover_art_url(track.cover_art_id, internal=True),
        None,
        track.album,
        fmt.content_type,
    )


async def resume(session: SessionState) -> dict:
    """/resume with transitions on: a new mix from where the pause was."""
    st = session.state
    at = heard_item(session, st.clock.resume_offset)
    if at is None:
        return {"paused": False}
    item, position = at
    error = await restart(session, item, position)
    return error or {"paused": False}


async def seek(session: SessionState, position: float) -> dict:
    """/seek with transitions on: a new mix from the same song, elsewhere."""
    st = session.state
    at = heard_item(
        session, st.clock.elapsed() if not st.clock.is_paused else st.clock.resume_offset
    )
    if at is None:
        return {"position": position}
    item, _ = at
    position = max(0.0, min(position, item.duration or position))
    if st.clock.is_paused:
        # Paused stays paused: the new run starts with the next /resume.
        mix = new_mix(session, item, position)
        old, st.mix = st.mix, mix
        if old is not None:
            old.stop()
        st.clock.start(0.0)
        st.clock.pause(0.0)
        await session.event_bus.broadcast(build_status_dict(session))
        return {"position": position}
    error = await restart(session, item, position)
    return error or {"position": position}


async def skip_to(session: SessionState, queue_index: int) -> bool:
    """A party skip vote with transitions on: a new mix from that song."""
    from .stream import _resolve_track

    st = session.state
    track = await _resolve_track(session, st.queue[queue_index], "Party skip")
    if track is None:
        return False
    item = replace(mix_item(session, track, queue_index, st.current_track_gain))
    return await restart(session, item, 0.0) is None


def queue_changed(session: SessionState) -> None:
    if session.state.mix is not None:
        session.state.mix.queue_changed()
