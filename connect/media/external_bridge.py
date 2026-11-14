"""media/external_bridge.py - what /rest/* does with an `ext:` id.

A song from the external source (core/external_source.py) travels through
the same Subsonic calls as a library song. The few that read it are answered
here; the ones that would hand it to the media server are refused, or have
it taken out, before the request goes on. Done in the proxy rather than only
in the renderer, so the remote control and the app API get the same rules.
"""

from urllib.parse import urlencode

from fastapi import Request

from core import external_source

from .base import subsonic_envelope, subsonic_error

_ID = "id"

# Calls that change something on the media server about one song: an
# external one has nothing there to change.
_REFUSED = {"star", "unstar", "setRating"}

# Calls that only make sense for a library song and have a harmless empty
# answer.
_EMPTY = {
    "getLyricsBySongId": {"lyricsList": {"structuredLyrics": []}},
    "getSimilarSongs2": {"similarSongs2": {"song": []}},
    "getSimilarSongs": {"similarSongs": {"song": []}},
    "getTopSongs": {"topSongs": {"song": []}},
}

# Which query keys name songs in the calls that take several. Everything
# external is taken out and the rest goes on to the media server.
_LIST_KEYS = {
    "createPlaylist": ("songId",),
    "updatePlaylist": ("songIdToAdd",),
    "savePlayQueue": ("id", "current"),
    "savePlayQueueByIndex": ("id",),
}


def _endpoint(path: str) -> str:
    return path.removesuffix(".view")


def external_id(path: str, request: Request) -> str | None:
    """The `ext:` id a single-song call is about, if it is about one. Never
    for the calls that list several songs under `id`: those keep their
    library songs (without_external_ids)."""
    if _endpoint(path) in _LIST_KEYS:
        return None
    item_id = request.query_params.get(_ID)
    if external_source.is_external_id(item_id):
        return item_id
    return None


def answer(path: str, item_id: str):
    """The response for a single-song call about `item_id`, or None for
    the calls the proxy streams itself (`stream`, `download`,
    `getCoverArt`)."""
    endpoint = _endpoint(path)
    if endpoint in ("stream", "download", "getCoverArt"):
        return None
    if endpoint == "getSong":
        try:
            track = external_source.get_track(item_id)
        except KeyError:
            return subsonic_error(70, "Song not found")
        return subsonic_envelope({"song": external_source.subsonic_song(track)})
    if endpoint == "scrobble":
        # The media server never hears of the song; Beacon's own play
        # history is recorded elsewhere.
        return subsonic_envelope({})
    if endpoint in _REFUSED:
        return subsonic_error(70, "Not available for a song from an external source")
    if endpoint in _EMPTY:
        return subsonic_envelope(_EMPTY[endpoint])
    return subsonic_error(70, "Not available for a song from an external source")


def without_external_ids(path: str, request: Request) -> Request:
    """`request` with every external song taken out of a multi-song call,
    or unchanged. savePlayQueue loses its position along with an external
    current song, since the position belongs to that song."""
    keys = _LIST_KEYS.get(_endpoint(path))
    if not keys:
        return request
    items = request.query_params.multi_items()
    kept = [(k, v) for k, v in items if not (k in keys and external_source.is_external_id(v))]
    if len(kept) == len(items):
        return request
    if any(k == "current" for k, v in items if external_source.is_external_id(v)):
        kept = [(k, v) for k, v in kept if k != "position"]
    scope = dict(request.scope)
    scope["query_string"] = urlencode(kept).encode()
    return Request(scope, request.receive)
