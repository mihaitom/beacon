"""routes/pairing.py — AirPlay 2 Pairing-Endpoints"""

import asyncio
import logging
import time

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from core.auth import require_token
from core.session import require_authenticated_session
from delivery import credentials

logger = logging.getLogger("connect.pairing")
router = APIRouter(
    prefix="/pair/airplay",
    dependencies=[Depends(require_token), Depends(require_authenticated_session)],
)

# Active pairing sessions: device_name → (pyatv pairing object, started_at)
_sessions: dict[str, tuple[object, float]] = {}

# Serializes /start calls per device. Without this, concurrent /start requests
# for the same device (e.g. a frontend bug re-firing the pairing dialog's
# start effect) each send their own fresh pair-setup handshake — the device
# can only track one pending handshake, so the losing request(s) get an
# incomplete/out-of-order M2 response and pyatv fails with a bare KeyError
# (e.g. "<TlvValue.Salt: 2>"). Serializing means only one request actually
# talks to the device; the rest wait and then reuse the session it created.
_locks: dict[str, asyncio.Lock] = {}


def _lock_for(name: str) -> asyncio.Lock:
    if name not in _locks:
        _locks[name] = asyncio.Lock()
    return _locks[name]


# How long a started-but-unfinished pairing session is considered reusable.
# Re-sending M1 (pair-setup start) to a device that's still waiting for M3
# (the PIN) tends to make it reject the new attempt entirely (it then needs
# a power-cycle). Reusing the existing session avoids that — but only while
# it's reasonably fresh, since AirPlay devices time out pending pairings on
# their own after a while anyway.
_SESSION_TTL = 90

# How often reap_stale_pairings() below checks for sessions past _SESSION_TTL
# — well under it, so a session goes reaped within a few seconds of actually
# expiring rather than sitting open for most of another full TTL window.
PAIRING_REAP_INTERVAL = 30


async def reap_stale_pairings_once() -> list[str]:
    """Closes every pairing session past _SESSION_TTL — split out from
    reap_stale_pairings() below purely so it's directly testable, same
    reasoning as core/session.py's reap_once(). /start's own TTL check only
    notices a stale session when the *same* device is started again; a user
    who starts a pairing and then just gives up (closes the dialog, never
    calls /finish or /start again) otherwise leaves it — and the pyatv
    handshake/connection it holds open — sitting in _sessions forever.
    Returns the device names that were reaped, mainly so tests don't need
    to duplicate this logic to assert on it."""
    now = time.monotonic()
    stale = [
        name for name, (_, started_at) in _sessions.items() if now - started_at >= _SESSION_TTL
    ]
    for name in stale:
        pairing, _ = _sessions.pop(name, (None, None))
        if pairing:
            try:
                await pairing.close()
            except Exception as e:
                logger.debug(f"[pairing] closing stale session for '{name}' failed: {e}")
        # Opportunistic cleanup for the per-device lock too (see _locks'
        # own comment) — only when nothing currently holds/is waiting on
        # it, so this can never pull a lock out from under a concurrent
        # /start that's about to acquire it.
        lock = _locks.get(name)
        if lock and not lock.locked():
            _locks.pop(name, None)
    if stale:
        logger.info(f"[pairing] Reaped {len(stale)} stale pairing session(s): {stale}")
    return stale


async def reap_stale_pairings() -> None:
    """Background task (see main.py's lifespan): calls
    reap_stale_pairings_once() every PAIRING_REAP_INTERVAL, forever."""
    while True:
        await asyncio.sleep(PAIRING_REAP_INTERVAL)
        await reap_stale_pairings_once()


class StartRequest(BaseModel):
    force: bool = False
    name: str


class FinishRequest(BaseModel):
    name: str
    pin: int | None = None


@router.get("")
async def list_paired():
    return {"paired": credentials.list_paired()}


