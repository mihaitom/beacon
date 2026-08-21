"""routes/discovery.py — /discover: SSDP/mDNS device scanning + caching"""

import asyncio
import logging
import time

from fastapi import APIRouter, Depends

from core.auth import require_token
from core.claims import claims
from core.session import (
    SessionState,
    registry,
    require_authenticated_session,
    track_label,
)
from core.state import ctx
from delivery import (
    credentials,
    discover_airplay,
    discover_chromecast,
    discover_dlna,
    discover_sonos,
)

logger = logging.getLogger("connect.devices")
router = APIRouter(dependencies=[Depends(require_token)])


# How many consecutive scans a single protocol's discover_*() call may fail
# before its last-known device list is dropped instead of being carried
# forward indefinitely (see _resolve_scan_result()) — high enough that one
# or two transient blips (a dropped multicast packet, a momentary network
# hiccup) don't flicker a device in and out; low enough that a genuinely,
# persistently broken discovery backend (a firewall rule change, a crashed
# zeroconf browser) stops confidently reporting now-nonexistent devices as
# available within a few scan cycles instead of forever.
_MAX_CONSECUTIVE_FAILURES = 3
_consecutive_failures: dict[str, int] = {"sonos": 0, "airplay": 0, "chromecast": 0, "dlna": 0}


def _resolve_scan_result(protocol: str, result: object, cached_list: list) -> list:
    """One protocol's gather() result -> the list _scan_devices() should
    actually use: the fresh scan if it succeeded, or the previous cached
    list carried forward for a bounded number of consecutive failures
    before giving up and reporting empty instead of devices that may no
    longer even be on the network."""
    if isinstance(result, list):
        _consecutive_failures[protocol] = 0
        return result
    _consecutive_failures[protocol] += 1
    if _consecutive_failures[protocol] >= _MAX_CONSECUTIVE_FAILURES:
        return []
    return cached_list


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
    sonos = _resolve_scan_result("sonos", sonos_res, cached["sonos"])
    airplay = _resolve_scan_result("airplay", airplay_res, cached["airplay"])
    chromecast = _resolve_scan_result("chromecast", chromecast_res, cached["chromecast"])
    dlna = _resolve_scan_result("dlna", dlna_res, cached["dlna"])
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
    global _last_scan_completed
    _last_scan_completed = time.monotonic()
    return ctx.discovered


_discover_lock = asyncio.Lock()
_discover_task: asyncio.Task | None = None
_last_scan_completed: float = 0.0
# ConnectDevicePicker.vue polls GET /discover every 4s while the popover is
# open — without a floor, /discover's own "rescan in the background on every
# call" (below) would fire a full SSDP/mDNS scan (several seconds of network
# traffic, per _scan_devices()) every single one of those polls instead of
# only occasionally in the background. Well above the poll interval, well
# below main.py's hourly periodic scan — just enough to make an open
# popover eventually notice a device that just appeared.
_BACKGROUND_RESCAN_MIN_INTERVAL = 30.0


async def _background_rescan() -> None:
    """Fire-and-forget wrapper for the quiet rescan /discover kicks off
    below — unlike main.py's own periodic scan (_periodic_discovery, same
    try/except), nothing awaits or otherwise observes this task's result,
    so an unhandled exception here would otherwise vanish as an unretrieved
    task exception (a "Task exception was never retrieved" warning at best)
    instead of being logged, and would leave _last_scan_completed stuck,
    triggering another one of these on every subsequent poll instead of
    respecting _BACKGROUND_RESCAN_MIN_INTERVAL."""
    try:
        await discover_all()
    except Exception:
        logger.exception("[discover] Background rescan failed")


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
    """Attach in_use_by_session_id/in_use_by_name/in_use_by_song to each
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
                "in_use_by_song": track_label(owner_session) if owner_session else None,
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
    # Whether a scan has ever completed at all — not whether it *found*
    # anything. A deployment with genuinely zero Sonos/AirPlay/Chromecast/
    # DLNA devices on the network (or every discovery backend transiently
    # unreachable, e.g. a firewall blocking multicast) legitimately
    # completes a scan with four empty lists; checking cached contents
    # instead of _last_scan_completed used to read that indistinguishably
    # from "never scanned yet" and fall through to a full synchronous
    # rescan on every single poll below instead of ever engaging the
    # background-rescan path.
    has_cache = _last_scan_completed > 0.0

    # fresh=true (explicit "Scan again") awaits a full rescan so the client can
    # show real progress. Otherwise serve cache instantly and rescan in the
    # background for snappy popover opens — but only if the cache is actually
    # stale (see _BACKGROUND_RESCAN_MIN_INTERVAL's comment); the device
    # picker's 4s poll would otherwise turn "rescan in the background" into a
    # full SSDP/mDNS scan every 4 seconds for as long as the popover stays open.
    if has_cache and not fresh:
        if time.monotonic() - _last_scan_completed > _BACKGROUND_RESCAN_MIN_INTERVAL:
            asyncio.create_task(_background_rescan())
        return _annotate_claims(cached)

    return _annotate_claims(await discover_all(verbose=True))
