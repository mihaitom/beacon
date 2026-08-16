"""media/jellyfin.py — Jellyfin API Client

Uses the simple `/Items/{id}/Download` endpoint for streaming (raw file, no
transcoding) — robust for FFmpeg re-streaming to Sonos / AirPlay / Chromecast.
"""

import logging
import secrets
from pathlib import Path
from urllib.parse import quote, urlencode

import httpx

from .base import Track

logger = logging.getLogger("connect.jellyfin")

# Jellyfin reports RunTimeTicks in units of 100 ns.
TICKS_PER_SECOND = 10_000_000

_DEVICE_ID_FILE = Path(__file__).resolve().parent.parent / ".jellyfin-device-id"
_CLIENT_VERSION = "1.0.0"


def _device_id() -> str:
    """Stable device id for the Authorization header below — Jellyfin
    registers a new "device" per unique DeviceId, so reusing the same one
    across restarts (same idea as core/auth.py's CONNECT_TOKEN) keeps this
    backend from piling up a fresh phantom device in the user's Jellyfin
    admin panel on every login/silent restore."""
    try:
        existing = _DEVICE_ID_FILE.read_text().strip()
        if existing:
            return existing
    except FileNotFoundError:
        pass
    generated = secrets.token_hex(16)
    try:
        _DEVICE_ID_FILE.write_text(generated)
    except OSError:
        pass  # Falls back to a fresh id next restart — not fatal, just loses stability.
    return generated


def _client_auth_header() -> dict:
    return {
        "Authorization": (
            'MediaBrowser Client="Beacon", Device="Beacon", '
            f'DeviceId="{_device_id()}", Version="{_CLIENT_VERSION}"'
        )
    }


def authenticate_by_name(url: str, username: str, password: str) -> dict:
    """Exchanges a Jellyfin username/password for an AccessToken + user id via
    POST /Users/AuthenticateByName. The frontend never talks to Jellyfin
    directly (see routes/jellyfin_auth.py) — this is the one place a raw
    password briefly exists server-side, mirroring how Subsonic's own
    salt+md5 hashing keeps a raw password from ever leaving the client for
    that server type. Raises httpx.HTTPStatusError on rejected credentials
    (4xx) — callers turn that into a clean 401."""
    base = url.rstrip("/")
    response = httpx.post(
        f"{base}/Users/AuthenticateByName",
        json={"Username": username, "Pw": password},
        headers=_client_auth_header(),
        timeout=10,
    )
    response.raise_for_status()
    data = response.json()
    return {"token": data["AccessToken"], "user_id": data["User"]["Id"]}


def initiate_quick_connect(url: str) -> dict:
    """Starts a Jellyfin Quick Connect flow: returns a short `code` the user
    enters on another already-authenticated device/app (or Jellyfin's own
    web UI, under their account's Quick Connect settings) to authorize this
    login, and a `secret` used to poll for completion (see
    check_quick_connect_authenticated()) and to exchange for a real token
    once authorized (see authenticate_with_quick_connect()). Raises
    httpx.HTTPStatusError if Quick Connect isn't enabled on this server —
    routes/jellyfin_auth.py turns that into a clean error for the login
    screen rather than a generic 500."""
    base = url.rstrip("/")
    response = httpx.post(
        f"{base}/QuickConnect/Initiate",
        headers=_client_auth_header(),
        timeout=10,
    )
    response.raise_for_status()
    data = response.json()
    return {"secret": data["Secret"], "code": data["Code"]}


def check_quick_connect_authenticated(url: str, secret: str) -> bool:
    """Polls whether the user has approved the Quick Connect request yet
    (see initiate_quick_connect()) — approval itself happens entirely on
    another device; this just reads the current state."""
    base = url.rstrip("/")
    response = httpx.get(
        f"{base}/QuickConnect/Connect",
        params={"secret": secret},
        headers=_client_auth_header(),
        timeout=10,
    )
    response.raise_for_status()
    return bool(response.json().get("Authenticated"))


