"""delivery/dlna.py — DlnaDelivery via async-upnp-client (UPnP/DLNA MediaRenderer)

Unlike Sonos/Chromecast, DLNA has no vendor SDK or persistent device browser —
each device is a generic UPnP MediaRenderer reached via its own SOAP control
URLs (AVTransport for play/stop/position, RenderingControl for volume), found
via SSDP. `async-upnp-client`'s `DmrDevice` profile wraps that SOAP surface
with plain async methods, so this stays about as small as chromecast.py.
"""

import logging
import xml.etree.ElementTree as ET

from didl_lite.didl_lite import MusicTrack, Resource, to_xml_string

from .base import BaseDelivery

logger = logging.getLogger("delivery")

# DLNA has no persistent discovery browser to query for a device's current
# location (unlike Sonos' soco.discover() or Chromecast's CastBrowser cache),
# so we keep our own: name -> description-XML URL, populated by discover_dlna()
# and consulted by _get_device() when a delivery is constructed directly from
# a known (type, name) pair (see core/state.py's resolve_target()) rather
# than from a fresh /discover call.
_location_cache: dict[str, str] = {}
_device_cache: dict = {}

# Two upstream didl_lite gaps patched here, both discovered building metadata
# for our stream (an audio/mpeg URL with no file extension, so it's always a
# MusicTrack item, never a container). We build the DIDL-Lite item ourselves
# (see _build_metadata below) rather than async-upnp-client's
# DmrDevice.construct_play_media_metadata() helper, since neither gap can be
# worked around through that helper's API:
#
# 1. MusicTrack's didl_properties_defs (unlike MusicAlbum's) doesn't declare
#    upnp:albumArtURI — DidlObject.to_xml() only serializes properties
#    declared on the class, so any album_art_url we set is silently dropped.
if not any(p[1] == "albumArtURI" for p in MusicTrack.didl_properties_defs):
    MusicTrack.didl_properties_defs = [
        *MusicTrack.didl_properties_defs,
        ("upnp", "albumArtURI", "O"),
    ]

# 2. Resource.to_xml() only ever serializes protocolInfo — every other
#    constructor param (duration, size, bitrate, ...) is stored on the
#    instance but never written to the <res> element, even though
#    Resource.from_xml() parses all of them back in on the reverse path. This
#    is what silently drops track duration.
def _patched_resource_to_xml(self: Resource) -> ET.Element:
    attribs = {"protocolInfo": self.protocol_info or ""}
    for attr, xml_name in (
        ("import_uri", "importUri"),
        ("size", "size"),
        ("duration", "duration"),
        ("bitrate", "bitrate"),
        ("sample_frequency", "sampleFrequency"),
        ("bits_per_sample", "bitsPerSample"),
        ("nr_audio_channels", "nrAudioChannels"),
        ("resolution", "resolution"),
        ("color_depth", "colorDepth"),
        ("protection", "protection"),
    ):
        value = getattr(self, attr, None)
        if value is not None:
            attribs[xml_name] = str(value)
    res_el = ET.Element("res", attribs)
    res_el.text = self.uri
    return res_el


Resource.to_xml = _patched_resource_to_xml


def _format_didl_duration(seconds: float) -> str:
    """DIDL-Lite <res duration=...> format, e.g. 3:45 -> "0:03:45"."""
    total = max(0, int(round(seconds)))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}"


def _build_metadata(
    stream_url: str,
    title: str,
    artist: str = "",
    album_art_url: str | None = None,
    duration: float | None = None,
    album: str = "",
    content_type: str = "audio/mpeg",
) -> str:
    resource = Resource(
        uri=stream_url,
        protocol_info=f"http-get:*:{content_type}:*",
        duration=_format_didl_duration(duration) if duration else None,
    )
    props: dict[str, str] = {}
    if artist:
        # Both set: upnp:artist is the modern/DLNA-preferred field, but some
        # renderers only read the older dc:creator instead.
        props["artist"] = artist
        props["creator"] = artist
    if album:
        props["album"] = album
    if album_art_url:
        props["albumArtURI"] = album_art_url
    item = MusicTrack(
        id="0", parent_id="-1", title=title, restricted="false", resources=[resource], **props
    )
    return to_xml_string(item).decode("utf-8")


