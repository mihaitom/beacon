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

# Below DEBUG(10) — registered once at import time (addLevelName() is
# process-global regardless of which logger touches it, and this module's
# body only ever runs once even if imported from several places). Exists so
# "give me detail on our own playback logic" (DEBUG) and "also show me every
# SOAP/HTTP call the libraries underneath make" (TRACE) can be two different
# choices instead of one all-or-nothing DEBUG that was always the second
# thing whether you wanted it or not — see LEVELS/apply() below.
#
# NOT 5 (DEBUG - 5, the "obvious" choice): pyatv's own mdns.py registers
# its own even-more-verbose "Traffic" level at exactly that number, the
# moment AirPlay first actually does anything (a lazy import, not at
# process startup, which is what made this easy to miss). addLevelName()
# only remembers one name per number — whichever of us registers second
# would silently rename the other's level in every log line, and there's no
# way to control which one that ends up being. 3 keeps clear of pyatv's 5
# (and uvicorn's/PyInstaller's own same-numbered "TRACE", registered lazily
# elsewhere) while staying low enough that setting a third-party logger's
# threshold to TRACE (see apply() below) still lets pyatv's own Traffic-
# level output through too, not just the libraries' plain DEBUG.
TRACE = 3
logging.addLevelName(TRACE, "TRACE")

LEVELS = ("TRACE", "DEBUG", "INFO", "WARNING", "ERROR")
_NUMERIC = {"TRACE": TRACE, "DEBUG": logging.DEBUG, "INFO": logging.INFO,
            "WARNING": logging.WARNING, "ERROR": logging.ERROR}

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_PATH = os.path.join(_DATA_DIR, "log_level.txt")

# Our own logger tree only (connect covers its children connect.streamer/
# connect.playback/... via propagation; delivery covers delivery/*.py's own
# "delivery" logger, e.g. sonos.py's transport-state lines). DEBUG here is
# meant to be readable on its own — everything below is third-party
# libraries doing their own request/response-level logging, which is only
# ever useful *alongside* our own DEBUG output, not a substitute for it, and
# is what TRACE (not DEBUG) now turns on. sonos/pyatv used to live in this
# tuple too, back when DEBUG was the only "give me more" option there was —
# they're SoCo/pyatv's own loggers (the third-party UPnP/AirPlay libraries),
# not our code, so they moved to _THIRD_PARTY_LOGGERS below.
_APP_LOGGERS = ("connect", "delivery")
_THIRD_PARTY_LOGGERS = ("sonos", "pyatv", "soco", "httpx", "httpcore")


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
    DEBUG, otherwise INFO) only when nothing's been persisted yet. Never
    TRACE from the env var fallback — that's a deliberate, heavier choice
    only ever made explicitly from Settings, not something a blanket
    DEBUG=true from before TRACE existed should silently opt into."""
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
    """Sets `level` across the app's own logger tree; the third-party
    libraries (SoCo, pyatv, httpx/httpcore) and uvicorn's access log only
    turn on for TRACE (at TRACE/INFO respectively — see the comment below on
    why not a plain DEBUG threshold for the libraries). Everywhere else
    (DEBUG included) they stay at WARNING, so DEBUG
    means "detail on our own playback logic" without also pulling in every
    SOAP/HTTP request the libraries underneath make — that used to be one
    and the same thing, whether you wanted the library noise or not.
    `persist=False` is for the one-time call at process startup — the value
    just came from disk (or the DEBUG env var fallback); writing it straight
    back would be a no-op at best and could turn a deliberate DEBUG=true
    override into a stale persisted INFO at worst.
    """
    if level not in LEVELS:
        raise ValueError(f"Invalid log level: {level!r}")
    numeric = _NUMERIC[level]
    for name in _APP_LOGGERS:
        logging.getLogger(name).setLevel(numeric)
    third_party_on = level == "TRACE"
    # TRACE itself (3), not logging.DEBUG (10) — pyatv's own deepest
    # verbosity (its "Traffic" level, 5, see TRACE's own comment above)
    # would otherwise still be filtered out at a plain DEBUG threshold, only
    # letting soco/httpx's ordinary DEBUG-level lines through and silently
    # leaving out the one library that actually needed TRACE to say
    # anything more than it already does at DEBUG.
    for name in _THIRD_PARTY_LOGGERS:
        logging.getLogger(name).setLevel(TRACE if third_party_on else logging.WARNING)
    # uvicorn's per-request access line — same reasoning as the third-party
    # libraries above, just INFO instead of DEBUG (that's the level it logs
    # each request at).
    logging.getLogger("uvicorn.access").setLevel(
        logging.INFO if third_party_on else logging.WARNING
    )
    if persist:
        _save_persisted(level)
    logger.info(f"[log-level] Set to {level}")
