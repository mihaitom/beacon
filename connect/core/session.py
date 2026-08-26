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
from .loop_health import peak_lag
from .state import AppState, EventBus, delivery_class_for, list_target_pairs, stream_url
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

    targets = []
    for target_type, name in list_target_pairs(st.active_delivery):
        volume, muted = st.device_volumes.get(f"{target_type}:{name}", (None, None))
        targets.append(
            {"name": name, "type": target_type, "volume": volume, "muted": muted}
        )

    fmt = st.current_output_format
    stream_info = {
        # "transcoding" is derived rather than a stored flag: every copy-tier
        # label ends in "(copy)" (see core/streamer.py's resolve_output_format())
        # and nothing else ever does, so this can't drift out of sync with the
        # label text the way a second, hand-set boolean could.
        "label": fmt.label,
        "content_type": fmt.content_type,
        "transcoding": "copy" not in fmt.label,
        "source_codec": fmt.source_codec,
        "source_sample_rate": fmt.source_sample_rate,
        "source_bit_depth": fmt.source_bit_depth,
        "source_bitrate_kbps": fmt.source_bitrate_kbps,
        # Only set where the output is actually forced away from the
        # source's own numbers, and why this track is being transcoded at
        # all — see OutputFormat's own comment on both.
        "target_sample_rate": fmt.target_sample_rate,
        "target_bit_depth": fmt.target_bit_depth,
        "target_bitrate_kbps": fmt.target_bitrate_kbps,
        "transcode_reason": fmt.transcode_reason,
        "active_connections": st.active_stream_connections,
        # Process-wide, not session-scoped — see core/loop_health.py. A short
        # window (30s) rather than the module's full 120s history: this is
        # meant to answer "is anything wrong *right now*", not carry a stall
        # from ten minutes ago forward on every status tick after it.
        "loop_lag": peak_lag(30.0),
    }

    return {
        "current_song": current_track,
        "stream_info": stream_info,
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


async def mark_interrupted(session: SessionState) -> None:
    """Record that playback stopped without anyone asking, and tell every
    client watching this session.

    Lives here rather than next to either of its callers because it has
    two: routes/stream.py's _mark_disconnected_if_not_reconnected(), for a
    device that closed its GET /stream connection and never came back, and
    delivery/airplay.py, whose push to the device failed outright. The two
    arrive at the same conclusion by very different routes — one after a
    grace period spent waiting for a reconnect that never happened, the
    other immediately, because a failed push leaves nothing ambiguous.

    The order below is load-bearing and was arrived at by two separate
    live bugs, so it is worth stating rather than rediscovering:

    - The position is read *before* is_streaming flips. compute_position()
      reads that flag itself and returns 0.0 once it is False, so reading
      it afterwards makes every interruption look like it happened at
      0:00, wherever the device actually was.
    - The clock is then paused at that position rather than left running.
      PlaybackClock.elapsed() has no notion of is_streaming and keeps
      advancing with the wall clock whether or not anything is playing.
      Without this, a resume minutes later seeks FFmpeg to wherever the
      clock got to — past the track's own end on anything but an immediate
      one, which FFmpeg answers with silence and no error. Observed live
      2026-08-24: a drop ~10s into a 222s track, resumed ~10 minutes
      later, produced a 200 response and no audio at all.

    `interrupted=True` marks this particular streaming->false transition as
    "nobody asked for this", which is what lets the frontend offer to pick
    playback back up instead of just going quiet. Beacon deliberately does
    not resume on its own for the pull-based targets: a device stopping by
    itself and a person pressing stop on the speaker are indistinguishable
    from here. AirPlay's failed push *is* distinguishable, but it reports
    through this same function anyway, so the interruption looks identical
    to the user whichever target it came from.
    """
    st = session.state
    position = compute_position(session)
    st.is_streaming = False
    st.clock.pause(position)
    await session.event_bus.broadcast(build_status_dict(session, interrupted=True))


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


async def _device_is_still_ours(session: SessionState) -> bool:
    """Whether the device this session was casting to is still playing the
    stream *this* session handed it — see reap_once() for why that question
    exists at all.

    Compares the device's own reported URI against what was dispatched: our
    /stream URL (which carries this instance's port and this session's id,
    so a different Beacon instance's stream is distinguishable even when it
    happens to use the same session id — session ids come from the media
    server login, so two instances serving the same user genuinely share
    one) or, for radio, the station URL that went straight to the device.

    A device that can't answer, or fails to, counts as ours: unchanged
    behaviour for AirPlay and anything else with no transport to query, and
    the safer default for our own housekeeping — leaving a speaker playing
    forever is a worse outcome than a stop that was already justified when
    the session was still alive."""
    st = session.state
    if st.active_delivery is None:
        return False
    expected = st.radio_info["url"] if st.radio_info else stream_url(session.session_id)
    try:
        uri = await st.active_delivery.current_uri()
    except Exception as e:
        logger.debug(f"[reap] {session.session_id}: could not read device URI: {e}")
        return True
    if uri is None:
        return True
    if uri == expected:
        return True
    logger.info(
        f"[reap] {session.session_id}: leaving {st.active_delivery!r} alone — it plays "
        f"{uri[:80]!r}, not this session's stream"
    )
    return False


async def reap_once() -> list[str]:
    """Release claims and forget any session that's been idle past
    SESSION_IDLE_TIMEOUT, stopping its device if it's still sitting on our
    stream. Returns the session ids that were reaped, mainly so tests don't
    need to duplicate this logic to assert on it.

    "Idle" is deliberately two conditions, not one — see the loop below."""
    now = time.time()
    reaped = []
    for session in registry.all():
        if now - session.last_seen <= SESSION_IDLE_TIMEOUT:
            continue
        # last_seen alone is NOT enough to call a session idle, because
        # nothing about casting touches it once a track is under way: the
        # /events heartbeat needs a client with the app open, and each GET
        # /stream connection touches it exactly once, when the device opens
        # it — one touch per *track*, not per minute.
        #
        # So a track longer than SESSION_IDLE_TIMEOUT, played with no app
        # window anywhere, ages its own session past the timeout while it is
        # audibly playing. Observed live 2026-08-23: an 80-minute mix cast
        # to a Sonos with every tab closed was reaped 31 minutes in and its
        # speaker stopped — proven on the wire, our Stop at 00:27:50.133 UTC
        # and the device's FIN 840ms later. From the outside that is
        # indistinguishable from the unexplained drops in
        # docs/playback-bugs/mid-track-drop-symptom.md, which is how it went
        # unnoticed.
        #
        # Whatever is still streaming is by definition not abandoned, so it
        # is not reaped at all. Covers a paused cast too: somebody may well
        # come back to it, and stopping the device under them would be the
        # same rudeness one step later.
        if session.state.is_streaming:
            logger.debug(
                f"[reap] {session.session_id}: idle since "
                f"{now - session.last_seen:.0f}s but still streaming — left alone"
            )
            continue
        # Not streaming any more, but the device may still be sitting on
        # this session's stream — a false-positive drop, or a queue that
        # ended without the device letting go. Stop it only if it really is
        # still ours: a reap is the one teardown nobody asked for, and the
        # speaker is shared far more widely than this process can see.
        # Observed live 2026-08-22: a session whose cast had ended hours
        # earlier was reaped and stopped its old speaker, which by then a
        # *different* Beacon instance on the same host was streaming to —
        # that instance saw a device drop with no cause of its own.
        if session.state.active_delivery and await _device_is_still_ours(session):
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
