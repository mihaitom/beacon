"""routes/discovery.py — /discover: SSDP/mDNS device scanning + caching"""

import asyncio
import logging

from fastapi import APIRouter, Depends

from core.auth import require_token
from core.claims import claims
from core.session import SessionState, registry, require_authenticated_session, track_label
from core.state import ctx

from delivery import credentials, discover_airplay, discover_chromecast, discover_dlna, discover_sonos

logger = logging.getLogger("connect.devices")
router = APIRouter(dependencies=[Depends(require_token)])


async def _scan_devices(verbose: bool = False) -> dict:
    """The actual SSDP/mDNS scan for Sonos, AirPlay, Chromecast and DLNA
    devices — extracted so discover_all() can coalesce concurrent callers
    into a single in-flight scan instead of each running their own.

    `verbose` is passed through to discover_airplay()/discover_dlna() — see
    discover_all()'s docstring."""
    cached = ctx.discovered
    logger.info("[discover] Scanning for Sonos, AirPlay, Chromecast and DLNA devices …")
    sonos_res, airplay_res, chromecast_res, dlna_res = await asyncio.gather(
        discover_sonos(),
        discover_airplay(verbose=verbose),
        discover_chromecast(),
        discover_dlna(verbose=verbose),
        return_exceptions=True,
    )
    sonos = sonos_res if isinstance(sonos_res, list) else cached["sonos"]
    airplay = airplay_res if isinstance(airplay_res, list) else cached["airplay"]
    chromecast = (
        chromecast_res if isinstance(chromecast_res, list) else cached["chromecast"]
    )
    dlna = dlna_res if isinstance(dlna_res, list) else cached["dlna"]
    if isinstance(sonos_res, Exception):
        logger.warning(f"[discover] Sonos error: {sonos_res}")
    if isinstance(airplay_res, Exception):
        logger.warning(f"[discover] AirPlay error: {airplay_res}")
    if isinstance(chromecast_res, Exception):
        logger.warning(f"[discover] Chromecast error: {chromecast_res}")
    if isinstance(dlna_res, Exception):
        logger.warning(f"[discover] DLNA error: {dlna_res}")
    logger.info(
        f"[discover] {len(sonos)} Sonos, {len(airplay)} AirPlay, "
        f"{len(chromecast)} Chromecast, {len(dlna)} DLNA found"
    )
    ctx.discovered = {
        "airplay": airplay,
        "chromecast": chromecast,
        "dlna": dlna,
        "sonos": sonos,
    }
    return ctx.discovered


_discover_lock = asyncio.Lock()
_discover_task: asyncio.Task | None = None


async def discover_all(verbose: bool = False) -> dict:
    """Scan for Sonos, AirPlay, Chromecast and DLNA devices and update the
    cache. Global, not session-scoped — the set of devices on the network is
    the same regardless of who's asking (see core/state.py's Context).

    Coalesces concurrent callers into a single in-flight scan: two users
    opening the popover at nearly the same time (or a request-triggered
    refresh overlapping the periodic background scan in main.py) would
    otherwise each kick off their own redundant — and, for mDNS/SSDP,
    mutually interfering — scan. Everyone who calls in while a scan is
    already running just awaits that same scan's result instead.

    `verbose` logs Sonos-duplicate AirPlay/DLNA entries as they're filtered
    out — reserved for an explicit "Scan again" (see /discover below); the
    quiet background rescan every popover open triggers, and the periodic
    scan in main.py, both stay quiet. If a verbose and a non-verbose caller
    happen to coalesce onto the same in-flight scan, whichever call started
    it decides — a rare, harmless mismatch, not worth avoiding.
    """
    global _discover_task
    async with _discover_lock:
        if _discover_task is None or _discover_task.done():
            _discover_task = asyncio.create_task(_scan_devices(verbose))
        task = _discover_task
    return await task


def _annotate_claims(discovered: dict) -> dict:
    """Attach in_use_by_session_id/in_use_by_name/in_use_by_track to each
    device in a fresh /discover response — computed per-request (not cached,
    unlike the device list itself) since claims change far more often than
    the device list. Reports the raw owner regardless of who's asking; the
    frontend decides "claimed by me" vs. "claimed by someone else" by
    comparing against its own session id."""
    annotated: dict = {}
    # discover_airplay() sets needs_pairing purely from the device's
    # advertised AirPlay protocol — it has no idea whether we've already
    # paired with it (that lives in credentials.py's on-disk store), so a
    # device paired in a previous session still came back with
    # needs_pairing=True forever. Cross-referencing here, once per request,
    # is cheaper than teaching the mDNS scan about credentials and keeps
    # discover_airplay()'s job to just "what does the network say".
    paired = set(credentials.list_paired())
    for group_type, devices in discovered.items():
        annotated[group_type] = []
        for device in devices:
            owner = claims.owner_of(group_type, device["name"])
            owner_session = registry.get(owner) if owner else None
            entry = {
                **device,
                "in_use_by_name": owner_session.display_name if owner_session else None,
                "in_use_by_session_id": owner,
                "in_use_by_track": track_label(owner_session) if owner_session else None,
            }
            if group_type == "airplay":
                entry["needs_pairing"] = (
                    device.get("needs_pairing", False) and device["name"] not in paired
                )
            annotated[group_type].append(entry)
    return annotated


@router.get("/discover")
async def discover(
    fresh: bool = False, session: SessionState = Depends(require_authenticated_session)
):
    cached = ctx.discovered
    has_cache = bool(
        cached["sonos"] or cached["airplay"] or cached["chromecast"] or cached["dlna"]
    )

    # fresh=true (explicit "Scan again") awaits a full rescan so the client can
    # show real progress. Otherwise serve cache instantly and rescan in the
    # background for snappy popover opens.
    if has_cache and not fresh:
        asyncio.create_task(discover_all())
        return _annotate_claims(cached)

    return _annotate_claims(await discover_all(verbose=True))
