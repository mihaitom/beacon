"""Beacon: control the Beacon desktop app from Home Assistant."""

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import BeaconClient
from .const import CONF_INSTANCE_ID, CONF_KEY
from .coordinator import BeaconCoordinator

PLATFORMS = [
    Platform.MEDIA_PLAYER,
    Platform.SELECT,
    Platform.SWITCH,
    Platform.BUTTON,
    Platform.SENSOR,
]


def device_id(entry: ConfigEntry) -> str:
    return entry.data.get(CONF_INSTANCE_ID) or entry.unique_id or entry.entry_id


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
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
    entry.async_on_unload(coordinator.stop)
    # A rediscovery with a new port/address updates entry.data; reload so
    # the client follows it.
    entry.async_on_unload(entry.add_update_listener(_reload))
    return True


async def _reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
