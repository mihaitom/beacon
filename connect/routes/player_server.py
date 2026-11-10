"""routes/player_server.py - /device-link/v1/player on a server.

A server steers only casts: a browser tab is somebody sitting in front of
it. The player is the account's cast that can be heard, else the paused one,
else the newest (core/now_playing.py's audible_cast()), and commands act on
its session directly, whether or not the tab that started it is still open.
A tab that is open follows through its status, as it does after a reload.
"""

import asyncio
import logging
import random
import secrets
import time
from collections import OrderedDict
from types import SimpleNamespace

from fastapi import HTTPException, Response

from core import app_library, now_playing
from core.cast_permissions import may_cast
from core.claims import claims
from core.device_keys import LIBRARY, KeyOwner
from core.session import SessionState, compute_position, registry
from core.state import ctx, list_target_pairs
from delivery import credentials
from routes import playback, stream
from routes.coverart import cover_image
from routes.devices import stop_device
from routes.discovery import discover_all
from routes.join import JoinRequest, join_stream
from routes.player_commands import LIBRARY_COMMANDS, needs
from routes.radio import radio_favicon
from routes.volume import VolumeRequest, record_volume, set_device_volume

logger = logging.getLogger("connect.player_server")

# Same as the window's previous button (stores/playback.ts): further in than
# this, previous starts the song again.
_RESTART_THRESHOLD_SECONDS = 5.0

_SONG_COMMANDS = (
    "play",
    "pause",
    "next",
    "previous",
    "seek",
    "volume",
    "shuffle",
    "repeat",
    "autoplay",
    "queue_jump",
    "devices",
)
_RADIO_COMMANDS = ("play", "pause", "volume", "devices")

# The session's queue is ids only. Titles are looked up around the current
# song and kept, so a long queue costs a few lookups and not one per poll.
_TITLES_KEPT = 2000
_FILL_BEHIND = 10
_FILL_AHEAD = 50
_titles: OrderedDict[tuple[str, str], dict] = OrderedDict()
_filling: set[str] = set()

# The window's Song Radio asks for as many.
_SONG_RADIO_LENGTH = 100

# key id -> the session of the casts that key started itself.
_key_sessions: dict[str, str] = {}


def _remember(server: str, song: dict) -> None:
    _titles[(server, song["id"])] = song
    _titles.move_to_end((server, song["id"]))
    while len(_titles) > _TITLES_KEPT:
        _titles.popitem(last=False)


def _track_fields(track) -> dict:
    return {
        "id": track.id,
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "duration": track.duration,
        "cover_art_id": track.cover_art_id,
    }


async def _fill_titles(session: SessionState, ids: list[str]) -> None:
    server = session.account_server_url
    try:
        for song_id in ids:
            try:
                track = await asyncio.to_thread(session.media.get_track, song_id)
            except Exception as e:
                logger.debug(f"[player] No title for {song_id}: {e}")
                continue
            _remember(server, _track_fields(track))
    finally:
        _filling.discard(session.session_id)


def _queue(session: SessionState) -> list[dict]:
    st = session.state
    server = session.account_server_url
    if st.current_track is not None:
        _remember(server, _track_fields(st.current_track))
    near = st.queue[max(0, st.queue_index - _FILL_BEHIND) : st.queue_index + _FILL_AHEAD]
    missing = [song_id for song_id in near if (server, song_id) not in _titles]
    if missing and session.session_id not in _filling:
        _filling.add(session.session_id)
        asyncio.get_running_loop().create_task(_fill_titles(session, missing))
    return [
        _titles.get((server, song_id))
        or {
            "id": song_id,
            "title": None,
            "artist": None,
            "album": None,
            "duration": None,
            "cover_art_id": None,
        }
        for song_id in st.queue
    ]


def _volume(session: SessionState) -> float | None:
    """What the speaker last said, with exactly one. Never asked here: this
    runs once a second for every open event stream."""
    targets = list_target_pairs(session.state.active_delivery)
    if len(targets) != 1:
        return None
    volume, _ = session.state.device_volumes.get(f"{targets[0][0]}:{targets[0][1]}", (None, None))
    return None if volume is None else volume / 100


def _idle(owner: KeyOwner, now: float) -> dict:
    return {
        "available": True,
        "state": "idle",
        "source": None,
        "song": None,
        "radio": None,
        "position": None,
        "at": round(now, 3),
        "volume": None,
        "shuffle": None,
        "repeat": None,
        "autoplay": None,
        "queue": [],
        "queue_index": None,
        "devices": [],
        "interrupted": False,
        "party": None,
        "commands": list(LIBRARY_COMMANDS) if LIBRARY in owner.scopes else [],
    }


