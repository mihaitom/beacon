"""routes/local_mix.py — transitions for Beacon's own player.

With transitions on, a tab does not fetch songs one by one: it starts a mix
here (core/local_mixes.py) and plays its stream as one long source, the way
a speaker does with a cast. What the tab needs on top of the audio is the
timeline (which song plays at which stream time, core/mix_timeline.py), so
it can show the song it is hearing; it asks for that alongside.

- POST   /stream/local/mix/{player}          start, or start over (a seek,
                                             a skip, picking a song)
- POST   /stream/local/preview/{player}      start a preview of excerpts
                                             instead (core/preview.py) -
                                             the rest below serves it too
- PUT    /stream/local/mix/{player}/queue    the songs coming up changed
- POST   /stream/local/mix/{player}/pause    / resume
- GET    /stream/local/mix/{player}/timeline
- GET    /stream/local/mix/{player}/audio    the stream, from any stream
                                             time still held
- GET    /stream/local/mix/{player}/hls/...  the same as a live HLS playlist,
                                             for WebKit (core/mix_hls.py)
- DELETE /stream/local/mix/{player}

`epoch` names one run of a mix. Every start makes a new one, and an audio
or timeline request for an old one is answered 410, so an element still
reconnecting to a run that was replaced cannot play it.
"""

import asyncio
import logging
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from core import hls, local_mixes, preview
from core.auth import require_token
from core.local_mixes import SongEntry
from core.mix_engine import MixItem
from core.session import SessionState, require_authenticated_session
from core.streamer import (
    OutputFormat,
    lossless_codec_args,
    lossless_encode_args,
    lossy_codec_args,
    lossy_encode_args,
)

from .local_stream import ALLOWED_BITRATES, LOSSLESS_FORMAT
from .mix_cast import TransitionSettings, mix_audio, planner_settings

logger = logging.getLogger("connect.mix")
router = APIRouter(dependencies=[Depends(require_token)])

# Rendered ahead of the listener: a browser buffers whatever it is handed,
# and this is the head start that rides out a phone's network changing.
LOCAL_LEAD_SECONDS = 20.0

_PLAYER_RE = re.compile(r"^[A-Za-z0-9_-]{6,40}$")
_HLS_SEGMENT_RE = re.compile(r"^(\d+)\.(m4s|mp3)$")
# How long a playlist request waits for the run's first segment: the mix
# renders its head start within a second or two once the first song's
# decoder delivers, and an empty playlist is no use to the player.
_HLS_FIRST_SEGMENT_TIMEOUT = 15.0


class MixSong(BaseModel):
    id: str
    queue_index: int
    gain: float = 1.0
    duration: float = 0.0
    album_id: str | None = None
    disc: int | None = None
    track: int | None = None
    bpm: float | None = None
    # For the log only.
    artist: str | None = None
    title: str | None = None


class MixStart(BaseModel):
    # The songs from the current one on, in the order they are to play -
    # the tab works out repeat-all's wrap itself.
    songs: list[MixSong]
    position: float = 0.0
    repeat_mode: Literal["off", "all", "one"] = "off"
    transitions: TransitionSettings


class PreviewStart(BaseModel):
    # The songs to preview, in the order they play; each one's queue_index
    # is its place in this list.
    songs: list[MixSong]
    index: int = 0


class MixQueue(BaseModel):
    songs: list[MixSong]
    repeat_mode: Literal["off", "all", "one"] = "off"


def _entries(songs: list[MixSong]) -> list[SongEntry]:
    return [SongEntry(**song.model_dump()) for song in songs]


def _player(player: str) -> str:
    if not _PLAYER_RE.match(player):
        raise HTTPException(status_code=400, detail="Invalid player id")
    return player


def _mix(session: SessionState, player: str, epoch: str | None = None) -> local_mixes.LocalMix:
    mix = local_mixes.get(session.session_id, _player(player))
    if mix is None or (epoch is not None and mix.engine.epoch != epoch):
        raise HTTPException(status_code=410, detail="No such mix")
    return mix


