"""delivery/chromecast.py — ChromecastDelivery via pychromecast"""

import asyncio
import logging
import threading
import time

from .base import BaseDelivery

logger = logging.getLogger("delivery")

# How often get_position() may ask a Chromecast for a fresh media status
# while its cached one says nothing usable — see the comment there. Twice
# the 0.5s poll core/radio_position.py uses while waiting for a device to
# start, so a stale cache is corrected within a poll or two without a
# genuinely buffering device being asked on every single one.
_STATUS_REFRESH_SECONDS = 1.0

# Module-level long-lived zeroconf + CastBrowser. Started once on first use and
# kept alive for the process lifetime. All chromecast operations (discovery and
# playback) share these — cast objects' socket clients need a live zeroconf for
# reconnection (stopping discovery causes "Zeroconf instance loop must be running").
_zconf = None
_cast_browser = None
_browser_started_at: float = 0.0
_browser_lock = threading.Lock()
_chromecast_cache: dict = {}


def _ensure_cast_browser():
    """Lazy-init the module-level zeroconf + CastBrowser. Never stopped."""
    global _zconf, _cast_browser, _browser_started_at
    if _cast_browser is not None:
        return _cast_browser, _zconf

    import pychromecast
    import zeroconf as zc

    with _browser_lock:
        if _cast_browser is None:
            _zconf = zc.Zeroconf()
            _cast_browser = pychromecast.discovery.CastBrowser(
                pychromecast.discovery.SimpleCastListener(),
                _zconf,
            )
            _cast_browser.start_discovery()
            _browser_started_at = time.time()
            logger.info("[Chromecast] CastBrowser started")
    return _cast_browser, _zconf


def _wait_for_discovery(min_seconds: float = 2.0) -> None:
    """Block briefly to let mDNS responses arrive on first discovery."""
    elapsed = time.time() - _browser_started_at
    if elapsed < min_seconds:
        time.sleep(min_seconds - elapsed)


class _VolumeListener:
    """Reports this device's own volume changes, the same way a Sonos
    speaker's RenderingControl subscription does (see
    core/device_volume.py).

    pychromecast pushes a CastStatus on every change the device makes —
    including the ones nothing here asked for: the TV remote, the Google
    Home app, another cast sender. That is what replaces asking the device
    every four seconds.

    Called on pychromecast's own connection thread, hence
    report_volume_from_thread() rather than a coroutine. Registered once per
    connection, and pychromecast keeps only a weak-ish list of listeners on
    that connection object — this instance is kept alive by the cache entry
    it hangs off (see _register_volume_listener)."""

    def __init__(self, target: str) -> None:
        self.target = target

    def new_cast_status(self, status) -> None:
        from core.device_volume import report_volume_from_thread

        level = getattr(status, "volume_level", None)
        if level is None:
            return
        report_volume_from_thread(
            "chromecast",
            self.target,
            volume=round(level * 100),
            muted=bool(getattr(status, "volume_muted", False)),
        )


def _register_volume_listener(cast, target: str) -> None:
    """Attach a _VolumeListener to a freshly connected device, once.

    Kept on the cast object itself rather than in a map of its own: the
    listener's life is exactly that connection's, and the cache already
    drops the connection when it stops answering (see
    _get_cached_chromecast), taking this with it."""
    from core.device_volume import mark_pushes_volume

    if getattr(cast, "_beacon_volume_listener", None) is not None:
        return
    try:
        listener = _VolumeListener(target)
        cast.register_status_listener(listener)
        cast._beacon_volume_listener = listener
        mark_pushes_volume("chromecast", target)
    except Exception as e:
        # A device that won't take a listener simply stays on the poll.
        logger.debug(f"[Chromecast:{target}] volume eventing unavailable: {e}")


def _get_cached_chromecast(target: str):
    """Return a connected, cached Chromecast or None if not cached / stale."""
    cast = _chromecast_cache.get(target.lower())
    if cast is None:
        return None
    try:
        if cast.socket_client.is_connected:
            return cast
    except Exception as e:
        logger.debug(
            f"[Chromecast:{target}] cached device no longer answering ({e}) — dropping from cache"
        )
    from core.device_volume import clear_pushes_volume

    _chromecast_cache.pop(target.lower(), None)
    # Nothing is pushing for it any more, so whoever is showing its volume
    # goes back to asking — see core/device_volume.py.
    clear_pushes_volume("chromecast", target)
    return None


