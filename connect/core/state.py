"""core/state.py — Session-agnostic runtime state: delivery resolution and
the AppState/EventBus building blocks used by core/session.py's per-session
SessionState.
"""

import asyncio
import os
import socket
from collections.abc import Awaitable, Callable

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
from .streamer import FALLBACK_FORMAT, OutputFormat

PORT = int(os.getenv("PORT", "7071"))


class AppState:
    def __init__(self):
        self.current_track: Track | None = None
        # Linear amplitude multiplier (ffmpeg `volume` filter convention) derived
        # from the frontend's ReplayGain settings for current_track. 1 = no change.
        self.current_track_gain: float = 1.0
        self.is_streaming: bool = False
        # How many GET /stream connections are *currently* open for this
        # session, right now — incremented in audio_stream() when a device
        # actually opens one (not the "no track loaded" 204 case), and
        # decremented in stream_with_completion()'s own finally block once
        # that specific connection ends, however it ends. See
        # _mark_disconnected_if_not_reconnected()'s own docstring for why
        # this needs to be a live count rather than a single "most recent
        # connection" marker: multi-target casting (e.g. Chromecast + DLNA
        # at once) means more than one connection can legitimately be open
        # for the same session simultaneously, each independently dropping
        # and reconnecting on its own — a single shared counter/generation
        # can't tell "the *other* device's connection changed" apart from
        # "mine did", and either wrongly declares the whole session dead
        # while a different device is still audibly playing, or never
        # notices its own device died at all once a later device's
        # connection has since bumped the count past it.
        self.active_stream_connections: int = 0
        # The play_generation that has already had audio served for it. What
        # distinguishes "the first GET /stream of a fresh dispatch" from "the
        # device reopened the stream on its own" — the two look identical
        # otherwise, since resume_offset has been consumed by then in both
        # cases. Set by routes/stream.py once a connection actually produces
        # bytes, not when it merely opens: a device can open and abandon a
        # connection without ever reading from it.
        self.streamed_generation: int | None = None
        self.radio_info: dict | None = None
        self.active_delivery: BaseDelivery | DeliveryManager | None = None
        # Bumped by core/session.py's displace_target() whenever its
        # play_lock-timeout fallback mutates active_delivery/is_streaming
        # *without* holding play_lock (see that function's own docstring
        # for why the fallback exists at all — a bounded wait to avoid a
        # cross-session deadlock). /play's own dispatch captures this right
        # after it sets active_delivery; if a failed target.play() then
        # needs to roll that back, it re-checks this first — a stale
        # displacement from a slow/unreachable device (the same kind of
        # device the timeout fallback exists for) resolving *after* an
        # unlocked displacement already landed must not silently clobber
        # it back to the pre-dispatch snapshot, undoing a takeover another
        # session was already told (via the "displaced" broadcast)
        # succeeded. Not touched by the locked, normal path in
        # displace_target()'s own _apply() — that one is already correctly
        # serialized against /play by play_lock itself.
        self.active_delivery_seq: int = 0
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
        # The queue (below) as it stood right *before* the last accepted
        # autoplay top-up extended it, plus when — see routes/playback.py's
        # _is_duplicate_queue_topup(). Two frontends sharing a cast session
        # both mirror the same queue-running-low status and can independently
        # decide to top it up, each after its own getSimilarSongs2() round
        # trip, each computing its own extension against that same *pre*-
        # top-up queue; without this, whichever /queue POST lands second (a
        # plain full-replacement, same as any other queue edit) silently
        # clobbers the first client's addition instead of the two merging.
        # Recording the pre-top-up queue specifically (not just a key derived
        # from the live one) is what lets the second racer still be
        # recognized once the first has already landed and moved `queue` on
        # — by the time it arrives, it no longer extends the *current* queue
        # at all, only this remembered earlier one. Separate fields from
        # last_dispatch_key/-_at above rather than sharing them: that pair's
        # own cooldown is tuned for a misbehaving client re-issuing /play in
        # a tight loop (sub-second), while this race spans a real
        # media-server round trip and needs a longer window.
        self.last_queue_topup_base: list[str] | None = None
        self.last_queue_topup_at: float = 0.0
        # Format resolved for current_track by routes/playback.py at dispatch
        # time (/play, /resume, /seek) — see core/streamer.py's
        # resolve_output_format(). /stream reads this instead of probing
        # again, so HEAD/GET and the actual ffmpeg invocation always agree
        # on what's being sent. Resets to the fallback for radio (/play-url
        # never goes through our own /stream proxy, so it's irrelevant there).
        self.current_output_format: OutputFormat = FALLBACK_FORMAT
        # The listener's standing quality ceiling for this cast, as last set
        # by a /play (see routes/playback.py's PlayRequest). Held on the
        # session rather than only per request because auto-advance
        # (routes/stream.py) resolves the *next* track's format with no
        # request of its own to read it from, and because a second client
        # controlling the same cast should not silently re-cap it to its own
        # setting mid-queue. Both None means no ceiling.
        self.max_lossy_format: str | None = None
        self.max_lossy_bitrate_kbps: int | None = None
        # The *full* ordered queue as the frontend currently understands it —
        # already-played history included, not just what's left — with
        # queue[queue_index] == current_track. Set by /play (fresh dispatch)
        # and /queue (an edit that doesn't restart playback, e.g. a reorder);
        # never derived from anything else. Two independent things read this:
        # - routes/stream.py's _advance_or_end() auto-advances casting to
        #   queue[queue_index + 1] entirely server-side when one exists,
        #   instead of only ever marking track_ended and waiting for the
        #   frontend to notice and re-dispatch — which never happens if the
        #   renderer that started this session is asleep (locked screen).
        # - build_status_dict() broadcasts it over SSE so every client
        #   controlling this session (not just the one that dispatched it)
        #   can mirror the same queue/current-song in its own UI — see
        #   stores/playback.ts's queue-adoption logic.
        # Reset to empty by /stop and /play-url (radio has no queue).
        self.queue: list[str] = []
        self.queue_index: int = 0
        # The *unshuffled* reference order queue was built from — mirrors
        # stores/playback.ts's own originalQueue exactly (same ids, same
        # purpose: what toggling shuffle off reverts queue to). Only ever
        # meaningful together with `queue`/shuffle above; not touched by
        # _advance_or_end() itself. Not reset by /stop/-url either — same
        # reasoning as shuffle/repeat_mode below, these are standing
        # preferences, not queue contents.
        self.original_queue: list[str] = []
        # Standing playback preferences, not tied to any one queue/track —
        # mirrors stores/playback.ts's shuffle/repeatMode. Broadcast over SSE
        # (build_status_dict()) purely so every client sharing this session
        # shows the same toggle state and, for shuffle, has a correct
        # original_queue to revert to when toggling it off locally — connect
        # itself never reads either of these (repeat-all/repeat-one/shuffle
        # logic all stays renderer-side, see stores/playback.ts's
        # advanceOnSongEnd()/toggleShuffle()). Not reset by /stop/-url:
        # switching to radio or stopping doesn't mean "forget the shuffle/
        # repeat preference for next time there's a queue again."
        self.shuffle: bool = False
        self.repeat_mode: str = "off"
        # Autoplay's own standing preference — mirrors stores/autoplay.ts's
        # enabled/batchSize, sent alongside shuffle/repeat_mode above (see
        # routes/playback.py's PlayRequest/QueueRequest) but, unlike those
        # two, actually read by connect itself: routes/stream.py's
        # _advance_or_end() uses it as a fallback queue top-up for whenever
        # no frontend client is around to run stores/playback.ts's own
        # maybeAutoplay() — see that function's docstring for why this is a
        # fallback and not the primary implementation. Not reset by /stop/
        # -url, same reasoning as shuffle/repeat_mode: a standing
        # preference, not queue contents.
        self.autoplay_enabled: bool = False
        self.autoplay_batch_size: int = 10
        # Last-known (volume, muted) per claimed device, keyed like
        # core/claims.py's own "type:name" — pushed by routes/upnp.py's
        # RenderingControl NOTIFY handler (Sonos only for now) and by
        # routes/volume.py's own explicit set, so build_status_dict() can
        # include it without a live device round trip on every status poll.
        # Either half stays None until something has actually reported it —
        # a device this session has never claimed, or one whose first
        # RenderingControl event hasn't arrived yet, has nothing to show,
        # which is exactly DeviceListItem.vue's existing "unfetched" state
        # (the slider hides rather than guessing a starting value).
        self.device_volumes: dict[str, tuple[int | None, bool | None]] = {}


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
    playback: `discovered` is the last device-discovery scan — a property of
    the deployment/network, not of a session. See core/session.py for the
    per-user SessionState/SessionRegistry this used to also hold."""

    def __init__(self):
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


def radio_stream_url(session_id: str) -> str:
    """Where a device fetches a *re-encoded* radio station from.

    Plain http on the LAN, like stream_url() above, which is half of why
    this route exists at all: a station published over https on someone
    else's host is refused outright by some devices (a Sonos answers
    ERROR_ACCESS_DENIED), and one in a format they won't take is refused
    the same way (ERROR_UNSUPPORTED_FORMAT). Both disappear when the bytes
    come from here as MP3 over http instead — see routes/stream.py's
    radio_stream() and the retry in routes/playback.py that switches to
    it."""
    return f"http://{get_local_ip()}:{PORT}/stream/radio/{session_id}"


def radio_dispatch_url(session_id: str, radio_info: dict) -> str:
    """Where a device should actually connect for `radio_info` — Beacon's
    own relay (core/radio_relay.py) when this station is routed through it
    (the default — see routes/playback.py's PlayUrlRequest.cast_directly),
    the station's own URL for the opt-in "direct to device" exception.

    Every place that dispatches or reconnects a device to whatever radio
    station is current (routes/join.py, routes/devices.py's device-stop
    restart, routes/playback.py's _current_reconnect_args) goes through
    this rather than reading radio_info["url"] directly, so "relayed"
    only has to be understood in one place."""
    return radio_stream_url(session_id) if radio_info.get("relayed") else radio_info["url"]


# Track id of routes/debug.py's synthesized test tone — not a real library
# track, so anything that would otherwise resolve a track id against the
# media server has to special-case it (routes/stream.py and
# core/visualizer_feed.py both do). Lives here rather than in routes/debug.py
# itself so core/ can recognize it without importing a route module back.
TEST_TONE_TRACK_ID = "__test_tone__"


def test_tone_url() -> str:
    """Loopback, not stream_url()'s LAN IP: the test tone is fetched by
    ffmpeg from inside this same process/container, never by a cast device."""
    return f"http://127.0.0.1:{PORT}/debug/test-tone.wav"


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
    on_playback_error: Callable[[str], Awaitable[None]] | None = None,
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

    `on_playback_error` is the delivery's way back into the calling
    session — see BaseDelivery.on_playback_error. Attached here, where
    every delivery this app actually plays through is resolved, rather than
    at each of the three call sites, so a new one cannot forget it. Set on
    reused instances too: `previous` can carry a callback bound to an
    earlier dispatch of the same session, and re-binding it costs nothing
    while leaving it stale would report an interruption against whatever
    that older closure captured.
    """

    def _attach(delivery: BaseDelivery) -> BaseDelivery:
        delivery.on_playback_error = on_playback_error
        return delivery

    def _reuse(cls: type[BaseDelivery], name: str) -> BaseDelivery | None:
        candidates = (
            previous.deliveries
            if isinstance(previous, DeliveryManager)
            else [previous]
            if previous is not None
            else []
        )
        return next((d for d in candidates if isinstance(d, cls) and d.target == name), None)

    if targets:
        deliveries: list[BaseDelivery] = []
        for t in targets:
            cls = _DELIVERY_TYPES.get(t.get("type"), AirPlayDelivery)
            deliveries.append(_attach(_reuse(cls, t["name"]) or cls(t["name"])))
        return DeliveryManager.from_deliveries(deliveries)
    if target_type and target_name:
        cls = _DELIVERY_TYPES.get(target_type, AirPlayDelivery)
        return _attach(_reuse(cls, target_name) or cls(target_name))
    return None


def find_sonos(active: BaseDelivery | DeliveryManager | None) -> list[SonosDelivery]:
    """Return all SonosDelivery objects in the active delivery."""
    if isinstance(active, SonosDelivery):
        return [active]
    if isinstance(active, DeliveryManager):
        return [d for d in active.deliveries if isinstance(d, SonosDelivery)]
    return []


def audio_capability_limits(
    delivery: BaseDelivery | DeliveryManager | None,
) -> tuple[int | None, int | None]:
    """The most restrictive (max_sample_rate_hz, max_bit_depth) across every
    delivery currently active, for core/streamer.py's resolve_output_format().

    Every active target shares the exact same encoded stream — there is only
    one ffmpeg process per session (see routes/stream.py's audio_stream()) —
    so a source that exceeds *any one* active delivery's own declared limit
    (BaseDelivery.MAX_SAMPLE_RATE_HZ/MAX_BIT_DEPTH) can't be safely
    stream-copied to *any* of them, not just the one it would have broken.
    None in either slot means nothing currently active declares a limit at
    all (no delivery active, or every active one's own attribute is None) —
    resolve_output_format() then leaves a high-res source untouched, exactly
    as it did before this function existed."""
    deliveries: list[BaseDelivery]
    if isinstance(delivery, DeliveryManager):
        deliveries = delivery.deliveries
    elif delivery is not None:
        deliveries = [delivery]
    else:
        deliveries = []

    rates = [d.MAX_SAMPLE_RATE_HZ for d in deliveries if d.MAX_SAMPLE_RATE_HZ is not None]
    depths = [d.MAX_BIT_DEPTH for d in deliveries if d.MAX_BIT_DEPTH is not None]
    return (min(rates) if rates else None, min(depths) if depths else None)


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
