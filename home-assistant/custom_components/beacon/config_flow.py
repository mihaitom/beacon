"""Set up by hand (address and key) or from the mDNS announcement.

A device key (it has a dot in it) uses the app API, api_v1.py; a key from
Beacon's older Home automation setting still sets up the way it used to."""

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo
from yarl import URL

from .api import BeaconAuthError, BeaconClient, BeaconError
from .api_v1 import BeaconV1Client
from .const import (
    API_V1,
    CONF_ACTIVE,
    CONF_API,
    CONF_INSTANCE_ID,
    CONF_KEY,
    CONF_SHOW_DASHBOARD,
    CONF_URL,
    DOMAIN,
)

# The desktop app's port when it was given a fixed one in the guide.
DEFAULT_PORT = 7071


def is_device_key(key: str) -> bool:
    return "." in key.strip()


async def check_device_key(hass: HomeAssistant, url: str, key: str) -> str | None:
    """None, or the form error for why this key will not do."""
    try:
        me = await BeaconV1Client(async_get_clientsession(hass), url, key.strip()).me()
    except BeaconAuthError:
        return "invalid_auth"
    except BeaconError:
        return "cannot_connect"
    return None if "control" in me.get("scopes", []) else "no_control"


def address_of(url: str) -> tuple[str, int]:
    parsed = URL(url if "://" in url else f"http://{url}")
    return parsed.host or "", parsed.explicit_port or DEFAULT_PORT


def base_url(url: str) -> str:
    url = url.strip().rstrip("/")
    return url if "://" in url else f"http://{url}"


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
        self._announces_api = False
        self._name = "Beacon"

    async def _check_legacy(self, host: str, port: int, key: str) -> str | None:
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
            url, key = base_url(user_input[CONF_URL]), user_input[CONF_KEY].strip()
            host, port = address_of(url)
            if is_device_key(key):
                error = await check_device_key(self.hass, url, key)
                data = {CONF_URL: url, CONF_KEY: key, CONF_API: API_V1}
                unique_id = url
            else:
                error = await self._check_legacy(host, port, key)
                data = {CONF_HOST: host, CONF_PORT: port, CONF_KEY: key}
                unique_id = f"{host}:{port}"
            if error:
                errors["base"] = error
            else:
                await self.async_set_unique_id(unique_id)
                self._abort_if_unique_id_configured()
                # Not plain "Beacon": that is the active Beacon's device (hub.py).
                return self.async_create_entry(title=f"Beacon on {host}", data=data)
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {vol.Required(CONF_URL): str, vol.Required(CONF_KEY): str}
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
        self._announces_api = bool(discovery_info.properties.get("api"))
        self._name = discovery_info.name.split("._beacon._tcp")[0]
        await self.async_set_unique_id(instance_id)
        # Already set up: follow a changed port or address, which is the
        # point of the announcement. Home Assistant reloads the entry itself
        # when this changes its data.
        existing = next(
            (e for e in self._async_current_entries() if e.unique_id == instance_id), None
        )
        if existing is not None and existing.data.get(CONF_API) == API_V1:
            updates: dict = {CONF_URL: f"http://{self._host}:{self._port}"}
        else:
            updates = {CONF_HOST: self._host, CONF_PORT: self._port}
        self._abort_if_unique_id_configured(updates=updates)
        self.context["title_placeholders"] = {"name": self._name}
        return await self.async_step_zeroconf_confirm()

    async def async_step_zeroconf_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            key = user_input[CONF_KEY].strip()
            url = f"http://{self._host}:{self._port}"
            if is_device_key(key) and self._announces_api:
                error = await check_device_key(self.hass, url, key)
                data = {CONF_URL: url, CONF_KEY: key, CONF_API: API_V1}
            else:
                error = await self._check_legacy(self._host, self._port, key)
                data = {CONF_HOST: self._host, CONF_PORT: self._port, CONF_KEY: key}
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(
                    title=self._name, data={**data, CONF_INSTANCE_ID: self._instance_id}
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
