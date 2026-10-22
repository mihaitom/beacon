"""delivery/sonos.py — SonosDelivery via SoCo / UPnP"""

import asyncio
import logging
import re
from xml.sax.saxutils import escape

from soco.exceptions import SoCoUPnPException

from core.http_protocol import CLOSE_DELIMITED, header_value
from core.older_sonos import stream_mode
from core.streamer import strip_stream_extension
from core.upnp_events import (
    AVTRANSPORT_EVENT_PATH,
    RENDERINGCONTROL_EVENT_PATH,
    subscribe,
)

from . import sonos_discovery
from .base import BaseDelivery
from .errors import DeviceNotFoundError

logger = logging.getLogger("delivery")

# UPnP "Transition not available". A soundbar playing its TV input reports
# PLAYING but offers only Set and Play there, so every Stop and Pause is
# answered with this (measured on a Beam, 2026-09-12).
_TRANSITION_NOT_AVAILABLE = "701"


def halt_if_possible(action) -> bool:
    """Runs a SoCo `stop` or `pause`. Returns whether it did anything.

    A 701 means the speaker is on a source Beacon never put there, so
    there is nothing of ours to halt - not a failure. Raising it aborted
    every dispatch to a soundbar whose TV was on, and left /stop unable to
    end the session."""
    try:
        action()
    except SoCoUPnPException as e:
        if str(e.error_code) != _TRANSITION_NOT_AVAILABLE:
            raise
        logger.debug(f"[Sonos] nothing to halt on the current source: {e}")
        return False
    return True


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
            f"[Sonos:{target}] cached device now reports '{info.get('zone_name')}' — rediscovering"
        )
        _device_cache.pop(target.lower(), None)
        return None
    return device


def forget_cached_devices() -> None:
    """Drops every cached device. For tests, and for anything that knows the
    network changed underneath us."""
    _device_cache.clear()


# routes/stream.py's own re-served radio endpoint — both the relayed default
# (core/radio_relay.py) and the direct-cast retry fallback
# (routes/playback.py's retry_radio_via_proxy()) point a device at a URL
# containing this path, never a station's own URL. Shared with
# core/state.py's first_radio_position_delivery(), which has to agree with
# _dispatch_uri() below on exactly this question — see both docstrings.
_BEACON_RADIO_PATH = "/stream/radio/"


def is_beacon_hosted_radio_uri(url: str) -> bool:
    """Whether `url` is Beacon's own re-served radio stream rather than a
    station's own URL — see _BEACON_RADIO_PATH's own comment for the two
    cases this covers, and _dispatch_uri() below for the one thing it's
    used to decide."""
    return _BEACON_RADIO_PATH in url


# The older models, by model number: a Play:3 (S3) and a first-generation
# Playbar (S9). They stop reading a stream 30-45s in, so how they get a
# song is Settings → Advanced's choice (core/older_sonos.py, #56).
_OLDER_MODELS = frozenset({"S3", "S9"})

# A Sonos fetching a stream names itself and its model in its user agent,
# the model number with "ZP" in front: "Linux UPnP/1.0 Sonos/86.10-81100
# (ZPS3)".
_SONOS_IN_USER_AGENT = re.compile(r"\bSonos/")
_MODEL_IN_USER_AGENT = re.compile(r"\bSonos/\S+ \(ZP(\w+)\)")


def stream_headers(user_agent: str | None, name: str | None) -> dict[str, str]:
    """What a cast stream's GET and HEAD add for a Sonos: an internet radio
    server's framing (see core/http_protocol.py), and like such a server,
    no byte ranges to come back for and the stream's name in `icy-name`.
    Empty for any other device."""
    if not _SONOS_IN_USER_AGENT.search(user_agent or ""):
        return {}
    headers = {**CLOSE_DELIMITED, "Accept-Ranges": "none"}
    if name:
        headers["icy-name"] = header_value(name)
    return headers


