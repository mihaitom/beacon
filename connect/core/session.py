"""core/session.py — Per-user Connect session state.

Replaces the old single global Context/AppState (still in core/state.py, now
shrunk to just the operator-configured fixed targets) with one SessionState
per logged-in user, identified by the X-Connect-Session header/query param
the frontend derives from their media-server login (see
connect-session-id.ts). Callers with no session id fall back to
DEFAULT_SESSION_ID, reproducing the old single-session behavior unchanged.
"""

import asyncio
import logging
import os
import time

from fastapi import Header, HTTPException, Query

from delivery import BaseDelivery, DeliveryManager
from media import MediaClient, SubsonicClient

from .claims import claims
from .state import AppState, EventBus, delivery_class_for, list_target_pairs
from .visualizer_feed import VisualizerFeed

logger = logging.getLogger("connect.session")

DEFAULT_SESSION_ID = "default"


class SessionState:
    def __init__(self, session_id: str):
        self.session_id = session_id
        # Set by /config's `username` field — shown to other sessions as
        # "in use by {display_name}" for claimed devices.
        self.display_name: str = ""
        self.state = AppState()
        # Serializes /play, /play-url, /pause, /resume, /seek, /stop for this
        # session — without it, two concurrent dispatches (e.g. rapid
        # next/next, or a click while a previous switch is still in flight)
        # can run their `await target.play(...)` calls interleaved, and
        # whichever's device I/O happens to finish last "wins" regardless of
        # which the user actually issued last, leaving the wrong track
        # audibly playing while session.state.current_track/the UI show the
        # one the user actually asked for (or vice versa). See play_seq
        # below for the other half of the fix (dropping a request that's
        # already been superseded, instead of just serializing execution
        # order).
        self.play_lock = asyncio.Lock()
        # Highest PlayRequest/PlayUrlRequest.seq accepted so far — see
        # play_lock's comment. The frontend hands out a strictly increasing
        # seq per dispatch (services/connect/playback.ts); a request whose
        # seq is lower than this has already been superseded by one that
        # (from the user's perspective) came after it, so it's dropped
        # before ever reaching the target device, not just before
        # overwriting session state. seq=0 (the default for any caller that
        # doesn't send one, e.g. tests) opts out of the check entirely.
        self.play_seq: int = 0
        # The same "stale response overwrites a newer one" race as play_seq
        # above, for /config instead of /play — two concurrent /config calls
        # for this session (a UI double-submit, a retry racing the original
        # request) each await media.ping() (a real network round trip)
        # before applying their result; without this, whichever ping()
        # happens to resolve *last* wins regardless of which request was
        # actually issued last, and the session can end up authenticated
        # against the wrong/older server credentials. Bumped at the start of
        # every /config call (routes/devices.py's configure()); a call whose
        # own value no longer matches this by the time its ping() resolves
        # has been superseded and discards its result instead of applying it.
        self.config_seq: int = 0
        # Default is an unconfigured Subsonic client — overwritten by /config
        # with either a Subsonic or Jellyfin client.
        self.media: MediaClient = SubsonicClient("")
        self.event_bus = EventBus()
        # Runs the fullscreen visualizer's frequency analysis, but only
        # while a GET /visualizer subscriber is actually watching it — see
        # core/visualizer_feed.py.
        self.visualizer = VisualizerFeed(self)
        self.last_seen: float = time.time()
        # Set only once /config has verified the supplied credential actually
        # authenticates against the (optionally locked) media server — see
        # routes/devices.py's configure() and require_authenticated_session
        # below. Everything that reveals or controls LAN devices depends on
        # this instead of just require_token, since nginx attaches
        # X-Connect-Token to every same-origin request itself (see
        # ng.conf.template) — it identifies "a request from this deployment's
        # frontend", not "a logged-in media-server user".
        self.authenticated: bool = False

    def touch(self) -> None:
        self.last_seen = time.time()


