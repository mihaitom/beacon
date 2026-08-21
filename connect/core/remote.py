"""core/remote.py — Remote Control state: lets a phone on the LAN control
this Beacon instance's own local playback (as opposed to core/session.py's
casting sessions, which control a Sonos/Chromecast/AirPlay/DLNA target).

A single global RemoteState, not one per SessionState — Beacon's Electron app
has exactly one renderer/window regardless of which media-server account is
logged into it, so tying this to the per-login session model would add
complexity for no benefit.

Two separate credentials, on purpose:
- `password` is the actual bearer credential (secrets.token_urlsafe — long,
  meant to travel inside a QR-code URL, never typed by hand).
- `pin` is a short, human-typeable code that's exchanged for `password` via
  POST /remote/login (routes/remote.py) and is never itself accepted as a
  bearer credential.
Both are regenerated every time the feature is enabled, and neither is ever
logged — unlike core/auth.py's CONNECT_TOKEN (a local-machine secret, safe to
log once at startup), this one gets typed into an untrusted phone on the LAN.
"""

import asyncio
import secrets
import time

from .state import EventBus

# A killed/crashed renderer (or a `connect` dev process outlived by an
# Electron restart) stops sending /remote/keepalive — auto-disable after
# this many seconds of silence rather than leaving the feature reachable
# with no renderer able to answer command/query relays.
KEEPALIVE_TIMEOUT = 90
REAP_INTERVAL = 15

# Rate limiting for /remote/login (PIN brute force) — a 6-digit PIN is only
# safe against brute force if attempts are throttled. 5 tries per window,
# window doubles on repeated lockouts (capped) rather than resetting, so a
# sustained attack keeps getting slower rather than getting a fresh budget
# every 60s.
LOGIN_ATTEMPT_LIMIT = 5
LOGIN_WINDOW_SECONDS = 60
LOGIN_LOCKOUT_MAX_SECONDS = 15 * 60


class RemoteState:
    def __init__(self):
        self.enabled: bool = False
        self.password: str | None = None
        self.pin: str | None = None
        # True only while GET /remote/agent-events has a live subscriber —
        # lets /remote/command and the query-relay endpoints fail fast
        # (503) instead of waiting out their own timeout when nothing is
        # listening on the renderer side at all.
        self.renderer_connected: bool = False
        # Bumped once per genuine GET /remote/agent-events connection — see
        # routes/remote.py's agent_events(). Only the renderer's single SSE
        # connection is expected at a time, but a quick reconnect (a brief
        # network blip, a page reload) can briefly overlap: the *old*
        # connection's generator doesn't finish unwinding (and clearing
        # renderer_connected in its own finally) until after the *new*
        # one has already landed and set it back to True. Without this,
        # the old connection's belated cleanup clobbers the new
        # connection's True back to False, and /remote/command and the
        # query-relay endpoints wrongly 503 as if nothing were listening,
        # even though the new connection is live.
        self.renderer_connection_seq: int = 0
        self.last_keepalive: float = 0.0
        self.snapshot: dict = {}
        self.event_bus = EventBus()  # -> phone GET /remote/events
        self.command_bus = EventBus()  # -> renderer GET /remote/agent-events
        self._pending: dict[str, asyncio.Future] = {}
        # ip -> failed-attempt timestamps within the current/most recent window,
        # plus how many consecutive lockouts that ip has triggered (for the
        # doubling backoff).
        self._attempts: dict[str, list[float]] = {}
        self._lockout_until: dict[str, float] = {}
        self._lockout_strikes: dict[str, int] = {}

    def enable(self) -> tuple[str, str]:
        """(Re)generates password+pin and marks the feature enabled. Called
        both for a fresh enable and for the Settings dialog's "regenerate"
        action — either way, any phone paired with the previous password is
        immediately locked out (see disable()'s wake-up of open connections,
        which this doesn't need to repeat since the old password simply stops
        comparing equal)."""
        self.password = secrets.token_urlsafe(24)
        self.pin = f"{secrets.randbelow(10**6):06d}"
        self.enabled = True
        self.snapshot = {}
        self.last_keepalive = time.time()
        return self.password, self.pin

    def disable(self) -> None:
        """Clears credentials/state and wakes every blocked SSE loop and
        pending query Future so they fail fast instead of hanging until
        their own timeout — see routes/remote.py's generator()/_query()."""
        self.enabled = False
        self.password = None
        self.pin = None
        self.snapshot = {}
        self.renderer_connected = False
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()

    def touch_keepalive(self) -> None:
        self.last_keepalive = time.time()

    def is_stale(self) -> bool:
        return self.enabled and time.time() - self.last_keepalive > KEEPALIVE_TIMEOUT

    # ── Login rate limiting ──────────────────────────────────────────────

    def is_locked_out(self, ip: str) -> bool:
        until = self._lockout_until.get(ip)
        return until is not None and time.time() < until

    def record_failed_attempt(self, ip: str) -> None:
        now = time.time()
        attempts = [t for t in self._attempts.get(ip, []) if now - t < LOGIN_WINDOW_SECONDS]
        attempts.append(now)
        self._attempts[ip] = attempts
        if len(attempts) >= LOGIN_ATTEMPT_LIMIT:
            strikes = self._lockout_strikes.get(ip, 0) + 1
            self._lockout_strikes[ip] = strikes
            window = min(LOGIN_WINDOW_SECONDS * (2 ** (strikes - 1)), LOGIN_LOCKOUT_MAX_SECONDS)
            self._lockout_until[ip] = now + window
            self._attempts[ip] = []

    def clear_attempts(self, ip: str) -> None:
        self._attempts.pop(ip, None)
        self._lockout_until.pop(ip, None)
        self._lockout_strikes.pop(ip, None)

    # ── Command/query relay ─────────────────────────────────────────────

    def new_pending(self, request_id: str) -> asyncio.Future:
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future
        return future

    def resolve_pending(self, request_id: str, data: dict) -> bool:
        future = self._pending.pop(request_id, None)
        if future is None or future.done():
            return False
        future.set_result(data)
        return True

    def drop_pending(self, request_id: str) -> None:
        self._pending.pop(request_id, None)


remote = RemoteState()


async def reap_stale_remote() -> None:
    """Background task (see main.py's lifespan): auto-disables Remote
    Control if the renderer stops pinging /remote/keepalive — covers a
    crashed/force-killed renderer and the dev-mode case where `connect`
    outlives an Electron restart."""
    while True:
        await asyncio.sleep(REAP_INTERVAL)
        if remote.is_stale():
            remote.disable()
