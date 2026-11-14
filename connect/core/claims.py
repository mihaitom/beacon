"""core/claims.py — Device claim registry.

Tracks which session currently "owns" a cast target, so /discover can tell
the frontend a device is in use by someone else, and /play, /play-url, /join
can refuse (or, with force=True, take over) a target already claimed by a
different session. Global (not per-session) by design — ownership is a
property of the physical device, checked across all sessions at once.

Remote claims are another connect's: a paired desktop app's on its server,
the server's (and other desktops') on a desktop (docs/plans/
shared-speaker-claims.md). They conflict like local ones, are shown by a
label rather than a session, and a takeover of one is reported through
`on_remote_taken` instead of stopping a local session. Each source replaces
its whole set at once and lapses when not refreshed for REMOTE_TTL_SECONDS.
"""

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass

# Long enough for two missed refreshes (every 30 s, or a keepalive every
# 15 s), short enough that a laptop closed mid-cast frees its speakers soon.
REMOTE_TTL_SECONDS = 90.0
REMOTE_PREFIX = "remote:"


@dataclass
class Claim:
    session_id: str
    claimed_at: float


def _key(target_type: str, name: str) -> str:
    return f"{target_type}:{name}"


def remote_holder_id(source: str) -> str:
    return f"{REMOTE_PREFIX}{source}"


def is_remote(holder: str | None) -> bool:
    return bool(holder) and holder.startswith(REMOTE_PREFIX)


@dataclass
class _RemoteSet:
    refreshed_at: float
    labels: dict[str, str]  # _key() -> who to show as holding it


