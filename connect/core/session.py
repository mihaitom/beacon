"""core/session.py — Per-user Connect session state.

Replaces the old single global Context/AppState (still in core/state.py, now
shrunk to just the operator-configured fixed targets) with one SessionState
per logged-in user, identified by the X-Connect-Session header/query param
the frontend derives from their media-server login (see
connect-session-id.ts). Callers with no session id fall back to
DEFAULT_SESSION_ID, reproducing the old single-session behavior unchanged.
"""

import asyncio
import os
import time

from fastapi import Header, HTTPException, Query

from delivery import BaseDelivery, DeliveryManager
from media import MediaClient, SubsonicClient

from .audio_analysis import AudioAnalyzer
from .claims import claims
from .state import AppState, delivery_class_for, EventBus, list_target_pairs

DEFAULT_SESSION_ID = "default"


class SessionState:
    def __init__(self, session_id: str):
        self.session_id = session_id
        # Set by /config's `username` field — shown to other sessions as
        # "in use by {display_name}" for claimed devices.
        self.display_name: str = ""
        self.state = AppState()
        # Default is an unconfigured Subsonic client — overwritten by /config
        # with either a Subsonic or Jellyfin client.
        self.media: MediaClient = SubsonicClient("")
        self.event_bus = EventBus()
        # Owned by routes/stream.py's stream_with_completion(), which
        # creates a fresh one per track and tears down the previous one —
        # see core/audio_analysis.py. None whenever nothing is currently
        # being live-analyzed (nothing streaming, or streaming to a target
        # that can't be, e.g. AirPlay/radio).
        self.audio_analyzer: AudioAnalyzer | None = None
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


def build_status_dict(session: SessionState, displaced: bool = False) -> dict:
    """Build the full status payload shared by /status and SSE /events.

    `displaced` is only ever True for the single broadcast displace_target()
    fires right after a takeover steals this session's device — it tells the
    frontend this particular streaming->false transition was a takeover, not
    the user stopping playback themselves, so it should just go quiet
    instead of picking playback back up over local speakers (see
    playback.ts's connect.$subscribe handler)."""
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
        "current_track": current_track,
        "current_track_index": 0,
        "elapsed": elapsed,
        "ended": st.track_ended,
        "paused": st.clock.is_paused,
        "radio": st.radio_info,
        "streaming": st.is_streaming,
        "targets": targets,
        "total_tracks": 1 if st.current_track else 0,
        "displaced": displaced,
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
    needed (see use-connect-session.ts's "external stop" effect)."""
    st = owner_session.state
    active = st.active_delivery
    cls = delivery_class_for(target_type)
    if active is None or cls is None:
        return

    if isinstance(active, DeliveryManager):
        lost = next(
            (d for d in active.deliveries if isinstance(d, cls) and d.target == name), None
        )
        if lost is None:
            return
        remaining = [d for d in active.deliveries if d is not lost]
    elif isinstance(active, cls) and active.target == name:
        lost = active
        remaining = []
    else:
        return

    try:
        await lost.stop()
    except Exception:
        pass

    if not remaining:
        st.is_streaming = False
        st.active_delivery = None
    elif len(remaining) == 1:
        st.active_delivery = remaining[0]
    else:
        st.active_delivery = DeliveryManager.from_deliveries(remaining)

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
