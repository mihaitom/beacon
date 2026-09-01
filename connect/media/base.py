"""media/base.py — Common Track type, MediaClient protocol, and the
Subsonic response envelope shared by every bridge module
(jellyfin_bridge.py, plex_bridge.py, ...).

Both SubsonicClient and JellyfinClient implement MediaClient so the rest of the
backend can stay agnostic about which music server is behind /config.
"""

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from fastapi.responses import JSONResponse

from core import radio_stations

_SUBSONIC_API_VERSION = "1.16.1"


def subsonic_envelope(result: dict) -> JSONResponse:
    return JSONResponse(
        {"subsonic-response": {"status": "ok", "version": _SUBSONIC_API_VERSION, **result}}
    )


def subsonic_error(code: int, message: str) -> JSONResponse:
    return JSONResponse(
        {
            "subsonic-response": {
                "status": "failed",
                "version": _SUBSONIC_API_VERSION,
                "error": {"code": code, "message": message},
            }
        }
    )


@dataclass
class Track:
    id: str
    title: str
    artist: str
    duration: int  # seconds
    cover_art_id: str = field(default="")
    album: str = field(default="")


@runtime_checkable
class MediaClient(Protocol):
    """Minimal interface every music-server adapter must provide."""

    base_url: str

    def get_track(self, track_id: str) -> Track: ...

    def get_stream_url(self, track_id: str) -> str: ...

    def get_cover_art_url(
        self, cover_art_id: str, internal: bool = False, size: int = 300
    ) -> str | None:
        """`internal=True` returns a URL reachable by LAN cast devices
        (Sonos/Chromecast/AirPlay/DLNA) fetching it directly — the default
        (False) is for the browser's own display, which may not be able to
        reach the same address (see routes/playback.py's device-facing call
        vs core/session.py's SSE-facing one). `size` is honored by Subsonic
        and Jellyfin; PlexClient accepts and ignores it, always returning
        its one fixed thumbnail size — its browser-facing single-cover path
        never plumbed a size through either (see media/plex_bridge.py's
        _handle_binary), so this isn't a regression, just not (yet)
        implemented there. Accepting the parameter anyway means a caller
        that treats every MediaClient the same doesn't need to special-case
        Plex just to avoid a TypeError."""
        ...

    def ping(self) -> bool: ...


# ── Playlist reordering ──────────────────────────────────────────────────────
# Subsonic expresses "reorder" as createPlaylist.view with a playlistId and
# the complete song list (see client.ts's setPlaylistSongs). Neither Jellyfin
# nor Plex has a "replace the whole list" call, but both can move a single
# entry, so each bridge resolves the wanted order against the playlist's
# current entries and moves what's out of place. That resolution is identical
# for both, hence living here.


def match_entries_to_song_ids(entry_song_ids: list[str], wanted: list[str]) -> list[int | None]:
    """For each wanted song id, the position of the playlist entry that will
    represent it — or None where the playlist holds no (further) entry for
    that song, i.e. it has to be added.

    Positions, not ids, because a playlist may hold the same song more than
    once: those are separate entries with separate per-entry ids, and each
    can only be claimed once. Matching them in order keeps a duplicate pair
    in its original relative order instead of swapping the two."""
    unclaimed: dict[str, list[int]] = {}
    for position, song_id in enumerate(entry_song_ids):
        unclaimed.setdefault(song_id, []).append(position)
    matched: list[int | None] = []
    for song_id in wanted:
        positions = unclaimed.get(song_id)
        matched.append(positions.pop(0) if positions else None)
    return matched


