"""delivery/airplay.py — AirPlayDelivery via pyatv"""

import asyncio
import io
import logging

import httpx

from . import credentials as creds_store
from .base import BaseDelivery
from .lazy_import import import_in_thread

logger = logging.getLogger("delivery")


class AirPlayDelivery(BaseDelivery):
    """
    Streams audio to an AirPlay device via pyatv.

    pip install pyatv

    Important: pyatv pushes the stream actively (unlike Sonos which pulls).
    The stream task runs in the background until stop() is called.
    """

    # AirPlay/RAOP gives no position feedback. Empirically the device's
    # buffering adds roughly this much delay before audio is audible.
    FIXED_OFFSET: float = 2.0

    def __init__(self, target: str):
        super().__init__(target)
        self._stream_task: asyncio.Task | None = None
        self._atv = None
        self._play_lock = asyncio.Lock()

    async def _find_device(self):
        pyatv = await import_in_thread("pyatv")
        Protocol = (await import_in_thread("pyatv.const")).Protocol

        # Lazy import: core/state.py imports delivery, so top-level import would be circular
        from core.state import ctx

        stored_creds = creds_store.get(self.target)
        loop = asyncio.get_event_loop()
        # Unpaired devices must be scanned via RAOP; paired AirPlay 2 devices
        # need a full-protocol scan so the AirPlay (HAP) service is exposed.
        protocol = None if stored_creds else Protocol.RAOP
        kind = "AirPlay 2, paired" if stored_creds else "RAOP, unpaired"

        # Fast path: a targeted unicast scan to the IP from the last discovery
        # returns as soon as the device replies (~ms), avoiding the full ~10s
        # mDNS sweep on every play. Falls back to a full scan if the cached IP
        # is missing or stale.
        cached = next(
            (
                d
                for d in ctx.discovered.get("airplay", [])
                if d.get("name", "").lower() == self.target.lower() and d.get("address")
            ),
            None,
        )
        host = cached["address"] if cached else None

        async def _scan(hosts, timeout):
            logger.info(
                f"[AirPlay:{self.target}] Scanning ({kind}"
                f"{f', {hosts[0]}' if hosts else ', full'})..."
            )
            devices = await pyatv.scan(
                loop, timeout=timeout, protocol=protocol, hosts=hosts
            )
            return next(
                (d for d in devices if d.name.lower() == self.target.lower()), None
            ), devices

        match, devices = (await _scan([host], 5)) if host else (None, [])
        if match is None:
            match, devices = await _scan(None, 10)

        if match is None:
            available = [d.name for d in devices]
            raise RuntimeError(
                f"AirPlay '{self.target}' not found. Available: {available}"
            )

        if stored_creds:
            # AirPlay 2 pairing yields HAP credentials valid for both protocols.
            # The audio is streamed via RAOP, so the RAOP service needs the
            # credentials too — otherwise pyatv sets up an unencrypted session
            # and the device refuses the audio data port (Connection refused).
            match.set_credentials(Protocol.AirPlay, stored_creds)
            has_raop = match.set_credentials(Protocol.RAOP, stored_creds)
            logger.info(
                f"[AirPlay:{self.target}] Found: {match.address} "
                f"({kind}, raop_creds={has_raop})"
            )
        else:
            logger.info(f"[AirPlay:{self.target}] Found: {match.address} ({kind})")
        return match

    @staticmethod
    async def _close_atv(atv) -> None:
        """Await all tasks returned by atv.close() so the aiohttp session is
        properly torn down before the next connect() call."""
        tasks = atv.close()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

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
        # this parameter was added for (see dlna.py). content_type accepted
        # for the same interface-parity reason but genuinely unused here —
        # AirPlay downloads and streams the original file directly (pyatv's
        # own stream_file), it never goes through our ffmpeg /stream proxy
        # that content_type describes (see core/streamer.py).
        pyatv = await import_in_thread("pyatv")

        async def _stream():
            try:
                if not stream_url:
                    logger.warning(f"[AirPlay:{self.target}] No stream URL")
                    return

                if duration is None:
                    # Radio / live URL — already producing bytes in real time,
                    # so pyatv can fetch and decode it directly.
                    logger.info(f"[AirPlay:{self.target}] ▶ {title}: {stream_url[:80]}")
                    await captured_atv.stream.stream_file(stream_url)
                else:
                    # Queued track: stream_url is our own /stream/<session_id>
                    # proxy, fed by a freshly spawned ffmpeg transcode — its
                    # first bytes can take longer than pyatv's hardcoded 10s
                    # decoder-detection timeout to arrive, which fails with an
                    # opaque "failed to init decoder" if handed to pyatv live.
                    # Downloading the whole (seek/gain-adjusted) track first
                    # sidesteps that: pyatv then decodes from an in-memory
                    # buffer with no timeout risk.
                    logger.info(f"[AirPlay:{self.target}] ↓ downloading: {title}")
                    async with httpx.AsyncClient(
                        follow_redirects=True, timeout=600.0
                    ) as http:
                        resp = await http.get(stream_url)
                        resp.raise_for_status()
                    audio = io.BytesIO(resp.content)
                    logger.info(f"[AirPlay:{self.target}] ▶ {title}")
                    await captured_atv.stream.stream_file(audio)

                logger.info(f"[AirPlay:{self.target}] ✓ stream ended")

            except asyncio.CancelledError:
                logger.info(f"[AirPlay:{self.target}] Stream cancelled")

            except Exception as e:
                if "not connected to remote" in str(e):
                    # Teardown noise: Apple TV dropped the connection; the actual
                    # cause (e.g. "Connection refused") is already logged by pyatv above.
                    logger.warning(
                        f"[AirPlay:{self.target}] Device disconnected during stream"
                    )
                else:
                    logger.error(f"[AirPlay:{self.target}] Error: {e}", exc_info=True)

            finally:
                if self._atv is captured_atv:
                    self._atv = None
                try:
                    await asyncio.shield(self._close_atv(captured_atv))
                except asyncio.CancelledError:
                    pass

        # Held from the previous stream's teardown through the new stream
        # task's creation (not just the connect) — otherwise a stop() landing
        # in the gap between releasing the lock and setting self._stream_task
        # would see the *old* (already-stopped) task, skip cancelling it, and
        # instead close self._atv — which by then is this call's freshly
        # connected instance, not the old one. stop() acquires the same lock
        # below, via _stop_locked(), so the two can never interleave.
        async with self._play_lock:
            await self._stop_locked()

            conf = await self._find_device()
            loop = asyncio.get_event_loop()
            self._atv = await pyatv.connect(conf, loop)

            logger.info(
                f"[AirPlay:{self.target}] connected — '{title}' (backend: {stream_url})"
            )

            # Capture connection at task-creation time so the finally block
            # closes exactly this instance, even if self._atv is replaced by
            # a concurrent play() call.
            captured_atv = self._atv
            self._stream_task = asyncio.create_task(_stream())

        logger.info(f"[AirPlay:{self.target}] ✓ stream task started")

    async def pause(self) -> None:
        # RAOP has no native pause — pyatv only exposes stop() for the audio
        # stream. Stopping the push here is correct: /resume reconnects via
        # play() with the seek offset already applied server-side (see
        # routes/stream.py), same as it does for a plain seek.
        await self.stop()

    async def stop(self) -> None:
        async with self._play_lock:
            await self._stop_locked()

    async def _stop_locked(self) -> None:
        """stop()'s actual work, assuming _play_lock is already held —
        called both by the public stop() and by play() to tear down the
        previous stream before starting a new one. Never call this directly
        without holding the lock (see play()'s comment for why)."""
        if self._stream_task and not self._stream_task.done():
            self._stream_task.cancel()
            try:
                await self._stream_task
            except asyncio.CancelledError:
                pass
        # _stream()'s finally already closes _atv when the task exits normally
        # or on cancellation. This handles the edge case where stop() is called
        # without an active stream task (e.g. connect failed after _atv was set).
        atv, self._atv = self._atv, None
        if atv:
            await self._close_atv(atv)
        logger.info(f"[AirPlay:{self.target}] stopped")