def _describe(mix: local_mixes.LocalMix) -> dict:
    engine = mix.engine
    return {
        "epoch": engine.epoch,
        "timeline": engine.timeline.to_json(),
        "end": engine.end_stream_time,
        "rendered": engine.rendered_time,
        # The rest of "is the next song settled" is in the timeline, read
        # against where the tab is listening - which only the tab knows.
        "next_committed": engine.next_committed,
        "transitions": engine.transitions(),
    }


@router.post("/stream/local/mix/{player}")
async def start_mix(
    player: str, req: MixStart, session: SessionState = Depends(require_authenticated_session)
):
    if not req.songs:
        raise HTTPException(status_code=400, detail="No songs")

    async def url_fn(item: MixItem) -> str | None:
        return await asyncio.to_thread(session.media.get_stream_url, item.song_id)

    first = req.songs[0]
    position = max(0.0, min(req.position, first.duration or req.position))
    mix = local_mixes.start(
        session.session_id,
        _player(player),
        _entries(req.songs),
        0,
        position,
        req.repeat_mode,
        url_fn,
        LOCAL_LEAD_SECONDS,
        planner_settings(req.transitions),
    )
    logger.info(f"[mix] ▶ {mix.engine.first.name} from {position:.1f}s (this device)")
    return _describe(mix)


@router.post("/stream/local/preview/{player}")
async def start_preview(
    player: str, req: PreviewStart, session: SessionState = Depends(require_authenticated_session)
):
    player = _player(player)
    if not 0 <= req.index < len(req.songs):
        raise HTTPException(status_code=400, detail="No such song")

    async def url_fn(item: MixItem) -> str | None:
        return await asyncio.to_thread(session.media.get_stream_url, item.song_id)

    songs = preview.PreviewSongs(_entries(req.songs), url_fn)
    first = await songs.item(req.index)
    assert first is not None
    mix = local_mixes.start_preview(
        session.session_id,
        player,
        first,
        songs.next_item,
        url_fn,
        LOCAL_LEAD_SECONDS,
        preview.SETTINGS,
    )
    logger.info(f"[mix] ▶ Preview from {first.name} at {first.start:.1f}s (this device)")
    return _describe(mix)


@router.put("/stream/local/mix/{player}/queue")
async def update_mix_queue(
    player: str, req: MixQueue, session: SessionState = Depends(require_authenticated_session)
):
    mix = _mix(session, player)
    if mix.preview:
        return {"status": "ok"}
    mix.songs = _entries(req.songs)
    mix.repeat_mode = req.repeat_mode
    mix.engine.queue_changed()
    mix.touch()
    return {"status": "ok"}


@router.post("/stream/local/mix/{player}/pause")
async def pause_mix(player: str, session: SessionState = Depends(require_authenticated_session)):
    mix = _mix(session, player)
    mix.engine.freeze()
    mix.touch()
    return {"paused": True}


@router.post("/stream/local/mix/{player}/resume")
async def resume_mix(player: str, session: SessionState = Depends(require_authenticated_session)):
    mix = _mix(session, player)
    mix.engine.unfreeze()
    mix.touch()
    return {"paused": False}


@router.delete("/stream/local/mix/{player}")
async def stop_mix(player: str, session: SessionState = Depends(require_authenticated_session)):
    local_mixes.stop(session.session_id, _player(player))
    return {"status": "stopped"}


@router.get("/stream/local/mix/{player}/timeline")
async def mix_timeline(
    player: str,
    epoch: str = Query(...),
    session: SessionState = Depends(require_authenticated_session),
):
    mix = _mix(session, player, epoch)
    mix.touch()
    return _describe(mix)


def output_args(fmt: str, br: int | None) -> tuple[list[str], str]:
    """The encode a tab asked for, held to what /stream/local/{id} allows."""
    if fmt == LOSSLESS_FORMAT:
        if br is not None:
            raise HTTPException(status_code=400, detail="flac takes no bitrate")
        return lossless_encode_args()
    if fmt not in ALLOWED_BITRATES or br not in ALLOWED_BITRATES[fmt]:
        raise HTTPException(status_code=400, detail="Unsupported format or bitrate")
    args, content_type = lossy_encode_args(fmt, br)
    if fmt == "mp3":
        # See core/streamer.py's resolve_mix_format().
        args = [*args, "-write_xing", "0", "-id3v2_version", "0"]
    return args, content_type