@router.post("/start")
async def start_pairing(req: StartRequest):
    import pyatv
    from pyatv.const import Protocol

    async with _lock_for(req.name):
        # If a recent, unfinished session already exists, reuse it instead of
        # sending a fresh pair-setup start (M1) — see _SESSION_TTL comment above.
        # Re-checked here (not just before acquiring the lock) so a request that
        # waited on the lock sees a session a concurrent request just created.
        existing = _sessions.get(req.name)
        if existing and not req.force:
            pairing, started_at = existing
            if time.monotonic() - started_at < _SESSION_TTL:
                logger.info(f"[pairing] Reusing existing session for '{req.name}'")
                return {
                    "device_provides_pin": pairing.device_provides_pin,
                    "name": req.name,
                }

        # Clean up any previous session for this device
        old, _ = _sessions.pop(req.name, (None, None))
        if old:
            try:
                await old.close()
            except Exception as e:
                logger.debug(f"[pairing] closing previous session for '{req.name}' failed: {e}")

        logger.info(f"[pairing] Scanning for '{req.name}' to pair...")
        devices = await pyatv.scan(asyncio.get_event_loop(), timeout=10)
        conf = next((d for d in devices if d.name.lower() == req.name.lower()), None)

        if not conf:
            available = [d.name for d in devices]
            return JSONResponse(
                {"error": f"Device '{req.name}' not found. Available: {available}"},
                status_code=404,
            )

        pairing = None
        try:
            # AirPlay 2 devices (HomePod, Sonos Era) require Protocol.AirPlay (HAP).
            # Protocol.RAOP returns 470 "Connection Authorization Required" on AirPlay 2.
            pairing = await pyatv.pair(conf, Protocol.AirPlay, asyncio.get_event_loop())
            await pairing.begin()
        except Exception as e:
            logger.error(f"[pairing] Start failed for '{req.name}': {e}")
            # pyatv.pair() itself can raise before returning anything, so
            # `pairing` may still be None here — nothing was created that
            # needs closing in that case.
            if pairing is not None:
                try:
                    await pairing.close()
                except Exception as close_err:
                    logger.debug(
                        f"[pairing] cleanup after failed start for '{req.name}': {close_err}"
                    )

            # pyatv raises a bare KeyError (e.g. "<TlvValue.Salt: 2>") when the device's
            # pair-setup response is missing fields. This happens when the device still
            # considers an earlier (e.g. cancelled or wrong-PIN) pairing attempt pending
            # and refuses to start a new handshake — usually fixed by power-cycling it.
            err_str = str(e)
            # KeyError.__str__ wraps its message in repr()'s quotes (a
            # quirk unique to KeyError among builtin exceptions), so the
            # raw string here is "'<TlvValue...'", not "<TlvValue...' —
            # stripped before the prefix check below, or this branch would
            # never match and every such failure would fall through to the
            # generic (raw, unfriendly) message instead.
            if err_str.strip("'").startswith("<TlvValue."):
                msg = (
                    f"'{req.name}' rejected the pairing request. It may still consider a "
                    f"previous pairing attempt pending — power-cycle the device and try again."
                )
            elif "470" in err_str:
                # 470 = Connection Authorization Required. At this stage (before any PIN was
                # entered) this means the device doesn't support pyatv's HAP pairing at all —
                # typically Sonos-style proprietary AirPlay 2 (MFi hardware auth).
                msg = (
                    f"'{req.name}' does not support pyatv pairing (HTTP 470 — MFi authentication "
                    f"required). Sonos speakers should be added as 'Sonos' devices, not AirPlay. "
                    f"HomePod and Apple TV work here."
                )
            else:
                msg = err_str

            return JSONResponse({"error": msg}, status_code=500)

        _sessions[req.name] = (pairing, time.monotonic())
        logger.info(
            f"[pairing] Started: '{req.name}' — device_provides_pin={pairing.device_provides_pin}"
        )
        return {
            "device_provides_pin": pairing.device_provides_pin,
            "name": req.name,
        }


@router.post("/finish")
async def finish_pairing(req: FinishRequest):
    session = _sessions.get(req.name)
    if not session:
        return JSONResponse(
            {"error": f"No active pairing session for '{req.name}'. Call /start first."},
            status_code=400,
        )

    pairing, _ = session
    try:
        if req.pin is not None:
            pairing.pin(req.pin)  # synchronous method, no await
        await pairing.finish()
    except Exception as e:
        err_str = str(e)
        _sessions.pop(req.name, None)
        try:
            await pairing.close()
        except Exception as close_err:
            logger.debug(f"[pairing] cleanup after failed finish for '{req.name}': {close_err}")

        # 470 = Connection Authorization Required. At this stage (after /start already
        # succeeded), this means the device rejected the entered PIN.
        if "470" in err_str:
            msg = f"Incorrect PIN for '{req.name}'. Please try again."
        else:
            msg = err_str

        logger.error(f"[pairing] Finish failed for '{req.name}': {msg}")
        return JSONResponse({"error": msg}, status_code=500)

    creds = pairing.service.credentials
    _sessions.pop(req.name, None)
    try:
        await pairing.close()
    except Exception as e:
        logger.debug(f"[pairing] closing finished session for '{req.name}' failed: {e}")

    if not creds:
        return JSONResponse(
            {"error": "Pairing completed but no credentials received."},
            status_code=500,
        )

    credentials.save(req.name, creds)
    logger.info(f"[pairing] ✓ Success: '{req.name}'")
    return {"success": True, "name": req.name}


@router.delete("/{name}")
async def unpair(name: str):
    deleted = credentials.delete(name)
    if not deleted:
        return JSONResponse({"error": f"'{name}' was not paired."}, status_code=404)
    return {"success": True, "name": name}
