"""delivery/sonos.py — SonosDelivery via SoCo / UPnP"""

import asyncio
import logging
from xml.sax.saxutils import escape

from core.upnp_events import AVTRANSPORT_EVENT_PATH, subscribe

from .base import BaseDelivery

logger = logging.getLogger("delivery")


# Resolved SoCo devices by (lower-cased) target name — see
# SonosDelivery._get_device() for why this exists. Process-wide rather than
# per-delivery: a delivery object is constructed per dispatch, so per-instance
# caching would barely ever hit.
_device_cache: dict = {}


def _cached_device(target: str):
    """The cached device for `target`, confirmed to still be that speaker, or
    None if there is nothing usable cached.

    The confirmation is one unicast HTTP request to the speaker (SoCo's
    get_speaker_info against /status/zp). It costs a few milliseconds against
    a device that is there, and it is what keeps a cache entry from outliving
    the speaker it names: a Sonos that changed IP, was renamed, or is simply
    gone drops out of the cache here and the caller falls back to a full
    discovery."""
    device = _device_cache.get(target.lower())
    if device is None:
        return None
    try:
        info = device.get_speaker_info(refresh=True)
    except Exception as e:
        logger.debug(f"[Sonos:{target}] cached device no longer answering ({e}) — rediscovering")
        _device_cache.pop(target.lower(), None)
        return None
    if (info.get("zone_name") or "").lower() != target.lower():
        logger.debug(
            f"[Sonos:{target}] cached device now reports "
            f"'{info.get('zone_name')}' — rediscovering"
        )
        _device_cache.pop(target.lower(), None)
        return None
    return device


def forget_cached_devices() -> None:
    """Drops every cached device. For tests, and for anything that knows the
    network changed underneath us."""
    _device_cache.clear()


