"""The queue, for dashboards: its length as the state, the songs as an
attribute. And what is playing as plain text, so history and logbook show
the songs themselves rather than only playing/paused."""

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import device_id
from .coordinator import BeaconCoordinator
from .entity import BeaconEntity

# Enough for a dashboard; a long queue would bloat the state machine.
MAX_LISTED = 50


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = entry.runtime_data
    dev_id = device_id(entry)
    async_add_entities(
        [
            BeaconQueueSensor(coordinator, dev_id, entry.title),
            BeaconNowPlayingSensor(coordinator, dev_id, entry.title),
        ]
    )


class BeaconQueueSensor(BeaconEntity, SensorEntity):
    _attr_name = "Queue"
    _attr_icon = "mdi:playlist-music"
    _attr_native_unit_of_measurement = "songs"

    def __init__(self, coordinator: BeaconCoordinator, dev_id: str, title: str) -> None:
        super().__init__(coordinator, dev_id, title, "queue")

    @property
    def native_value(self) -> int:
        return len(self.coordinator.snapshot.get("queue") or [])

    @property
    def extra_state_attributes(self) -> dict:
        queue = self.coordinator.snapshot.get("queue") or []
        index = self.coordinator.snapshot.get("queue_index") or 0
        upcoming = queue[index + 1 : index + 1 + MAX_LISTED]
        return {
            "position": index + 1 if queue else 0,
            "up_next": [f"{s.get('title', '?')} – {s.get('artist', '')}" for s in upcoming],
        }


class BeaconNowPlayingSensor(BeaconEntity, SensorEntity):
    _attr_name = "Now playing"
    _attr_icon = "mdi:music-note"

    def __init__(self, coordinator: BeaconCoordinator, dev_id: str, title: str) -> None:
        super().__init__(coordinator, dev_id, title, "now_playing")

    @property
    def native_value(self) -> str | None:
        snapshot = self.coordinator.snapshot
        song = snapshot.get("current_song")
        if song:
            artist = song.get("artist")
            title = song.get("title", "?")
            # A state is at most 255 characters.
            return (f"{artist} – {title}" if artist else title)[:255]
        radio = snapshot.get("radio")
        if radio:
            tag = radio.get("now_playing")
            return (f"{radio.get('name')}: {tag}" if tag else radio.get("name", "Radio"))[:255]
        return None

    @property
    def extra_state_attributes(self) -> dict:
        song = self.coordinator.snapshot.get("current_song") or {}
        return {
            "album": song.get("album"),
            "playing": bool(self.coordinator.snapshot.get("playing")),
        }
