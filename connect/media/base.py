"""media/base.py — Common Track type and MediaClient protocol.

Both SubsonicClient and JellyfinClient implement MediaClient so the rest of the
backend can stay agnostic about which music server is behind /config.
"""

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


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
