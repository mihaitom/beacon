"""delivery/airplay.py — AirPlayDelivery via pyatv"""

import asyncio
import logging

import httpx

from . import credentials as creds_store
from .base import BaseDelivery
from .lazy_import import import_in_thread

logger = logging.getLogger("delivery")


# Artwork is sent inline over RTSP as part of the track's DAAP metadata, so
# it travels on the same connection as the audio and there is no second
# fetch for the device to make. Big enough for a cover, small enough that a
# mis-sized image can't crowd out the stream it shares a socket with — a
# 300px JPEG, which is what every media server here serves, lands well
# under this.
_MAX_ARTWORK_BYTES = 2 * 1024 * 1024

# Long enough for a media server that has to resize on demand, short enough
# that a slow one delays the first note by a noticeable but bounded amount.
# The track plays without a cover if this runs out; it never fails the play.
_ARTWORK_TIMEOUT_SECONDS = 5.0


async def _fetch_artwork(url: str | None) -> bytes | None:
    """Raw JPEG bytes for `url`, or None if it can't be had.

    Never raises: artwork is decoration, and a media server having a bad
    moment must not stop the music. Every miss is a debug line and a track
    that plays without a cover.
    """
    if not url:
        return None
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=_ARTWORK_TIMEOUT_SECONDS
        ) as http:
            resp = await http.get(url)
            resp.raise_for_status()
            if len(resp.content) > _MAX_ARTWORK_BYTES:
                logger.debug(f"[AirPlay] Artwork too large ({len(resp.content)}B), skipping")
                return None
            return resp.content
    except (httpx.HTTPError, ValueError) as e:
        logger.debug(f"[AirPlay] Artwork unavailable: {e}")
        return None


async def _aclose_quietly(closeable) -> None:
    """Close an httpx client or response without letting the teardown itself
    become the failure.

    Called from a finally that may already be unwinding a real error, and on
    the cancellation path, where the connection is usually half-torn-down
    already — which is exactly when aclose() has something to complain
    about. The two caught here are what that actually looks like: a
    transport-level error finishing the read, or httpx objecting that the
    thing is closed or in the wrong state. Anything else is a real bug and
    is left to propagate.
    """
    try:
        await closeable.aclose()
    except (httpx.HTTPError, RuntimeError) as e:
        logger.debug(f"[AirPlay] Ignoring error while closing stream: {e}")