class ChromecastDelivery(BaseDelivery):
    """Controls a Chromecast (Google Cast) device via pychromecast."""

    SUPPORTS_POSITION: bool = True
    # The (now discontinued) Chromecast Audio's own spec — 24-bit/96kHz.
    # Not necessarily every Cast-enabled speaker/soundbar this delivery can
    # target (Google's own Default Media Receiver's real ceiling isn't
    # published as clearly), but a documented number beats a guess, and
    # it's the more permissive end of what's out there rather than the
    # restrictive one — see docs/investigations/copy-tier-device-limits.md,
    # for why guessing wrong in the *restrictive* direction is the one that
    # actually breaks playback.
    MAX_SAMPLE_RATE_HZ: int | None = 96000
    MAX_BIT_DEPTH: int | None = 24
    # The one target here that does play Opus: Google's Default Media
    # Receiver lists it alongside MP3, AAC, Vorbis, FLAC and WAV. That is
    # the whole reason Opus is offered as a cast quality at all — every
    # other target falls back to AAC for it (see core/streamer.py's
    # _codec_for_ceiling()).
    PLAYABLE_CODECS: frozenset[str] = frozenset({"mp3", "aac", "flac", "vorbis", "opus"})
    # When this delivery last asked the device for a fresh media status —
    # see get_position(). Class-level default, assigned per instance on
    # first use; a delivery object is per target and per dispatch, and a
    # brand-new one asking immediately is exactly right.
    _status_refreshed_at: float = 0.0

    def _get_device(self):
        import pychromecast

        cached = _get_cached_chromecast(self.target)
        if cached is not None:
            return cached

        browser, zconf = _ensure_cast_browser()
        _wait_for_discovery(min_seconds=3.0)

        target_lower = self.target.lower()
        for cast_info in browser.devices.values():
            if cast_info.friendly_name.lower() == target_lower:
                cast = pychromecast.get_chromecast_from_cast_info(cast_info, zconf)
                cast.wait(timeout=10)
                _chromecast_cache[target_lower] = cast
                _register_volume_listener(cast, self.target)
                return cast

        available = [info.friendly_name for info in browser.devices.values()]
        raise RuntimeError(f"Chromecast '{self.target}' not found. Available: {available}")

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
        import pychromecast

        cast = await asyncio.to_thread(self._get_device)
        # Some receivers (e.g. Google TV's own home-screen "Media Player")
        # already declare support for the media namespace while running a
        # non-default app, so play_media() below would send LOAD there
        # instead of to the Default Media Receiver — and that app silently
        # drops it (no error, no HTTP request ever reaches our stream_url).
        # start_app() only actually launches when a different app is
        # running, so this is a no-op once the Default Media Receiver is
        # already active.
        await asyncio.to_thread(cast.start_app, pychromecast.APP_MEDIA_RECEIVER)
        mc = cast.media_controller
        metadata = {"metadataType": 3, "title": title, "artist": artist}
        if album_art_url:
            metadata["images"] = [{"url": album_art_url}]
        if album:
            metadata["albumName"] = album
        logger.debug(f"[Chromecast:{self.target}] → play: {stream_url}")
        await asyncio.to_thread(
            mc.play_media,
            stream_url,
            content_type,
            title=title,
            thumb=album_art_url,
            metadata=metadata,
        )
        await asyncio.to_thread(mc.block_until_active, 10)
        logger.info(f"[Chromecast:{self.target}] ✓ playing")

    async def pause(self) -> None:
        cast = await asyncio.to_thread(self._get_device)
        await asyncio.to_thread(cast.media_controller.pause)
        logger.info(f"[Chromecast:{self.target}] paused")

    async def resume(self) -> None:
        cast = await asyncio.to_thread(self._get_device)
        await asyncio.to_thread(cast.media_controller.play)
        logger.info(f"[Chromecast:{self.target}] resumed")

    async def stop(self) -> None:
        cast = await asyncio.to_thread(self._get_device)
        await asyncio.to_thread(cast.media_controller.stop)
        logger.info(f"[Chromecast:{self.target}] stopped")

    async def get_position(self) -> float | None:
        cast = await asyncio.to_thread(self._get_device)
        status = cast.media_controller.status
        if status.player_state not in ("PLAYING", "PAUSED"):
            # Nothing usable in whatever this device last *pushed*. Two very
            # different situations look identical from here: a device
            # genuinely still buffering, and a cached status nothing ever
            # sent an update for — pychromecast keeps the last pushed one,
            # and a Chromecast object is reused across dispatches (see
            # _chromecast_cache above, and core/radio_position.py's own
            # _REBASELINE_AFTER_SECONDS for the other half of that hazard).
            #
            # Asking settles it: a GET_STATUS over the socket that is
            # already open. Its answer arrives asynchronously and is read by
            # the next poll — the point of the call is that there *is* a
            # next answer, rather than waiting on a device that has stopped
            # pushing. Rate-limited because core/radio_position.py polls
            # every 0.5s while waiting for a device to start, and a device
            # that keeps answering "buffering" should not be asked twice a
            # second for as long as that lasts.
            #
            # Observed live 2026-09-07: a Chromecast reporting nothing
            # usable for 48s after a pause/resume, while audibly playing the
            # whole time — its position, when it finally arrived, was 35.61s
            # into a stream dispatched 48s earlier, i.e. it had been playing
            # all along. The radio buffering indicator and the visualizer
            # both wait on this reading, so both sat frozen for those 48s.
            now = time.monotonic()
            if now - self._status_refreshed_at > _STATUS_REFRESH_SECONDS:
                self._status_refreshed_at = now
                logger.debug(
                    f"[Chromecast:{self.target}] no usable position "
                    f"(player_state={status.player_state}) — asking for a fresh status"
                )
                await asyncio.to_thread(cast.media_controller.update_status)
            return None
        return status.adjusted_current_time

    async def current_uri(self) -> str | None:
        cast = await asyncio.to_thread(self._get_device)
        status = cast.media_controller.status
        if status.player_state not in ("PLAYING", "PAUSED", "BUFFERING"):
            return None
        return status.content_id or None
