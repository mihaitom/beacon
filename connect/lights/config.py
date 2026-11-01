"""lights/config.py — the Hue pairing and the choices made for it.

One per connect instance, like the integration key: lights belong to the
house, not to an account. Plain JSON under CONNECT_DATA_DIR, mode 0600,
since the pairing key in it is what lets anybody drive the lights.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import asdict, dataclass, replace

logger = logging.getLogger("connect.lights")

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_FILENAME = "hue_lights.json"

# How far ahead of the music a colour is sent, so it lights when the beat
# is heard rather than a bridge round trip later. A starting point to be
# tuned by ear per house (the setting), not a measurement.
DEFAULT_LEAD_MS = 80
MAX_LEAD_MS = 1000

STYLES = ("pulse", "calm", "party", "wave")
COLOUR_MODES = ("cover", "palette", "fixed")
DEFAULT_FIXED_COLOUR = "#3b6bff"
# In percent. Not lower: below this the flashes no longer read as flashes.
MIN_BRIGHTNESS = 20


@dataclass(frozen=True)
class LightsConfig:
    bridge_host: str = ""
    bridge_id: str = ""
    username: str = ""
    clientkey: str = ""
    app_id: str = ""
    area_id: str = ""
    enabled: bool = False
    lead_ms: int = DEFAULT_LEAD_MS
    style: str = "pulse"
    # "cover": the cover's main colour; "palette": several of its colours,
    # spread over the lights; "fixed": fixed_colour.
    colour_mode: str = "cover"
    fixed_colour: str = DEFAULT_FIXED_COLOUR
    brightness: int = 100

    @property
    def paired(self) -> bool:
        return bool(self.bridge_host and self.username and self.clientkey and self.app_id)

    @property
    def ready(self) -> bool:
        return self.paired and self.enabled and bool(self.area_id)


_lock = threading.Lock()
_cache: LightsConfig | None = None


def _path() -> str:
    return os.path.join(_DATA_DIR, _FILENAME)


def _read() -> LightsConfig:
    try:
        with open(_path(), encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return LightsConfig()
    except Exception as e:
        logger.warning(f"[lights] Could not read {_FILENAME}: {e}")
        return LightsConfig()
    if not isinstance(data, dict):
        return LightsConfig()
    known = {k: v for k, v in data.items() if k in LightsConfig.__dataclass_fields__}
    try:
        return LightsConfig(**known)
    except TypeError as e:
        logger.warning(f"[lights] Ignoring a malformed {_FILENAME}: {e}")
        return LightsConfig()


def get() -> LightsConfig:
    global _cache
    with _lock:
        if _cache is None:
            _cache = _read()
        return _cache


def update(**changes) -> LightsConfig:
    """Applies `changes` and writes the result; returns it."""
    global _cache
    with _lock:
        current = _cache if _cache is not None else _read()
        new = replace(current, **changes)
        os.makedirs(_DATA_DIR, exist_ok=True)
        tmp = _path() + ".tmp"
        data = asdict(new)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, _path())
        _cache = new
        return new


def forget() -> None:
    """Drops the pairing and every choice made for it."""
    global _cache
    with _lock:
        try:
            os.remove(_path())
        except FileNotFoundError:
            pass
        _cache = LightsConfig()


def reset_cache_for_tests() -> None:
    global _cache
    with _lock:
        _cache = None