def _entries_already_in_order(current: list[str], target: list[str]) -> set[str]:
    """The entries that don't have to move at all: the longest subsequence
    of `target` whose entries already appear in that relative order in
    `current`. Everything else is moved around them.

    This is what keeps a single dragged song to a single move — moving the
    other four instead would produce the same order, but every move is its
    own request to the media server."""
    position_in_current = {entry_id: index for index, entry_id in enumerate(current)}
    positions = [position_in_current[entry_id] for entry_id in target]

    # Patience sorting: tails[k] is the index (into `positions`) ending the
    # smallest increasing run of length k+1 found so far, and `previous`
    # links each element back to its predecessor in that run, so the run
    # itself can be read back out at the end.
    tails: list[int] = []
    previous: list[int | None] = [None] * len(positions)
    for index, value in enumerate(positions):
        low, high = 0, len(tails)
        while low < high:
            middle = (low + high) // 2
            if positions[tails[middle]] < value:
                low = middle + 1
            else:
                high = middle
        previous[index] = tails[low - 1] if low > 0 else None
        if low == len(tails):
            tails.append(index)
        else:
            tails[low] = index

    stable: set[str] = set()
    cursor: int | None = tails[-1] if tails else None
    while cursor is not None:
        stable.add(target[cursor])
        cursor = previous[cursor]
    return stable


def reorder_moves(current: list[str], target: list[str]) -> list[tuple[str, int, str | None]]:
    """The moves that turn `current` into `target`: (entry id, destination
    index, id of the entry it should end up after). Each takes the entry
    out of where it is and re-inserts it at that index — Jellyfin's move
    call names the index, Plex's names the entry to follow, so both are
    given; `after` is None for a move to the very front.

    Apply them in the order returned. Both lists must hold the same entry
    ids: callers add and remove first (see each bridge's own
    _set_playlist_songs), so by this point only the order differs.

    Right to left, each entry going immediately before the one that is to
    follow it — which, going this direction, is already where it belongs.
    Its destination is therefore wherever that follower currently sits, not
    the entry's own final index: the entries still out of place to its left
    are occupying positions that shift everything along."""
    stable = _entries_already_in_order(current, target)
    working = list(current)
    moves: list[tuple[str, int, str | None]] = []
    for index in range(len(target) - 1, -1, -1):
        entry_id = target[index]
        if entry_id in stable:
            continue
        working.remove(entry_id)
        follower = target[index + 1] if index + 1 < len(target) else None
        destination = len(working) if follower is None else working.index(follower)
        working.insert(destination, entry_id)
        moves.append((entry_id, destination, working[destination - 1] if destination else None))
    return moves


# ── Internet radio stations (self-hosted — see core/radio_stations.py) ──────
# Shared by every bridge module (jellyfin_bridge.py, plex_bridge.py, ...) —
# not a real-server API translation like the rest of a bridge's handlers,
# these four instead read/write connect's own local station list, so the
# logic is identical regardless of which backend a session actually talks
# to. `media` is unused but kept in the signature for each bridge's uniform
# per-endpoint dispatch-table type.


async def get_internet_radio_stations(_params: dict, _media: object) -> dict:
    stations = radio_stations.list_stations()
    return {
        "internetRadioStations": {
            "internetRadioStation": [
                {
                    "id": s["id"],
                    "name": s["name"],
                    "streamUrl": s["streamUrl"],
                    "homePageUrl": s.get("homePageUrl", ""),
                }
                for s in stations
            ]
        }
    }


async def create_internet_radio_station(params: dict, _media: object) -> dict:
    # client.ts sends the Subsonic-conventional "homepageUrl" (lowercase p)
    # query param — distinct from the raw response's "homePageUrl" above.
    radio_stations.create(
        params.get("name", ""), params.get("streamUrl", ""), params.get("homepageUrl", "")
    )
    return {}


async def update_internet_radio_station(params: dict, _media: object) -> dict:
    station_id = params["id"]
    updated = radio_stations.update(
        station_id,
        params.get("name", ""),
        params.get("streamUrl", ""),
        params.get("homepageUrl", ""),
    )
    if not updated:
        raise ValueError(f"No such radio station: {station_id}")
    return {}


async def delete_internet_radio_station(params: dict, _media: object) -> dict:
    station_id = params["id"]
    if not radio_stations.delete(station_id):
        raise ValueError(f"No such radio station: {station_id}")
    return {}
