"""Beacon as a media player: state, transport, speakers as sources, and the
library in Home Assistant's media browser."""

import logging
import unicodedata

from homeassistant.components.media_player import (
    BrowseMedia,
    MediaClass,
    MediaPlayerEnqueue,
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
    MediaType,
    RepeatMode,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from . import device_id
from .api import BeaconError
from .coordinator import BeaconCoordinator
from .entity import BeaconEntity

_LOGGER = logging.getLogger(__name__)

# Beacon's own cycle order for the "repeat" command.
_REPEAT_ORDER = ["off", "all", "one"]


def album_letter(name: str) -> str:
    """A-Z by the first letter, umlauts and accents under their base letter,
    leading punctuation skipped; digits and other scripts under "#"."""
    for char in unicodedata.normalize("NFKD", name):
        if char.isalpha() and char.isascii():
            return char.upper()
        if char.isalnum():
            return "#"
    return "#"
    return "#"


_FEATURES = (
    MediaPlayerEntityFeature.PLAY
    | MediaPlayerEntityFeature.PAUSE
    | MediaPlayerEntityFeature.NEXT_TRACK
    | MediaPlayerEntityFeature.PREVIOUS_TRACK
    | MediaPlayerEntityFeature.SEEK
    | MediaPlayerEntityFeature.VOLUME_SET
    | MediaPlayerEntityFeature.SHUFFLE_SET
    | MediaPlayerEntityFeature.REPEAT_SET
    | MediaPlayerEntityFeature.SELECT_SOURCE
    | MediaPlayerEntityFeature.BROWSE_MEDIA
    | MediaPlayerEntityFeature.PLAY_MEDIA
    | MediaPlayerEntityFeature.MEDIA_ENQUEUE
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    async_add_entities([BeaconPlayer(entry.runtime_data, device_id(entry), entry.title)])


class BeaconPlayer(BeaconEntity, MediaPlayerEntity):
    _attr_name = None
    _attr_supported_features = _FEATURES
    _attr_media_content_type = MediaType.MUSIC

    def __init__(self, coordinator: BeaconCoordinator, dev_id: str, title: str) -> None:
        super().__init__(coordinator, dev_id, title, "")
        self._position_at = dt_util.utcnow()
        self._last_snapshot: dict | None = None

    @property
    def _snapshot(self) -> dict:
        snapshot = self.coordinator.snapshot
        if snapshot is not self._last_snapshot:
            self._last_snapshot = snapshot
            self._position_at = dt_util.utcnow()
        return snapshot

    async def _send(self, type_: str, payload: dict | None = None) -> None:
        try:
            await self.coordinator.client.command(type_, payload)
        except BeaconError as e:
            raise HomeAssistantError(f"Beacon: {e}") from e

    # ── State ────────────────────────────────────────────────────────────

    @property
    def _song(self) -> dict | None:
        return self._snapshot.get("current_song")

    @property
    def _radio(self) -> dict | None:
        return self._snapshot.get("radio")

    @property
    def state(self) -> MediaPlayerState:
        if not self._song and not self._radio:
            return MediaPlayerState.IDLE
        return (
            MediaPlayerState.PLAYING if self._snapshot.get("playing") else MediaPlayerState.PAUSED
        )

    @property
    def media_title(self) -> str | None:
        if self._song:
            return self._song.get("title")
        if self._radio:
            return self._radio.get("now_playing") or self._radio.get("name")
        return None

    @property
    def media_artist(self) -> str | None:
        if self._song:
            return self._song.get("artist")
        return self._radio.get("name") if self._radio else None

    @property
    def media_album_name(self) -> str | None:
        return self._song.get("album") if self._song else None

    @property
    def media_duration(self) -> float | None:
        return self._snapshot.get("duration") if self._song else None

    @property
    def media_position(self) -> float | None:
        return self._snapshot.get("position") if self._song else None

    @property
    def media_position_updated_at(self):
        _ = self._snapshot
        return self._position_at

    @property
    def media_image_url(self) -> str | None:
        client = self.coordinator.client
        if self._song and self._song.get("cover_art_id"):
            return client.cover_url(self._song["cover_art_id"], self._snapshot.get("session_id"))
        if self._radio:
            return self._radio.get("favicon_url")
        return None

    @property
    def volume_level(self) -> float | None:
        device = self._snapshot.get("device_volume")
        if device is not None:
            return device / 100
        return self._snapshot.get("volume")

    @property
    def shuffle(self) -> bool | None:
        return self._snapshot.get("shuffle")

    @property
    def repeat(self) -> RepeatMode | None:
        mode = self._snapshot.get("repeat")
        return RepeatMode(mode) if mode in _REPEAT_ORDER else None

    @property
    def source_list(self) -> list[str]:
        return self.coordinator.sources

    @property
    def source(self) -> str:
        return self.coordinator.source

    @property
    def extra_state_attributes(self) -> dict:
        return {
            "casting_to": [t.get("name") for t in self.coordinator.casting],
            "interrupted": bool(self._snapshot.get("interrupted")),
        }

    # ── Transport ────────────────────────────────────────────────────────

    async def async_media_play(self) -> None:
        await self._send("play")

    async def async_media_pause(self) -> None:
        await self._send("pause")

    async def async_media_next_track(self) -> None:
        await self._send("next")

    async def async_media_previous_track(self) -> None:
        await self._send("previous")

    async def async_media_seek(self, position: float) -> None:
        await self._send("seek", {"position": position})

    async def async_set_volume_level(self, volume: float) -> None:
        await self._send("volume", {"volume": volume})

    async def async_set_shuffle(self, shuffle: bool) -> None:
        # Beacon only toggles.
        if bool(self._snapshot.get("shuffle")) != shuffle:
            await self._send("shuffle")

    async def async_set_repeat(self, repeat: RepeatMode) -> None:
        # Beacon only cycles off -> all -> one, so step to the wanted mode.
        current = self._snapshot.get("repeat", "off")
        if current not in _REPEAT_ORDER:
            current = "off"
        steps = (_REPEAT_ORDER.index(repeat.value) - _REPEAT_ORDER.index(current)) % 3
        for _ in range(steps):
            await self._send("repeat")

    async def async_select_source(self, source: str) -> None:
        try:
            await self.coordinator.select_source(source)
        except BeaconError as e:
            raise HomeAssistantError(f"Beacon: {e}") from e

    # ── Library ──────────────────────────────────────────────────────────
    #
    # Content ids: "queue:<index>:<songId>", "playlist:<id>",
    # "playlist:<id>:<index>:<songId>", "album:<id>", "radio:<id>",
    # "song:<id>", "songradio:<id>". A song's own id rides along wherever it
    # is known, so "play next"/"add to queue" works from any list.

    async def async_play_media(
        self,
        media_type: MediaType | str,
        media_id: str,
        enqueue: MediaPlayerEnqueue | None = None,
        **kwargs,
    ) -> None:
        kind, _, rest = media_id.partition(":")
        queueing = enqueue in (MediaPlayerEnqueue.ADD, MediaPlayerEnqueue.NEXT)
        parts = rest.split(":")
        # A song picked out of a list is queued as that song.
        song_in_list = (kind == "queue" and len(parts) >= 2) or (
            kind == "playlist" and len(parts) >= 3
        )
        if queueing and song_in_list and parts[-1]:
            kind, rest = "song", parts[-1]
        if kind == "song":
            if enqueue == MediaPlayerEnqueue.NEXT:
                await self._send("queue-next", {"songId": rest})
            elif enqueue == MediaPlayerEnqueue.ADD:
                await self._send("queue-add", {"songId": rest})
            else:
                await self._send("play-song", {"songId": rest})
            return
        if queueing:
            raise HomeAssistantError("Beacon can only queue single songs")
        if kind == "queue":
            await self._send("queue-jump", {"index": int(parts[0])})
        elif kind == "playlist":
            payload: dict = {"playlistId": await self._resolve("playlists", parts[0])}
            if len(parts) > 1:
                payload["startIndex"] = int(parts[1])
            await self._send("play-playlist", payload)
        elif kind == "album":
            await self._send("play-album", {"albumId": rest})
        elif kind == "radio":
            await self._send(
                "play-radio-station", {"stationId": await self._resolve("radio-stations", rest)}
            )
        elif kind == "songradio":
            await self._send("play-song-radio", {"songId": rest})
        else:
            raise HomeAssistantError(f"Unknown media: {media_id}")

    async def _resolve(self, path: str, id_or_name: str) -> str:
        """Takes a playlist's or station's name as well as its id, so a
        dashboard button can say "playlist:Classic Rock" instead of an id
        nobody can see anywhere."""
        items = (await self._query(path)).get("items", [])
        if any(item["id"] == id_or_name for item in items):
            return id_or_name
        wanted = id_or_name.casefold()
        match = next((item for item in items if item.get("name", "").casefold() == wanted), None)
        if match is None:
            raise HomeAssistantError(
                f"Beacon has no {path.rstrip('s').replace('-', ' ')} {id_or_name!r}"
            )
        return match["id"]

    def _thumb(self, content_type: str, content_id: str, cover_id: str | None) -> str | None:
        # Through Home Assistant's image proxy: the direct URL carries the key.
        if not cover_id:
            return None
        return self.get_browse_image_url(content_type, content_id, cover_id)

    async def async_get_browse_image(
        self,
        media_content_type: MediaType | str,
        media_content_id: str,
        media_image_id: str | None = None,
    ) -> tuple[bytes | None, str | None]:
        if not media_image_id:
            return None, None
        client = self.coordinator.client
        if media_content_id.startswith("radio:"):
            station = next(
                (s for s in self._stations if f"radio:{s['id']}" == media_content_id), None
            )
            url = client.favicon_url(
                station.get("home_page_url") if station else None,
                station.get("favicon_hint") if station else None,
            )
        else:
            url = client.cover_url(media_image_id, self._snapshot.get("session_id"))
        if not url:
            return None, None
        return await self._async_fetch_image(url)

    _stations: list[dict] = []

    async def _query(self, path: str, params: dict | None = None) -> dict:
        try:
            return await self.coordinator.client.query(path, params)
        except BeaconError as e:
            raise HomeAssistantError(f"Beacon: {e}") from e

    def _song_item(self, song: dict, content_id: str, can_expand: bool = False) -> BrowseMedia:
        return BrowseMedia(
            media_class=MediaClass.TRACK,
            media_content_id=content_id,
            media_content_type=MediaType.TRACK,
            title=f"{song.get('title', '?')} – {song.get('artist', '')}",
            can_play=True,
            can_expand=can_expand,
            thumbnail=self._thumb(MediaType.TRACK, content_id, song.get("cover_art_id")),
        )

    def _folder(self, title: str, content_id: str, children=None, icon_class=MediaClass.DIRECTORY):
        return BrowseMedia(
            media_class=icon_class,
            media_content_id=content_id,
            media_content_type="folder",
            title=title,
            can_play=False,
            can_expand=True,
            children=children,
            children_media_class=None,
        )

    async def _albums(self) -> list[dict]:
        try:
            return await self.coordinator.albums()
        except BeaconError as e:
            raise HomeAssistantError(f"Beacon: {e}") from e

    async def async_browse_media(
        self,
        media_content_type: MediaType | str | None = None,
        media_content_id: str | None = None,
    ) -> BrowseMedia:
        if not media_content_id or media_content_id == "root":
            current = self._song
            song_radio = (
                [
                    BrowseMedia(
                        media_class=MediaClass.CHANNEL,
                        media_content_id=f"songradio:{current['id']}",
                        media_content_type=MediaType.CHANNEL,
                        title=f"Radio from “{current.get('title', '')}”",
                        can_play=True,
                        can_expand=False,
                    )
                ]
                if current and current.get("id") and self._snapshot.get("song_radio_supported")
                else []
            )
            return self._folder(
                "Beacon",
                "root",
                song_radio
                + [
                    self._folder("Queue", "queue", icon_class=MediaClass.PLAYLIST),
                    self._folder("Playlists", "playlists", icon_class=MediaClass.PLAYLIST),
                    self._folder("Albums", "albums", icon_class=MediaClass.ALBUM),
                    self._folder("Radio", "radios", icon_class=MediaClass.CHANNEL),
                ],
            )

        if media_content_id == "queue":
            queue = self._snapshot.get("queue") or []
            current = self._snapshot.get("queue_index")
            children = []
            for i, song in enumerate(queue):
                item = self._song_item(song, f"queue:{i}:{song.get('id', '')}")
                if i == current:
                    item.title = f"▶ {item.title}"
                children.append(item)
            return self._folder("Queue", "queue", children)

        if media_content_id == "playlists":
            result = await self._query("playlists")
            children = [
                BrowseMedia(
                    media_class=MediaClass.PLAYLIST,
                    media_content_id=f"playlist:{p['id']}",
                    media_content_type=MediaType.PLAYLIST,
                    title=f"{p['name']} ({p.get('song_count', 0)})",
                    can_play=True,
                    can_expand=True,
                    thumbnail=self._thumb(
                        MediaType.PLAYLIST, f"playlist:{p['id']}", p.get("cover_art_id")
                    ),
                )
                for p in result.get("items", [])
            ]
            return self._folder("Playlists", "playlists", children)

        if media_content_id.startswith("playlist:"):
            playlist_id = media_content_id.split(":", 1)[1]
            result = await self._query(f"playlists/{playlist_id}")
            playlist = result.get("playlist", {})
            children = [
                self._song_item(song, f"playlist:{playlist_id}:{i}:{song.get('id', '')}")
                for i, song in enumerate(result.get("songs", []))
            ]
            return BrowseMedia(
                media_class=MediaClass.PLAYLIST,
                media_content_id=media_content_id,
                media_content_type=MediaType.PLAYLIST,
                title=playlist.get("name", "Playlist"),
                can_play=True,
                can_expand=True,
                children=children,
            )

        if media_content_id == "albums":
            albums = await self._albums()
            counts: dict[str, int] = {}
            for album in albums:
                letter = album_letter(album.get("name", ""))
                counts[letter] = counts.get(letter, 0) + 1
            letters = sorted(counts, key=lambda letter: (letter == "#", letter))
            children = [
                self._folder(
                    f"{letter} ({counts[letter]})", f"albums:{letter}", icon_class=MediaClass.ALBUM
                )
                for letter in letters
            ]
            return self._folder(f"Albums ({len(albums)})", "albums", children)

        if media_content_id.startswith("albums:"):
            letter = media_content_id.split(":", 1)[1]
            albums = sorted(
                (a for a in await self._albums() if album_letter(a.get("name", "")) == letter),
                key=lambda a: (a.get("name", "").casefold(), a.get("artist", "").casefold()),
            )
            children = [
                BrowseMedia(
                    media_class=MediaClass.ALBUM,
                    media_content_id=f"album:{a['id']}",
                    media_content_type=MediaType.ALBUM,
                    title=f"{a['name']} – {a.get('artist', '')}",
                    can_play=True,
                    can_expand=False,
                    thumbnail=self._thumb(
                        MediaType.ALBUM, f"album:{a['id']}", a.get("cover_art_id")
                    ),
                )
                for a in albums
            ]
            return self._folder(f"Albums: {letter}", media_content_id, children)

        if media_content_id == "radios":
            result = await self._query("radio-stations")
            BeaconPlayer._stations = result.get("items", [])
            children = [
                BrowseMedia(
                    media_class=MediaClass.CHANNEL,
                    media_content_id=f"radio:{s['id']}",
                    media_content_type=MediaType.CHANNEL,
                    title=s["name"],
                    can_play=True,
                    can_expand=False,
                    thumbnail=self._thumb(
                        MediaType.CHANNEL,
                        f"radio:{s['id']}",
                        s["id"] if (s.get("home_page_url") or s.get("favicon_hint")) else None,
                    ),
                )
                for s in BeaconPlayer._stations
            ]
            return self._folder("Radio", "radios", children)

        raise HomeAssistantError(f"Unknown folder: {media_content_id}")