def state(owner: KeyOwner, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    session = now_playing.audible_cast(owner.account)
    if session is None:
        return _idle(owner, now)
    st = session.state
    track = st.current_track
    library = list(LIBRARY_COMMANDS) if LIBRARY in owner.scopes else []
    return {
        "available": True,
        "state": "paused" if st.clock.is_paused else "playing",
        "source": "cast",
        "song": _track_fields(track) if track is not None else None,
        "radio": None
        if track is not None
        else {"station": st.radio_info["title"], "title": session.radio_title},
        "position": None if track is None else round(compute_position(session), 3),
        "at": round(now, 3),
        "volume": _volume(session),
        "shuffle": st.shuffle if track is not None else None,
        "repeat": st.repeat_mode if track is not None else None,
        "autoplay": st.autoplay_enabled if track is not None else None,
        "queue": _queue(session) if track is not None else [],
        "queue_index": st.queue_index if track is not None else None,
        "devices": [
            {"type": kind, "name": name} for kind, name in list_target_pairs(st.active_delivery)
        ],
        "interrupted": False,
        "party": None,
        "commands": [*(_SONG_COMMANDS if track is not None else _RADIO_COMMANDS), *library],
    }


def _cast(owner: KeyOwner, kind: str) -> SessionState:
    session = now_playing.audible_cast(owner.account)
    if session is None:
        raise HTTPException(status_code=409, detail="nothing_playing")
    allowed = _SONG_COMMANDS if session.state.current_track is not None else _RADIO_COMMANDS
    if kind not in allowed:
        raise HTTPException(status_code=409, detail="not_available")
    return session


def _failed(answer) -> None:
    """The playback handlers answer a failure with an `error` body, as the
    window expects, rather than raising."""
    if isinstance(answer, dict) and answer.get("error"):
        raise HTTPException(status_code=502, detail=str(answer["error"]))


async def _edit_queue(session: SessionState, **changes) -> None:
    """Through /queue, so a mix hears about it and a window adopts it."""
    st = session.state
    request = playback.QueueRequest(
        song_ids=changes.get("song_ids", st.queue),
        queue_index=changes.get("queue_index", st.queue_index),
        original_queue=changes.get("original_queue", st.original_queue),
        shuffle=changes.get("shuffle", st.shuffle),
        repeat_mode=changes.get("repeat_mode", st.repeat_mode),
        autoplay_enabled=changes.get("autoplay_enabled", st.autoplay_enabled),
        autoplay_batch_size=st.autoplay_batch_size,
        # Ahead of anything a window sent before: see stream.jump_to().
        seq=max(session.play_seq + 1, int(time.time() * 1000)),
    )
    await playback.update_queue(request, session)


def shuffled(queue: list[str], original: list[str], index: int, on: bool, keep_next: bool):
    """The queue and index after shuffle is switched, as the window does it
    (stores/playback.ts's toggleShuffle): the song playing stays where the
    listener is, and with a mix the song it has already lined up stays next."""
    if not queue:
        return queue, index
    current = queue[index]
    locked = queue[index + 1] if keep_next and index + 1 < len(queue) else None
    base = original or queue
    if on:
        rest = [song_id for song_id in base if song_id != current]
        random.shuffle(rest)
        result, at = [current, *rest], 0
    else:
        result = list(base)
        at = result.index(current) if current in result else 0
    if locked is not None and locked in result:
        result.remove(locked)
        at = result.index(current)
        result.insert(at + 1, locked)
    return result, at


async def command(owner: KeyOwner, cmd, library=None) -> None:
    """`library` is the media client of the key's own login, for the
    commands that need the library right."""
    if cmd.type in LIBRARY_COMMANDS or cmd.type == "devices":
        await _start(owner, cmd, library)
        return
    session = _cast(owner, cmd.type)
    st = session.state
    kind = cmd.type
    if kind == "play":
        if st.clock.is_paused:
            _failed(await playback.resume_playback(session=session))
    elif kind == "pause":
        if not st.clock.is_paused:
            _failed(await playback.pause_session(session, "device-link app"))
    elif kind == "seek":
        position = needs(cmd, "position")
        _failed(await playback.seek_playback(playback.SeekRequest(position=position), session))
    elif kind == "next":
        if not await stream.advance_now(session):
            raise HTTPException(status_code=409, detail="nothing_next")
    elif kind == "previous":
        back = st.queue_index - 1
        if compute_position(session) > _RESTART_THRESHOLD_SECONDS or back < 0:
            _failed(await playback.seek_playback(playback.SeekRequest(position=0), session))
        elif not await stream.jump_to(session, back, "App previous"):
            raise HTTPException(status_code=409, detail="nothing_before")
    elif kind == "queue_jump":
        if not await stream.jump_to(session, needs(cmd, "index"), "App queue jump"):
            raise HTTPException(status_code=409, detail="no_such_entry")
    elif kind == "volume":
        level = round(needs(cmd, "volume") * 100)
        for device_type, name in list_target_pairs(st.active_delivery):
            answer = await set_device_volume(
                device_type, name, VolumeRequest(volume=level), session
            )
            _failed(answer)
            record_volume(session, device_type, name, level, None)
    elif kind == "shuffle":
        on = needs(cmd, "on")
        if on != st.shuffle:
            queue, index = shuffled(
                st.queue, st.original_queue, st.queue_index, on, keep_next=st.mix is not None
            )
            await _edit_queue(session, song_ids=queue, queue_index=index, shuffle=on)
    elif kind == "repeat":
        # Kept for the windows, which act on it at the end of the queue.
        await _edit_queue(session, repeat_mode=needs(cmd, "mode"))
    elif kind == "autoplay":
        await _edit_queue(session, autoplay_enabled=needs(cmd, "on"))


async def _song_ids(library, cmd) -> tuple[list[str], int]:
    """The queue a library command plays, and where in it to start."""
    kind = cmd.type
    if kind == "play_song":
        return [needs(cmd, "song_id")], 0
    if kind == "play_album":
        found = await app_library.album(library, needs(cmd, "album_id"))
        ids = [song["id"] for song in found["songs"]] if found else []
        return ids, 0
    if kind == "play_playlist":
        found = await app_library.playlist(library, needs(cmd, "playlist_id"))
        ids = [song["id"] for song in found["songs"]] if found else []
        start = cmd.start_index or 0
        return ids, start if start < len(ids) else 0
    # play_song_radio: the window's Song Radio, the song and what is like it.
    seed = needs(cmd, "song_id")
    similar = await asyncio.to_thread(library.get_similar_songs2, seed, _SONG_RADIO_LENGTH)
    return [seed, *(track.id for track in similar if track.id != seed)], 0


def _refused(answer) -> None:
    """A /play, /play-url or /join refusal as the app's status code: a
    speaker somebody else is using stays theirs, there is no takeover."""
    if not isinstance(answer, dict) or not answer.get("error"):
        return
    error = answer["error"]
    if error == "device_in_use":
        raise HTTPException(status_code=409, detail="device_in_use")
    if error == "cast_forbidden":
        raise HTTPException(status_code=403, detail="cast_forbidden")
    raise HTTPException(status_code=502, detail=str(error))


def _key_session_id(owner: KeyOwner) -> str:
    """One session per key for what it starts itself. Not guessable: an
    authenticated session id is all the cast routes ask for."""
    session_id = _key_sessions.get(owner.key_id)
    if session_id is None or registry.get(session_id) is None:
        session_id = f"key-{owner.key_id}-{secrets.token_urlsafe(16)}"
        _key_sessions[owner.key_id] = session_id
    return session_id


def forget_key(key_id: str) -> None:
    _key_sessions.pop(key_id, None)


async def _key_session(owner: KeyOwner, library) -> SessionState:
    session = await registry.get_or_create(_key_session_id(owner))
    server_type, server_url, username = owner.account
    session.media = library
    session.account_server_type = server_type
    session.account_server_url = server_url
    session.account_username = username
    session.display_name = username or session.session_id
    session.authenticated = True
    session.touch()
    return session


def _seq(session: SessionState) -> int:
    return max(session.play_seq + 1, int(time.time() * 1000))


def _wanted_targets(cmd) -> list[dict]:
    return [{"type": d.type, "name": d.name} for d in cmd.devices or []]


async def _play(session: SessionState, ids: list[str], index: int, targets: list[dict]) -> None:
    st = session.state
    request = playback.PlayRequest(
        song_ids=ids,
        queue_index=index,
        original_queue=ids,
        repeat_mode=st.repeat_mode,
        autoplay_enabled=st.autoplay_enabled,
        autoplay_batch_size=st.autoplay_batch_size,
        targets=targets,
        seq=_seq(session),
        # The listener's standing choices, as the window last sent them.
        max_lossy_format=st.max_lossy_format,
        max_lossy_bitrate_kbps=st.max_lossy_bitrate_kbps,
        transitions=st.transitions if st.mix is not None else None,
    )
    _refused(await playback.play_tracks(request, session))


async def _play_station(session: SessionState, station: dict, targets: list[dict]) -> None:
    st = session.state
    request = playback.PlayUrlRequest(
        url=station["stream_url"],
        title=station["name"],
        targets=targets,
        seq=_seq(session),
        max_lossy_format=st.max_lossy_format,
        max_lossy_bitrate_kbps=st.max_lossy_bitrate_kbps,
    )
    _refused(await playback.play_url(request, session))


def _queued(st, song_id: str, next_up: bool) -> tuple[list[str], list[str]]:
    """The queue with `song_id` added, next or at the end. Next comes after a
    song a mix has already lined up, as in the window."""
    queue = list(st.queue)
    at = st.queue_index + (2 if st.mix is not None else 1) if next_up else len(queue)
    queue.insert(min(at, len(queue)), song_id)
    original = [*st.original_queue, song_id] if st.original_queue else []
    return queue, original


async def _start(owner: KeyOwner, cmd, library) -> None:
    """Library commands, and `devices`: what can start a cast from here."""
    cast = now_playing.audible_cast(owner.account)
    kind = cmd.type
    if kind == "devices":
        if cast is None:
            raise HTTPException(status_code=409, detail="nothing_playing")
        await _move(cast, _wanted_targets(cmd))
        return
    if kind in ("queue_next", "queue_add"):
        song_id = needs(cmd, "song_id")
        if cast is None or cast.state.current_track is None:
            raise HTTPException(status_code=409, detail="nothing_playing")
        queue, original = _queued(cast.state, song_id, kind == "queue_next")
        await _edit_queue(cast, song_ids=queue, original_queue=original)
        return

    if cast is not None:
        session = cast
        targets = [{"type": t, "name": n} for t, n in list_target_pairs(cast.state.active_delivery)]
    else:
        targets = _wanted_targets(cmd)
        if not targets:
            raise HTTPException(status_code=409, detail="no_speaker")
        session = await _key_session(owner, library)

    if kind == "play_radio":
        station = await app_library.radio_station(library, needs(cmd, "station_id"))
        if station is None:
            raise HTTPException(status_code=404, detail="No such station")
        await _play_station(session, station, targets)
        return
    ids, index = await _song_ids(library, cmd)
    if not ids:
        raise HTTPException(status_code=404, detail="Nothing to play there")
    await _play(session, ids, index, targets)


async def _move(session: SessionState, targets: list[dict]) -> None:
    """The cast onto exactly `targets`: joins the new ones, then lets go of
    the rest, so the music never stops in between. None at all stops it."""
    if not targets:
        await playback.stop_playback(session)
        return
    playing = set(list_target_pairs(session.state.active_delivery))
    wanted = [(t["type"], t["name"]) for t in targets]
    for device_type, name in wanted:
        if (device_type, name) not in playing:
            join = JoinRequest(target_type=device_type, target_name=name)
            _refused(await join_stream(join, session))
    for device_type, name in playing - set(wanted):
        _refused(await stop_device(device_type, name, session))


async def devices(owner: KeyOwner, rescan: bool) -> dict:
    found = await discover_all(verbose=True) if rescan or not ctx.discovered else ctx.discovered
    account = SimpleNamespace(
        account_server_type=owner.account[0],
        account_server_url=owner.account[1],
        account_username=owner.account[2],
        account_is_admin=False,
        display_name=owner.account[2],
    )
    if not await asyncio.to_thread(may_cast, account):
        return {"items": []}
    items = []
    for device_type in ("sonos", "airplay", "chromecast", "dlna"):
        for device in found.get(device_type) or []:
            holder_id = claims.owner_of(device_type, device["name"])
            holder = registry.get(holder_id) if holder_id else None
            items.append(
                {
                    "type": device_type,
                    "name": device["name"],
                    "in_use_by": holder.display_name if holder else None,
                    "needs_pairing": bool(device.get("needs_pairing"))
                    and device["name"] not in credentials.list_paired(),
                }
            )
    return {"items": items}


async def cover(owner: KeyOwner, size: int) -> Response:
    """The song's cover, or the station's logo, looked up with the cast's
    own login like the window does."""
    session = now_playing.audible_cast(owner.account)
    if session is None:
        raise HTTPException(status_code=404, detail="Nothing is playing")
    st = session.state
    if st.current_track is not None and st.current_track.cover_art_id:
        return await cover_image(session.media, st.current_track.cover_art_id)
    if st.current_track is None and st.radio_info is not None:
        try:
            station = await app_library.station_playing(
                session.media, st.radio_info["url"], st.radio_info["title"]
            )
        except Exception as e:
            logger.debug(f"[player] No station list for the logo: {e}")
            station = None
        if station and station["home_page_url"]:
            return await radio_favicon(url=station["home_page_url"], min_size=size, hint="")
    raise HTTPException(status_code=404, detail="No cover for what is playing")
