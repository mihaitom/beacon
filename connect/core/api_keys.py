"""core/api_keys.py — installation-wide API keys for external services.

One place for the credentials Beacon stores on behalf of a whole
installation rather than one account: Last.fm's application key and
Fanart.tv's personal key today. Each is a plain text file under
CONNECT_DATA_DIR (`<service>_api_key.txt`, mode 0600) so it survives an
Electron app update, whose packaged resources folder is replaced wholesale,
and a Docker container recreation. An environment variable
(`<SERVICE>_API_KEY`) overrides it, so a deployment can set the key without
anyone typing it in.

Stored in plain text with the file mode restricted to the owner: connect
has to read a key back unattended on every start, so any key it could
decrypt with would have to sit next to it and be readable by the same
process - which protects against nobody who can read the file in the first
place. What the mode does buy is the other accounts on a shared machine.

Which services exist is a fixed list below, not a free-form argument: a
route that accepted any name would let a caller write files anywhere under
CONNECT_DATA_DIR.
"""

import logging
import os
import threading

logger = logging.getLogger("connect.api_keys")

# Every service a key may be stored for. The route only accepts these.
SERVICES = ("lastfm", "fanart")

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)

# Never read at import time: Settings can change a key while the process
# runs, and an import-time constant would keep serving the old one until a
# restart. None means "not resolved yet", '' means "resolved to nothing".
_cache: dict[str, str | None] = {}
_lock = threading.Lock()


def _path(service: str) -> str:
    return os.path.join(_DATA_DIR, f"{service}_api_key.txt")


def _env(service: str) -> str:
    return f"{service.upper()}_API_KEY"


def _load_stored(service: str) -> str:
    try:
        with open(_path(service), encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""
    except Exception as e:
        logger.warning(f"[api-keys] Could not read the stored {service} key: {e}")
        return ""


def get(service: str) -> str:
    """The key in effect: whatever Settings stored, else the environment.

    A value entered in the app wins over the environment, so a Docker
    deployment that sets the variable still gets a sensible starting point
    while anyone can change it later without touching the container."""
    with _lock:
        if _cache.get(service) is None:
            _cache[service] = _load_stored(service) or os.getenv(_env(service), "").strip()
        return _cache[service]


def stored(service: str) -> str:
    """Only what Settings persisted, ignoring the environment - what the
    status needs to tell the two sources apart."""
    return _load_stored(service)


def is_configured(service: str) -> bool:
    return bool(get(service))


def set(service: str, key: str) -> None:
    """Stores a key entered in Settings, or clears it when given ''. An
    empty value falls back to the environment rather than to nothing, which
    is what makes clearing the field in a Docker deployment return to the
    environment's key instead of switching the feature off."""
    cleaned = key.strip()
    with _lock:
        try:
            os.makedirs(os.path.dirname(_path(service)), exist_ok=True)
            if cleaned:
                # 0600 before anything is written: the default umask leaves
                # this world-readable, and on a NAS or a shared box that is
                # every other account on the machine.
                fd = os.open(_path(service), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(cleaned)
            else:
                try:
                    os.unlink(_path(service))
                except FileNotFoundError:
                    pass
        except Exception as e:
            logger.error(f"[api-keys] Could not store the {service} key: {e}")
        # Re-resolved on the next get() rather than set straight to
        # `cleaned`, so clearing it picks the environment's key back up.
        _cache[service] = None
    logger.info(f"[api-keys] {service} key {'stored' if cleaned else 'cleared'}")


def status(service: str) -> dict:
    """Whether the service has a key at all, and whether it came from the
    environment rather than from Settings. The key itself is never part of
    this: Settings only ever needs to know whether one is set, and an
    installation-wide credential has no business being readable by every
    logged-in account."""
    configured = is_configured(service)
    return {"configured": configured, "fromEnvironment": configured and not stored(service)}
