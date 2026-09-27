"""Set up by hand (host, port, key) or from the mDNS announcement."""

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from .api import BeaconAuthError, BeaconClient, BeaconError
from .const import CONF_ACTIVE, CONF_INSTANCE_ID, CONF_KEY, CONF_SHOW_DASHBOARD, DOMAIN


class BeaconConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return BeaconOptionsFlow()

    @classmethod
    @callback
    def async_supports_options_flow(cls, config_entry: ConfigEntry) -> bool:
        # Only the active Beacon has options: whether its dashboard shows.
        return bool(config_entry.data.get(CONF_ACTIVE))

    def __init__(self) -> None:
        self._host: str | None = None
        self._port: int | None = None
        self._instance_id: str | None = None
        self._name = "Beacon"

    async def _check(self, host: str, port: int, key: str) -> str | None:
        try:
            await BeaconClient(async_get_clientsession(self.hass), host, port, key).get_state()
        except BeaconAuthError:
            return "invalid_auth"
        except BeaconError:
            return "cannot_connect"
        return None

    async def async_step_import(
        self, import_data: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """The active Beacon (hub.py), created by the first instance."""
        await self.async_set_unique_id("active")
        self._abort_if_unique_id_configured()
        return self.async_create_entry(title="Beacon (active)", data={CONF_ACTIVE: True})

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            error = await self._check(
                user_input[CONF_HOST], user_input[CONF_PORT], user_input[CONF_KEY]
            )
            if error:
                errors["base"] = error
            else:
                await self.async_set_unique_id(f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}")
                self._abort_if_unique_id_configured()
                # Not plain "Beacon": that is the active Beacon's device (hub.py).
                return self.async_create_entry(
                    title=f"Beacon on {user_input[CONF_HOST]}", data=user_input
                )
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST): str,
                    vol.Required(CONF_PORT, default=7071): int,
                    vol.Required(CONF_KEY): str,
                }
            ),
            errors=errors,
        )

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> ConfigFlowResult:
        instance_id = discovery_info.properties.get("id")
        if not instance_id:
            return self.async_abort(reason="not_supported")
        self._host = str(discovery_info.ip_address)
        self._port = discovery_info.port
        self._instance_id = instance_id
        self._name = discovery_info.name.split("._beacon._tcp")[0]
        await self.async_set_unique_id(instance_id)
        # Already set up: follow a changed port or address, which is the
        # point of the announcement. Home Assistant reloads the entry itself
        # when this changes its data.
        self._abort_if_unique_id_configured(updates={CONF_HOST: self._host, CONF_PORT: self._port})
        self.context["title_placeholders"] = {"name": self._name}
        return await self.async_step_zeroconf_confirm()

    async def async_step_zeroconf_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            error = await self._check(self._host, self._port, user_input[CONF_KEY])
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(
                    title=self._name,
                    data={
                        CONF_HOST: self._host,
                        CONF_PORT: self._port,
                        CONF_KEY: user_input[CONF_KEY],
                        CONF_INSTANCE_ID: self._instance_id,
                    },
                )
        return self.async_show_form(
            step_id="zeroconf_confirm",
            data_schema=vol.Schema({vol.Required(CONF_KEY): str}),
            description_placeholders={"name": self._name, "host": f"{self._host}:{self._port}"},
            errors=errors,
        )


class BeaconOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            # Merged, not replaced: the options also hold the pinned instance.
            return self.async_create_entry(data={**self.config_entry.options, **user_input})
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_SHOW_DASHBOARD,
                        default=self.config_entry.options.get(CONF_SHOW_DASHBOARD, True),
                    ): bool
                }
            ),
        )
