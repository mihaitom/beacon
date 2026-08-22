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


async def import_in_thread(name: str) -> ModuleType:
    """Import `name` off the event loop and return the module.

    Every call after the first hits sys.modules and costs nothing beyond the
    thread hop, so callers can use this unconditionally instead of tracking
    whether the import already happened."""
    return await asyncio.to_thread(importlib.import_module, name)
