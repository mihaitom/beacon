"""core/client_id.py — stable per-install ids

The Jellyfin and Plex client ids, and the id this Beacon announces itself
with over mDNS (core/mdns.py). Jellyfin and Plex register a new
device/session for every client id they have not seen before, so an id has
to be the same on every request and across restarts. It lives under
CONNECT_DATA_DIR (see delivery/credentials.py) — next to the code is
read-only in a Windows install under Program Files.
"""

import logging
import os
import secrets
import threading

logger = logging.getLogger("connect.client_id")

_CODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or _CODE_DIR
# Where the id was kept before CONNECT_DATA_DIR was used for it.
_LEGACY_DIR = _CODE_DIR

_cache: dict[str, str] = {}
_lock = threading.Lock()


def stable_id(filename: str) -> str:
    """Held in memory once resolved, so an id that cannot be saved still stays
    the same until the next restart instead of changing on every request."""
    with _lock:
        if filename not in _cache:
            _cache[filename] = _load_or_create(filename)
        return _cache[filename]


def _read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def _load_or_create(filename: str) -> str:
    path = os.path.join(_DATA_DIR, filename)
    existing = _read(path)
    if existing:
        return existing
    value = _read(os.path.join(_LEGACY_DIR, filename)) or secrets.token_hex(16)
    try:
        os.makedirs(_DATA_DIR, exist_ok=True)
        with open(path, "w") as f:
            f.write(value)
    except OSError as e:
        logger.warning("Could not save %s (%s) — it will change on the next restart", path, e)
    return value


def forget_cached_ids() -> None:
    """For tests, which point _DATA_DIR somewhere else per test."""
    with _lock:
        _cache.clear()