class SessionRegistry:
    def __init__(self):
        self._sessions: dict[str, SessionState] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(self, session_id: str) -> SessionState:
        async with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                session = SessionState(session_id)
                self._sessions[session_id] = session
            session.touch()
            return session

    def get(self, session_id: str) -> SessionState | None:
        """Read-only lookup — unlike get_or_create, does not create a session
        or touch last_seen. For displaying another session's info (e.g. the
        display_name behind a device claim) without side effects."""
        return self._sessions.get(session_id)

    def all(self) -> list[SessionState]:
        return list(self._sessions.values())

    async def remove(self, session_id: str) -> SessionState | None:
        async with self._lock:
            return self._sessions.pop(session_id, None)


registry = SessionRegistry()


async def get_session(
    x_connect_session: str | None = Header(default=None),
    session: str | None = Query(default=None),
) -> SessionState:
    return await registry.get_or_create(x_connect_session or session or DEFAULT_SESSION_ID)


async def require_authenticated_session(
    x_connect_session: str | None = Header(default=None),
    session: str | None = Query(default=None),
) -> SessionState:
    """Like get_session, but 401s until /config has verified real media-server
    credentials for this session (see SessionState.authenticated) — and,
    unlike get_session, never creates a session just to reject it. An
    unauthenticated caller (anyone with just the shared CONNECT_TOKEN, which
    nginx attaches automatically — see SessionState.authenticated's comment)
    could otherwise grow the registry unbounded by spamming arbitrary
    X-Connect-Session values, each surviving until the idle reaper runs.
    Use this instead of get_session for anything that reveals or controls
    LAN devices."""
    session_id = x_connect_session or session or DEFAULT_SESSION_ID
    existing = registry.get(session_id)
    if existing is None or not existing.authenticated:
        raise HTTPException(
            status_code=401,
            detail="Session not authenticated — call /config with valid media-server "
            "credentials first",
        )
    existing.touch()
    return existing


def compute_position(session: SessionState) -> float:
    """Return elapsed seconds into the current track, clamped to track duration.

    See PlaybackClock.elapsed() for the buffering-delay correction — this just
    adds the duration clamp, since the clock itself doesn't know about tracks.
    """
    st = session.state
    if not st.is_streaming or not st.clock.play_start_time:
        return 0.0
    elapsed = st.clock.elapsed()
    if st.current_track:
        return min(elapsed, float(st.current_track.duration))
    return elapsed


def build_status_dict(
    session: SessionState, displaced: bool = False, interrupted: bool = False
) -> dict:
    """Build the full status payload shared by /status and SSE /events.

    `displaced` is only ever True for the single broadcast displace_target()
    fires right after a takeover steals this session's device — it tells the
    frontend this particular streaming->false transition was a takeover, not
    the user stopping playback themselves, so it should just go quiet
    instead of picking playback back up over local speakers (see
    playback.ts's connect.$subscribe handler).

    `interrupted` is the same shape for a different event: the single
    broadcast fired when a cast device dropped its connection and never came
    back. It says "this stopped and nobody asked for it" - the frontend turns
    that into a toast offering to pick playback back up. A one-shot flag on
    the payload rather than state on the session, deliberately: there is
    nothing to clear afterwards, and a client connecting later should not be
    told about an interruption it never witnessed."""
    elapsed = compute_position(session)
    st = session.state

    current_track = None
    if st.current_track:
        t = st.current_track
        current_track = {
            "id": t.id,
            "artist": t.artist,
            "album": t.album,
            "cover_art_url": session.media.get_cover_art_url(t.cover_art_id),
            "duration": t.duration,
            "title": t.title,
        }

    targets = [
        {"name": name, "type": target_type}
        for target_type, name in list_target_pairs(st.active_delivery)
    ]

    return {
        "current_song": current_track,
        # The full queue (history included) and where current_track sits in
        # it — see AppState.queue's comment. Lets every client sharing this
        # session (not just whichever one dispatched it) mirror the same
        # queue/now-playing in its own UI, see stores/playback.ts's
        # queue-adoption logic.
        "queue": st.queue,
        "current_song_index": st.queue_index,
        # Standing shuffle/repeat preferences — see AppState.shuffle/
        # repeat_mode's comment. original_queue matters together with
        # shuffle: it's what stores/playback.ts's toggleShuffle() reverts
        # `queue` to when switching shuffle off, so every client needs the
        # same one, not just the same on/off flag.
        "original_queue": st.original_queue,
        "shuffle": st.shuffle,
        "repeat_mode": st.repeat_mode,
        "elapsed": elapsed,
        "ended": st.track_ended,
        "paused": st.clock.is_paused,
        "radio": st.radio_info,
        "streaming": st.is_streaming,
        "targets": targets,
        "total_songs": len(st.queue),
        "displaced": displaced,
        "interrupted": interrupted,
    }


