"""routes/player_desktop.py - /device-link/v1/player on the desktop app.

The desktop's player is its one window: the state is the snapshot the window
pushes for the phone remote, and commands go down the same relay
(routes/remote.py). Only while that window is signed in with the key's own
account; signed in as somebody else, the player is not there for this key.
"""

import time

from fastapi import HTTPException, Response

from core.claims import claims
from core.device_keys import LIBRARY, KeyOwner
from core.remote import remote
from core.session import SessionState, registry
from routes.coverart import cover_image
from routes.player_commands import LIBRARY_COMMANDS, TRANSPORT_COMMANDS, needs, unavailable
from routes.radio import radio_favicon
from routes.remote import relay_command, relay_query

_REPEAT_ORDER = ("off", "all", "one")


def _window(owner: KeyOwner) -> SessionState | None:
    if not remote.renderer_connected:
        return None
    session_id = remote.snapshot.get("session_id")
    session = registry.get(session_id) if session_id else None
    if session is None:
        return None
    signed_in = (
        session.account_server_type,
        session.account_server_url,
        session.account_username,
    )
    return session if signed_in == owner.account else None


def _song(song: dict) -> dict:
    return {
        "id": song.get("id"),
        "title": song.get("title"),
        "artist": song.get("artist"),
        "album": song.get("album"),
        "duration": song.get("duration"),
        "cover_art_id": song.get("cover_art_id"),
    }


