"""delivery/dlna.py — DlnaDelivery via async-upnp-client (UPnP/DLNA MediaRenderer)

Unlike Sonos/Chromecast, DLNA has no vendor SDK or persistent device browser —
each device is a generic UPnP MediaRenderer reached via its own SOAP control
URLs (AVTransport for play/stop/position, RenderingControl for volume), found
via SSDP. `async-upnp-client`'s `DmrDevice` profile wraps that SOAP surface
with plain async methods, so this stays about as small as chromecast.py.
"""

import asyncio
import logging
import xml.etree.ElementTree as ET

from didl_lite.didl_lite import MusicTrack, Resource, to_xml_string

from .base import BaseDelivery
from .errors import DeviceNotFoundError, MediaRejectedError

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
# for our stream (always a MusicTrack item — one track, never a container).
# We build the DIDL-Lite item ourselves (see _build_metadata below) rather
# than async-upnp-client's DmrDevice.construct_play_media_metadata() helper,
# since neither gap can be worked around through that helper's API:
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
    total = max(0, round(seconds))
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


# One five-second timeout for everything (async-upnp-client's default) is
# wrong at both ends. A command may legitimately take several seconds —
# transport switches of around seven have been reported — and giving up on
# one loses a track that was about to play. A reading has to be back well
# inside routes/playback.py's POSITION_RESYNC_INTERVAL to be worth
# anything. Discovery keeps the old value: it walks every SSDP responder in
# turn, so this is paid once per unreachable device before anything lists.
_COMMAND_TIMEOUT = 15
_POLL_TIMEOUT = 4.0
_DISCOVERY_TIMEOUT = 5


async def _create_dmr_device(location: str, timeout: int = _COMMAND_TIMEOUT):
    from async_upnp_client.aiohttp import AiohttpRequester
    from async_upnp_client.client_factory import UpnpFactory
    from async_upnp_client.exceptions import UpnpError
    from async_upnp_client.profiles.dlna import DmrDevice

    requester = AiohttpRequester(timeout=timeout)
    factory = UpnpFactory(requester)
    upnp_device = await factory.async_create_device(location)
    try:
        return DmrDevice(upnp_device, event_handler=None)
    except UpnpError as e:
        raise UnsupportedDlnaDevice(upnp_device.friendly_name) from e


# The service a renderer's volume lives on. Version 1 is what every
# MediaRenderer implements; async-upnp-client resolves a v2/v3 device's own
# service for this id anyway.
_RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1"

# Looked up by id rather than by type, so a renderer's AVTransport:2 or :3
# is found as well as :1.
_AV_TRANSPORT_ID = "urn:upnp-org:serviceId:AVTransport"


async def _send_play(device) -> None:
    """Play, sent whatever the renderer last said it allows.

    DmrDevice.async_play() sends nothing at all when the allowed actions
    from its last poll leave Play out, and reports nothing either. Sent
    directly, a renderer that really will not play answers with a fault
    instead of play() reporting success over silence."""
    service = device.profile_device.service_id(_AV_TRANSPORT_ID)
    if service is None or not service.has_action("Play"):
        raise MediaRejectedError("the renderer has no Play action")
    await service.action("Play").async_call(InstanceID=0, Speed="1")