def track_label(session: SessionState) -> str | None:
    """Short "what's playing" label for a session — used to annotate a
    claimed device in /discover (e.g. "in use by X, playing Y") so another
    session can see what they'd be taking over before doing so."""
    st = session.state
    if st.current_track:
        t = st.current_track
        return f"{t.artist} - {t.title}" if t.artist else t.title
    if st.radio_info:
        return st.radio_info.get("title")
    return None


# ── Claim enforcement / takeover ─────────────────────────────────────────────


async def check_claims(
    target: BaseDelivery | DeliveryManager, session: SessionState, force: bool = False
) -> tuple[dict | None, list[tuple[str, str, str]]]:
    """Claim every (type, name) pair the resolved delivery touches — including
    Sonos multiroom followers pulled in by grouping, since list_target_pairs()
    reflects the *resolved* delivery, not just the request's explicit targets.

    force=False (Phase 1 default): refuses on any conflict — returns a
    device_in_use error dict and an empty displaced list.

    force=True (Phase 2 takeover): always succeeds — returns None and the
    list of (type, name, previous_owner) pairs that got displaced, for the
    caller to pass to displace_target() so the previous owner's delivery
    actually stops and its SSE reflects the loss.
    """
    pairs = list_target_pairs(target)
    if force:
        displaced = await claims.force_claim_many(pairs, session.session_id)
        return None, displaced

    conflict = await claims.claim_many(pairs, session.session_id)
    if conflict is None:
        return None, []
    target_type, name, owner = conflict
    owner_session = registry.get(owner)
    return {
        "device": {"name": name, "type": target_type},
        "error": "device_in_use",
        "owner": owner_session.display_name if owner_session else "another session",
    }, []


def check_ownership(target_type: str, name: str, session: SessionState) -> dict | None:
    """Read-only claim check for actions (e.g. volume) on a device that's
    already claimed elsewhere — unlike check_claims(), this never claims the
    device itself, it only rejects when a *different* session currently owns
    it. Returns the same device_in_use error shape as check_claims(), or None
    when the device is unclaimed or owned by this session."""
    owner = claims.owner_of(target_type, name)
    if owner is None or owner == session.session_id:
        return None
    owner_session = registry.get(owner)
    return {
        "device": {"name": name, "type": target_type},
        "error": "device_in_use",
        "owner": owner_session.display_name if owner_session else "another session",
    }


