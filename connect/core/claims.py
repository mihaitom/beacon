"""core/claims.py — Device claim registry.

Tracks which session currently "owns" a cast target, so /discover can tell
the frontend a device is in use by someone else, and /play, /play-url, /join
can refuse (or, with force=True, take over) a target already claimed by a
different session. Global (not per-session) by design — ownership is a
property of the physical device, checked across all sessions at once.
"""

import asyncio
import time
from dataclasses import dataclass


@dataclass
class Claim:
    session_id: str
    claimed_at: float


def _key(target_type: str, name: str) -> str:
    return f"{target_type}:{name}"


class ClaimRegistry:
    def __init__(self):
        self._claims: dict[str, Claim] = {}
        self._lock = asyncio.Lock()

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
            existing = self._claims.get(key)
            if existing is not None and existing.session_id != session_id:
                if not force:
                    return existing.session_id
                previous_owner = existing.session_id
                self._claims[key] = Claim(session_id=session_id, claimed_at=time.time())
                return previous_owner
            self._claims[key] = Claim(session_id=session_id, claimed_at=time.time())
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
                existing = self._claims.get(_key(target_type, name))
                if existing is not None and existing.session_id != session_id and not force:
                    return (target_type, name, existing.session_id)
            for target_type, name in pairs:
                self._claims[_key(target_type, name)] = Claim(
                    session_id=session_id, claimed_at=time.time()
                )
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
                existing = self._claims.get(key)
                if existing is not None and existing.session_id != session_id:
                    displaced.append((target_type, name, existing.session_id))
                self._claims[key] = Claim(session_id=session_id, claimed_at=time.time())
            return displaced

    async def release(
        self, target_type: str, name: str, session_id: str | None = None
    ) -> None:
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

    async def release_all_for_session(self, session_id: str) -> list[tuple[str, str]]:
        """Release every claim owned by session_id. Returns the released
        (type, name) pairs."""
        async with self._lock:
            released = [
                key for key, claim in self._claims.items() if claim.session_id == session_id
            ]
            for key in released:
                del self._claims[key]
        return [tuple(key.split(":", 1)) for key in released]  # type: ignore[misc]

    def owner_of(self, target_type: str, name: str) -> str | None:
        claim = self._claims.get(_key(target_type, name))
        return claim.session_id if claim else None


claims = ClaimRegistry()
