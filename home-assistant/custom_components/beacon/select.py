"""Where Beacon plays: this computer or one speaker. The switches cover
casting to several at once."""

from homeassistant.components.select import SelectEntity
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
    async_add_entities([BeaconSpeakerSelect(entry.runtime_data, device_id(entry), entry.title)])


class BeaconSpeakerSelect(BeaconEntity, SelectEntity):
    _attr_name = "Speaker"
    _attr_icon = "mdi:speaker"

    def __init__(self, coordinator: BeaconCoordinator, dev_id: str, title: str) -> None:
        super().__init__(coordinator, dev_id, title, "speaker")

    @property
    def options(self) -> list[str]:
        return self.coordinator.sources

    @property
    def current_option(self) -> str | None:
        # Several speakers at once is not one of the options; the switches
        # show that case.
        source = self.coordinator.source
        return source if source in self.options else None

    async def async_select_option(self, option: str) -> None:
        try:
            await self.coordinator.select_source(option)
        except BeaconError as e:
            raise HomeAssistantError(f"Beacon: {e}") from e
