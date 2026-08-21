"""delivery/manager.py — DeliveryManager and device discovery helpers"""

import asyncio
import logging

from core.log_level import is_at_least

from .base import BaseDelivery
from .chromecast import _ensure_cast_browser, _wait_for_discovery
from .dlna import UnsupportedDlnaDevice, _create_dmr_device, _location_cache
from .sonos import SonosDelivery

logger = logging.getLogger("delivery")


# Ties into the same log-level setting as everything else named "debug" in
# this app (Settings' dropdown, or LOG_LEVEL — see core/log_level.py) rather
# than its own separate env var — disables the Sonos-as-AirPlay/Sonos-as-DLNA
# dedup filters below at Debug or louder, so a household with only Sonos
# hardware can still exercise the AirPlay/DLNA discovery and delivery code
# paths during development, live, without a restart. Note this doesn't make
# AirPlay-to-Sonos actually work — that fails for the real reason documented
# on _is_sonos() (no MFi auth) regardless of log level; it only makes the
# entry selectable so the failure path itself can be tested. DLNA-to-Sonos
# does work, since Sonos genuinely speaks UPnP AVTransport.
def _debug_enabled() -> bool:
    return is_at_least("DEBUG")


class DeliveryManager:
    """Groups multiple delivery targets so they can be played/paused/stopped
    together — e.g. a Sonos multiroom group, or several independent targets
    fanned out from one /play call. Always built via from_deliveries(); there
    is no standalone/config-driven construction path."""

    def __init__(self, deliveries: list[BaseDelivery]) -> None:
        self.deliveries = deliveries

    @classmethod
    def from_deliveries(cls, deliveries: list[BaseDelivery]) -> "DeliveryManager":
        """Create a manager from an explicit list of delivery objects (e.g. for multiroom)."""
        return cls(deliveries)

    async def play(
        self,
        stream_url: str,
        title: str = "Connect",
        artist: str = "",
        album_art_url: str | None = None,
        duration: float | None = None,
        album: str = "",
        content_type: str = "audio/mpeg",
    ) -> None:
        if not self.deliveries:
            return
        sonos = [d for d in self.deliveries if isinstance(d, SonosDelivery)]
        others = [d for d in self.deliveries if not isinstance(d, SonosDelivery)]

        tasks = []
        if len(sonos) > 1:
            tasks.append(
                self._play_grouped_sonos(
                    sonos, stream_url, title, artist, album_art_url, duration, album, content_type
                )
            )
        elif sonos:
            tasks.append(
                sonos[0].play(
                    stream_url, title, artist, album_art_url, duration, album, content_type
                )
            )
        tasks.extend(
            d.play(stream_url, title, artist, album_art_url, duration, album, content_type)
            for d in others
        )

        results = await asyncio.gather(*tasks, return_exceptions=True)
        errors = [r for r in results if isinstance(r, Exception)]
        for error in errors:
            logger.error(f"Delivery error: {error}")
        if errors and len(errors) == len(results):
            # Every target failed — nothing is actually playing anywhere,
            # unlike a *partial* failure (some targets started fine
            # despite one having trouble), which callers should not treat
            # as a failed dispatch just because one device in the group
            # misbehaved. Re-raising only in the all-failed case is what
            # lets routes/playback.py's own except-and-rollback around
            # target.play() actually fire for it — before this, a dispatch
            # to a DeliveryManager where every device failed still looked
            # like success to the caller: is_streaming stayed True,
            # active_delivery stayed set, and every target's claim stayed
            # held, for a dispatch that produced no actual playback
            # anywhere.
            raise errors[0]

    async def _play_grouped_sonos(
        self,
        deliveries: list[SonosDelivery],
        stream_url: str,
        title: str,
        artist: str = "",
        album_art_url: str | None = None,
        duration: float | None = None,
        album: str = "",
        content_type: str = "audio/mpeg",
    ) -> None:
        """Group Sonos devices so they play in sync (coordinator + followers)."""
        devices = await asyncio.gather(
            *[asyncio.to_thread(d._get_device) for d in deliveries]
        )
        coordinator, followers = devices[0], devices[1:]

        for f in followers:
            try:
                await asyncio.to_thread(f.unjoin)
            except Exception as e:
                logger.warning(f"[Sonos group] unjoin: {e}")

        await asyncio.sleep(0.5)

        for f in followers:
            try:
                await asyncio.to_thread(f.join, coordinator)
            except Exception as e:
                logger.warning(f"[Sonos group] join: {e}")

        await asyncio.sleep(0.5)

        await deliveries[0].play(
            stream_url, title, artist, album_art_url, duration, album, content_type
        )

    async def pause(self) -> None:
        await asyncio.gather(
            *[d.pause() for d in self.deliveries], return_exceptions=True
        )

    async def resume(self) -> None:
        await asyncio.gather(
            *[d.resume() for d in self.deliveries], return_exceptions=True
        )

    async def stop(self) -> None:
        await asyncio.gather(
            *[d.stop() for d in self.deliveries], return_exceptions=True
        )

    async def play_all(self, stream_url: str, title: str = "Connect") -> None:
        await self.play(stream_url, title)

    async def stop_all(self) -> None:
        await self.stop()

    def list_targets(self) -> list[dict]:
        return [
            {"type": type(d).__name__.replace("Delivery", "").lower(), "name": d.target}
            for d in self.deliveries
        ]

    def __repr__(self) -> str:
        if not self.deliveries:
            return "<no targets>"
        return ", ".join(f"{t['type']}:{t['name']}" for t in self.list_targets())


