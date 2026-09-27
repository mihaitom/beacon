"""core/integration_key.py — the key home automation uses for Remote Control

Home Assistant and the like talk to the same /remote/* endpoints a phone
does (routes/remote.py), but a phone's pairing is the wrong shape for them:
its password is regenerated every time Remote Control is switched on, which
is what locks old phones out, and an unattended integration would be locked
out with them after every restart. So integrations get a credential of their
own, independent of the phone feature: created in Settings, kept under
CONNECT_DATA_DIR until it is revoked or replaced.

Plain text, mode 0600, for the same reason as core/api_keys.py: connect has
to read it back unattended on every start.
"""

import logging
import os
import secrets
import threading

logger = logging.getLogger("connect.integration_key")

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_FILENAME = "integration_key.txt"

# None = not read from disk yet, '' = no key.
_cache: str | None = None
_lock = threading.Lock()


def _path() -> str:
    return os.path.join(_DATA_DIR, _FILENAME)


def _load() -> str:
    try:
        with open(_path(), encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""
    except OSError as e:
        logger.warning(f"[integration-key] Could not read the stored key: {e}")
        return ""


def get() -> str:
    """The key in effect, or '' when integrations are switched off."""
    global _cache
    with _lock:
        if _cache is None:
            _cache = _load()
        return _cache


def is_set() -> bool:
    return bool(get())


def generate() -> str:
    """Replaces any existing key, so whatever used the old one is locked
    out. Raises OSError if it cannot be saved: a key that silently lasted
    only until the next restart is exactly the problem this exists to fix."""
    global _cache
    key = secrets.token_urlsafe(32)
    with _lock:
        os.makedirs(_DATA_DIR, exist_ok=True)
        fd = os.open(_path(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(key)
        _cache = key
    return key


def revoke() -> None:
    global _cache
    with _lock:
        try:
            os.remove(_path())
        except FileNotFoundError:
            pass
        _cache = ""


def matches(provided: str | None) -> bool:
    key = get()
    if not key or not provided:
        return False
    # Bytes, not str: compare_digest raises on a non-ASCII str.
    return secrets.compare_digest(provided.encode(), key.encode())


def forget_cached() -> None:
    """For tests, which point _DATA_DIR somewhere else per test."""
    global _cache
    with _lock:
        _cache = None
