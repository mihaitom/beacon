"""core/shared_claims.py - speakers shared between a desktop app and its server.

A paired desktop app and its server tell each other which speakers they are
playing on (docs/plans/shared-speaker-claims.md), so "in use by", the
takeover dialog and `device_in_use` reach across both. The claims themselves
live in core/claims.py as remote sets; this module moves them.

Only the desktop opens connections: it PUTs its own claims to the server and
follows the server's (its own plus every other desktop's) on an event
stream. A takeover of a remote holder's speaker is reported to the other
side, which then stops its own cast on that one speaker - nothing more.
"""

import asyncio
import json
import logging
import socket
import time

import httpx

from core import server_link
from core.claims import claims, is_remote, remote_holder_id
from core.device_keys import KeyOwner
from core.session import displace_target, registry

logger = logging.getLogger("connect.shared_claims")

# On a desktop: the source its server's claims are kept under.
SERVER_SOURCE = "server"
# How often a desktop holding speakers says so again; core/claims.py's
# REMOTE_TTL_SECONDS lets two of these go missing.
PUSH_EVERY_SECONDS = 30.0
MAX_CLAIMS = 64
_RETRY_BASE_SECONDS = 5.0
_RETRY_MAX_SECONDS = 300.0
# Notices for a desktop whose stream is not open are of no use later.
_MAX_TAKEN_NOTICES = 32


def key_source(key_id: str) -> str:
    return f"key:{key_id}"


async def lose(target_type: str, name: str) -> None:
    """Somebody on the other side took this speaker over: stop our own cast
    on it, as a local takeover would (displace_target()), and let go."""
    holder = claims.owner_of(target_type, name)
    if holder is None:
        return
    session = registry.get(holder)
    if session is not None:
        await displace_target(session, target_type, name)
    await claims.release(target_type, name, holder)
    logger.info(f"[claims] {target_type} '{name}' was taken over on the other side")


# ── On the server ─────────────────────────────────────────────────────────

_taken: dict[str, list[dict]] = {}


def receive(owner: KeyOwner, host: str, items: list[dict]) -> None:
    """A desktop's whole set of claims, shown as "<account> on <host>"."""
    label = f"{owner.account.username} on {host}" if host else owner.account.username
    claims.set_remote(
        key_source(owner.key_id),
        [{"type": i["type"], "name": i["name"], "label": label} for i in items],
    )


def snapshot_for(owner: KeyOwner) -> list[dict]:
    """What a desktop is shown: the server's own claims and every other
    desktop's, never its own."""

    def label_of(session_id: str) -> str:
        session = registry.get(session_id)
        return session.display_name if session else ""

    return claims.local_labelled(label_of) + claims.remote_claims(exclude=key_source(owner.key_id))


def take_notices(owner: KeyOwner) -> list[dict]:
    return _taken.pop(owner.key_id, [])


async def taken_by(owner: KeyOwner, target_type: str, name: str) -> None:
    """A desktop took (type, name) over. Whoever held it here loses it: a
    session of this server, or another desktop, which is told in turn."""
    holder = claims.holder_of(target_type, name)
    if holder is None or holder == remote_holder_id(key_source(owner.key_id)):
        return
    if is_remote(holder):
        await claims.take_remote(holder, target_type, name)
    else:
        await lose(target_type, name)


def forget(key_id: str) -> None:
    """A revoked key: its claims lapse at once, not after the TTL."""
    claims.drop_remote(key_source(key_id))
    _taken.pop(key_id, None)


# ── Both sides ────────────────────────────────────────────────────────────


def _on_remote_taken(source: str, target_type: str, name: str) -> None:
    """A local takeover displaced a remote holder: tell that side."""
    notice = {"type": target_type, "name": name}
    if source.startswith("key:"):
        pending = _taken.setdefault(source.removeprefix("key:"), [])
        pending.append(notice)
        del pending[:-_MAX_TAKEN_NOTICES]
    elif source == SERVER_SOURCE:
        asyncio.get_running_loop().create_task(_report_taken(notice))


claims.on_remote_taken = _on_remote_taken


# ── On a desktop ──────────────────────────────────────────────────────────

_pushed: list[tuple[str, str]] | None = None
_pushed_at = 0.0
_push_wanted: asyncio.Event | None = None


def _local_changed() -> None:
    if _push_wanted is not None:
        _push_wanted.set()


claims.listeners.append(_local_changed)


def _host() -> str:
    return (socket.gethostname().split(".")[0] or "")[:64]


async def _report_taken(notice: dict) -> None:
    link = server_link.current()
    if link is None:
        return
    try:
        await asyncio.to_thread(
            server_link.call, link, "POST", "/claims/taken", notice, server_link.SHORT_TIMEOUT
        )
    except server_link.LinkError as e:
        logger.info(f"[claims] Could not tell the server about a takeover: {e.state}")