# ── Discovery Helpers ─────────────────────────────────────────────────────────


async def discover_sonos() -> list[dict]:
    """Discovers all Sonos devices on the network."""
    import soco

    devices = await asyncio.to_thread(lambda: list(soco.discover() or []))
    return [{"name": d.player_name, "ip": d.ip_address} for d in devices]


def _is_sonos(device) -> bool:
    """True if the AirPlay device is actually a Sonos speaker.

    Sonos exposes AirPlay 2 but requires MFi hardware authentication, which
    pyatv cannot do — streaming to it via AirPlay fails with the device
    refusing the audio port. Such devices must use the native Sonos (UPnP)
    delivery instead, so we hide them from the AirPlay list.
    """
    for service in device.services:
        props = getattr(service, "properties", None) or {}
        if "sonos" in props.get("manufacturer", "").lower():
            return True
    return False


async def discover_airplay(verbose: bool = False) -> list[dict]:
    """Discovers all AirPlay devices on the network.

    `verbose` logs which Sonos-duplicate entries were skipped — only worth
    showing for an explicit "Scan again", not the quiet background rescans
    triggered by every popover open or the periodic task in main.py.
    """
    import pyatv
    from pyatv.const import Protocol

    devices = await pyatv.scan(asyncio.get_event_loop(), timeout=10)
    result = []
    for d in devices:
        if _is_sonos(d) and not _debug_enabled():
            if verbose:
                logger.info(
                    f"[discover] Skipping AirPlay for Sonos device '{d.name}' "
                    f"(use Sonos output instead)"
                )
            continue
        protocols = {s.protocol for s in d.services}
        result.append(
            {
                "address": str(d.address),
                "model": str(d.device_info.model),
                "name": d.name,
                # AirPlay 2 devices expose Protocol.AirPlay (HAP-based) and require pairing.
                # AirPlay 1 / RAOP devices do not.
                "needs_pairing": Protocol.AirPlay in protocols,
            }
        )
    return result


async def discover_chromecast() -> list[dict]:
    """Discovers all Chromecast (Google Cast) devices on the network."""

    def _scan():
        browser, _ = _ensure_cast_browser()
        _wait_for_discovery(min_seconds=3.0)
        return [
            {
                "host": str(info.host) if info.host else "",
                "model": info.model_name or "",
                "name": info.friendly_name,
            }
            for info in browser.devices.values()
        ]

    return await asyncio.to_thread(_scan)


async def discover_dlna(verbose: bool = False) -> list[dict]:
    """Discovers all DLNA/UPnP MediaRenderer devices on the network.

    Sonos speakers also expose themselves as generic UPnP MediaRenderers (it's
    how SoCo itself talks to them), so they'd otherwise show up twice — once
    correctly via discover_sonos(), once again here. Filtered out by
    manufacturer, same idea as _is_sonos() for the AirPlay list.

    `verbose` logs which Sonos-duplicate entries were skipped — see
    discover_airplay()'s docstring.
    """
    from async_upnp_client.search import async_search
    from async_upnp_client.utils import CaseInsensitiveDict

    responses: dict[str, CaseInsensitiveDict] = {}

    async def _on_response(headers: CaseInsensitiveDict) -> None:
        location = headers.get("location")
        usn = headers.get("usn", "")
        if location and usn not in responses:
            responses[usn] = headers

    await async_search(
        async_callback=_on_response,
        search_target="urn:schemas-upnp-org:device:MediaRenderer:1",
        timeout=5,
    )

    result = []
    for headers in responses.values():
        location = headers["location"]
        try:
            device = await _create_dmr_device(location)
        except UnsupportedDlnaDevice as e:
            logger.info(
                f"[discover] '{e.friendly_name}' at {location} answered UPnP "
                f"discovery but isn't a MediaRenderer, skipping"
            )
            continue
        except Exception as e:
            logger.warning(f"[discover] DLNA device at {location}: {e}")
            continue
        if "sonos" in (device.manufacturer or "").lower() and not _debug_enabled():
            if verbose:
                logger.info(
                    f"[discover] Skipping DLNA for Sonos device '{device.name}' "
                    f"(use Sonos output instead)"
                )
            continue
        result.append({"location": location, "name": device.name})
        _location_cache[device.name.lower()] = location
    return result
