"""delivery/chromecast.py — ChromecastDelivery via pychromecast"""

import asyncio
import logging
import threading
import time

from .base import BaseDelivery

logger = logging.getLogger("delivery")

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


def _get_cached_chromecast(target: str):
    """Return a connected, cached Chromecast or None if not cached / stale."""
    cast = _chromecast_cache.get(target.lower())
    if cast is None:
        return None
    try:
        if cast.socket_client.is_connected:
            return cast
    except Exception:
        pass
    _chromecast_cache.pop(target.lower(), None)
    return None


class ChromecastDelivery(BaseDelivery):
    """Controls a Chromecast (Google Cast) device via pychromecast."""

    SUPPORTS_POSITION: bool = True
    # The (now discontinued) Chromecast Audio's own spec — 24-bit/96kHz.
    # Not necessarily every Cast-enabled speaker/soundbar this delivery can
    # target (Google's own Default Media Receiver's real ceiling isn't
    # published as clearly), but a documented number beats a guess, and
    # it's the more permissive end of what's out there rather than the
    # restrictive one — see docs/playback-bugs/copy-tier-device-limits.md,
    # for why guessing wrong in the *restrictive* direction is the one that
    # actually breaks playback.
    MAX_SAMPLE_RATE_HZ: int | None = 96000
    MAX_BIT_DEPTH: int | None = 24

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
                return cast

        available = [info.friendly_name for info in browser.devices.values()]
        raise RuntimeError(
            f"Chromecast '{self.target}' not found. Available: {available}"
        )

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
        cast = await asyncio.to_thread(self._get_device)
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
            return None
        return status.adjusted_current_time

    async def current_uri(self) -> str | None:
        cast = await asyncio.to_thread(self._get_device)
        status = cast.media_controller.status
        if status.player_state not in ("PLAYING", "PAUSED", "BUFFERING"):
            return None
        return status.content_id or None
