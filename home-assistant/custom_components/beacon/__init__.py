"""Beacon: control Beacon, the desktop app or a server's casts, from Home Assistant."""

from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import dashboard
from .api import BeaconClient
from .api_v1 import BeaconV1Client
from .const import API_V1, CONF_API, CONF_KEY, CONF_SHOW_DASHBOARD, CONF_URL, DOMAIN
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
        _apply_dashboard(hass, entry)
        # The options also hold the pinned instance, which changes without a
        # reload; the dashboard switch is the only one that needs acting on.
        entry.async_on_unload(entry.add_update_listener(_options_updated))
        entry.async_on_unload(lambda: dashboard.remove(hass))
        return True

    client = make_client(hass, entry.data)
    _flag_integration_key(hass, entry)
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


def make_client(hass: HomeAssistant, data: dict) -> BeaconClient | BeaconV1Client:
    session = async_get_clientsession(hass)
    if data.get(CONF_API) == API_V1:
        return BeaconV1Client(session, data[CONF_URL], data[CONF_KEY])
    return BeaconClient(session, data[CONF_HOST], data[CONF_PORT], data[CONF_KEY])


def _flag_integration_key(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Beacon retires the integration key: an entry still using it gets a
    repair that switches it to a device key (repairs.py)."""
    issue_id = f"integration_key_{entry.entry_id}"
    if entry.data.get(CONF_API) == API_V1:
        ir.async_delete_issue(hass, DOMAIN, issue_id)
        return
    ir.async_create_issue(
        hass,
        DOMAIN,
        issue_id,
        is_fixable=True,
        severity=ir.IssueSeverity.WARNING,
        translation_key="integration_key_retiring",
        translation_placeholders={"name": entry.title},
        data={"entry_id": entry.entry_id},
    )


def _apply_dashboard(hass: HomeAssistant, entry: ConfigEntry) -> None:
    if entry.options.get(CONF_SHOW_DASHBOARD, True):
        dashboard.register(hass)
    else:
        dashboard.remove(hass)


async def _options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    _apply_dashboard(hass, entry)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    ir.async_delete_issue(hass, DOMAIN, f"integration_key_{entry.entry_id}")