def state(owner: KeyOwner, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    if _window(owner) is None:
        return unavailable(now)
    snap = remote.snapshot
    song, radio = snap.get("current_song"), snap.get("radio")
    playing = bool(snap.get("playing"))
    casting = snap.get("casting") or []
    position = snap.get("position") if song else None
    if position is not None and playing:
        position += max(0.0, now - remote.snapshot_at)
    device_volume = snap.get("device_volume")
    party = snap.get("party")
    return {
        "available": True,
        "state": "idle" if not song and not radio else "playing" if playing else "paused",
        "source": None if not song and not radio else "cast" if casting else "local",
        "song": _song(song) if song else None,
        "radio": {"station": radio.get("name") or "", "title": radio.get("now_playing")}
        if radio
        else None,
        "position": None if position is None else round(position, 3),
        "at": round(now, 3),
        "volume": device_volume / 100 if device_volume is not None else snap.get("volume"),
        "shuffle": snap.get("shuffle"),
        "repeat": snap.get("repeat") if snap.get("repeat") in _REPEAT_ORDER else None,
        "autoplay": snap.get("autoplay"),
        "queue": [_song(s) for s in snap.get("queue") or []],
        "queue_index": snap.get("queue_index"),
        "devices": [{"type": t.get("type"), "name": t.get("name")} for t in casting],
        "interrupted": bool(snap.get("interrupted")),
        "party": {
            "running": bool(party.get("running")),
            "guests": party.get("guests") or 0,
            "listeners": party.get("listeners") or 0,
            "listen_kbps": party.get("listen_kbps"),
        }
        if party
        else None,
        "commands": [*TRANSPORT_COMMANDS, *(LIBRARY_COMMANDS if LIBRARY in owner.scopes else ())],
    }


def _require_window(owner: KeyOwner) -> None:
    if _window(owner) is None:
        raise HTTPException(status_code=409, detail="not_available")


def _refuse_held_speakers(owner: KeyOwner, wanted) -> None:
    """An app never takes a speaker over, as on a server: unlike the phone
    remote it may not have shown anybody who holds it. Checked here, since
    the window's relay command always takes over (made for the phone)."""
    window = _window(owner)
    for device in wanted:
        holder = claims.owner_of(device.type, device.name)
        if holder is not None and (window is None or holder != window.session_id):
            raise HTTPException(status_code=409, detail="device_in_use")


async def command(owner: KeyOwner, cmd) -> None:
    """The window's relay commands, which toggle where v1 says what it wants."""
    _require_window(owner)
    snap = remote.snapshot
    kind = cmd.type
    if kind in ("play", "pause", "next", "previous"):
        await relay_command(kind, {})
    elif kind == "seek":
        await relay_command("seek", {"position": needs(cmd, "position")})
    elif kind == "volume":
        volume = needs(cmd, "volume")
        casting = snap.get("casting") or []
        if len(casting) > 1:
            # The window's own volume command leaves several speakers alone,
            # having no one volume to set; v1 sets each, as on a server.
            for target in casting:
                await relay_command(
                    "set-device-volume",
                    {
                        "deviceType": target.get("type"),
                        "name": target.get("name"),
                        "volume": round(volume * 100),
                    },
                )
        else:
            await relay_command("volume", {"volume": volume})
    elif kind == "shuffle":
        if bool(snap.get("shuffle")) != needs(cmd, "on"):
            await relay_command("shuffle", {})
    elif kind == "autoplay":
        if bool(snap.get("autoplay")) != needs(cmd, "on"):
            await relay_command("autoplay", {})
    elif kind == "repeat":
        current = snap.get("repeat") if snap.get("repeat") in _REPEAT_ORDER else "off"
        wanted = needs(cmd, "mode")
        for _ in range((_REPEAT_ORDER.index(wanted) - _REPEAT_ORDER.index(current)) % 3):
            await relay_command("repeat", {})
    elif kind == "devices":
        wanted = needs(cmd, "devices")
        _refuse_held_speakers(owner, wanted)
        targets = [{"deviceType": d.type, "name": d.name} for d in wanted]
        await relay_command("cast-to-many", {"targets": targets})
    elif kind == "queue_jump":
        await relay_command("queue-jump", {"index": needs(cmd, "index")})
    elif kind == "resume_interrupted":
        await relay_command("resume-interrupted", {})
    elif kind == "play_song":
        await relay_command("play-song", {"songId": needs(cmd, "song_id")})
    elif kind == "play_song_radio":
        await relay_command("play-song-radio", {"songId": needs(cmd, "song_id")})
    elif kind == "queue_next":
        await relay_command("queue-next", {"songId": needs(cmd, "song_id")})
    elif kind == "queue_add":
        await relay_command("queue-add", {"songId": needs(cmd, "song_id")})
    elif kind == "play_album":
        await relay_command("play-album", {"albumId": needs(cmd, "album_id")})
    elif kind == "play_playlist":
        await relay_command(
            "play-playlist",
            {"playlistId": needs(cmd, "playlist_id"), "startIndex": cmd.start_index or 0},
        )
    elif kind == "play_radio":
        await relay_command("play-radio-station", {"stationId": needs(cmd, "station_id")})


async def devices(owner: KeyOwner, rescan: bool) -> dict:
    _require_window(owner)
    found = await relay_query("devices-request", {"rescan": rescan})
    return {
        "items": [
            {
                "type": d.get("type"),
                "name": d.get("name"),
                "in_use_by": d.get("in_use_by_name"),
                "needs_pairing": bool(d.get("needs_pairing")),
            }
            for d in found.get("items") or []
        ]
    }


async def cover(owner: KeyOwner, size: int) -> Response:
    """The song's cover, or the station's logo."""
    session = _window(owner)
    if session is None:
        raise HTTPException(status_code=404, detail="Nothing is playing")
    song, radio = remote.snapshot.get("current_song"), remote.snapshot.get("radio")
    if song and song.get("cover_art_id"):
        return await cover_image(session.media, song["cover_art_id"])
    if radio and (radio.get("home_page_url") or radio.get("favicon_hint")):
        return await radio_favicon(
            url=radio.get("home_page_url") or "",
            min_size=size,
            hint=radio.get("favicon_hint") or "",
        )
    raise HTTPException(status_code=404, detail="No cover for what is playing")