def model_in_user_agent(user_agent: str | None) -> str | None:
    """A Sonos's model number from its user agent ("S3" for a Play:3)."""
    match = _MODEL_IN_USER_AGENT.search(user_agent or "")
    return match.group(1) if match else None


def older_model_mode(user_agent: str | None) -> str | None:
    """How the device behind this user agent gets a song: one of
    core/older_sonos.py's MODES for an older model, None for any other
    device."""
    if model_in_user_agent(user_agent) not in _OLDER_MODELS:
        return None
    return stream_mode()


def _dispatch_uri(stream_url: str) -> str:
    """The URI actually handed to SetAVTransportURI (and the DIDL `<res>`
    alongside it) — `stream_url` unchanged, except for Beacon's own
    re-served radio endpoint, which is dispatched over Sonos's own
    `x-rincon-mp3radio://` scheme instead of plain `http://`.

    That scheme is what tells a Sonos "this is a live internet-radio
    broadcast, size your buffer for one" rather than treating it as an
    ordinary bounded HTTP resource — confirmed by the same production URI
    variant scripts/icy_sync_probe.py's own `_VARIANTS` list documents as
    "exactly what delivery/sonos.py does in production" (before this
    function existed, that comment described plain http:// dispatch; it's
    now stale for the specific case this function rewrites — the probe
    script itself was never updated to match, since it exists to compare
    variants, not to mirror whichever one production currently picks).

    Deliberately not applied to a station's own URL when casting directly
    to it (PlayUrlRequest.cast_directly): that one already gets Sonos's
    native radio buffer with no help needed, confirmed live by the
    listener's own A/B test, 2026-09-04.

    The trade-off this reintroduces — and why it's confined to exactly
    this one case rather than applied everywhere — is spelled out in
    core/radio_position.py's module docstring and
    core/state.py's first_radio_position_delivery(): a Sonos dispatched
    this way reports position 0.00s for the entire run, no real feedback
    for RadioPositionTracker to poll, which is why plain http:// was
    chosen when that feature was built on 2026-09-02. Reinstated here
    anyway after IcyMuxer (core/icy_metadata.py) — the first attempt at
    fixing the same symptom, by telling Sonos it's radio via ICY
    signalling on the audio itself rather than the URI scheme — turned out
    insufficient on its own: reported live 2026-09-04, the buffer measured
    at ~1s even with ICY metadata present. first_radio_position_delivery()
    is what keeps this from also reintroducing the *old* problem (radio_
    buffering stuck True forever) for a Sonos dispatched this way — it
    simply excludes Sonos from position tracking again whenever this
    function would have rewritten the URI, the same fallback behaviour
    Sonos radio had before 2026-09-02.

    `x-rincon-mp3radio://{host}/path` — a straight scheme swap, not
    `x-rincon-mp3radio://http://{host}/path` (the other variant the probe
    script tried): the first is what's confirmed to work; the second was
    never shown to behave any differently and there is no reason to prefer
    the longer form."""
    if not is_beacon_hosted_radio_uri(stream_url):
        return stream_url
    return "x-rincon-mp3radio://" + stream_url.removeprefix("http://").removeprefix("https://")


