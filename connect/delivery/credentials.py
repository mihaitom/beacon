"""delivery/credentials.py — persistent AirPlay pairing credentials per device"""

import json
import logging
import os

logger = logging.getLogger("connect.credentials")

# CONNECT_DATA_DIR points this at a stable, persistent directory:
#   - Electron sets it (main/index.ts) to the app's userData path, since the
#     packaged PyInstaller binary's own folder gets replaced wholesale on
#     every app update.
#   - Docker's start.sh defaults it to /data — mount a volume there.
# Falls back to next to this package when unset (bare source checkout).
_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_PATH = os.path.join(_DATA_DIR, "airplay_credentials.json")


def _load() -> dict[str, str]:
    try:
        with open(_PATH, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        logger.warning(f"[credentials] Load failed: {e}")
        return {}


def _save(data: dict[str, str]) -> None:
    try:
        os.makedirs(os.path.dirname(_PATH), exist_ok=True)
        with open(_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        logger.error(f"[credentials] Save failed: {e}")


def get(device_name: str) -> str | None:
    return _load().get(device_name)


def save(device_name: str, credentials: str) -> None:
    data = _load()
    data[device_name] = credentials
    _save(data)
    logger.info(f"[credentials] Saved: {device_name}")


def delete(device_name: str) -> bool:
    data = _load()
    if device_name not in data:
        return False
    del data[device_name]
    _save(data)
    logger.info(f"[credentials] Deleted: {device_name}")
    return True


def list_paired() -> list[str]:
    return list(_load().keys())
