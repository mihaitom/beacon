"""The integration key's repair: the same Beacon, with a device key."""

from typing import Any

import voluptuous as vol
from homeassistant.components.repairs import RepairsFlow
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult

from .config_flow import base_url, check_device_key
from .const import API_V1, CONF_API, CONF_INSTANCE_ID, CONF_KEY, CONF_URL


async def async_create_fix_flow(
    hass: HomeAssistant, issue_id: str, data: dict[str, Any] | None
) -> RepairsFlow:
    return DeviceKeyRepair((data or {}).get("entry_id", ""))


class DeviceKeyRepair(RepairsFlow):
    def __init__(self, entry_id: str) -> None:
        self._entry_id = entry_id

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        return await self.async_step_key()

    async def async_step_key(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        entry = self.hass.config_entries.async_get_entry(self._entry_id)
        if entry is None:
            return self.async_abort(reason="entry_gone")
        errors: dict[str, str] = {}
        if user_input is not None:
            url, key = base_url(user_input[CONF_URL]), user_input[CONF_KEY].strip()
            error = await check_device_key(self.hass, url, key)
            if error:
                errors["base"] = error
            else:
                data = {CONF_URL: url, CONF_KEY: key, CONF_API: API_V1}
                if entry.data.get(CONF_INSTANCE_ID):
                    data[CONF_INSTANCE_ID] = entry.data[CONF_INSTANCE_ID]
                # The entry keeps its entities and their ids; only how it
                # reaches Beacon changes. The reload clears this repair.
                self.hass.config_entries.async_update_entry(entry, data=data)
                await self.hass.config_entries.async_reload(entry.entry_id)
                return self.async_create_entry(data={})
        address = f"http://{entry.data.get(CONF_HOST)}:{entry.data.get(CONF_PORT)}"
        return self.async_show_form(
            step_id="key",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_URL, default=address): str,
                    vol.Required(CONF_KEY): str,
                }
            ),
            description_placeholders={"name": entry.title},
            errors=errors,
        )
