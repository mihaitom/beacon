"""delivery/credentials.py — persistent AirPlay pairing credentials per device"""

import json
import logging
import os
import threading

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

# save()/delete() are read-modify-write over a file shared by every paired
# device, and nothing serializes their callers: routes/pairing.py finishes
# a pairing while another request unpairs a different speaker, and reads
# come from pyatv's own threads too. Without this, one of the two writes
# would be built on a copy read before the other landed and would silently
# drop it — losing a pairing credential means re-pairing the speaker by
# hand, PIN and all.
_lock = threading.Lock()


def _read_file() -> dict[str, str] | None:
    """Parsed contents, `{}` when there's no file yet, or `None` when the
    file exists but can't be read back — three distinct answers on purpose,
    since the write path has to treat the last one very differently from
    the second (see _load_for_update() below)."""
    try:
        with open(_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        logger.warning(f"[credentials] Load failed: {e}")
        return None
    if not isinstance(data, dict):
        logger.warning("[credentials] Load failed: not a JSON object")
        return None
    return data


def _load() -> dict[str, str]:
    """Read side, where an unreadable store is fine to treat as empty — the
    caller ends up asking for a pairing it can no longer prove it has,
    which is the same outcome as never having paired."""
    data = _read_file()
    return {} if data is None else data


def _load_for_update() -> dict[str, str]:
    """Read side of a read-modify-write, which cannot silently start from
    `{}` the way _load() does: the very next _save() would then persist
    that empty document and unpair *every* device, not just lose the read.
    The unreadable copy is kept aside for recovery instead."""
    data = _read_file()
    if data is None:
        logger.error(f"[credentials] Unreadable store, moving aside to {_PATH}.corrupt")
        try:
            os.replace(_PATH, f"{_PATH}.corrupt")
        except OSError as e:
            logger.error(f"[credentials] Could not move it aside: {e}")
        return {}
    return data


def _save(data: dict[str, str]) -> None:
    """Write-to-temp + os.replace(), never a truncate-in-place: this file
    holds *every* paired device's credential, so a write interrupted
    halfway (crash, full disk) would otherwise leave a truncated file that
    reads back as unparseable and take all of them down with it — every
    speaker would have to be paired again by hand. os.replace() is atomic
    on the same filesystem, so a reader sees either the old file or the new
    one, never a half-written one."""
    tmp = f"{_PATH}.tmp"
    try:
        os.makedirs(os.path.dirname(_PATH), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, _PATH)
    except Exception as e:
        logger.error(f"[credentials] Save failed: {e}")
        try:
            os.unlink(tmp)
        except OSError:
            pass


def get(device_name: str) -> str | None:
    with _lock:
        return _load().get(device_name)


def save(device_name: str, credentials: str) -> None:
    with _lock:
        data = _load_for_update()
        data[device_name] = credentials
        _save(data)
    logger.info(f"[credentials] Saved: {device_name}")


def delete(device_name: str) -> bool:
    with _lock:
        data = _load_for_update()
        if device_name not in data:
            return False
        del data[device_name]
        _save(data)
    logger.info(f"[credentials] Deleted: {device_name}")
    return True


def list_paired() -> list[str]:
    with _lock:
        return list(_load().keys())
