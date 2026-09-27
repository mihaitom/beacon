"""One connection to Beacon, shared by every entity of an entry."""

import asyncio
import logging
import time
from collections.abc import Callable

from homeassistant.core import HomeAssistant, callback

from .api import BeaconClient, BeaconError

_LOGGER = logging.getLogger(__name__)

# The speaker list comes from the app's own last sweep, so asking is cheap.
DEVICES_INTERVAL = 60
LOCAL_SOURCE = "This computer"
# The album list is fetched whole to group it by letter; kept this long so
# browsing from letter to letter does not fetch it again each time.
ALBUMS_TTL = 600
# More than any library will have; the app answers from memory.
ALBUMS_LIMIT = 100_000


class BeaconCoordinator:
    def __init__(self, hass: HomeAssistant, client: BeaconClient) -> None:
        self.hass = hass
        self.client = client
        self.snapshot: dict = {}
        self.devices: list[dict] = []
        self.available = False
        self._listeners: list[Callable[[], None]] = []
        self._device_listeners: list[Callable[[], None]] = []
        self._tasks: list[asyncio.Task] = []
        self._albums: list[dict] = []
        self._albums_at = 0.0

    def start(self) -> None:
        self._tasks.append(
            self.hass.async_create_background_task(
                self.client.listen(self._on_state, self._on_available), "beacon_events"
            )
        )
        self._tasks.append(
            self.hass.async_create_background_task(self._poll_devices(), "beacon_devices")
        )

    def stop(self) -> None:
        for task in self._tasks:
            task.cancel()

    @callback
    def add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    @callback
    def add_device_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._device_listeners.append(listener)
        return lambda: self._device_listeners.remove(listener)

    def _notify(self) -> None:
        for listener in list(self._listeners):
            listener()

    def _on_state(self, snapshot: dict) -> None:
        self.snapshot = snapshot
        self._notify()

    def _on_available(self, available: bool) -> None:
        if available != self.available:
            self.available = available
            self._notify()
            if available:
                self.hass.async_create_task(self.refresh_devices())

    async def refresh_devices(self, rescan: bool = False) -> None:
        try:
            result = await self.client.query("devices", {"rescan": "true"} if rescan else None)
        except BeaconError as e:
            _LOGGER.debug("Could not list speakers: %s", e)
            return
        self.devices = result.get("items", [])
        for listener in list(self._device_listeners):
            listener()
        self._notify()

    async def _poll_devices(self) -> None:
        while True:
            await asyncio.sleep(DEVICES_INTERVAL)
            if self.available:
                await self.refresh_devices()

    async def albums(self) -> list[dict]:
        if not self._albums or time.monotonic() - self._albums_at > ALBUMS_TTL:
            result = await self.client.query("albums", {"limit": ALBUMS_LIMIT})
            self._albums = result.get("items", [])
            self._albums_at = time.monotonic()
        return self._albums

    # ── What the snapshot says ───────────────────────────────────────────

    @property
    def casting(self) -> list[dict]:
        return self.snapshot.get("casting") or []

    def is_casting_to(self, device_type: str, name: str) -> bool:
        return any(t.get("type") == device_type and t.get("name") == name for t in self.casting)

    @property
    def sources(self) -> list[str]:
        """This computer, then every speaker that can be cast to right away."""
        return [LOCAL_SOURCE] + [d["name"] for d in self.devices if not d.get("needs_pairing")]

    @property
    def source(self) -> str:
        if not self.casting:
            return LOCAL_SOURCE
        return " + ".join(t.get("name", "?") for t in self.casting)

    async def select_source(self, source: str) -> None:
        """Plays on exactly this one: the computer, or a single speaker."""
        if source == LOCAL_SOURCE:
            await self.cast_to([])
            return
        device = next((d for d in self.devices if d["name"] == source), None)
        if device is None:
            raise BeaconError(f"No speaker called {source!r}")
        await self.cast_to([(device["type"], device["name"])])

    async def cast_to(self, targets: list[tuple[str, str]]) -> None:
        """The whole set of speakers, as Beacon's phone picker sends it; an
        empty set stops casting."""
        await self.client.command(
            "cast-to-many",
            {"targets": [{"deviceType": t, "name": n} for t, n in targets]},
        )
