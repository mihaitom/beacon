"""delivery/base.py — BaseDelivery abstract class"""

from abc import ABC, abstractmethod


class BaseDelivery(ABC):
    # Fixed startup-buffering delay (seconds) between the wall-clock position
    # tracked by the server and what's actually audible on the device. Used
    # for protocols that don't expose real playback position (e.g. AirPlay).
    FIXED_OFFSET: float = 0.0

    # True if get_position() returns a real device-side position.
    SUPPORTS_POSITION: bool = False

    def __init__(self, target: str):
        self.target = target

    @abstractmethod
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
        """Start stream playback. `duration` (seconds) is None for radio/URL
        streams, which have no fixed length. `content_type` is the real
        MIME type of what `stream_url` will actually serve — see
        core/streamer.py's resolve_output_format() — so device-facing
        metadata (DIDL protocolInfo, Cast content_type) matches what's sent
        instead of always claiming audio/mpeg."""

    @abstractmethod
    async def stop(self) -> None:
        """Stop playback."""

    async def pause(self) -> None:
        """Pause playback (optional, default: no-op)."""

    async def resume(self) -> None:
        """Resume playback (optional, default: no-op)."""

    async def get_position(self) -> float | None:
        """Return the device's actual playback position in seconds, or None
        if the protocol doesn't expose one."""
        return None

    async def current_uri(self) -> str | None:
        """What the device says it is currently playing, or None if it can't
        say (no transport to ask, nothing playing, lookup failed).

        Exists so a caller can tell "this device is still playing the stream
        *I* gave it" from "somebody else owns this device now" — which
        matters because a speaker is shared far more widely than this
        process knows about: another session, another Beacon instance on the
        same host, or one on a different machine entirely. Only session
        housekeeping uses it (core/session.py's reap_once); anything the
        user actually asked for stops the device unconditionally."""
        return None

    async def get_volume(self) -> float | None:
        """Return the device's current volume (0-100), or None if the
        protocol doesn't expose one."""
        return None

    async def set_volume(self, volume: float) -> None:
        """Set the device's volume (0-100) (optional, default: no-op)."""

    def __repr__(self):
        return f"{self.__class__.__name__}({self.target})"
