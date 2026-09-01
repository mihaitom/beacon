"""media/subsonic.py — Navidrome / Subsonic API Client"""

import hashlib
import logging
import secrets
from urllib.parse import parse_qs, urlencode

from . import http_client
from .base import Track

logger = logging.getLogger("connect.subsonic")


class SubsonicClient:
    def __init__(
        self,
        url: str,
        user: str = "",
        password: str = "",
        credential: str = "",
        internal_url: str = "",
    ):
        self.base_url = url.rstrip("/")
        self.internal_url = (internal_url or url).rstrip("/")
        # Where requests actually ended up, once redirects were followed —
        # see _get(). Empty until the first successful call.
        self.resolved_url = ""
        self.user = user
        self.password = password
        self._credential = credential  # pre-built Subsonic auth query string
        self.app_name = "navispot"
        self.api_version = "1.16.1"

    def _auth_params(self) -> dict:
        if self._credential:
            parsed = parse_qs(self._credential, keep_blank_values=True)
            params = {k: v[0] for k, v in parsed.items()}
            params.setdefault("v", self.api_version)
            params.setdefault("c", self.app_name)
            params.setdefault("f", "json")
            return params
        salt = secrets.token_hex(6)
        token = hashlib.md5(f"{self.password}{salt}".encode()).hexdigest()
        return {
            "u": self.user,
            "t": token,
            "s": salt,
            "v": self.api_version,
            "c": self.app_name,
            "f": "json",
        }

    def _get(self, endpoint: str, **params) -> dict:
        url = f"{self.internal_url}/rest/{endpoint}"
        response = http_client.get(url, params={**self._auth_params(), **params}, timeout=10)
        response.raise_for_status()
        # A server behind a reverse proxy commonly answers http:// with a 301
        # to https://, and every client here follows redirects (see
        # media/http_client.py) — so a login typed with the wrong scheme
        # works, but pays an extra round trip on every single request from
        # then on. Recording where the request really landed lets /config
        # hand the frontend the address that actually answered. Only
        # meaningful when we asked the login URL itself: with an internal
        # override in play, this resolves to a LAN address the browser may
        # not be able to reach at all.
        if self.internal_url == self.base_url:
            self.resolved_url = str(response.url).split("/rest/")[0]
        data = response.json()

        subsonic = data.get("subsonic-response", {})
        if subsonic.get("status") != "ok":
            error = subsonic.get("error", {})
            raise RuntimeError(f"Subsonic Error {error.get('code')}: {error.get('message')}")

        return subsonic

    def get_track(self, track_id: str) -> Track:
        data = self._get("getSong.view", id=track_id)
        song = data.get("song", {})
        return Track(
            id=song["id"],
            title=song.get("title", "Unknown"),
            artist=song.get("artist", "Unknown"),
            duration=song.get("duration", 0),
            cover_art_id=song.get("coverArt", ""),
            album=song.get("album", ""),
        )

    # Not part of the MediaClient Protocol — genuinely optional (Plex has no
    # equivalent, see media/plex.py's absence of this method and
    # capabilities.ts's songRadio: false for it), so callers duck-type via
    # hasattr() rather than this being declared (and needing a
    # NotImplementedError stub) on every adapter. Used by both
    # stores/playback.ts's Song/Artist Radio (via the getSimilarSongs2.view
    # passthrough in routes/proxy.py, which never touches this method at
    # all) and, the actual reason this exists as a *client* method rather
    # than only ever a raw proxied endpoint, routes/stream.py's own
    # Autoplay fallback top-up, which needs to call this from inside
    # connect itself — see AppState.autoplay_enabled's comment.
    def get_similar_songs2(self, seed_id: str, count: int = 10) -> list[Track]:
        data = self._get("getSimilarSongs2.view", id=seed_id, count=count)
        songs = data.get("similarSongs2", {}).get("song", [])
        return [
            Track(
                id=song["id"],
                title=song.get("title", "Unknown"),
                artist=song.get("artist", "Unknown"),
                duration=song.get("duration", 0),
                cover_art_id=song.get("coverArt", ""),
                album=song.get("album", ""),
            )
            for song in songs
        ]

    def get_stream_url(self, track_id: str) -> str:
        # urlencode (not a naive f-string join) so auth param values with
        # reserved characters (e.g. a username containing '&' or a space)
        # can't corrupt the query string — see _auth_params()'s credential
        # branch, which decodes the frontend's percent-encoded values via
        # parse_qs and would otherwise hand back raw unsafe characters here.
        params = {"id": track_id, **self._auth_params()}
        return f"{self.internal_url}/rest/stream.view?{urlencode(params)}"

    def get_cover_art_url(
        self, cover_art_id: str, internal: bool = False, size: int = 300
    ) -> str | None:
        if not cover_art_id or not self.base_url:
            return None
        base = self.internal_url if internal else self.base_url
        params = {"id": cover_art_id, "size": size, **self._auth_params()}
        return f"{base}/rest/getCoverArt.view?{urlencode(params)}"

    def ping(self) -> bool:
        try:
            self._get("ping.view")
            return True
        except Exception as e:
            # /config only surfaces a generic "credential rejected" to the
            # frontend (see routes/devices.py) — this is the only place the
            # actual reason (wrong URL, unreachable server, bad credential,
            # ...) is visible at all, so it's worth a real log line rather
            # than being silently swallowed.
            logger.warning(f"[ping] {self.internal_url}/rest/ping.view failed: {e}")
            return False