async def push_once() -> bool:
    """Sends this desktop's claims when they changed or are due again.
    False when the server could not take them."""
    global _pushed, _pushed_at
    link = server_link.current()
    if link is None:
        _pushed = None
        return True
    pairs = sorted(claims.local_pairs())[:MAX_CLAIMS]
    due = bool(pairs) and time.monotonic() - _pushed_at >= PUSH_EVERY_SECONDS
    # Remote changes wake this too; only our own, or the refresh, are sent.
    if pairs == (_pushed or []) and not due:
        _pushed = pairs
        return True
    body = {"host": _host(), "claims": [{"type": t, "name": n} for t, n in pairs]}
    try:
        await asyncio.to_thread(
            server_link.call, link, "PUT", "/claims", body, server_link.SHORT_TIMEOUT
        )
    except server_link.LinkError as e:
        logger.debug(f"[claims] Could not send our claims: {e.state}")
        return False
    _pushed, _pushed_at = pairs, time.monotonic()
    return True


def withdraw() -> None:
    """Before unpairing: the server frees this desktop's speakers now, not
    after the TTL - unpairing keeps the key there. Blocking, best effort."""
    global _pushed
    link = server_link.current()
    if link is None or not _pushed:
        return
    try:
        server_link.call(
            link, "PUT", "/claims", {"host": _host(), "claims": []}, server_link.SHORT_TIMEOUT
        )
    except server_link.LinkError as e:
        logger.info(f"[claims] Could not free our speakers on the server: {e.state}")
    _pushed = None


async def _push_loop() -> None:
    global _push_wanted
    _push_wanted = asyncio.Event()
    failures = 0
    while True:
        ok = await push_once()
        failures = 0 if ok else failures + 1
        delay = (
            PUSH_EVERY_SECONDS
            if ok
            else min(_RETRY_BASE_SECONDS * 2 ** (failures - 1), _RETRY_MAX_SECONDS)
        )
        try:
            await asyncio.wait_for(_push_wanted.wait(), timeout=delay)
        except TimeoutError:
            pass
        _push_wanted.clear()


async def apply_event(payload: dict) -> None:
    """One event from the server's claims stream."""
    if "claims" in payload:
        items = [
            i
            for i in payload["claims"]
            if isinstance(i, dict) and {"type", "name", "label"} <= i.keys()
        ][: MAX_CLAIMS * 4]
        claims.set_remote(SERVER_SOURCE, items)
    taken = payload.get("taken")
    if isinstance(taken, dict) and {"type", "name"} <= taken.keys():
        await lose(str(taken["type"]), str(taken["name"]))


async def follow_once() -> None:
    """Follows the server's claims stream until it ends. Raises
    server_link.LinkError for a refusal, httpx.HTTPError for the network."""
    link = server_link.current()
    if link is None:
        claims.drop_remote(SERVER_SOURCE)
        return
    url, headers = server_link.stream_target(link, "/claims/events")
    async with (
        httpx.AsyncClient(
            transport=server_link.async_transport(),
            timeout=httpx.Timeout(10.0, read=45.0),
            follow_redirects=False,
        ) as client,
        client.stream("GET", url, headers=headers) as response,
    ):
        server_link.check_stream_answer(response)
        async for line in response.aiter_lines():
            # Unpairing leaves the key valid on the server; stop listening.
            if server_link.current() is None:
                claims.drop_remote(SERVER_SOURCE)
                return
            if line.startswith(":"):
                claims.touch_remote(SERVER_SOURCE)
            elif line.startswith("data:"):
                try:
                    payload = json.loads(line[5:].strip())
                except ValueError:
                    continue
                if isinstance(payload, dict):
                    await apply_event(payload)


async def _follow_loop() -> None:
    failures = 0
    while True:
        if server_link.current() is None:
            claims.drop_remote(SERVER_SOURCE)
            await asyncio.sleep(PUSH_EVERY_SECONDS)
            continue
        try:
            await follow_once()
            failures = 0
        except (server_link.LinkError, httpx.HTTPError) as e:
            failures += 1
            logger.debug(f"[claims] Server's claims stream ended: {e}")
        except Exception:
            failures += 1
            logger.exception("[claims] Following the server's claims failed")
        await asyncio.sleep(
            min(_RETRY_BASE_SECONDS * 2 ** max(failures - 1, 0), _RETRY_MAX_SECONDS)
        )


async def run() -> None:
    """Background task (main.py's lifespan); a desktop app only."""
    if not server_link.AVAILABLE:
        return
    await asyncio.gather(_push_loop(), _follow_loop())


def reset_for_tests() -> None:
    global _pushed, _pushed_at, _push_wanted
    _pushed, _pushed_at = None, 0.0
    _push_wanted = None
    _taken.clear()