class SonosDelivery(BaseDelivery):
    """Controls a Sonos speaker via SoCo."""

    SUPPORTS_POSITION: bool = True
    # Confirmed the hard way (see docs/investigations/copy-tier-device-limits.md):
    # a 24-bit/96kHz FLAC
    # sent as-is reported ERROR_UNSUPPORTED_FREQ over UPnP eventing and
    # stopped 1.1s in. Sonos' own published spec tops out at 24-bit/48kHz.
    MAX_SAMPLE_RATE_HZ: int | None = 48000
    MAX_BIT_DEPTH: int | None = 24
    # Measured on both a standalone Era 100 and a Beam with surround
    # satellites (see docs/investigations/multichannel-flac-silent-on-sonos.md):
    # a 5-channel FLAC is refused with ERROR_UNSUPPORTED_FORMAT and never
    # starts, at 44.1kHz just as at 96kHz. A speaker set that plays surround
    # from a TV still does not decode one out of an HTTP URI, so this is not
    # per-speaker.
    MAX_CHANNELS: int | None = 2
    # Sonos' own published format list: MP3, AAC, FLAC, ALAC, WMA, Ogg
    # Vorbis, AIFF and WAV. Opus is not on it, and is not merely
    # undocumented — a real speaker accepts the URI and then plays
    # silence (confirmed 2026-08-19, see _COPY_MUXER_FOR_CODEC in
    # core/streamer.py). A listener who picks Opus in Settings therefore
    # gets AAC on a Sonos rather than nothing.
    PLAYABLE_CODECS: frozenset[str] = frozenset({"mp3", "aac", "flac", "vorbis"})
    # Measured on a real speaker: an endless FLAC with no length played 10
    # minutes without a stop (docs/investigations/continuous-stream-on-devices.md).
    CONTINUOUS_FLAC_OK: bool = True

    def _get_device(self):
        """The SoCo device for this target.

        Cached across calls, and that matters more than it sounds: this is
        called on *every* device interaction, and the position-resync loop
        alone calls it every POSITION_RESYNC_INTERVAL for as long as a cast
        runs. Each uncached call is a network-wide SSDP M-SEARCH, sent
        several times over its timeout - measured on beacon-dev
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

        devices = sonos_discovery.discover_zones()
        if not devices:
            raise DeviceNotFoundError("No Sonos devices found.")
        for d in devices:
            try:
                if d.player_name.lower() == self.target.lower():
                    # Return the actual device; callers handle grouping themselves
                    _device_cache[self.target.lower()] = d
                    return d
            except Exception as e:
                logger.debug(
                    f"[Sonos:{self.target}] skipping unreadable device during discovery: {e}"
                )
        available = [d.player_name for d in devices]
        raise DeviceNotFoundError(f"Sonos '{self.target}' not found. Available: {available}")

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
            # A TV input refuses the Stop; SetAVTransportURI below switches
            # the speaker away from it all the same.
            await asyncio.to_thread(halt_if_possible, device.stop)

        # See _dispatch_uri()'s own docstring — plain `stream_url` for
        # everything except Beacon's own re-served radio endpoint, which
        # goes out over Sonos's own x-rincon-mp3radio:// scheme instead so
        # the speaker sizes its buffer for a live broadcast. protocolInfo
        # below stays "http-get" either way — a Sonos dispatched over that
        # scheme still fetches over plain HTTP under the hood, this is
        # only ever a hint about *how much to buffer*, not the transport.
        dispatch_uri = _dispatch_uri(stream_url)
        if duration and not is_beacon_hosted_radio_uri(stream_url):
            model = await asyncio.to_thread(lambda: device.get_speaker_info().get("model_number"))
            if model in _OLDER_MODELS and stream_mode() == "file":
                # Whatever the source, the file is an MP3 (routes/stream.py).
                dispatch_uri = strip_stream_extension(dispatch_uri) + ".mp3"
                content_type = "audio/mpeg"

        # DIDL-Lite Metadata. An audioBroadcast without a duration, the file
        # mode's included: announced as a musicTrack with its length, an Era
        # 100's track showed in the Sonos app as "No content", without its
        # artwork (#56).
        album_art_tag = (
            f"<upnp:albumArtURI>{escape(album_art_url)}</upnp:albumArtURI>" if album_art_url else ""
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
            f'<res protocolInfo="http-get:*:{escape(content_type)}:*">{escape(dispatch_uri)}</res>'
            "</item>"
            "</DIDL-Lite>"
        )

        logger.debug(f"[Sonos:{self.target}] → play: {dispatch_uri}")
        await asyncio.to_thread(
            device.avTransport.SetAVTransportURI,
            [
                ("InstanceID", 0),
                ("CurrentURI", dispatch_uri),
                ("CurrentURIMetaData", metadata),
            ],
        )
        await asyncio.to_thread(device.avTransport.Play, [("InstanceID", 0), ("Speed", 1)])
        logger.info(f"[Sonos:{self.target}] ✓ playing")

    async def _subscribe_to_events(self, device) -> None:
        """Ask this speaker to report its own transport-state changes and
        its own volume/mute (see core/upnp_events.py) — two independent
        subscriptions, one per UPnP service, so either can fail without
        taking the other down. The AVTransport one stays purely diagnostic;
        a speaker that refuses it still plays perfectly well, so every
        failure here is swallowed rather than allowed to break a dispatch.
        The RenderingControl one now actually feeds a session's
        device_volumes (routes/upnp.py) — still swallowed the same way on
        failure, since DeviceListItem.vue's own poll is still there as a
        fallback for a speaker that won't subscribe."""
        # Imported here, not at module scope: routes/upnp.py imports the
        # delivery layer's siblings via core.state, and pulling it in at
        # import time would close that loop.
        from core.device_volume import mark_pushes_volume
        from routes.upnp import callback_url_for

        try:
            ip = await asyncio.to_thread(lambda: device.ip_address)
        except Exception as e:
            logger.debug(f"[Sonos:{self.target}] transport eventing unavailable: {e}")
            return

        try:
            await subscribe(
                self.target,
                "avtransport",
                f"http://{ip}:1400{AVTRANSPORT_EVENT_PATH}",
                callback_url_for(self.target, "avtransport"),
            )
        except Exception as e:
            logger.debug(f"[Sonos:{self.target}] transport eventing unavailable: {e}")

        try:
            subscription = await subscribe(
                self.target,
                "renderingcontrol",
                f"http://{ip}:1400{RENDERINGCONTROL_EVENT_PATH}",
                callback_url_for(self.target, "renderingcontrol", "sonos"),
            )
            # Only once the speaker has actually accepted it: this is what
            # tells every slider showing this device to stop polling it (see
            # core/device_volume.py), so claiming it for a subscription that
            # was refused would leave them on a value nothing refreshes.
            if subscription is not None:
                mark_pushes_volume("sonos", self.target)
        except Exception as e:
            logger.debug(f"[Sonos:{self.target}] volume eventing unavailable: {e}")

    async def pause(self) -> None:
        device = await asyncio.to_thread(self._get_device)
        if await asyncio.to_thread(halt_if_possible, device.pause):
            logger.info(f"[Sonos:{self.target}] paused")

    async def resume(self) -> None:
        device = await asyncio.to_thread(self._get_device)
        await asyncio.to_thread(device.play)
        logger.info(f"[Sonos:{self.target}] resumed")

    async def stop(self) -> None:
        device = await asyncio.to_thread(self._get_device)
        if await asyncio.to_thread(halt_if_possible, device.stop):
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

    async def describe_transport(self) -> str | None:
        # Which of these explains a restart: a duration the speaker made up
        # for a stream that has none, its own repeat or crossfade setting,
        # or a transport that reports an error or a different URI.
        def read() -> str:
            device = self._get_device()
            track = device.get_current_track_info()
            transport = device.get_current_transport_info()
            return (
                f"state={transport.get('current_transport_state')} "
                f"status={transport.get('current_transport_status')} "
                f"position={track.get('position')} duration={track.get('duration')} "
                f"queue_position={track.get('playlist_position')} "
                f"play_mode={device.play_mode} crossfade={device.cross_fade} "
                f"uri={(track.get('uri') or '')[:80]}"
            )

        return await asyncio.to_thread(read)

    async def get_volume(self) -> float | None:
        device = await asyncio.to_thread(self._get_device)
        return await asyncio.to_thread(lambda: device.volume)

    async def set_volume(self, volume: float) -> None:
        device = await asyncio.to_thread(self._get_device)
        await asyncio.to_thread(setattr, device, "volume", int(volume))