def authenticate_with_quick_connect(url: str, secret: str) -> dict:
    """Exchanges an approved Quick Connect secret for a real AccessToken +
    user id, the same way authenticate_by_name() does for a password — only
    meaningful after check_quick_connect_authenticated() has returned True
    (Jellyfin itself still rejects it otherwise). Also returns the
    username, unlike authenticate_by_name() (where the frontend already
    has it from the login form) — Quick Connect never collects one
    directly, so this is the only place to get it from."""
    base = url.rstrip("/")
    response = httpx.post(
        f"{base}/Users/AuthenticateWithQuickConnect",
        json={"Secret": secret},
        headers=_client_auth_header(),
        timeout=10,
    )
    response.raise_for_status()
    data = response.json()
    return {
        "token": data["AccessToken"],
        "user_id": data["User"]["Id"],
        "username": data["User"].get("Name", ""),
    }


class JellyfinClient:
    def __init__(
        self,
        url: str,
        token: str = "",
        user_id: str = "",
        internal_url: str = "",
    ):
        self.base_url = url.rstrip("/")
        self.internal_url = (internal_url or url).rstrip("/")
        self.token = token
        self.user_id = user_id

    def _auth_header(self) -> dict:
        if not self.token:
            return {}
        return {"X-Emby-Token": self.token}

    def auth_headers(self) -> dict:
        """Public accessor for media/jellyfin_bridge.py, which calls several
        Jellyfin endpoints this class itself has no method for."""
        return self._auth_header()

    def _get(self, path: str, **params) -> dict:
        url = f"{self.internal_url}{path}"
        response = httpx.get(
            url, headers=self._auth_header(), params=params, timeout=10
        )
        response.raise_for_status()
        return response.json()

    def get_track(self, track_id: str) -> Track:
        if not self.user_id:
            raise RuntimeError("Jellyfin user_id missing — re-send /config")
        item = self._get(f"/Users/{self.user_id}/Items/{track_id}")
        artists = item.get("Artists") or []
        return Track(
            id=item["Id"],
            title=item.get("Name", "Unknown"),
            artist=", ".join(artists)
            if artists
            else item.get("AlbumArtist", "Unknown"),
            duration=int((item.get("RunTimeTicks") or 0) / TICKS_PER_SECOND),
            # For Jellyfin the cover art id IS the item id (Primary image endpoint).
            cover_art_id=item["Id"],
            album=item.get("Album", ""),
        )

    def get_stream_url(self, track_id: str) -> str:
        # `/Items/{id}/Download` returns the original file unchanged — FFmpeg
        # handles container/codec conversion downstream. quote() on the id
        # (not a naive f-string join) so a malformed/adversarial track_id
        # can't escape the /Items/{id}/ path segment — see get_cover_art_url
        # below and jellyfin_bridge.py's _quote_id for the same reasoning.
        return (
            f"{self.internal_url}/Items/{quote(track_id, safe='')}/Download"
            f"?{urlencode({'api_key': self.token})}"
        )

    def get_cover_art_url(self, cover_art_id: str, internal: bool = False) -> str | None:
        if not cover_art_id or not self.base_url:
            return None
        base = self.internal_url if internal else self.base_url
        return f"{base}/Items/{quote(cover_art_id, safe='')}/Images/Primary?maxHeight=300"

    def ping(self) -> bool:
        """Verifies the token actually authenticates — hits an endpoint that
        requires it (unlike /System/Info/Public, which any anonymous caller
        can reach), so this can't be satisfied by an unrelated/garbage token."""
        try:
            response = httpx.get(
                f"{self.internal_url}/Users/Me",
                headers=self._auth_header(),
                timeout=10,
            )
            response.raise_for_status()
            return True
        except Exception as e:
            # /config only surfaces a generic "credential rejected" to the
            # frontend (see routes/devices.py) — this is the only place the
            # actual reason (wrong URL, unreachable server, expired token,
            # ...) is visible at all, so it's worth a real log line rather
            # than being silently swallowed.
            logger.warning(f"[ping] {self.internal_url}/Users/Me failed: {e}")
            return False
