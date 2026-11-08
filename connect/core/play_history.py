"""core/play_history.py - when each account listened to what.

The media servers only report a total per song, so anything dated (the Stats
page's listening year, streaks, chart movement) needs a log of our own.

One directory per account, addressed by the same hash as
core/account_settings.py:

  listens.jsonl   Beacon's own plays, appended one line at a time
  imported.jsonl  a year read once from Last.fm or ListenBrainz, always
                  written whole, so a failed import leaves nothing behind
  meta.json       who the directory belongs to, the import's outcome, and the
                  milestones already celebrated

The account always comes from the verified session (routes/play_history.py),
never from a request: this is a dated record of what somebody listened to.
"""

import hashlib
import json
import logging
import os
import threading
import time
from collections import Counter
from typing import NamedTuple

from core.paths import data_dir
from core.title_match import normalize

logger = logging.getLogger("connect.play_history")

_DIR = os.path.join(data_dir(), "play-history")

# Several windows can follow one cast, and each reports the same play. Longer
# than the seconds that separate those reports, shorter than a song played
# twice in a row.
_SAME_PLAY_SECONDS = 60

_TOP_N = 8
_RECENT_DAYS = 30
_DAY_SECONDS = 24 * 60 * 60

_lock = threading.Lock()
_last_recorded: dict[str, tuple[str, float]] = {}


class Account(NamedTuple):
    server_type: str
    server_url: str
    username: str


def _key(account: Account) -> str:
    raw = f"{account.server_type}|{account.server_url}|{account.username}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _path(account: Account, name: str) -> str:
    return os.path.join(_DIR, _key(account), name)


def _read_listens(path: str) -> list[dict]:
    """Every readable line. A crash mid-append leaves at most one broken line,
    which must not cost the rest of the log."""
    listens = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict) and isinstance(entry.get("ts"), int):
                    listens.append(entry)
    except FileNotFoundError:
        pass
    except OSError as e:
        logger.warning(f"[play-history] reading {os.path.basename(path)} failed: {e}")
    return listens


