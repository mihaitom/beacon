"""One switch per speaker (cast to it, alongside whatever else is playing),
and Autoplay."""

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import BeaconError
from .coordinator import BeaconCoordinator
from .entity import BeaconEntity, is_active

_TYPE_LABELS = {"sonos": "Sonos", "airplay": "AirPlay", "chromecast": "Chromecast", "dlna": "DLNA"}


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    source = entry.runtime_data
    async_add_entities([BeaconAutoplaySwitch(source, entry)])
    # Speakers belong to one computer, so only its own device gets a switch
    # for each; the active Beacon has select.beacon_speaker instead.
    if is_active(entry):
        return

    coordinator: BeaconCoordinator = source
    known: set[tuple[str, str]] = set()

    @callback
    def add_new_speakers() -> None:
        new = []
        for device in coordinator.devices:
            ref = (device["type"], device["name"])
            if ref in known or device.get("needs_pairing"):
                continue
            known.add(ref)
            new.append(BeaconSpeakerSwitch(coordinator, entry, *ref))
        if new:
            async_add_entities(new)

    entry.async_on_unload(coordinator.add_device_listener(add_new_speakers))
    add_new_speakers()


class BeaconSpeakerSwitch(BeaconEntity, SwitchEntity):
    _attr_icon = "mdi:speaker-wireless"

    def __init__(
        self, coordinator: BeaconCoordinator, entry: ConfigEntry, device_type: str, name: str
    ) -> None:
        self._key = f"cast_{device_type}_{name}"
        super().__init__(coordinator, entry, "switch")
        self._type = device_type
        self._name = name
        self._attr_name = f"Cast {name}"

    @property
    def is_on(self) -> bool:
        return self.coordinator.is_casting_to(self._type, self._name)

    @property
    def available(self) -> bool:
        return self.coordinator.available and any(
            d["type"] == self._type and d["name"] == self._name for d in self.coordinator.devices
        )

    @property
    def extra_state_attributes(self) -> dict:
        device = next(
            (
                d
                for d in self.coordinator.devices
                if d["type"] == self._type and d["name"] == self._name
            ),
            {},
        )
        return {
            "type": _TYPE_LABELS.get(self._type, self._type),
            "in_use_by": device.get("in_use_by_name"),
        }

    def _current(self) -> list[tuple[str, str]]:
        return [(t.get("type"), t.get("name")) for t in self.coordinator.casting]

    async def _apply(self, targets: list[tuple[str, str]]) -> None:
        try:
            await self.coordinator.cast_to(targets)
        except BeaconError as e:
            raise HomeAssistantError(f"Beacon: {e}") from e

    async def async_turn_on(self, **kwargs) -> None:
        if not self.is_on:
            await self._apply(self._current() + [(self._type, self._name)])

    async def async_turn_off(self, **kwargs) -> None:
        if self.is_on:
            await self._apply([t for t in self._current() if t != (self._type, self._name)])


class BeaconAutoplaySwitch(BeaconEntity, SwitchEntity):
    _attr_name = "Autoplay"
    _attr_icon = "mdi:playlist-plus"

    _key = "autoplay"

    def __init__(self, source, entry: ConfigEntry) -> None:
        super().__init__(source, entry, "switch")

    @property
    def is_on(self) -> bool:
        return bool(self.coordinator.snapshot.get("autoplay"))

    async def _toggle_to(self, on: bool) -> None:
        # Beacon only toggles.
        if self.is_on != on:
            try:
                await self.coordinator.client.command("autoplay")
            except BeaconError as e:
                raise HomeAssistantError(f"Beacon: {e}") from e

    async def async_turn_on(self, **kwargs) -> None:
        await self._toggle_to(True)

    async def async_turn_off(self, **kwargs) -> None:
        await self._toggle_to(False)
