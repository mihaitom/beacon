from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import CONF_ACTIVE, CONF_INSTANCE_ID, DOMAIN
from .coordinator import BeaconCoordinator

ACTIVE_DEVICE = "active"


def is_active(entry: ConfigEntry) -> bool:
    """The entry behind the active Beacon (hub.py), not an instance."""
    return bool(entry.data.get(CONF_ACTIVE))


def instance_id(entry: ConfigEntry) -> str:
    return entry.data.get(CONF_INSTANCE_ID) or entry.unique_id or entry.entry_id


class BeaconEntity(Entity):
    """`source` is an instance's coordinator or the hub; both have a
    `coordinator` and `add_listener`.

    The active Beacon's entities get fixed ids (media_player.beacon,
    select.beacon_speaker, ...) - those are what a shared dashboard uses.
    An instance's are named after it ("Beacon on <host>")."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    # Unique within a device; empty for the device's main entity.
    _key = ""
    # The active Beacon's entity id suffix, where it should read better
    # than the key (which stays as it is: it is part of the unique id).
    _object_id = ""

    def __init__(self, source, entry: ConfigEntry, domain: str) -> None:
        self._source = source
        if is_active(entry):
            device, name = ACTIVE_DEVICE, "Beacon"
            suffix = self._object_id or self._key
            self.entity_id = f"{domain}.beacon" + (f"_{suffix}" if suffix else "")
        else:
            device, name = instance_id(entry), entry.title
        self._attr_unique_id = f"{device}_{self._key}" if self._key else device
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, device)}, name=name, manufacturer="Beacon"
        )

    @property
    def coordinator(self) -> BeaconCoordinator:
        return self._source.coordinator

    @property
    def available(self) -> bool:
        return self.coordinator.available

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._source.add_listener(self.async_write_ha_state))