class ClaimRegistry:
    def __init__(self):
        self._claims: dict[str, Claim] = {}
        self._remote: dict[str, _RemoteSet] = {}
        self._lock = asyncio.Lock()
        # Called (with no arguments) after any change, local or remote.
        self.listeners: list[Callable[[], None]] = []
        # Called with (source, type, name) when a local takeover displaces a
        # remote holder, for whoever reports that back to the other side.
        self.on_remote_taken: Callable[[str, str, str], None] | None = None

    def _changed(self) -> None:
        for listener in list(self.listeners):
            listener()

    def _remote_holder(self, key: str, now: float | None = None) -> str | None:
        now = time.time() if now is None else now
        for source, remote in self._remote.items():
            if key in remote.labels and now - remote.refreshed_at < REMOTE_TTL_SECONDS:
                return remote_holder_id(source)
        return None

    def _holder(self, key: str) -> str | None:
        claim = self._claims.get(key)
        return claim.session_id if claim else self._remote_holder(key)

    def _take_from_remote(self, key: str, holder: str) -> None:
        source = holder.removeprefix(REMOTE_PREFIX)
        remote = self._remote.get(source)
        if remote is not None:
            remote.labels.pop(key, None)
        if self.on_remote_taken is not None:
            target_type, name = key.split(":", 1)
            self.on_remote_taken(source, target_type, name)

    async def claim(
        self, target_type: str, name: str, session_id: str, force: bool = False
    ) -> str | None:
        """Claim (type, name) for session_id.

        Returns None when there was no conflict — either newly claimed, or
        already owned by session_id (idempotent re-claim, e.g. /seek
        re-playing the same target).

        Returns the *previous* owner's session_id when there was a conflict:
        - force=False (Phase 1): the claim is refused and left untouched —
          the caller must reject the request (device_in_use).
        - force=True (Phase 2): the claim is displaced and reassigned to
          session_id — the caller uses the returned id to stop that
          session's delivery for this target and let its own SSE reflect
          the loss.
        """
        key = _key(target_type, name)
        async with self._lock:
            holder = self._holder(key)
            if holder is not None and holder != session_id:
                if not force:
                    return holder
                if is_remote(holder):
                    self._take_from_remote(key, holder)
                self._claims[key] = Claim(session_id=session_id, claimed_at=time.time())
                self._changed()
                return holder
            self._claims[key] = Claim(session_id=session_id, claimed_at=time.time())
            self._changed()
            return None

    async def claim_many(
        self, pairs: list[tuple[str, str]], session_id: str, force: bool = False
    ) -> tuple[str, str, str] | None:
        """Claim every (type, name) in `pairs` for session_id atomically — all
        of them succeed, or none do, checked under a single lock acquisition
        so two concurrent claim_many() calls for overlapping devices can't
        both "pass" and then race each other in a second pass.

        Returns None on full success. Otherwise the first conflicting
        (type, name, previous_owner) — with force=True this still means the
        whole batch was refused (a multi-target claim is all-or-nothing even
        in Phase 2; a caller wanting to displace one device shouldn't
        silently displace an unrelated one too as a side effect).
        """
        async with self._lock:
            for target_type, name in pairs:
                holder = self._holder(_key(target_type, name))
                if holder is not None and holder != session_id and not force:
                    return (target_type, name, holder)
            for target_type, name in pairs:
                key = _key(target_type, name)
                holder = self._holder(key)
                if is_remote(holder):
                    self._take_from_remote(key, holder)
                self._claims[key] = Claim(session_id=session_id, claimed_at=time.time())
            self._changed()
            return None

    async def force_claim_many(
        self, pairs: list[tuple[str, str]], session_id: str
    ) -> list[tuple[str, str, str]]:
        """Claim every (type, name) in `pairs` for session_id unconditionally
        (single lock acquisition, so it can't race a concurrent claim/release).

        Unlike claim_many(force=True) — which still refuses the *entire*
        batch if it can't cleanly resolve — this always succeeds. Returns the
        (type, name, previous_owner) triples for pairs that had a *different*
        previous owner, so the caller can stop that owner's delivery for just
        that target and let its own SSE reflect the loss (see
        core/session.py's displace_target()). Pairs with no previous owner,
        or already owned by session_id, are silently (re)claimed and omitted.
        """
        async with self._lock:
            displaced = []
            for target_type, name in pairs:
                key = _key(target_type, name)
                holder = self._holder(key)
                if holder is not None and holder != session_id:
                    displaced.append((target_type, name, holder))
                    if is_remote(holder):
                        self._take_from_remote(key, holder)
                self._claims[key] = Claim(session_id=session_id, claimed_at=time.time())
            self._changed()
            return displaced

    async def release(self, target_type: str, name: str, session_id: str | None = None) -> None:
        """Release (type, name). If session_id is given, only releases when
        that session is the current owner (avoids one session accidentally
        releasing a claim it just lost to a takeover)."""
        key = _key(target_type, name)
        async with self._lock:
            existing = self._claims.get(key)
            if existing is None:
                return
            if session_id is not None and existing.session_id != session_id:
                return
            del self._claims[key]
            self._changed()

    async def release_all_for_session(self, session_id: str) -> list[tuple[str, str]]:
        """Release every claim owned by session_id. Returns the released
        (type, name) pairs."""
        async with self._lock:
            released = [
                key for key, claim in self._claims.items() if claim.session_id == session_id
            ]
            for key in released:
                del self._claims[key]
            if released:
                self._changed()
        return [tuple(key.split(":", 1)) for key in released]  # type: ignore[misc]

    def owner_of(self, target_type: str, name: str) -> str | None:
        """The local session holding it: where its device events go."""
        claim = self._claims.get(_key(target_type, name))
        return claim.session_id if claim else None

    def holder_of(self, target_type: str, name: str) -> str | None:
        """owner_of(), or a remote holder's id (remote_holder_id()): who is
        in the way of playing there."""
        return self._holder(_key(target_type, name))

    def remote_label(self, holder: str, target_type: str, name: str) -> str | None:
        """Who to show as holding (type, name) for a remote holder; None
        once that claim has lapsed or gone."""
        remote = self._remote.get(holder.removeprefix(REMOTE_PREFIX))
        if remote is None or time.time() - remote.refreshed_at >= REMOTE_TTL_SECONDS:
            return None
        return remote.labels.get(_key(target_type, name))

    def local_pairs(self) -> list[tuple[str, str]]:
        """Every (type, name) a local session holds."""
        return [tuple(key.split(":", 1)) for key in self._claims]  # type: ignore[misc]

    def local_labelled(self, label_of: Callable[[str], str]) -> list[dict]:
        """The local claims as a remote set for another connect, labelled
        by `label_of(session_id)`."""
        return [
            {
                "type": key.split(":", 1)[0],
                "name": key.split(":", 1)[1],
                "label": label_of(claim.session_id),
            }
            for key, claim in self._claims.items()
        ]

    def remote_claims(self, exclude: str | None = None) -> list[dict]:
        """Every live remote claim except `exclude`'s, as set_remote() takes them."""
        now = time.time()
        return [
            {"type": key.split(":", 1)[0], "name": key.split(":", 1)[1], "label": label}
            for source, remote in self._remote.items()
            if source != exclude and now - remote.refreshed_at < REMOTE_TTL_SECONDS
            for key, label in remote.labels.items()
        ]

    def set_remote(self, source: str, items: list[dict], now: float | None = None) -> None:
        """Replaces `source`'s whole set with `items` ({type, name, label})."""
        labels = {_key(i["type"], i["name"]): i["label"] for i in items}
        before = self._remote.get(source)
        self._remote[source] = _RemoteSet(time.time() if now is None else now, labels)
        if before is None or before.labels != labels:
            self._changed()

    async def take_remote(self, holder: str, target_type: str, name: str) -> None:
        """A remote holder lost (type, name) to somebody else: take it out of
        its set and report it as a takeover would."""
        async with self._lock:
            key = _key(target_type, name)
            if self._remote_holder(key) == holder:
                self._take_from_remote(key, holder)
                self._changed()

    def touch_remote(self, source: str, now: float | None = None) -> None:
        remote = self._remote.get(source)
        if remote is not None:
            remote.refreshed_at = time.time() if now is None else now

    def drop_remote(self, source: str) -> None:
        if self._remote.pop(source, None) is not None:
            self._changed()


claims = ClaimRegistry()
