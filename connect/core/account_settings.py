"""core/account_settings.py — settings that follow the *person*, not the
device: language, personalized-recommendations opt-in, enabled lyrics
providers, autoplay batch size. See TODO.md's account-vs-device settings
item — device-local settings (audio quality, caches, the playback resume
snapshot, ...) already live in the renderer's own localStorage, namespaced
per account there (services/accountKey.ts) so different accounts sharing
one device/browser don't leak into each other. These four are different:
the same person switching devices should see their own choice follow them,
which needs a server-side store connect didn't have before.

connect has no account-identity concept otherwise — require_token only
checks the instance-wide CONNECT_TOKEN. The (server_type, server_url,
username) triple below is not a credential, just a partition key: the
actual security boundary is still CONNECT_TOKEN, gating routes/
account_settings.py exactly like every other machine-to-machine endpoint
here.

Same "one JSON file, keyed by identifier" convention as delivery/
credentials.py (there: device_name -> pairing credential; here: account
hash -> settings dict), persisted the same CONNECT_DATA_DIR way.
"""

import hashlib
import json
import logging
import os
import threading

logger = logging.getLogger("connect.account_settings")

_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_PATH = os.path.join(_DATA_DIR, "account_settings.json")

# save() is read-modify-write over a file shared by every account, and two
# devices belonging to the same person routinely push at the same moment
# (both come out of the same login). Without this, the later write would be
# built on a copy read before the earlier one landed and would silently
# drop it. Routes are sync `def` handlers (see routes/account_settings.py),
# so this is contended by threadpool workers, not coroutines — a plain
# threading.Lock is the right primitive.
_lock = threading.Lock()


def _account_key(server_type: str, server_url: str, username: str) -> str:
    # Not reversible on purpose — nothing here needs to read a username back
    # out of the key, only to land the same account on the same entry every
    # time. Same shape (server_type|server_url|username) as the renderer's
    # own accountKey.ts, hashed because this becomes a JSON *object key*
    # rather than a filename (accountKey.ts's own reason for hashing
    # doesn't apply here, but there's no reason for the two to disagree on
    # what identifies an account either).
    raw = f"{server_type}|{server_url}|{username}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _read_file() -> dict[str, dict] | None:
    """Parsed contents, `{}` when there's no file yet, or `None` when the
    file exists but can't be read back — three distinct answers on purpose,
    since save() has to treat the last one very differently from the
    second (see its own comment)."""
    try:
        with open(_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        logger.warning(f"[account-settings] Load failed: {e}")
        return None
    if not isinstance(data, dict):
        logger.warning("[account-settings] Load failed: not a JSON object")
        return None
    return data


def _load_all() -> dict[str, dict]:
    """Read side, where an unreadable store is fine to treat as empty — the
    caller keeps using its own local value, exactly as it would for an
    account that has simply never synced."""
    data = _read_file()
    return {} if data is None else data


def _save_all(data: dict[str, dict]) -> None:
    """Write-to-temp + os.replace(), never a truncate-in-place: this file
    holds *every* account's settings, so a write interrupted halfway
    (crash, full disk) would otherwise leave a truncated file that reads
    back as unparseable and takes all of them down with it. os.replace()
    is atomic on the same filesystem, so a reader sees either the old file
    or the new one, never a half-written one."""
    tmp = f"{_PATH}.tmp"
    try:
        os.makedirs(os.path.dirname(_PATH), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, _PATH)
    except Exception as e:
        logger.error(f"[account-settings] Save failed: {e}")
        try:
            os.unlink(tmp)
        except OSError:
            pass


def load(server_type: str, server_url: str, username: str) -> dict:
    """Whatever's been synced for this account so far — `{}` for an account
    that has never pushed anything (not an error; the caller's own local
    value is what a phone/desktop that's never synced should keep using)."""
    key = _account_key(server_type, server_url, username)
    with _lock:
        entry = _load_all().get(key, {})
    # Never hand back the raw identity fields stashed alongside the
    # settings below — only the settings themselves are this call's answer.
    return {k: v for k, v in entry.items() if k != "identity"}


def save(server_type: str, server_url: str, username: str, patch: dict) -> dict:
    """Merges `patch` into whatever's already stored for this account (a
    POST that only names one changed field must not clobber the others —
    same reasoning as the renderer's own setters, which each only touch
    their own key) and returns the merged settings."""
    key = _account_key(server_type, server_url, username)
    with _lock:
        data = _read_file()
        if data is None:
            # Existing file, unreadable. Starting from `{}` here would hand
            # the next _save_all() an empty document and wipe every *other*
            # account's settings along with this one's, so keep the
            # unreadable copy aside for recovery instead of overwriting it.
            logger.error(f"[account-settings] Unreadable store, moving aside to {_PATH}.corrupt")
            try:
                os.replace(_PATH, f"{_PATH}.corrupt")
            except OSError as e:
                logger.error(f"[account-settings] Could not move it aside: {e}")
            data = {}
        entry = data.get(key, {})
        settings = {k: v for k, v in entry.items() if k != "identity"}
        settings.update(patch)
        data[key] = {
            # Kept purely for debuggability (inspecting account_settings.json
            # by hand) — load()/save() themselves never read this back.
            "identity": {
                "server_type": server_type,
                "server_url": server_url,
                "username": username,
            },
            **settings,
        }
        _save_all(data)
    logger.info(f"[account-settings] Saved for {server_type}:{username}: {list(patch.keys())}")
    return settings
