"""core/log_level.py — runtime-adjustable backend log verbosity.

Persisted the same way as AirPlay pairing credentials/radio stations (see
delivery/credentials.py) — CONNECT_DATA_DIR survives Electron app updates
(the packaged binary's own folder gets replaced wholesale) and Docker
container recreation (mounted volume). routes/log_level.py's GET/POST
/log-level (driven by SettingsView.vue's log-level dropdown) reads/writes
this at runtime; main.py's initial_level() falls back to the old DEBUG env
var only when nothing's been persisted yet — an upgrade from before this
setting existed, or a deployment troubleshooting a container that never
comes up far enough to reach Settings in the first place.

Deliberately separate from main.py's own `_DEBUG` — that also gates the API
docs/openapi/redoc endpoints and routes/debug.py's diagnostic router (real
attack-surface decisions, not just verbosity), and stays a deploy-time-only
env var for that reason. This module only ever touches how much gets logged.
"""

import logging
import os

logger = logging.getLogger("connect.log_level")

LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_PATH = os.path.join(_DATA_DIR, "log_level.txt")

# Our own logger tree (connect covers its children connect.streamer/
# connect.playback/... via propagation) plus the third-party libraries that
# are only ever chatty at DEBUG — see main.py's old _DEBUG handling this
# replaces.
_APP_LOGGERS = ("connect", "delivery", "sonos", "pyatv", "soco")
_HTTP_CLIENT_LOGGERS = ("httpx", "httpcore")


def _load_persisted() -> str | None:
    try:
        with open(_PATH, encoding="utf-8") as f:
            level = f.read().strip().upper()
    except FileNotFoundError:
        return None
    except Exception as e:
        logger.warning(f"[log-level] Load failed: {e}")
        return None
    return level if level in LEVELS else None


def _save_persisted(level: str) -> None:
    try:
        os.makedirs(os.path.dirname(_PATH), exist_ok=True)
        with open(_PATH, "w", encoding="utf-8") as f:
            f.write(level)
    except Exception as e:
        logger.error(f"[log-level] Save failed: {e}")


def initial_level() -> str:
    """The level to apply once at process startup — persisted Settings
    choice first, falling back to the legacy DEBUG env var (DEBUG=true ->
    DEBUG, otherwise INFO) only when nothing's been persisted yet."""
    persisted = _load_persisted()
    if persisted:
        return persisted
    debug_env = os.getenv("DEBUG", "").strip().lower() in ("1", "true", "yes", "on")
    return "DEBUG" if debug_env else "INFO"


def current_level() -> str:
    """Reads back whatever apply() last set — _APP_LOGGERS[0] ("connect")
    stands in for the whole group, since apply() always sets every name in
    it to the same level together."""
    return logging.getLevelName(logging.getLogger(_APP_LOGGERS[0]).level)


def apply(level: str, *, persist: bool = True) -> None:
    """Sets `level` across the app's own logger tree, the third-party
    libraries that are only ever informative at DEBUG, and uvicorn's access
    log. `persist=False` is for the one-time call at process startup — the
    value just came from disk (or the DEBUG env var fallback); writing it
    straight back would be a no-op at best and could turn a deliberate
    DEBUG=true override into a stale persisted INFO at worst.
    """
    if level not in LEVELS:
        raise ValueError(f"Invalid log level: {level!r}")
    numeric = getattr(logging, level)
    for name in _APP_LOGGERS:
        logging.getLogger(name).setLevel(numeric)
    # httpx/httpcore log every outgoing request at INFO — only useful
    # alongside our own DEBUG output; anything else just keeps them at
    # WARNING (not a literal INFO/ERROR mapping, which would either spam
    # every request or hide their own connection failures).
    for name in _HTTP_CLIENT_LOGGERS:
        logging.getLogger(name).setLevel(numeric if level == "DEBUG" else logging.WARNING)
    # Same reasoning as the HTTP clients above — uvicorn's per-request
    # access line is only ever useful at DEBUG.
    logging.getLogger("uvicorn.access").setLevel(
        logging.INFO if level == "DEBUG" else logging.WARNING
    )
    if persist:
        _save_persisted(level)
    logger.info(f"[log-level] Set to {level}")
