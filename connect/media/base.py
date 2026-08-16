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

    def get_cover_art_url(self, cover_art_id: str, internal: bool = False) -> str | None:
        """`internal=True` returns a URL reachable by LAN cast devices
        (Sonos/Chromecast/AirPlay/DLNA) fetching it directly — the default
        (False) is for the browser's own display, which may not be able to
        reach the same address (see routes/playback.py's device-facing call
        vs core/session.py's SSE-facing one)."""
        ...

    def ping(self) -> bool: ...


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
        station_id, params.get("name", ""), params.get("streamUrl", ""), params.get("homepageUrl", "")
    )
    if not updated:
        raise ValueError(f"No such radio station: {station_id}")
    return {}


async def delete_internet_radio_station(params: dict, _media: object) -> dict:
    station_id = params["id"]
    if not radio_stations.delete(station_id):
        raise ValueError(f"No such radio station: {station_id}")
    return {}