class UnsupportedDlnaDevice(Exception):
    """Raised by _create_dmr_device() when a device answers our SSDP
    MediaRenderer search but its own XML doesn't actually declare a
    MediaRenderer — routers, NAS boxes, smart-home hubs (e.g. a Philips Hue
    bridge) and similar UPnP-but-not-media devices often respond fairly
    broadly to generic discovery requests. Carries friendly_name (available
    from the device's XML, fetched successfully — it just isn't a renderer)
    so discover_dlna() can log something more useful than the raw
    "could not find device of type" error."""

    def __init__(self, friendly_name: str):
        self.friendly_name = friendly_name
        super().__init__(f"'{friendly_name}' is not a MediaRenderer")


async def _create_dmr_device(location: str):
    from async_upnp_client.aiohttp import AiohttpRequester
    from async_upnp_client.client_factory import UpnpFactory
    from async_upnp_client.exceptions import UpnpError
    from async_upnp_client.profiles.dlna import DmrDevice

    requester = AiohttpRequester()
    factory = UpnpFactory(requester)
    upnp_device = await factory.async_create_device(location)
    try:
        return DmrDevice(upnp_device, event_handler=None)
    except UpnpError as e:
        raise UnsupportedDlnaDevice(upnp_device.friendly_name) from e


class DlnaDelivery(BaseDelivery):
    """Controls a DLNA/UPnP MediaRenderer device via async-upnp-client."""

    SUPPORTS_POSITION: bool = True

    async def _get_device(self):
        cached = _device_cache.get(self.target.lower())
        if cached is not None:
            return cached

        location = _location_cache.get(self.target.lower())
        if not location:
            # No cached location (e.g. delivery built directly from a
            # (type, name) pair — see core/state.py's resolve_target()) — do
            # a fresh scan to resolve one. Imported locally: discover_dlna
            # lives in manager.py, which itself imports from this module.
            from .manager import discover_dlna

            for d in await discover_dlna():
                if d["name"].lower() == self.target.lower():
                    location = d["location"]
                    break
        if not location:
            raise RuntimeError(f"DLNA device '{self.target}' not found")

        device = await _create_dmr_device(location)
        await device.async_update()
        _device_cache[self.target.lower()] = device
        return device

    async def _get_device_or_evict(self):
        try:
            return await self._get_device()
        except Exception:
            _device_cache.pop(self.target.lower(), None)
            raise

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
        device = await self._get_device_or_evict()
        # Built ourselves rather than via DmrDevice.construct_play_media_metadata()
        # — that helper auto-detects a DIDL-Lite class from the stream's
        # Content-Type via MIME_TO_UPNP_CLASS_MAPPING, which only has a coarse
        # "audio" -> plain AudioItem entry (never MusicTrack), so artist/
        # albumArtURI/duration would all be silently dropped (AudioItem doesn't
        # declare artist/albumArtURI, and the helper's own Resource construction
        # doesn't expose duration at all). async_set_transport_uri() passes a
        # string meta_data straight through instead of auto-building it.
        xml_meta_data = _build_metadata(
            stream_url, title, artist, album_art_url, duration, album, content_type
        )
        logger.debug(f"[DLNA:{self.target}] → play: {stream_url}")
        try:
            await device.async_set_transport_uri(stream_url, title, xml_meta_data)
            await device.async_play()
        except Exception:
            _device_cache.pop(self.target.lower(), None)
            raise
        logger.info(f"[DLNA:{self.target}] ✓ playing")

    async def pause(self) -> None:
        device = await self._get_device_or_evict()
        await device.async_pause()
        logger.info(f"[DLNA:{self.target}] paused")

    async def resume(self) -> None:
        device = await self._get_device_or_evict()
        await device.async_play()
        logger.info(f"[DLNA:{self.target}] resumed")

    async def stop(self) -> None:
        device = await self._get_device_or_evict()
        await device.async_stop()
        logger.info(f"[DLNA:{self.target}] stopped")

    async def get_position(self) -> float | None:
        device = await self._get_device_or_evict()
        await device.async_update(do_ping=False)
        position = device.media_position
        return float(position) if position is not None else None

    async def get_volume(self) -> float | None:
        device = await self._get_device_or_evict()
        await device.async_update(do_ping=False)
        level = device.volume_level
        return round(level * 100) if level is not None else None

    async def set_volume(self, volume: float) -> None:
        device = await self._get_device_or_evict()
        await device.async_set_volume_level(max(0.0, min(1.0, volume / 100.0)))
