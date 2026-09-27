from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN
from .coordinator import BeaconCoordinator


class BeaconEntity(Entity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self, coordinator: BeaconCoordinator, device_id: str, title: str, key: str
    ) -> None:
        self.coordinator = coordinator
        self._attr_unique_id = f"{device_id}_{key}" if key else device_id
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, device_id)},
            # Not the entry's title ("Beacon on <host>"): a fixed device name
            # gives every install the same entity ids, which is what lets a
            # dashboard be shared.
            name="Beacon",
            manufacturer="Beacon",
        )

    @property
    def available(self) -> bool:
        return self.coordinator.available

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.coordinator.add_listener(self.async_write_ha_state))
