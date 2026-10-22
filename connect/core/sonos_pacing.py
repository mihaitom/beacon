"""core/sonos_pacing.py — whether the older Sonos models get their stream at
playback speed like every other speaker. An installation-wide switch in
Settings → Advanced (routes/sonos_pacing.py): the speakers belong to the
installation, not to whoever is signed in.

Off by default, so a Play:3 or first-generation Playbar gets each song as
fast as ffmpeg makes it (see delivery/sonos.py's _UNPACED_MODELS). Persisted
in CONNECT_DATA_DIR like core/log_level.py, so it survives a container being
recreated.
"""

import logging
import os

logger = logging.getLogger("connect.sonos_pacing")

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_PATH = os.path.join(_DATA_DIR, "sonos_pacing.txt")
_PACED = "paced"

# Read from disk once, then kept: every /stream connection asks.
_paced: bool | None = None


def _load() -> bool:
    try:
        with open(_PATH, encoding="utf-8") as f:
            return f.read().strip() == _PACED
    except FileNotFoundError:
        return False
    except Exception as e:
        logger.warning(f"[sonos-pacing] Load failed: {e}")
        return False


def old_models_paced() -> bool:
    global _paced
    if _paced is None:
        _paced = _load()
    return _paced


def set_old_models_paced(paced: bool) -> None:
    global _paced
    _paced = paced
    try:
        os.makedirs(os.path.dirname(_PATH), exist_ok=True)
        with open(_PATH, "w", encoding="utf-8") as f:
            f.write(_PACED if paced else "unpaced")
    except Exception as e:
        logger.error(f"[sonos-pacing] Save failed: {e}")
    logger.info(f"[sonos-pacing] Older Sonos models: {'paced' if paced else 'unpaced'}")