class SonosDelivery(BaseDelivery):
    """Controls a Sonos speaker via SoCo."""

    SUPPORTS_POSITION: bool = True

    def _get_device(self):
        """The SoCo device for this target.

        Cached across calls, and that matters more than it sounds: this is
        called on *every* device interaction, and the position-resync loop
        alone calls it every POSITION_RESYNC_INTERVAL for as long as a cast
        runs. Each uncached call is a network-wide SSDP M-SEARCH, which SoCo
        repeats several times over its timeout - measured on beacon-dev
        2026-08-23 at roughly 25 multicast searches per minute during
        ordinary playback, rising past 180/min with a device picker open in
        two instances. That is by far the loudest thing this app does to the
        network it shares with the speakers, and every one of those searches
        also blocks its worker thread for the discovery timeout.

        The cached device is confirmed before use with a single unicast HTTP
        call to the speaker itself (SoCo's own get_speaker_info against
        /status/zp, a few milliseconds), so a speaker that changed address or
        went away falls back to a real discovery instead of leaving this
        stuck on a dead handle. Keyed by target name and shared process-wide:
        two sessions casting to the same speaker resolve it once between
        them."""
        cached = _cached_device(self.target)
        if cached is not None:
            return cached

        import soco

        devices = list(soco.discover() or [])
        if not devices:
            raise RuntimeError("No Sonos devices found.")
        for d in devices:
            try:
                if d.player_name.lower() == self.target.lower():
                    # Return the actual device; callers handle grouping themselves
                    _device_cache[self.target.lower()] = d
                    return d
            except Exception:
                pass
        available = [d.player_name for d in devices]
        raise RuntimeError(f"Sonos '{self.target}' not found. Available: {available}")

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
        # duration accepted for interface parity with BaseDelivery.play() but
        # not yet wired up here — not part of the DLNA missing-duration fix
        # this parameter was added for (see dlna.py).
        device = await asyncio.to_thread(self._get_device)
        await self._subscribe_to_events(device)

        # Leave any existing group so we play on this specific device
        try:
            is_coord = await asyncio.to_thread(lambda: device.is_coordinator)
            if not is_coord:
                await asyncio.to_thread(device.unjoin)
                await asyncio.sleep(0.3)
        except Exception as e:
            logger.warning(f"[Sonos:{self.target}] unjoin: {e}")

        info = await asyncio.to_thread(device.get_current_transport_info)
        state = info.get("current_transport_state", "UNKNOWN")
        # TEMPORARY — logged while chasing an intermittent stall (device
        # keeps reporting position 0 while the wall clock keeps advancing):
        # a dispatch arriving while the device is still TRANSITIONING from a
        # *previous* dispatch (e.g. two transport switches in quick
        # succession) is exactly the kind of state this app never used to
        # have visibility into.
        logger.debug(f"[Sonos:{self.target}] transport state before dispatch: {state}")
        if state in ("PLAYING", "PAUSED_PLAYBACK", "TRANSITIONING"):
            await asyncio.to_thread(device.stop)

        # DIDL-Lite Metadata
        album_art_tag = (
            f"<upnp:albumArtURI>{escape(album_art_url)}</upnp:albumArtURI>"
            if album_art_url
            else ""
        )
        album_tag = f"<upnp:album>{escape(album)}</upnp:album>" if album else ""
        metadata = (
            '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
            'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
            '<item id="1" parentID="0" restricted="1">'
            f"<dc:title>{escape(title)}</dc:title>"
            f"<dc:creator>{escape(artist)}</dc:creator>"
            f"<upnp:artist>{escape(artist)}</upnp:artist>"
            f"{album_tag}"
            f"{album_art_tag}"
            "<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>"
            f'<res protocolInfo="http-get:*:{escape(content_type)}:*">{escape(stream_url)}</res>'
            "</item>"
            "</DIDL-Lite>"
        )

        logger.debug(f"[Sonos:{self.target}] → play: {stream_url}")
        await asyncio.to_thread(
            device.avTransport.SetAVTransportURI,
            [
                ("InstanceID", 0),
                ("CurrentURI", stream_url),
                ("CurrentURIMetaData", metadata),
            ],
        )
        await asyncio.to_thread(
            device.avTransport.Play, [("InstanceID", 0), ("Speed", 1)]
        )
        logger.info(f"[Sonos:{self.target}] ✓ playing")

    async def _subscribe_to_events(self, device) -> None:
        """Ask this speaker to report its own transport-state changes (see
        core/upnp_events.py). Purely diagnostic — a speaker that refuses
        the subscription still plays perfectly well, so every failure here
        is swallowed rather than allowed to break a dispatch."""
        # Imported here, not at module scope: routes/upnp.py imports the
        # delivery layer's siblings via core.state, and pulling it in at
        # import time would close that loop.
        from routes.upnp import callback_url_for

        try:
            ip = await asyncio.to_thread(lambda: device.ip_address)
            await subscribe(
                self.target,
                f"http://{ip}:1400{AVTRANSPORT_EVENT_PATH}",
                callback_url_for(self.target),
            )
        except Exception as e:
            logger.debug(f"[Sonos:{self.target}] transport eventing unavailable: {e}")

    async def pause(self) -> None:
        device = await asyncio.to_thread(self._get_device)
        await asyncio.to_thread(device.pause)
        logger.info(f"[Sonos:{self.target}] paused")

    async def resume(self) -> None:
        device = await asyncio.to_thread(self._get_device)
        await asyncio.to_thread(device.play)
        logger.info(f"[Sonos:{self.target}] resumed")

    async def stop(self) -> None:
        device = await asyncio.to_thread(self._get_device)
        await asyncio.to_thread(device.stop)
        logger.info(f"[Sonos:{self.target}] stopped")

    async def get_position(self) -> float | None:
        device = await asyncio.to_thread(self._get_device)
        info = await asyncio.to_thread(device.get_current_track_info)
        position = info.get("position", "0:00:00")
        try:
            h, m, s = (int(p) for p in position.split(":"))
            return h * 3600 + m * 60 + s
        except (ValueError, AttributeError):
            return None

    async def current_uri(self) -> str | None:
        device = await asyncio.to_thread(self._get_device)
        info = await asyncio.to_thread(device.get_current_track_info)
        return info.get("uri") or None

    async def get_volume(self) -> float | None:
        device = await asyncio.to_thread(self._get_device)
        return await asyncio.to_thread(lambda: device.volume)

    async def set_volume(self, volume: float) -> None:
        device = await asyncio.to_thread(self._get_device)
        await asyncio.to_thread(setattr, device, "volume", int(volume))
