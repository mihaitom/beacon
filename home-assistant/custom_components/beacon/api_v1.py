"""Beacon's app API, /device-link/v1/ (docs/help/faq/apps-and-api.md in the
Beacon repo), with a key that has the control right, and the library right
for the media browser.

It answers in the shape the entities already read, the one of the older home
automation API (api.py): an entry made before the switch keeps working, and
no entity has to know which of the two its entry uses.
"""

import asyncio
import json
import logging
import time
from collections.abc import Callable

import aiohttp
from yarl import URL

from .api import RETRY_SECONDS, BeaconAuthError, BeaconError

_LOGGER = logging.getLogger(__name__)

KEY_HEADER = "X-Beacon-Device-Key"
API_PATH = "/device-link/v1"
# The most /library/albums gives at once.
_ALBUM_PAGE = 500
_REPEAT_ORDER = ("off", "all", "one")

# The older API's commands, with what each needs here: (v1 type, fields).
_RENAMED = {
    "play": ("play", {}),
    "pause": ("pause", {}),
    "next": ("next", {}),
    "previous": ("previous", {}),
    "seek": ("seek", {"position": "position"}),
    "volume": ("volume", {"volume": "volume"}),
    "queue-jump": ("queue_jump", {"index": "index"}),
    "resume-interrupted": ("resume_interrupted", {}),
    "play-song": ("play_song", {"songId": "song_id"}),
    "play-song-radio": ("play_song_radio", {"songId": "song_id"}),
    "queue-next": ("queue_next", {"songId": "song_id"}),
    "queue-add": ("queue_add", {"songId": "song_id"}),
    "play-album": ("play_album", {"albumId": "album_id"}),
    "play-playlist": ("play_playlist", {"playlistId": "playlist_id", "startIndex": "start_index"}),
    "play-radio-station": ("play_radio", {"stationId": "station_id"}),
}
_STARTING = {"play_song", "play_song_radio", "play_album", "play_playlist", "play_radio"}


def snapshot_of(player: dict, now: float | None = None) -> dict:
    """A v1 player as the older API's snapshot."""
    now = time.time() if now is None else now
    song, radio = player.get("song"), player.get("radio")
    position = player.get("position")
    if position is not None and player.get("state") == "playing":
        position += max(0.0, now - (player.get("at") or now))
    party = player.get("party")
    return {
        "playing": player.get("state") == "playing",
        "current_song": song,
        "duration": song.get("duration") if song else None,
        "position": position,
        "radio": {"name": radio.get("station"), "now_playing": radio.get("title")}
        if radio
        else None,
        "volume": player.get("volume"),
        "shuffle": player.get("shuffle"),
        "repeat": player.get("repeat"),
        "autoplay": player.get("autoplay"),
        "queue": player.get("queue") or [],
        "queue_index": player.get("queue_index"),
        "casting": [{"type": d["type"], "name": d["name"]} for d in player.get("devices") or []],
        "interrupted": bool(player.get("interrupted")),
        "party": {
            "running": party.get("running"),
            "guests": party.get("guests"),
            "listeners": party.get("listeners"),
            "listen_kbps": party.get("listen_kbps"),
        }
        if party
        else None,
        "song_radio_supported": "play_song_radio" in (player.get("commands") or []),
    }