async def displace_target(owner_session: SessionState, target_type: str, name: str) -> None:
    """Stop delivery to a single (type, name) target within owner_session,
    without touching the rest of its active_delivery — e.g. a takeover only
    steals the one Sonos speaker/Chromecast a new session claimed, not every
    device owner_session is still legitimately streaming to.

    Broadcasts on owner_session's own event_bus afterwards, so its existing
    SSE connection naturally reflects the loss — no separate push mechanism
    needed (see use-connect-session.ts's "external stop" effect).

    Mutates active_delivery/is_streaming under owner_session's own
    play_lock, same as /play, /pause, /seek etc. (see that field's
    docstring) — otherwise one of those handlers running concurrently on
    the victim session can finish just after this function reads/writes
    that state and clobber it (e.g. overwrite the "displaced" broadcast
    below with its own default displaced=False once it resumes and
    broadcasts its own status). Bounded by a timeout rather than awaited
    unconditionally: the caller here (_claim_or_takeover) is itself
    already holding *its own* session's play_lock, so an unbounded wait
    would risk a cross-session deadlock if two sessions force-takeover
    each other's devices in the same instant. On timeout, falls back to
    the old best-effort (racy but non-blocking) behavior rather than
    hanging the request."""

    def _apply(st) -> BaseDelivery | None:
        """Re-reads st.active_delivery (rather than trusting a value
        captured before the lock) since it may have changed while this
        function was waiting to acquire the lock — e.g. the victim's own
        /stop already cleared it. Returns the stopped delivery, or None if
        there's nothing left to stop."""
        active = st.active_delivery
        cls = delivery_class_for(target_type)
        if active is None or cls is None:
            return None
        if isinstance(active, DeliveryManager):
            lost = next(
                (d for d in active.deliveries if isinstance(d, cls) and d.target == name), None
            )
            if lost is None:
                return None
            remaining = [d for d in active.deliveries if d is not lost]
        elif isinstance(active, cls) and active.target == name:
            lost = active
            remaining = []
        else:
            return None

        if not remaining:
            st.is_streaming = False
            st.active_delivery = None
        elif len(remaining) == 1:
            st.active_delivery = remaining[0]
        else:
            st.active_delivery = DeliveryManager.from_deliveries(remaining)
        # See active_delivery_seq's own comment in core/state.py — bumped
        # here regardless of which of the two call sites below reached
        # this (the locked path doesn't strictly need it, already
        # serialized against /play by play_lock itself, but there's no
        # harm in it being consistent either way).
        st.active_delivery_seq += 1
        return lost

    st = owner_session.state
    try:
        async with asyncio.timeout(2.0):
            async with owner_session.play_lock:
                lost = _apply(st)
    except TimeoutError:
        logger.warning(
            f"[displace] Timed out waiting for {owner_session.session_id}'s play_lock; "
            "applying displacement without it"
        )
        lost = _apply(st)

    if lost is None:
        return

    try:
        await lost.stop()
    except Exception:
        pass

    await owner_session.event_bus.broadcast(build_status_dict(owner_session, displaced=True))


# ── Session lifecycle ────────────────────────────────────────────────────────

SESSION_REAP_INTERVAL = 60
SESSION_IDLE_TIMEOUT = int(os.getenv("SESSION_IDLE_TIMEOUT", str(60 * 30)))


async def reap_once() -> list[str]:
    """Stop delivery, release claims, and forget any session that's been idle
    past SESSION_IDLE_TIMEOUT. A session is "idle" only if no request AND no
    /events heartbeat has touched it — an open tab actively streaming or just
    listening never goes idle, since both paths call session.touch().
    Returns the session ids that were reaped, mainly so tests don't need to
    duplicate this logic to assert on it."""
    now = time.time()
    reaped = []
    for session in registry.all():
        if now - session.last_seen <= SESSION_IDLE_TIMEOUT:
            continue
        if session.state.active_delivery:
            try:
                await session.state.active_delivery.stop()
            except Exception:
                pass
        await session.visualizer.shutdown()
        await claims.release_all_for_session(session.session_id)
        await registry.remove(session.session_id)
        reaped.append(session.session_id)
    return reaped


async def reap_stale_sessions() -> None:
    """Background task (see main.py's lifespan): calls reap_once() every
    SESSION_REAP_INTERVAL, forever."""
    while True:
        await asyncio.sleep(SESSION_REAP_INTERVAL)
        await reap_once()
