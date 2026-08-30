"""delivery/base.py — BaseDelivery abstract class"""

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable


class BaseDelivery(ABC):
    # Fixed startup-buffering delay (seconds) between the wall-clock position
    # tracked by the server and what's actually audible on the device. For a
    # protocol that can neither report a position nor have one derived for
    # it — no delivery here is in that position any more (AirPlay was the
    # last, see AirPlayDelivery.get_position()), but the mechanism stays as
    # the honest fallback for one that turns out to be.
    FIXED_OFFSET: float = 0.0

    # True if get_position() answers with something worth calibrating
    # against. Every delivery but AirPlay reads that off the device, which
    # is the real thing; AirPlay's is worked out from what it has pushed
    # and stays an approximation the device never confirms (see
    # AirPlayDelivery.get_position()). Both are better than a constant,
    # which is all this flag claims.
    SUPPORTS_POSITION: bool = False

    # Highest sample rate (Hz) / bit depth this device class is known to
    # accept for a stream-copied or lossless-reencoded source — read by
    # core/state.py's audio_capability_limits() and enforced in
    # core/streamer.py's resolve_output_format(). None means no known
    # limit: a high-res source is left untouched, same as before either
    # attribute existed. See each subclass for where its own number comes
    # from; this base default deliberately assumes nothing; a delivery
    # nobody has ever hit this class of failure with (AirPlay, DLNA, ...)
    # gets whatever the subclass declares, not a guess made here.
    MAX_SAMPLE_RATE_HZ: int | None = None
    MAX_BIT_DEPTH: int | None = None

    def __init__(self, target: str):
        self.target = target
        # Called when a delivery discovers by itself that playback has
        # failed, with a short description for the log. The one and only
        # way back into the session from here: a delivery holds no
        # reference to one, and cannot be given one, because core/state.py
        # imports this package and the reverse would be circular.
        #
        # Only AirPlay needs it, and only because of how it plays. Every
        # other target pulls GET /stream for the duration of the track, so
        # a device going away closes that connection and routes/stream.py
        # notices without anything being reported to it. AirPlay is pushed
        # to, and once the push fails there is nothing left holding a
        # connection open for anyone to notice the absence of.
        #
        # Wired up in core/state.py's resolve_target(); left None for a
        # delivery built outside that path (tests, routes/devices.py's
        # one-shot stop), where there is no session to report to anyway.
        self.on_playback_error: Callable[[str], Awaitable[None]] | None = None

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
