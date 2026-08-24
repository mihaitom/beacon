"""delivery/lazy_import.py — importing a heavy dependency without stalling
the event loop.

Every protocol library here is imported lazily, inside the function that
needs it, rather than at module import: they are large, several are optional
in practice, and pulling all of them in would make process start noticeably
slower for a session that then only ever casts to one kind of device.

That deferral is right; doing it *inline in a coroutine* is not. The first
import of one of these is genuinely expensive — measured in the deployed
image on 2026-08-22: pyatv 0.68s (it pulls in cryptography, protobuf and
miniaudio), async_upnp_client 0.22s, pychromecast 0.22s, soco 0.19s — and
all of that is synchronous, CPU-bound work on whatever thread runs it. On
the event loop it is time nothing else runs at all: a device scan starts
every protocol's discovery at once, so their first imports queue up
back-to-back and the loop is gone for over a second (a 1.71s stall logged on
a fresh instance — see core/loop_health.py, which exists to make exactly
this visible).

Beyond a slow scan, that window is also time a cast device's open /stream
socket isn't serviced, which eats into the buffer the device is playing
from — the same class of hiccup core/streamer.py's `-readrate_catchup`
exists to recover from. A scan is something the UI triggers while music is
playing (opening the device picker), so this is not a startup-only concern.
"""

import asyncio
import importlib
from types import ModuleType

# A device scan starts every protocol's discovery at once (see
# routes/discovery.py's asyncio.gather), and each protocol's first import
# above runs in its own OS thread via asyncio.to_thread — genuinely
# concurrent, not just interleaved. CPython's own per-module import lock
# only guards a *single* top-level import call; it does nothing to stop two
# *different* top-level imports (say, pyatv for AirPlay and
# async_upnp_client for DLNA) from racing through a dependency they both
# transitively pull in. Confirmed live (2026-08-24) on a fresh instance,
# both scans starting at once: "cannot import name 'HeadersParser' from
# partially initialized module 'aiohttp.http_parser' (most likely due to a
# circular import)" — aiohttp itself, imported by both threads at the same
# moment. This lock serializes every call here so at most one heavy import
# runs at a time — still entirely off the event loop, still free after the
# first call per module (the to_thread hop is the only remaining cost),
# just no longer racing another thread through the same half-initialized
# package.
_import_lock = asyncio.Lock()


async def import_in_thread(name: str) -> ModuleType:
    """Import `name` off the event loop and return the module.

    Every call after the first hits sys.modules and costs nothing beyond the
    thread hop, so callers can use this unconditionally instead of tracking
    whether the import already happened."""
    async with _import_lock:
        return await asyncio.to_thread(importlib.import_module, name)
