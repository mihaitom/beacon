"""media — Music server client abstraction for Feishin Connect.

Sub-modules:
  base      Track dataclass and MediaClient protocol
  subsonic  SubsonicClient (Navidrome / Subsonic API)
  jellyfin  JellyfinClient (Jellyfin API)
"""

from .base import MediaClient, Track
from .jellyfin import JellyfinClient
from .subsonic import SubsonicClient


def server_type_name(media: MediaClient) -> str:
    """Canonical 'subsonic'/'jellyfin' string for a live MediaClient
    instance — the one place that knows the isinstance mapping, used by
    both /health's session_server_type (routes/devices.py) and the Jellyfin
    proxy bridge dispatch (routes/proxy.py), so there's exactly one spot to
    extend when a third backend (Plex) is added."""
    if isinstance(media, JellyfinClient):
        return "jellyfin"
    return "subsonic"


__all__ = ["JellyfinClient", "MediaClient", "SubsonicClient", "Track", "server_type_name"]
