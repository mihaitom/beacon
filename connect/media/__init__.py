"""media — Music server client abstraction for Beacon Connect.

Sub-modules:
  base      Track dataclass and MediaClient protocol
  subsonic  SubsonicClient (Navidrome / Subsonic API)
  jellyfin  JellyfinClient (Jellyfin API)
  plex      PlexClient (Plex API)
"""

import asyncio
from typing import NamedTuple

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


class ResolvedAccount(NamedTuple):
    """The account a session's credential actually belongs to, as the media
    server reports it — see resolve_account(). `verified` is False when the
    server could not be asked for a name (Plex, see below) or did not answer
    one; core/cast_permissions.py treats an unverified account as "not
    listed" whenever the server has a restriction, so a lookup failure can
    never open the door."""

    username: str
    is_admin: bool
    verified: bool


async def resolve_account(media: MediaClient, username_hint: str = "") -> ResolvedAccount:
    """Resolve the media-server account behind a verified credential.

    Called by /config once media.ping() has succeeded, so the session can
    carry a real identity instead of the request body's `username` (see
    docs/cast-permissions.md). Dispatches like routes/proxy.py: Jellyfin and
    Plex through their bridges, Subsonic through the client itself.

    `username_hint` is only needed for Subsonic, whose getUser.view requires
    a username parameter and only answers about the caller's own account —
    the bridge handlers ignore it and read the token instead. Plex has no
    way to resolve the name from the server token at all (the user list
    lives at plex.tv and needs the account token), so it comes back
    unverified.
    """
    # Imported lazily: media/__init__.py is imported by the bridge modules
    # themselves (apply_image_cache_control), so a module-level import here
    # would be circular.
    from . import jellyfin_bridge, plex_bridge

    if isinstance(media, JellyfinClient):
        user = (await jellyfin_bridge.get_user({}, media)).get("user", {})
        name = user.get("username", "")
        return ResolvedAccount(name, bool(user.get("adminRole")), bool(name))
    if isinstance(media, PlexClient):
        user = (await plex_bridge.get_user({}, media)).get("user", {})
        return ResolvedAccount("", bool(user.get("adminRole")), False)
    user = await asyncio.to_thread(media.get_user, username_hint)
    name = user.get("username", "")
    return ResolvedAccount(name, bool(user.get("adminRole")), bool(name))


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
    "ResolvedAccount",
    "SubsonicClient",
    "Track",
    "apply_image_cache_control",
    "http_client",
    "resolve_account",
    "server_type_name",
]
