"""The "active Beacon": one set of entities with fixed ids that follows
whichever Beacon instance is in use, so a dashboard works unchanged however
many instances there are and whatever they are called.

Automatic by default: the instance that is playing, else the one that is
running. A specific instance can be pinned through select.beacon_instance.
"""

from collections.abc import Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback

from .api import BeaconError
from .const import DOMAIN
from .coordinator import BeaconCoordinator

AUTOMATIC = "Automatic"
CONF_PINNED = "instance"


class _NoClient:
    """Stands in while no instance is set up at all."""

    async def _fail(self, *args, **kwargs):
        raise BeaconError("No Beacon is running")

    get_state = query = command = _fail

    def cover_url(self, *args, **kwargs) -> None:
        return None

    def favicon_url(self, *args, **kwargs) -> None:
        return None


class BeaconHub:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.entry: ConfigEntry | None = None
        self._instances: dict[str, tuple[ConfigEntry, BeaconCoordinator]] = {}
        self._unsubs: dict[str, Callable[[], None]] = {}
        self._listeners: list[Callable[[], None]] = []
        self._none = BeaconCoordinator(hass, _NoClient())

    # ── Instances ────────────────────────────────────────────────────────

    @callback
    def add(self, entry: ConfigEntry, coordinator: BeaconCoordinator) -> None:
        self._instances[entry.entry_id] = (entry, coordinator)
        self._unsubs[entry.entry_id] = coordinator.add_listener(self._notify)
        self._notify()

    @callback
    def remove(self, entry_id: str) -> None:
        self._instances.pop(entry_id, None)
        unsub = self._unsubs.pop(entry_id, None)
        if unsub:
            unsub()
        self._notify()

    @property
    def labels(self) -> dict[str, str]:
        """entry_id -> the name shown for it; two instances on the same
        computer share a title, so the later ones get a number."""
        result: dict[str, str] = {}
        seen: dict[str, int] = {}
        for entry_id, (entry, _) in self._instances.items():
            seen[entry.title] = seen.get(entry.title, 0) + 1
            count = seen[entry.title]
            result[entry_id] = entry.title if count == 1 else f"{entry.title} #{count}"
        return result

    # ── Which one is active ──────────────────────────────────────────────

    @property
    def pinned(self) -> str | None:
        pinned = self.entry.options.get(CONF_PINNED) if self.entry else None
        return pinned if pinned in self._instances else None

    @property
    def coordinator(self) -> BeaconCoordinator:
        if self.pinned:
            return self._instances[self.pinned][1]
        coordinators = [c for _, c in self._instances.values()]
        running = [c for c in coordinators if c.available]
        playing = [c for c in running if c.snapshot.get("playing")]
        return next(iter(playing or running or coordinators), self._none)

    @property
    def active_label(self) -> str | None:
        coordinator = self.coordinator
        for entry_id, (_, c) in self._instances.items():
            if c is coordinator:
                return self.labels[entry_id]
        return None

    def pin(self, label: str) -> None:
        if not self.entry:
            return
        entry_id = next((i for i, name in self.labels.items() if name == label), None)
        options = {**self.entry.options, CONF_PINNED: entry_id}
        self.hass.config_entries.async_update_entry(self.entry, options=options)
        self._notify()

    # ── Listeners ────────────────────────────────────────────────────────

    @callback
    def add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def _notify(self) -> None:
        for listener in list(self._listeners):
            listener()


def get_hub(hass: HomeAssistant) -> BeaconHub:
    hub = hass.data.get(DOMAIN)
    if hub is None:
        hub = hass.data[DOMAIN] = BeaconHub(hass)
    return hub
