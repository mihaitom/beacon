"""core/mdns.py — announces this Beacon on the LAN for home automation

Advertised as `_beacon._tcp` while something exists that can use it - the
retired integration key (core/integration_key.py), or on the desktop app a
device key allowed to steer playback - and withdrawn once neither does: a
laptop has no business advertising itself on every network it joins
otherwise. The record carries the port, so an integration that follows it
keeps working when the desktop app had to fall back to another one.

A server is not announced: it sits behind an address somebody set up, and a
container's multicast rarely reaches the LAN anyway.

TXT properties: `id` (stable across restarts, for telling instances apart),
`version`, `api`, where the device-link API lives, and `path`, where the
retired one does. See docs/help/faq/apps-and-api.md.
"""

import asyncio
import logging
import socket

from zeroconf import IPVersion
from zeroconf.asyncio import AsyncServiceInfo, AsyncZeroconf

from core import device_keys, integration_key, server_link
from core.client_id import stable_id
from core.state import PORT, get_local_ip
from lyrics.shared import CONNECT_VERSION

logger = logging.getLogger("connect.mdns")

SERVICE_TYPE = "_beacon._tcp.local."
API_PATH = "/remote/"
DEVICE_LINK_PATH = "/device-link/v1/"
# How often the announcement is checked against the machine's address, so a
# laptop that moved networks is not left advertising its old one.
RECHECK_SECONDS = 60

_zeroconf: AsyncZeroconf | None = None
_info: AsyncServiceInfo | None = None
_lock = asyncio.Lock()


def instance_id() -> str:
    return stable_id(".beacon-instance-id")


def _build_info(address: str) -> AsyncServiceInfo:
    ident = instance_id()
    host = socket.gethostname().split(".")[0] or "beacon"
    return AsyncServiceInfo(
        SERVICE_TYPE,
        f"Beacon on {host}.{SERVICE_TYPE}",
        port=PORT,
        parsed_addresses=[address],
        # Its own host name rather than the machine's: the OS may already
        # answer for that one, and two responders disagreeing about it is
        # worse than a name nobody reads.
        server=f"beacon-{ident[:8]}.local.",
        properties={
            "id": ident,
            "version": CONNECT_VERSION,
            "api": DEVICE_LINK_PATH,
            "path": API_PATH,
        },
    )


async def _register(address: str) -> None:
    global _zeroconf, _info
    if _zeroconf is None:
        _zeroconf = AsyncZeroconf(ip_version=IPVersion.V4Only)
    info = _build_info(address)
    await _zeroconf.async_register_service(info, allow_name_change=True)
    _info = info
    logger.info(f"[mdns] Announcing {info.name} at {address}:{PORT}")


async def _unregister() -> None:
    global _info
    if _zeroconf is None or _info is None:
        return
    await _zeroconf.async_unregister_service(_info)
    logger.info(f"[mdns] Withdrew {_info.name}")
    _info = None


def steered_from_outside() -> bool:
    """Whether something outside may steer this player: an integration key,
    or on a desktop app a key with the control right. Announced then, and
    the window keeps the remote relay running for it (routes/remote.py)."""
    if integration_key.is_set():
        return True
    # AVAILABLE: this is a desktop app.
    return server_link.AVAILABLE and device_keys.any_key_has_scope(device_keys.CONTROL)


async def sync() -> None:
    """Brings the announcement in line with the keys and the current
    address. Never raises: an announcement that failed costs discovery, not
    the API."""
    try:
        wanted = await asyncio.to_thread(steered_from_outside)
    except Exception as e:
        logger.warning(f"[mdns] Could not read the keys: {e}")
        return
    async with _lock:
        try:
            if not wanted:
                await _unregister()
                return
            address = get_local_ip()
            if _info is not None and address in _info.parsed_addresses():
                return
            await _unregister()
            await _register(address)
        except Exception as e:
            logger.warning(f"[mdns] Could not update the announcement: {e}")


async def keep_announced() -> None:
    """Background task (see main.py's lifespan)."""
    while True:
        await sync()
        await asyncio.sleep(RECHECK_SECONDS)


async def shutdown() -> None:
    global _zeroconf
    async with _lock:
        try:
            await _unregister()
        except Exception as e:
            logger.warning(f"[mdns] Could not withdraw the announcement: {e}")
        if _zeroconf is not None:
            await _zeroconf.async_close()
            _zeroconf = None