class BeaconV1Client:
    def __init__(self, session: aiohttp.ClientSession, url: str, key: str):
        self._session = session
        self.url = url.rstrip("/")
        self._key = key
        self._player: dict = {}
        # Picked while nothing played: a server starts the next song there.
        self._speakers: list[dict] = []

    @property
    def base(self) -> str:
        return f"{self.url}{API_PATH}"

    @property
    def _headers(self) -> dict:
        return {KEY_HEADER: self._key}

    async def _get(self, path: str, params: dict | None = None, timeout: float = 10) -> dict:
        try:
            async with self._session.get(
                f"{self.base}{path}",
                headers=self._headers,
                params=params,
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                if resp.status == 401:
                    raise BeaconAuthError("Key rejected")
                if resp.status != 200:
                    raise BeaconError(f"{path}: HTTP {resp.status}")
                return await resp.json()
        except aiohttp.ClientError as e:
            raise BeaconError(str(e)) from e

    async def me(self) -> dict:
        """Who the key belongs to and what it may do."""
        return await self._get("/me")

    async def get_state(self) -> dict:
        self._player = await self._get("/player")
        return snapshot_of(self._player)

    async def query(self, path: str, params: dict | None = None) -> dict:
        if path == "devices":
            found = await self._get("/player/devices", params, timeout=30)
            return {
                "items": [
                    {**device, "in_use_by_name": device.get("in_use_by")}
                    for device in found.get("items", [])
                ]
            }
        if path == "albums":
            return {"items": await self._all_albums()}
        return await self._get(f"/library/{path}", params, timeout=30)

    async def _all_albums(self) -> list[dict]:
        albums: list[dict] = []
        while True:
            page = await self._get(
                "/library/albums", {"offset": len(albums), "limit": _ALBUM_PAGE}, timeout=30
            )
            albums += page.get("items", [])
            if len(page.get("items", [])) < _ALBUM_PAGE:
                return albums

    async def command(self, type_: str, payload: dict | None = None) -> None:
        await self._send(self._translated(type_, payload or {}))

    def _translated(self, type_: str, payload: dict) -> dict:
        """The older API toggles shuffle and autoplay and cycles repeat;
        here the wanted state is sent, worked out from the last one seen."""
        player = self._player
        if type_ in ("shuffle", "autoplay"):
            on = not player.get(type_)
            player[type_] = on
            return {"type": type_, "on": on}
        if type_ == "repeat":
            current = player.get("repeat") if player.get("repeat") in _REPEAT_ORDER else "off"
            mode = _REPEAT_ORDER[(_REPEAT_ORDER.index(current) + 1) % 3]
            player["repeat"] = mode
            return {"type": "repeat", "mode": mode}
        if type_ == "cast-to-many":
            devices = [
                {"type": t["deviceType"], "name": t["name"]} for t in payload.get("targets", [])
            ]
            return {"type": "devices", "devices": devices}
        if type_ not in _RENAMED:
            raise BeaconError(f"Unknown command {type_!r}")
        name, fields = _RENAMED[type_]
        command = {"type": name}
        for old, new in fields.items():
            if payload.get(old) is not None:
                command[new] = payload[old]
        if name in _STARTING and self._speakers:
            command["devices"] = self._speakers
        return command

    async def _send(self, command: dict) -> None:
        try:
            async with self._session.post(
                f"{self.base}/player/commands",
                headers=self._headers,
                json=command,
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status == 200:
                    if command["type"] == "devices":
                        self._speakers = []
                    return
                detail = await resp.text()
        except aiohttp.ClientError as e:
            raise BeaconError(str(e)) from e
        if command["type"] == "devices" and resp.status == 409 and "nothing_playing" in detail:
            # A server has nothing to move yet: the speakers are where the
            # next song starts.
            self._speakers = command["devices"]
            return
        raise BeaconError(f"{command['type']}: HTTP {resp.status} {detail}")

    # ── Images: the key goes in a header, so Home Assistant fetches these
    # through image() rather than handing the address to a browser.

    def image_url(self, snapshot: dict) -> str | None:
        """/player/cover, which needs no library right. Its address stays the
        same from song to song, so what it is for goes along: Home Assistant
        fetches the image again when the address changes."""
        song, radio = snapshot.get("current_song"), snapshot.get("radio")
        if song and song.get("cover_art_id"):
            subject = song["cover_art_id"]
        elif radio:
            subject = radio.get("name") or ""
        else:
            return None
        return str(URL(f"{self.base}/player/cover").with_query({"for": subject}))

    def cover_url(self, cover_art_id: str, session_id: str | None = None) -> str:
        return f"{self.base}/library/cover/{cover_art_id}"

    def station_logo_url(self, station: dict | None) -> str | None:
        if not station or not station.get("home_page_url"):
            return None
        return f"{self.base}/library/radio-stations/{station['id']}/logo"

    async def image(self, url: str) -> tuple[bytes | None, str | None]:
        try:
            async with self._session.get(
                url, headers=self._headers, timeout=aiohttp.ClientTimeout(total=15)
            ) as resp:
                if resp.status != 200:
                    return None, None
                return await resp.read(), resp.headers.get("Content-Type")
        except aiohttp.ClientError:
            return None, None

    async def listen(
        self,
        on_state: Callable[[dict], None],
        on_available: Callable[[bool], None],
    ) -> None:
        """Follows /player/events until cancelled, reconnecting on its own.
        A desktop app whose window is closed, or signed in as somebody else,
        is unavailable as when it is not running."""
        while True:
            try:
                async with self._session.get(
                    f"{self.base}/player/events",
                    headers=self._headers,
                    timeout=aiohttp.ClientTimeout(total=None, sock_read=45),
                ) as resp:
                    if resp.status != 200:
                        raise BeaconError(f"HTTP {resp.status}")
                    async for raw in resp.content:
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        try:
                            player = json.loads(line[5:].strip())
                        except ValueError:
                            _LOGGER.debug("Unparseable event: %s", line)
                            continue
                        self._player = player
                        on_available(bool(player.get("available")))
                        on_state(snapshot_of(player))
            except asyncio.CancelledError:
                raise
            except (BeaconError, aiohttp.ClientError, TimeoutError) as e:
                _LOGGER.debug("Event stream from %s ended: %s", self.url, e)
            on_available(False)
            await asyncio.sleep(RETRY_SECONDS)