class _ResponseReader:
    """Hands pyatv an open HTTP response one chunk at a time.

    Exists to keep whole tracks out of memory. AirPlay used to download the
    entire track into an io.BytesIO before playing a note of it — over
    100MB for an 80-minute mix, per target — because handing pyatv the URL
    itself runs into a hardcoded timeout: `PatchedIceCastClient.read()`
    (pyatv's protocols/raop/audio_source.py) raises after DEFAULT_TIMEOUT =
    10s whenever the buffer hasn't filled, and our /stream is fed by a
    freshly spawned ffmpeg that can take longer than that to produce its
    first bytes. The failure surfaces as an opaque "failed to init decoder".

    That timeout belongs to the URL path specifically. `open_source()`
    branches on `isinstance(source, str)`, and anything that is neither a
    string nor an io.BufferedIOBase ends up in `StreamReaderWrapper`, whose
    only interaction with what it was given is `await source.read(n)` —
    with no timeout anywhere. So this class implements exactly that one
    method and nothing else.

    Back-pressure comes for free: the next chunk is pulled off the response
    only when pyatv asks for one, so nothing accumulates. An
    asyncio.StreamReader fed by a pump task would have reintroduced the
    original problem in a new shape — feed_data() has no flow control
    without a transport behind it, so a producer faster than the consumer
    fills memory just the same.

    **A known edge, and why it does not bite in practice.**
    `StreamReaderWrapper.read()` computes `min(n, BUFFER_SIZE - buffer.size)`
    before asking us for anything, so a full 64KB buffer makes it ask for
    zero bytes — and a zero-byte read is, correctly, empty, which miniaudio
    reads as end of stream. Reproduced 2026-08-26 by feeding a whole track
    in as fast as the reader would take it, where FLAC then failed to
    initialise its decoder.

    It does not happen against the real /stream because that end is paced to
    real time (core/streamer.py's _READRATE_ARGS), so the buffer never gets
    far enough ahead — confirmed on a real Apple TV the same day, playing a
    24/96 FLAC resampled to 44.1/16. Worth knowing before "speeding up" the
    stream: removing the pacing for AirPlay would turn this from a lab
    curiosity into silence.
    """

    # What read(-1) answers with. pyatv asks for "everything" in one branch
    # of StreamReaderWrapper.read(); answering literally would buffer the
    # rest of the track, which is the thing this class exists to avoid.
    # Returning less than asked for is allowed — the caller comes back for
    # more — as long as it is never *empty*, which means end of stream.
    _UNBOUNDED_READ_SIZE = 64 * 1024

    def __init__(self, response: httpx.Response):
        self._chunks = response.aiter_bytes()
        self._buffer = bytearray()
        self._eof = False

    async def read(self, n: int = -1) -> bytes:
        """Up to `n` bytes, or fewer only at the end of the stream.

        Fewer *before* the end would be legal for a file object but is not
        worth the risk here: miniaudio treats a short read as a hint about
        the source, and the chunk boundaries httpx happens to produce carry
        no meaning at all.
        """
        want = self._UNBOUNDED_READ_SIZE if n < 0 else n
        if want == 0:
            return b""
        while len(self._buffer) < want and not self._eof:
            try:
                self._buffer += await anext(self._chunks)
            except StopAsyncIteration:
                self._eof = True
        chunk = bytes(self._buffer[:want])
        del self._buffer[:want]
        return chunk


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
    # Classic AirPlay/RAOP's real ceiling — 16-bit/44.1kHz, matching CD
    # quality and nothing past it (AirPlay 2 raised this on newer hardware,
    # but pyatv's classic RAOP path this delivery uses does not negotiate
    # that). Lower priority than Sonos/Chromecast/DLNA to actually exercise
    # live (see TODO.md), but declared correctly rather than left at "no
    # limit" now that the mechanism exists.
    MAX_SAMPLE_RATE_HZ: int | None = 44100
    MAX_BIT_DEPTH: int | None = 16

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
            devices = await pyatv.scan(loop, timeout=timeout, protocol=protocol, hosts=hosts)
            return next(
                (d for d in devices if d.name.lower() == self.target.lower()), None
            ), devices

        match, devices = (await _scan([host], 5)) if host else (None, [])
        if match is None:
            match, devices = await _scan(None, 10)

        if match is None:
            available = [d.name for d in devices]
            raise RuntimeError(f"AirPlay '{self.target}' not found. Available: {available}")

        if stored_creds:
            # AirPlay 2 pairing yields HAP credentials valid for both protocols.
            # The audio is streamed via RAOP, so the RAOP service needs the
            # credentials too — otherwise pyatv sets up an unencrypted session
            # and the device refuses the audio data port (Connection refused).
            match.set_credentials(Protocol.AirPlay, stored_creds)
            has_raop = match.set_credentials(Protocol.RAOP, stored_creds)
            logger.info(
                f"[AirPlay:{self.target}] Found: {match.address} ({kind}, raop_creds={has_raop})"
            )
        else:
            logger.info(f"[AirPlay:{self.target}] Found: {match.address} ({kind})")
        return match

    async def _report_playback_error(self, detail: str) -> None:
        """Tell the session its playback died, if anyone is listening.

        None whenever this delivery wasn't built through
        core/state.py's resolve_target() — routes/devices.py constructs a
        throwaway instance just to stop a device, and there is no session
        behind that one to report to. A failure in the callback itself must
        not take down the teardown that follows it in _stream()'s finally.
        """
        if self.on_playback_error is None:
            return
        try:
            await self.on_playback_error(detail)
        except Exception:
            logger.exception(f"[AirPlay:{self.target}] Reporting playback error failed")

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
        # content_type accepted for interface parity with BaseDelivery.play()
        # but genuinely unused here: it describes what our ffmpeg /stream
        # proxy is sending, and pyatv works that out from the bytes itself
        # rather than being told.
        pyatv = await import_in_thread("pyatv")
        MediaMetadata = (await import_in_thread("pyatv.interface")).MediaMetadata

        # Told to the device explicitly rather than left for pyatv to read
        # out of the stream. Two reasons it cannot be left to the stream:
        # ffmpeg's -vn (see core/streamer.py's _FFMPEG_BASE_CMD) strips the
        # embedded cover before anything downstream could see it, and the
        # tags that do survive are only readable when the source is fully
        # seekable — which a live stream is not. We have all of it in hand
        # anyway, from the same /play request that named the track.
        #
        # Passing this also stops pyatv calling get_metadata() on the source
        # at all (see its stream_file()), so nothing depends on what the
        # stream happens to carry.
        metadata = MediaMetadata(
            title=title or None,
            artist=artist or None,
            album=album or None,
            duration=duration,
            artwork=await _fetch_artwork(album_art_url),
        )

        async def _stream():
            # Set only on the queued-track path below; closed in the finally
            # whichever way this ends, including cancellation.
            http: httpx.AsyncClient | None = None
            resp: httpx.Response | None = None
            try:
                if not stream_url:
                    logger.warning(f"[AirPlay:{self.target}] No stream URL")
                    return

                if duration is None:
                    # Radio / live URL — already producing bytes in real time,
                    # so pyatv can fetch and decode it directly.
                    logger.info(f"[AirPlay:{self.target}] ▶ {title}: {stream_url[:80]}")
                    await captured_atv.stream.stream_file(stream_url, metadata=metadata)
                else:
                    # Queued track: stream_url is our own /stream/<session_id>
                    # proxy, fed by a freshly spawned ffmpeg transcode. Read
                    # incrementally rather than handed to pyatv as a URL —
                    # see _ResponseReader for why the URL path is not an
                    # option and why this doesn't buffer the track.
                    #
                    # The client and the response both have to outlive this
                    # statement: stream_file() below reads from them for the
                    # length of the track, so closing either at the end of an
                    # `async with` would tear the stream down before a note
                    # played. Both are closed in the finally instead.
                    http = httpx.AsyncClient(follow_redirects=True, timeout=600.0)
                    resp = await http.send(http.build_request("GET", stream_url), stream=True)
                    resp.raise_for_status()
                    logger.info(
                        f"[AirPlay:{self.target}] ▶ {title}"
                        f"{' (with artwork)' if metadata.artwork else ''}"
                    )
                    await captured_atv.stream.stream_file(_ResponseReader(resp), metadata=metadata)

                logger.info(f"[AirPlay:{self.target}] ✓ stream ended")

            except asyncio.CancelledError:
                logger.info(f"[AirPlay:{self.target}] Stream cancelled")

            except Exception as e:
                if "not connected to remote" in str(e):
                    # The device went away mid-track. Unlike the pull-based
                    # targets, nothing else can notice this: they hold a GET
                    # /stream connection open for the whole track, so their
                    # dying closes it and routes/stream.py sees the absence.
                    # AirPlay is pushed to, and a failed push is the only
                    # trace there is — which is why this used to be a silent
                    # death (see docs/playback-bugs/airplay-silent-death.md).
                    #
                    # Reported without a grace period, deliberately, unlike
                    # _mark_disconnected_if_not_reconnected()'s 10s wait: a
                    # clean FIN there cannot be told apart from somebody
                    # pressing stop on the speaker, so it waits to see if a
                    # reconnect turns up. A push that failed is unambiguous.
                    logger.warning(f"[AirPlay:{self.target}] Device disconnected during stream")
                    await self._report_playback_error(
                        f"AirPlay device '{self.target}' disconnected mid-track"
                    )
                else:
                    logger.exception(f"[AirPlay:{self.target}] Error")

            finally:
                # Before the atv teardown: these hold an open connection to
                # our own /stream, and leaving it dangling keeps ffmpeg
                # producing for a target that has stopped listening.
                if resp is not None:
                    await asyncio.shield(_aclose_quietly(resp))
                if http is not None:
                    await asyncio.shield(_aclose_quietly(http))
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

            logger.info(f"[AirPlay:{self.target}] connected — '{title}' (backend: {stream_url})")

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
