"""routes/player_commands.py - what /device-link/v1/player takes, on either
kind of installation (routes/player_desktop.py, routes/player_server.py)."""

from fastapi import HTTPException

# Toggles in the app are absolute here (`shuffle` takes `on`): an app says
# what it wants, so a command arriving twice does not undo itself.
TRANSPORT_COMMANDS = (
    "play",
    "pause",
    "next",
    "previous",
    "seek",
    "volume",
    "shuffle",
    "repeat",
    "autoplay",
    "devices",
    "queue_jump",
    "resume_interrupted",
)

# Starting or queueing something new: the library right.
LIBRARY_COMMANDS = (
    "play_song",
    "play_album",
    "play_playlist",
    "play_radio",
    "play_song_radio",
    "queue_next",
    "queue_add",
)


def needs(cmd, field: str):
    value = getattr(cmd, field)
    if value is None:
        raise HTTPException(status_code=422, detail=f"`{cmd.type}` needs `{field}`")
    return value


def unavailable(now: float) -> dict:
    return {
        "available": False,
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
        "commands": [],
    }
