"""media — Music server client abstraction for Beacon Connect.

Sub-modules:
  base      Track dataclass and MediaClient protocol
  subsonic  SubsonicClient (Navidrome / Subsonic API)
  jellyfin  JellyfinClient (Jellyfin API)
  plex      PlexClient (Plex API)
"""

from . import http_client
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


# Fallback Cache-Control for proxied image responses (cover art, artist
# photos, ...) that come back with no caching directive of their own —
# several Subsonic-API servers don't set one on getCoverArt.view at all,
# which leaves the browser re-fetching art it already has every time, even
# though the frontend's own coverArtUrl() query params (id+size+token+
# session, no timestamp) already make the same request produce an
# identical response every time.
#
# 30 days, matching routes/coverart.py's own cache: what keeps artwork
# current is that a cover art id changes when the picture does (see
# base.py's artwork_id), not that the cache forgets it. The expiry is the
# backstop for a server whose ids don't carry a version, which is why it is
# a month rather than open-ended.
_IMAGE_CACHE_CONTROL = "public, max-age=2592000"


def apply_image_cache_control(headers: dict[str, str], content_type: str | None) -> None:
    """Fills in Cache-Control (in place) on `headers` when `content_type`
    is an image and the origin didn't already send its own directive —
    left alone otherwise, including a deliberate "no-store" for e.g. a
    just-changed avatar. Shared by routes/proxy.py (Subsonic) and
    jellyfin_bridge.py's/plex_bridge.py's own binary-response paths — all
    three build their own response-headers dict from an upstream response
    the same way, none of them through a single shared streaming helper."""
    if not content_type or not content_type.startswith("image/"):
        return
    if any(k.lower() == "cache-control" for k in headers):
        return
    headers["cache-control"] = _IMAGE_CACHE_CONTROL


__all__ = [
    "JellyfinClient",
    "MediaClient",
    "PlexClient",
    "SubsonicClient",
    "Track",
    "apply_image_cache_control",
    "http_client",
    "server_type_name",
]