class DlnaDelivery(BaseDelivery):
    """Controls a DLNA/UPnP MediaRenderer device via async-upnp-client."""

    SUPPORTS_POSITION: bool = True
    # "Varies per renderer" is the honest answer (see
    # docs/investigations/copy-tier-device-limits.md) — DLNA covers
    # everything from budget soundbars to full AV receivers, with no
    # single real spec ceiling the way Sonos/Chromecast Audio publish one.
    # Reuses Sonos' own 24-bit/48kHz as the least-surprising shared
    # assumption: the two protocols' devices overlap heavily in practice
    # (see core/upnp_events.py's own comment on sharing an event-service
    # path), and understating a renderer's real ceiling costs a needless
    # resample, while overstating it reproduces the exact silent-failure
    # this whole mechanism exists to prevent.
    MAX_SAMPLE_RATE_HZ: int | None = 48000
    MAX_BIT_DEPTH: int | None = 24
    # Same "varies per renderer" problem as the two limits above, and the
    # same answer: MP3 and AAC are what a MediaRenderer is in practice
    # guaranteed to decode, FLAC and Vorbis are what this backend has
    # always handed one. Opus is left out — plenty of renderers predate it
    # entirely, and the failure it produces is silence rather than an
    # error anyone would see.
    PLAYABLE_CODECS: frozenset[str] = frozenset({"mp3", "aac", "flac", "vorbis"})

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
            raise DeviceNotFoundError(f"DLNA device '{self.target}' not found")

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
            # The allowed actions change with the new URI, and the ones cached
            # from the last poll can leave Play out - a renderer that was
            # playing typically lists Pause and Stop, not Play. Waited for
            # here, then sent regardless (see _send_play()).
            await device.async_wait_for_can_play()
            await _send_play(device)
        except Exception:
            _device_cache.pop(self.target.lower(), None)
            raise
        logger.info(f"[DLNA:{self.target}] ✓ playing")
        await self._subscribe_to_volume_events(device)

    async def _subscribe_to_volume_events(self, device) -> None:
        """Ask this renderer to report its own volume/mute changes, the same
        RenderingControl subscription Sonos gets (see delivery/sonos.py and
        routes/upnp.py, which parses both) — one fewer device to ask every
        four seconds, and a level someone changes on the renderer itself
        shows up here at once rather than at the next poll.

        Entirely optional: plenty of renderers refuse eventing, and one that
        does simply stays on the poll — nothing here is allowed to affect
        whether it plays. Which of the two a device ended up on is reported
        per device in the status (core/device_volume.py), rather than
        assumed from the fact that it is a DLNA renderer at all.

        Imported here, not at module scope: routes/upnp.py reaches the
        delivery layer through core.state, so importing it at import time
        would close that loop."""
        from core.device_volume import mark_pushes_volume
        from core.upnp_events import subscribe
        from routes.upnp import callback_url_for

        try:
            # The renderer publishes its own event URL in its device
            # description; unlike Sonos there is no fixed path to assume
            # (see core/upnp_events.py's own comment on that assumption).
            service = device.profile_device.service(_RENDERING_CONTROL)
            event_url = service.event_sub_url if service else None
            if not event_url:
                return
            subscription = await subscribe(
                self.target,
                "renderingcontrol",
                event_url,
                callback_url_for(self.target, "renderingcontrol", "dlna"),
            )
            if subscription is not None:
                mark_pushes_volume("dlna", self.target)
        except Exception as e:
            logger.debug(f"[DLNA:{self.target}] volume eventing unavailable: {e}")

    @staticmethod
    async def _refresh_allowed_actions(device) -> None:
        """Ask the renderer afresh what it allows right now.

        DmrDevice.async_pause() and async_stop() go by the allowed actions
        from the last poll and send nothing when those leave the action out,
        so a stop judged against a stale answer could leave the renderer
        playing while Beacon reports it stopped. If a fresh answer still
        leaves the action out, there is genuinely nothing to act on. A
        renderer without the action at all is not that case: the library
        raises for it, as it should."""
        await device.async_update(do_ping=False)

    async def pause(self) -> None:
        device = await self._get_device_or_evict()
        await self._refresh_allowed_actions(device)
        if device.has_pause and not device.can_pause:
            logger.debug(f"[DLNA:{self.target}] nothing to pause")
            return
        await device.async_pause()
        logger.info(f"[DLNA:{self.target}] paused")

    async def resume(self) -> None:
        device = await self._get_device_or_evict()
        await device.async_play()
        logger.info(f"[DLNA:{self.target}] resumed")

    async def stop(self) -> None:
        device = await self._get_device_or_evict()
        await self._refresh_allowed_actions(device)
        if device.has_stop and not device.can_stop:
            logger.debug(f"[DLNA:{self.target}] nothing to stop")
            return
        await device.async_stop()
        logger.info(f"[DLNA:{self.target}] stopped")

    async def _poll_device(self):
        """A device refreshed for a reading, under the short timeout. Raises
        TimeoutError past it — every caller already treats that as no answer."""
        device = await self._get_device_or_evict()
        await asyncio.wait_for(device.async_update(do_ping=False), _POLL_TIMEOUT)
        return device

    async def get_position(self) -> float | None:
        device = await self._poll_device()
        position = device.media_position
        return float(position) if position is not None else None

    async def current_uri(self) -> str | None:
        device = await self._poll_device()
        return device.current_track_uri or None

    async def get_volume(self) -> float | None:
        device = await self._poll_device()
        level = device.volume_level
        return round(level * 100) if level is not None else None

    async def set_volume(self, volume: float) -> None:
        device = await self._get_device_or_evict()
        await device.async_set_volume_level(max(0.0, min(1.0, volume / 100.0)))