def _read_meta(account: Account) -> dict:
    try:
        with open(_path(account, "meta.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _replace(path: str, write) -> None:
    """Through a temporary file and a rename, so a reader only ever sees a
    whole file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        write(f)
    os.replace(tmp, path)


def _update_meta(account: Account, **fields) -> None:
    meta = _read_meta(account)
    meta["identity"] = account._asdict()
    meta.update(fields)
    _replace(_path(account, "meta.json"), lambda f: json.dump(meta, f, indent=2))


def record(account: Account, listen: dict, now: float | None = None) -> bool:
    """Appends one play, stamped here so a wrong client clock cannot damage
    the log. False when it was the same play again or could not be written.
    Never raises: a log that cannot be written is not a reason to fail."""
    now = time.time() if now is None else now
    key = _key(account)
    song_id = listen.get("song_id", "")
    with _lock:
        last = _last_recorded.get(key)
        if last and last[0] == song_id and now - last[1] < _SAME_PLAY_SECONDS:
            return False
        entry = {"ts": int(now), "source": "beacon", **listen}
        path = _path(account, "listens.jsonl")
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
            if not os.path.exists(_path(account, "meta.json")):
                _update_meta(account)
        except OSError as e:
            logger.warning(f"[play-history] appending failed: {e}")
            return False
        _last_recorded[key] = (song_id, now)
    return True


def replace_imported(account: Account, source: str, listens: list[dict]) -> int:
    """Stores an import, keeping only what is older than Beacon's first own
    entry. Decided here, at the moment of writing, so that plays logged while
    the import ran cannot be counted twice. Returns how many were kept."""
    with _lock:
        own = _read_listens(_path(account, "listens.jsonl"))
        cutoff = min((entry["ts"] for entry in own), default=None)
        kept = sorted(
            (entry for entry in listens if cutoff is None or entry["ts"] < cutoff),
            key=lambda entry: entry["ts"],
        )
        _replace(
            _path(account, "imported.jsonl"),
            lambda f: f.writelines(
                json.dumps({**entry, "source": source}) + "\n" for entry in kept
            ),
        )
        # Forgets what was seen, so the next visit sets a silent baseline: a
        # streak that arrives with a year of old plays is nothing to celebrate.
        _update_meta(
            account, **{"import": {"status": "done", "source": source}, "milestones": None}
        )
    return len(kept)


def mark_import_failed(account: Account, source: str, error: str) -> None:
    with _lock:
        _update_meta(account, **{"import": {"status": "failed", "source": source, "error": error}})


def import_state(account: Account) -> dict:
    with _lock:
        state = _read_meta(account).get("import")
    return state if isinstance(state, dict) else {"status": "none"}


def milestones(account: Account) -> dict | None:
    """What has been celebrated so far, None before the first visit."""
    with _lock:
        seen = _read_meta(account).get("milestones")
    return seen if isinstance(seen, dict) else None


def save_milestones(account: Account, seen: dict) -> None:
    """Merged upwards, so a device with an older view cannot lower them and
    bring a moment back."""
    with _lock:
        current = _read_meta(account).get("milestones")
        current = current if isinstance(current, dict) else {}
        merged = {name: max(value, current.get(name, 0)) for name, value in seen.items()}
        _update_meta(account, milestones=merged)


def _name_key(value: str) -> str:
    return normalize(value) or value.casefold().strip()


def _top(listens: list[dict], key_of, describe) -> list[dict]:
    """The most played groups. The newest entry describes a group, and only
    Beacon's own entries carry ids, so a group is described by one of those
    wherever it has one."""
    counts: Counter[str] = Counter()
    described: dict[str, dict] = {}
    for entry in listens:
        key = key_of(entry)
        if not key:
            continue
        counts[key] += 1
        if key not in described or entry.get("source") == "beacon":
            described[key] = entry
    return [
        {"id": key, "value": value, **describe(described[key])}
        for key, value in counts.most_common(_TOP_N)
    ]


def _charts(listens: list[dict]) -> dict:
    def pair(entry: dict, field: str) -> str | None:
        name = entry.get(field) or ""
        artist = entry.get("artist") or ""
        return f"{_name_key(artist)}|{_name_key(name)}" if name and artist else None

    return {
        "songs": _top(
            listens,
            lambda e: pair(e, "title"),
            lambda e: {
                "label": e.get("title", ""),
                "sublabel": e.get("artist", ""),
                "album_id": e.get("album_id", ""),
                "cover_art_id": e.get("cover_art_id", ""),
            },
        ),
        "artists": _top(
            listens,
            lambda e: _name_key(e.get("artist") or ""),
            lambda e: {"label": e.get("artist", ""), "artist_id": e.get("artist_id", "")},
        ),
        "albums": _top(
            listens,
            lambda e: pair(e, "album"),
            lambda e: {
                "label": e.get("album", ""),
                "sublabel": e.get("artist", ""),
                "album_id": e.get("album_id", ""),
                "cover_art_id": e.get("cover_art_id", ""),
            },
        ),
        "genres": _top(
            listens,
            lambda e: _name_key(e.get("genre") or ""),
            lambda e: {"label": e.get("genre", "")},
        ),
    }


def summary(account: Account, now: float | None = None) -> dict:
    """Timestamps rather than days: only the browser knows the listener's
    time zone."""
    now = time.time() if now is None else now
    with _lock:
        own = _read_listens(_path(account, "listens.jsonl"))
        imported = _read_listens(_path(account, "imported.jsonl"))
    listens = own + imported
    since = now - _RECENT_DAYS * _DAY_SECONDS
    recent = Counter(e["song_id"] for e in own if e["ts"] >= since and e.get("song_id"))
    return {
        "available": True,
        "total": len(listens),
        "timestamps": sorted(e["ts"] for e in listens),
        "live_since": min((e["ts"] for e in own), default=None),
        "recent_plays": dict(recent),
        "top": _charts(listens),
    }
