"""media — Music server client abstraction for Feishin Connect.

Sub-modules:
  base      Track dataclass and MediaClient protocol
  subsonic  SubsonicClient (Navidrome / Subsonic API)
  jellyfin  JellyfinClient (Jellyfin API)
"""

from .base import MediaClient, Track
from .jellyfin import JellyfinClient
from .subsonic import SubsonicClient

__all__ = ["JellyfinClient", "MediaClient", "SubsonicClient", "Track"]
