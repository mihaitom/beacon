"""Pick a cast back up after a speaker dropped out, and look for speakers."""

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import device_id
from .api import BeaconError
from .coordinator import BeaconCoordinator
from .entity import BeaconEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator = entry.runtime_data
    dev_id = device_id(entry)
    async_add_entities(
        [
            BeaconResumeButton(coordinator, dev_id, entry.title),
            BeaconRescanButton(coordinator, dev_id, entry.title),
        ]
    )


class BeaconResumeButton(BeaconEntity, ButtonEntity):
    """Only there while a cast was interrupted - the same condition Beacon's
    own "carry on?" prompt stands for."""

    _attr_name = "Resume cast"
    _attr_icon = "mdi:cast-connected"

    def __init__(self, coordinator: BeaconCoordinator, dev_id: str, title: str) -> None:
        super().__init__(coordinator, dev_id, title, "resume_cast")

    @property
    def available(self) -> bool:
        return self.coordinator.available and bool(self.coordinator.snapshot.get("interrupted"))

    async def async_press(self) -> None:
        try:
            await self.coordinator.client.command("resume-interrupted")
        except BeaconError as e:
            raise HomeAssistantError(f"Beacon: {e}") from e


class BeaconRescanButton(BeaconEntity, ButtonEntity):
    _attr_name = "Scan for speakers"
    _attr_icon = "mdi:magnify"

    def __init__(self, coordinator: BeaconCoordinator, dev_id: str, title: str) -> None:
        super().__init__(coordinator, dev_id, title, "rescan")

    async def async_press(self) -> None:
        await self.coordinator.refresh_devices(rescan=True)
