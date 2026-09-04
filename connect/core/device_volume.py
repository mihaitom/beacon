"""core/device_volume.py — a device reporting its own volume, from wherever
that report arrives.

Three kinds of device can tell Beacon their volume changed rather than
waiting to be asked:

  * Sonos and DLNA renderers, over a UPnP RenderingControl subscription —
    the report arrives as a NOTIFY on routes/upnp.py's callback endpoint,
  * a Chromecast, through pychromecast's own status listener on the
    connection Beacon already holds open to it (delivery/chromecast.py).

They differ in nothing that matters afterwards: a level (and sometimes a
mute flag) has to reach whichever session currently claims that device, and
every client watching it has to be told. That common half lives here, so a
new source of readings is a listener plus one call rather than its own copy
of the session lookup and the broadcast.

The other half is the frontend's: a slider stops polling a device once the
device pushes (see `pushes_volume`, surfaced per target in
build_status_dict). That has to be per *device* rather than per device type,
because whether a DLNA renderer supports eventing at all is a fact about
that particular renderer, not about DLNA.
"""

import asyncio
import logging

logger = logging.getLogger("connect.device-volume")

# The loop everything else here runs on, captured at startup (main.py's
# lifespan). Needed only by report_volume_from_thread() below: pychromecast
# calls its listeners from its own connection thread, and that is the one
# report here that doesn't already arrive on the loop as an HTTP request.
_main_loop: asyncio.AbstractEventLoop | None = None


def capture_main_loop() -> None:
    global _main_loop
    _main_loop = asyncio.get_running_loop()


# Devices known to be reporting their own volume, keyed "type:name". A
# device is in here for as long as whatever pushes for it is live: a UPnP
# subscription that was accepted, a Chromecast connection with a listener
# on it. Dropped again when that ends, so a client falls back to polling
# rather than sitting on a value nothing is refreshing.
_pushing: set[str] = set()


def device_key(device_type: str, name: str) -> str:
    return f"{device_type}:{name}"


def mark_pushes_volume(device_type: str, name: str) -> None:
    _pushing.add(device_key(device_type, name))


def clear_pushes_volume(device_type: str, name: str) -> None:
    _pushing.discard(device_key(device_type, name))


def pushes_volume(device_type: str, name: str) -> bool:
    return device_key(device_type, name) in _pushing


async def record_pushed_volume(
    device_type: str,
    name: str,
    *,
    volume: int | None = None,
    muted: bool | None = None,
) -> bool:
    """Store a reading the device sent by itself and rebroadcast the status
    that carries it. Whichever of the two values is None is left as it was:
    a RenderingControl event may carry only one of them, and a Chromecast
    reports both every time.

    False, not an error, whenever nobody currently claims this device — the
    app was closed, the device was released, or this is a stray report. The
    reading then simply has nothing to update.

    Imported lazily: core/session.py reaches the delivery layer, which is
    where two of the three callers live, and importing it at module scope
    would close that loop."""
    from core.claims import claims
    from core.session import build_status_dict, registry

    session_id = claims.owner_of(device_type, name)
    if session_id is None:
        return False
    session = registry.get(session_id)
    if session is None:
        return False

    key = device_key(device_type, name)
    previous_volume, previous_muted = session.state.device_volumes.get(key, (None, None))
    session.state.device_volumes[key] = (
        previous_volume if volume is None else volume,
        previous_muted if muted is None else muted,
    )
    await session.event_bus.broadcast(build_status_dict(session))
    return True


def report_volume_from_thread(
    device_type: str,
    name: str,
    *,
    volume: int | None = None,
    muted: bool | None = None,
) -> None:
    """record_pushed_volume() for a caller that is not on the event loop —
    a pychromecast status listener, which runs on that library's own
    connection thread.

    Silently does nothing before the loop has been captured (a listener
    firing during startup, or in a unit test that never started the app):
    a volume reading is not worth an exception on somebody else's thread,
    where nothing would catch it."""
    loop = _main_loop
    if loop is None or loop.is_closed():
        return
    try:
        asyncio.run_coroutine_threadsafe(
            record_pushed_volume(device_type, name, volume=volume, muted=muted), loop
        )
    except RuntimeError as e:
        logger.debug(f"[{device_type}:{name}] volume report dropped: {e}")


def _reset_for_tests() -> None:
    _pushing.clear()