@router.get("/stream/local/mix/{player}/audio")
async def mix_stream(
    player: str,
    epoch: str = Query(...),
    start: float = Query(0.0, ge=0.0, alias="from"),
    fmt: str = Query(...),
    br: int | None = Query(None),
    session: SessionState = Depends(require_authenticated_session),
):
    try:
        mix = _mix(session, player, epoch)
    except HTTPException as e:
        # A plain status the element reports as an unplayable source rather
        # than retrying: this run of the mix is over.
        return JSONResponse({"detail": e.detail}, status_code=e.status_code)
    args, content_type = output_args(fmt, br)
    mix.touch()
    fmt_label = fmt if br is None else f"{fmt} {br}k"
    logger.info(f"[mix] Local player {player} reading from {start:.1f}s as {fmt_label}")
    audio = mix_audio(mix.engine, start, OutputFormat(ffmpeg_args=args, content_type=content_type))
    return StreamingResponse(
        audio,
        media_type=content_type,
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _codec_args(fmt: str, br: int | None) -> list[str]:
    """output_args() without the container, which HLS supplies."""
    output_args(fmt, br)  # the same checks
    if fmt == LOSSLESS_FORMAT:
        return lossless_codec_args()
    assert br is not None
    return lossy_codec_args(fmt, br)


def _mix_hls(session: SessionState, player: str, epoch: str, fmt: str, br: int | None):
    mix = _mix(session, player, epoch)
    mix.touch()
    return mix.hls_for(fmt, _codec_args(fmt, br))


def _gone(e: HTTPException) -> JSONResponse:
    return JSONResponse({"detail": e.detail}, status_code=e.status_code)


@router.get("/stream/local/mix/{player}/hls/index.m3u8")
async def mix_hls_playlist(
    player: str,
    request: Request,
    epoch: str = Query(...),
    fmt: str = Query(...),
    br: int | None = Query(None),
    session: SessionState = Depends(require_authenticated_session),
):
    try:
        stream = _mix_hls(session, player, epoch, fmt, br)
    except HTTPException as e:
        return _gone(e)
    await stream.wait_for_segments(1, _HLS_FIRST_SEGMENT_TIMEOUT)
    return Response(
        stream.playlist(request.url.query),
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/stream/local/mix/{player}/hls/init.mp4")
async def mix_hls_init(
    player: str,
    epoch: str = Query(...),
    fmt: str = Query(...),
    br: int | None = Query(None),
    session: SessionState = Depends(require_authenticated_session),
):
    try:
        stream = _mix_hls(session, player, epoch, fmt, br)
    except HTTPException as e:
        return _gone(e)
    init = None if stream.packed else await stream.init_segment()
    if init is None:
        return JSONResponse({"error": "No init segment"}, status_code=404)
    return Response(init, media_type="audio/mp4", headers={"Cache-Control": "no-store"})


@router.get("/stream/local/mix/{player}/hls/{segment}")
async def mix_hls_segment(
    player: str,
    segment: str,
    epoch: str = Query(...),
    fmt: str = Query(...),
    br: int | None = Query(None),
    session: SessionState = Depends(require_authenticated_session),
):
    match = _HLS_SEGMENT_RE.match(segment)
    if match is None:
        return JSONResponse({"error": f"Unknown segment '{segment}'"}, status_code=404)
    try:
        stream = _mix_hls(session, player, epoch, fmt, br)
    except HTTPException as e:
        return _gone(e)
    if match.group(2) != hls.segment_extension(stream.packed):
        return JSONResponse({"error": f"Unknown segment '{segment}'"}, status_code=404)
    body = await stream.segment(int(match.group(1)))
    if body is None:
        return JSONResponse({"error": f"Segment {segment} was not produced"}, status_code=404)
    return Response(
        body,
        media_type="audio/mpeg" if stream.packed else "audio/mp4",
        headers={"Cache-Control": "no-store"},
    )
