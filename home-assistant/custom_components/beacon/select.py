"""Where Beacon plays: this computer or one speaker. The switches cover
casting to several at once."""

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import BeaconError
from .entity import BeaconEntity, is_active
from .hub import AUTOMATIC, BeaconHub


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    source = entry.runtime_data
    entities: list[SelectEntity] = [BeaconSpeakerSelect(source, entry)]
    if is_active(entry):
        entities.append(BeaconInstanceSelect(source, entry))
    async_add_entities(entities)


class BeaconSpeakerSelect(BeaconEntity, SelectEntity):
    _attr_name = "Speaker"
    _attr_icon = "mdi:speaker"

    _key = "speaker"

    def __init__(self, source, entry: ConfigEntry) -> None:
        super().__init__(source, entry, "select")

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


class BeaconInstanceSelect(BeaconEntity, SelectEntity):
    """Which Beacon the active one follows: automatic, or pinned to one."""

    _attr_name = "Instance"
    _attr_icon = "mdi:laptop"
    _key = "instance"

    def __init__(self, hub: BeaconHub, entry: ConfigEntry) -> None:
        super().__init__(hub, entry, "select")
        self._hub = hub

    @property
    def available(self) -> bool:
        # Choosing stays possible while nothing runs.
        return True

    @property
    def options(self) -> list[str]:
        return [AUTOMATIC, *self._hub.labels.values()]

    @property
    def current_option(self) -> str:
        pinned = self._hub.pinned
        return self._hub.labels[pinned] if pinned else AUTOMATIC

    @property
    def extra_state_attributes(self) -> dict:
        return {"following": self._hub.active_label}

    async def async_select_option(self, option: str) -> None:
        self._hub.pin(option)
