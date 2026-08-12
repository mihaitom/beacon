"""core/state.py — Session-agnostic runtime state: delivery resolution, global
(operator-configured) targets, and the AppState/EventBus building blocks used
by core/session.py's per-session SessionState.
"""

import asyncio
import os
import socket

from delivery import (
    AirPlayDelivery,
    BaseDelivery,
    ChromecastDelivery,
    DeliveryManager,
    DlnaDelivery,
    SonosDelivery,
)
from media import Track

from .playback_clock import PlaybackClock

PORT = int(os.getenv("PORT", "9181"))
TARGETS = os.getenv("TARGETS", "")


class AppState:
    def __init__(self):
        self.current_track: Track | None = None
        # Linear amplitude multiplier (ffmpeg `volume` filter convention) derived
        # from the frontend's ReplayGain settings for current_track. 1 = no change.
        self.current_track_gain: float = 1.0
        self.is_streaming: bool = False
        self.radio_info: dict | None = None
        self.active_delivery: BaseDelivery | DeliveryManager | None = None
        # Wall-clock position tracking for the current track/stream — see
        # playback_clock.py for why this is its own object.
        self.clock = PlaybackClock()
        # Set True when a track finishes naturally; cleared by /play, /play-url, /stop.
        # Lets the frontend detect track-end even after SSE reconnect or page reload.
        self.track_ended: bool = False
        # Identity + timestamp of the last dispatch actually sent to a delivery
        # target from /play or /play-url — see routes/playback.py's
        # _is_duplicate_dispatch(). Backend-side safety net against a
        # misbehaving client re-issuing the same play command in a tight loop:
        # each call stops and restarts the device before it can buffer audio.
        self.last_dispatch_key: str | None = None
        self.last_dispatch_at: float = 0.0


class EventBus:
    """Broadcasts a session's state changes to that session's connected SSE clients."""

    def __init__(self):
        self._queues: list[asyncio.Queue] = []

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=10)
        self._queues.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self._queues:
            self._queues.remove(q)

    async def broadcast(self, payload: dict) -> None:
        """Push `payload` to all of this session's connected SSE clients."""
        if not self._queues:
            return
        for q in self._queues:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass  # slow consumer — drop update rather than block


class Context:
    """Holds process-wide state that isn't specific to any one user's
    playback: `delivery` is the operator-configured (env `TARGETS`) fixed
    hardware, and `discovered` is the last device-discovery scan — properties
    of the deployment/network, not of a session. See core/session.py for the
    per-user SessionState/SessionRegistry this used to also hold."""

    def __init__(self):
        self.delivery = DeliveryManager(TARGETS)
        # Last successful discovery results — returned immediately on
        # subsequent /discover calls. Shared across sessions: the set of
        # devices on the network doesn't depend on who's asking (who's
        # *using* one of them does — see core/claims.py).
        self.discovered: dict = {
            "airplay": [],
            "chromecast": [],
            "dlna": [],
            "sonos": [],
        }


ctx = Context()


# ── Helpers ───────────────────────────────────────────────────────────────────


def get_local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def stream_url(session_id: str) -> str:
    return f"http://{get_local_ip()}:{PORT}/stream/{session_id}"


_DELIVERY_TYPES: dict[str, type[BaseDelivery]] = {
    "airplay": AirPlayDelivery,
    "chromecast": ChromecastDelivery,
    "dlna": DlnaDelivery,
    "sonos": SonosDelivery,
}


def delivery_class_for(target_type: str) -> type[BaseDelivery] | None:
    return _DELIVERY_TYPES.get(target_type)


def resolve_target(
    targets: list[dict] | None = None,
    target_name: str | None = None,
    target_type: str | None = None,
    previous: BaseDelivery | DeliveryManager | None = None,
) -> BaseDelivery | DeliveryManager | None:
    """Resolve one or more targets from a request into a single delivery object.

    `previous` is the caller's current active_delivery, if any — a requested
    (type, name) pair already present in `previous` reuses that same
    instance instead of constructing a fresh one. This matters for
    AirPlayDelivery specifically: play() relies on its own instance state
    (_stream_task, _atv) to stop its previous stream before reconnecting —
    a fresh instance on every call skips that, leaving the old RAOP session
    racing the new one for the device's single audio data port, which the
    device then refuses instead of cleanly handing over.
    """

    def _reuse(cls: type[BaseDelivery], name: str) -> BaseDelivery | None:
        candidates = (
            previous.deliveries
            if isinstance(previous, DeliveryManager)
            else [previous]
            if previous is not None
            else []
        )
        return next(
            (d for d in candidates if isinstance(d, cls) and d.target == name), None
        )

    if targets:
        deliveries: list[BaseDelivery] = []
        for t in targets:
            cls = _DELIVERY_TYPES.get(t.get("type"), AirPlayDelivery)
            deliveries.append(_reuse(cls, t["name"]) or cls(t["name"]))
        return DeliveryManager.from_deliveries(deliveries)
    if target_type and target_name:
        cls = _DELIVERY_TYPES.get(target_type, AirPlayDelivery)
        return _reuse(cls, target_name) or cls(target_name)
    if ctx.delivery.deliveries:
        return ctx.delivery
    return None


def find_sonos(active: BaseDelivery | DeliveryManager | None) -> list[SonosDelivery]:
    """Return all SonosDelivery objects in the active delivery, or from config."""
    if isinstance(active, SonosDelivery):
        return [active]
    if isinstance(active, DeliveryManager):
        found = [d for d in active.deliveries if isinstance(d, SonosDelivery)]
        if found:
            return found
    return [d for d in ctx.delivery.deliveries if isinstance(d, SonosDelivery)]


def list_target_pairs(
    delivery: BaseDelivery | DeliveryManager | None,
) -> list[tuple[str, str]]:
    """Flatten a delivery into (type, name) pairs — the shape the device claim
    registry (core/claims.py) keys on. Used for both status reporting
    (SessionState.build_status_dict) and claim enforcement, so grouped/fanned-out
    deliveries (e.g. Sonos multiroom followers) are accounted for identically
    in both places."""
    if isinstance(delivery, DeliveryManager):
        return [(t["type"], t["name"]) for t in delivery.list_targets()]
    if delivery is not None:
        return [(type(delivery).__name__.replace("Delivery", "").lower(), delivery.target)]
    return []
