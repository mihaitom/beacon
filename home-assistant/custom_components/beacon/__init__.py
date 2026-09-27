"""Beacon: control the Beacon desktop app from Home Assistant."""

from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import BeaconClient
from .const import CONF_KEY, DOMAIN
from .coordinator import BeaconCoordinator
from .entity import is_active
from .hub import get_hub

PLATFORMS = [
    Platform.MEDIA_PLAYER,
    Platform.SELECT,
    Platform.SWITCH,
    Platform.BUTTON,
    Platform.SENSOR,
]
ACTIVE_UNIQUE_ID = "active"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hub = get_hub(hass)

    if is_active(entry):
        hub.entry = entry
        entry.runtime_data = hub
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
        return True

    client = BeaconClient(
        async_get_clientsession(hass),
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data[CONF_KEY],
    )
    coordinator = BeaconCoordinator(hass, client)
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    coordinator.start()
    hub.add(entry, coordinator)
    entry.async_on_unload(coordinator.stop)
    entry.async_on_unload(lambda: hub.remove(entry.entry_id))

    # The active Beacon is an entry of its own, created with the first
    # instance so there is nothing extra to set up.
    if not any(e.unique_id == ACTIVE_UNIQUE_ID for e in hass.config_entries.async_entries(DOMAIN)):
        hass.async_create_task(
            hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_IMPORT})
        )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
