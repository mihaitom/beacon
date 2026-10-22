"""core/older_sonos.py — how the older Sonos models get a song (#56). An
installation-wide choice in Settings → Advanced (routes/older_sonos.py): the
speakers belong to the installation, not to whoever is signed in.

A Play:3 or a first-generation Playbar stops reading a stream 30-45 seconds
in (docs/investigations/old-sonos-models-stop-reading-the-stream.md), and
which way of sending a song survives that has not been measured yet:

- "whole": as fast as ffmpeg makes it, the default. Plays through what
  reaches the speaker in that time, about 14 MiB on a Play:3.
- "paced": at playback speed after a head start, as every other speaker gets
  it and as the internet radio station that plays to the end sends.
- "file": a file of known length, encoded at a constant bitrate so it can be
  fetched in parts with byte ranges, the way Sonos documents a player
  fetching a large file.

Persisted in CONNECT_DATA_DIR like core/log_level.py, so it survives a
container being recreated.
"""

import logging
import os

logger = logging.getLogger("connect.older_sonos")

MODES = ("whole", "paced", "file")
DEFAULT_MODE = "whole"

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_PATH = os.path.join(_DATA_DIR, "older_sonos_mode.txt")

# Read from disk once, then kept: every /stream connection asks.
_mode: str | None = None


def _load() -> str:
    try:
        with open(_PATH, encoding="utf-8") as f:
            mode = f.read().strip()
    except FileNotFoundError:
        return DEFAULT_MODE
    except Exception as e:
        logger.warning(f"[older-sonos] Load failed: {e}")
        return DEFAULT_MODE
    return mode if mode in MODES else DEFAULT_MODE


def stream_mode() -> str:
    global _mode
    if _mode is None:
        _mode = _load()
    return _mode


def set_stream_mode(mode: str) -> None:
    if mode not in MODES:
        raise ValueError(f"Invalid mode: {mode!r}")
    global _mode
    _mode = mode
    try:
        os.makedirs(os.path.dirname(_PATH), exist_ok=True)
        with open(_PATH, "w", encoding="utf-8") as f:
            f.write(mode)
    except Exception as e:
        logger.error(f"[older-sonos] Save failed: {e}")
    logger.info(f"[older-sonos] Older Sonos models get a song: {mode}")
