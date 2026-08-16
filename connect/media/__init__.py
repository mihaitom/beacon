"""media — Music server client abstraction for Beacon Connect.

Sub-modules:
  base      Track dataclass and MediaClient protocol
  subsonic  SubsonicClient (Navidrome / Subsonic API)
  jellyfin  JellyfinClient (Jellyfin API)
  plex      PlexClient (Plex API)
"""

from .base import MediaClient, Track
from .jellyfin import JellyfinClient
from .plex import PlexClient
from .subsonic import SubsonicClient


def server_type_name(media: MediaClient) -> str:
    """Canonical 'subsonic'/'jellyfin'/'plex' string for a live MediaClient
    instance — the one place that knows the isinstance mapping, used by
    both /health's session_server_type (routes/devices.py) and the proxy
    bridge dispatch (routes/proxy.py)."""
    if isinstance(media, JellyfinClient):
        return "jellyfin"
    if isinstance(media, PlexClient):
        return "plex"
    return "subsonic"


__all__ = [
    "JellyfinClient",
    "MediaClient",
    "PlexClient",
    "SubsonicClient",
    "Track",
    "server_type_name",
]
