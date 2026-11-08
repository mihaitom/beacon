"""core/play_history.py - when each account listened to what.

The media servers only report a total per song, so anything dated (the Stats
page's listening year, streaks, chart movement) needs a log of our own.

One SQLite file holds every account: `listens` is Beacon's own plays and a
year read once from Last.fm or ListenBrainz, told apart by `source`, and
`accounts` is who they belong to, the import's outcome and the milestones
already celebrated. A listen's id is random rather than a counter, so it still
names the same play on another machine.

The account always comes from the verified session (routes/play_history.py) or
a device key made by that session (routes/device_link.py), never from a
request: this is a dated record of what somebody listened to.
"""

import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from collections import Counter
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from typing import NamedTuple

from core.paths import data_dir
from core.title_match import normalize

logger = logging.getLogger("connect.play_history")

_DIR = os.path.join(data_dir(), "play-history")
_DATABASE = "play-history.db"

# No WAL: there is one writer, a write per song, and data directories on a
# network share, which WAL does not work on.
_SCHEMA = (
    """CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        server_type TEXT NOT NULL,
        server_url TEXT NOT NULL,
        username TEXT NOT NULL,
        import_state TEXT,
        milestones TEXT,
        UNIQUE (server_type, server_url, username)
    )""",
    """CREATE TABLE listens (
        id TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts (id),
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        song_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        artist TEXT NOT NULL DEFAULT '',
        artist_id TEXT NOT NULL DEFAULT '',
        album TEXT NOT NULL DEFAULT '',
        album_id TEXT NOT NULL DEFAULT '',
        cover_art_id TEXT NOT NULL DEFAULT '',
        genre TEXT NOT NULL DEFAULT '',
        duration REAL NOT NULL DEFAULT 0
    )""",
    "CREATE INDEX listens_by_account ON listens (account_id, ts)",
)

_DEVICE_LINK_SCHEMA = (
    # Null until the paired server has acknowledged the row.
    "ALTER TABLE listens ADD COLUMN sent_at INTEGER",
    "CREATE INDEX listens_unsent ON listens (account_id, ts) WHERE sent_at IS NULL",
    # settings_identity is null when the account settings cannot be tied to
    # the verified name (core/device_keys.py).
    """CREATE TABLE device_keys (
        id TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts (id),
        key_hash TEXT NOT NULL,
        label TEXT NOT NULL,
        settings_identity TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
    )""",
    "CREATE INDEX device_keys_by_account ON device_keys (account_id)",
)

_OWN_SOURCE = "beacon"
_TEXT_FIELDS = (
    "song_id",
    "title",
    "artist",
    "artist_id",
    "album",
    "album_id",
    "cover_art_id",
    "genre",
)
_WIRE_FIELDS = ("id", "ts", "duration", *_TEXT_FIELDS)
_FIND_ACCOUNT = "server_type = ? AND server_url = ? AND username = ?"

# Several windows can follow one cast, and each reports the same play. Longer
# than the seconds that separate those reports, shorter than a song played
# twice in a row.
_SAME_PLAY_SECONDS = 60

_TOP_N = 8
_RECENT_DAYS = 30
_DAY_SECONDS = 24 * 60 * 60

_lock = threading.Lock()


class Account(NamedTuple):
    server_type: str
    server_url: str
    username: str


_last_recorded: dict[Account, tuple[str, float]] = {}


def _insert_listens(conn: sqlite3.Connection, account_id: int, listens: Iterable[dict]) -> int:
    """How many were new. An id already stored is the same play sent again."""
    columns = ", ".join(_TEXT_FIELDS)
    marks = ", ".join("?" * (len(_TEXT_FIELDS) + 5))
    return conn.executemany(
        f"INSERT INTO listens (id, account_id, ts, source, duration, {columns}) VALUES ({marks})"
        " ON CONFLICT (id) DO NOTHING",
        (
            (
                entry.get("id") or uuid.uuid4().hex,
                account_id,
                entry["ts"],
                entry.get("source") or _OWN_SOURCE,
                entry.get("duration") or 0,
                *(entry.get(field) or "" for field in _TEXT_FIELDS),
            )
            for entry in listens
        ),
    ).rowcount


def _account_id(conn: sqlite3.Connection, account: Account) -> int:
    conn.execute(
        "INSERT INTO accounts (server_type, server_url, username) VALUES (?, ?, ?)"
        " ON CONFLICT DO NOTHING",
        account,
    )
    return conn.execute(f"SELECT id FROM accounts WHERE {_FIND_ACCOUNT}", account).fetchone()["id"]


def _write_account_field(conn: sqlite3.Connection, account_id: int, field: str, value) -> None:
    """`field` is one of the two JSON columns, never from outside."""
    conn.execute(
        f"UPDATE accounts SET {field} = ? WHERE id = ?",
        (None if value is None else json.dumps(value), account_id),
    )


def _read_account_field(conn: sqlite3.Connection, account: Account, field: str) -> dict | None:
    row = conn.execute(f"SELECT {field} FROM accounts WHERE {_FIND_ACCOUNT}", account).fetchone()
    return None if row is None or row[0] is None else json.loads(row[0])


def _read_old_log(path: str) -> list[dict]:
    """Every readable line. A crash mid-append left at most one broken line,
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
    return listens


def _adopt_old_logs(conn: sqlite3.Connection) -> None:
    """Takes in the per-account folders of plain files that came before this
    database. They stay where they are; nothing reads them after this."""
    for entry in os.scandir(_DIR):
        if not entry.is_dir():
            continue
        try:
            with open(os.path.join(entry.path, "meta.json"), encoding="utf-8") as f:
                meta = json.load(f)
            account = Account(**meta["identity"])
        except (OSError, ValueError, KeyError, TypeError) as e:
            logger.warning(f"[play-history] skipping an old log without an owner: {e!r}")
            continue
        account_id = _account_id(conn, account)
        for name in ("listens.jsonl", "imported.jsonl"):
            _insert_listens(conn, account_id, _read_old_log(os.path.join(entry.path, name)))
        _write_account_field(conn, account_id, "import_state", meta.get("import"))
        _write_account_field(conn, account_id, "milestones", meta.get("milestones"))


def _create_log(conn: sqlite3.Connection) -> None:
    for statement in _SCHEMA:
        conn.execute(statement)
    _adopt_old_logs(conn)


def _add_device_links(conn: sqlite3.Connection) -> None:
    for statement in _DEVICE_LINK_SCHEMA:
        conn.execute(statement)


# PRAGMA user_version counts how many of these have run. Append only.
_MIGRATIONS = (_create_log, _add_device_links)


def _prepare(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version >= len(_MIGRATIONS):
        return
    # One transaction, so an interrupted upgrade simply happens again.
    conn.execute("BEGIN IMMEDIATE")
    for migrate in _MIGRATIONS[version:]:
        migrate(conn)
    conn.execute(f"PRAGMA user_version = {len(_MIGRATIONS)}")
    conn.commit()


@contextmanager
def _database() -> Iterator[sqlite3.Connection]:
    """One transaction: committed at the end, undone by an exception. Only
    under _lock."""
    os.makedirs(_DIR, exist_ok=True)
    conn = sqlite3.connect(os.path.join(_DIR, _DATABASE))
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            _prepare(conn)
            yield conn
    finally:
        conn.close()


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """For the other tables in this database (core/device_keys.py)."""
    with _lock, _database() as conn:
        yield conn


def account_row(conn: sqlite3.Connection, account: Account) -> int:
    """The account's id in this database, created if it is new."""
    return _account_id(conn, account)


def record(account: Account, listen: dict, now: float | None = None) -> bool:
    """Stores one play, stamped here so a wrong client clock cannot damage the
    log. False when it was the same play again or could not be written.
    Never raises: a log that cannot be written is not a reason to fail."""
    now = time.time() if now is None else now
    song_id = listen.get("song_id", "")
    with _lock:
        last = _last_recorded.get(account)
        if last and last[0] == song_id and now - last[1] < _SAME_PLAY_SECONDS:
            return False
        try:
            with _database() as conn:
                entry = {**listen, "ts": int(now), "source": _OWN_SOURCE}
                _insert_listens(conn, _account_id(conn, account), [entry])
        except (OSError, sqlite3.Error) as e:
            logger.warning(f"[play-history] writing a play failed: {e}")
            return False
        _last_recorded[account] = (song_id, now)
    return True


def replace_imported(account: Account, source: str, listens: list[dict]) -> int:
    """Stores an import, keeping only what is older than Beacon's first own
    entry. Decided here, at the moment of writing, so that plays logged while
    the import ran cannot be counted twice. Returns how many were kept."""
    with _lock, _database() as conn:
        account_id = _account_id(conn, account)
        cutoff = conn.execute(
            "SELECT MIN(ts) FROM listens WHERE account_id = ? AND source = ?",
            (account_id, _OWN_SOURCE),
        ).fetchone()[0]
        kept = [entry for entry in listens if cutoff is None or entry["ts"] < cutoff]
        conn.execute(
            "DELETE FROM listens WHERE account_id = ? AND source != ?", (account_id, _OWN_SOURCE)
        )
        _insert_listens(conn, account_id, ({**entry, "source": source} for entry in kept))
        _write_account_field(conn, account_id, "import_state", {"status": "done", "source": source})
        # Forgets what was seen, so the next visit sets a silent baseline: a
        # streak that arrives with a year of old plays is nothing to celebrate.
        _write_account_field(conn, account_id, "milestones", None)
    return len(kept)


def mark_import_failed(account: Account, source: str, error: str) -> None:
    with _lock, _database() as conn:
        state = {"status": "failed", "source": source, "error": error}
        _write_account_field(conn, _account_id(conn, account), "import_state", state)


def import_state(account: Account) -> dict:
    with _lock, _database() as conn:
        state = _read_account_field(conn, account, "import_state")
    return state or {"status": "none"}


def milestones(account: Account) -> dict | None:
    """What has been celebrated so far, None before the first visit."""
    with _lock, _database() as conn:
        return _read_account_field(conn, account, "milestones")


def save_milestones(account: Account, seen: dict) -> None:
    """Merged upwards, so a device with an older view cannot lower them and
    bring a moment back."""
    with _lock, _database() as conn:
        current = _read_account_field(conn, account, "milestones") or {}
        merged = {name: max(value, current.get(name, 0)) for name, value in seen.items()}
        _write_account_field(conn, _account_id(conn, account), "milestones", merged)


def _first_own_play(conn: sqlite3.Connection, account_id: int) -> int | None:
    return conn.execute(
        "SELECT MIN(ts) FROM listens WHERE account_id = ? AND source = ?",
        (account_id, _OWN_SOURCE),
    ).fetchone()[0]


def _is_same_play(conn: sqlite3.Connection, account_id: int, entry: dict) -> bool:
    """One play reported through two paths has two ids, so only song and time
    can tell. Plays without a song id cannot be compared and are kept."""
    if not entry.get("song_id"):
        return False
    return (
        conn.execute(
            "SELECT 1 FROM listens WHERE account_id = ? AND source = ? AND song_id = ?"
            " AND id != ? AND ABS(ts - ?) < ? LIMIT 1",
            (
                account_id,
                _OWN_SOURCE,
                entry["song_id"],
                entry["id"],
                entry["ts"],
                _SAME_PLAY_SECONDS,
            ),
        ).fetchone()
        is not None
    )


def receive_listens(
    account: Account, listens: list[dict], backfill: bool = False, now: float | None = None
) -> int:
    """Stores plays a paired device made, returning how many were new.

    `ts` comes from outside here, unlike record(): it was stamped by the
    device's own connect, and anything further ahead than a day is a broken
    clock rather than a play."""
    now = time.time() if now is None else now
    latest = now + _DAY_SECONDS
    stored = 0
    with _lock, _database() as conn:
        account_id = _account_id(conn, account)
        first_before = _first_own_play(conn, account_id)
        for entry in listens:
            if entry["ts"] > latest or _is_same_play(conn, account_id, entry):
                continue
            stored += _insert_listens(conn, account_id, [{**entry, "source": _OWN_SOURCE}])
        first_after = _first_own_play(conn, account_id)
        if first_after is not None and first_after != first_before:
            # The rule replace_imported() applies: an import only ever covers
            # what is older than Beacon's first own play, and that just moved.
            conn.execute(
                "DELETE FROM listens WHERE account_id = ? AND source != ? AND ts >= ?",
                (account_id, _OWN_SOURCE, first_after),
            )
        if backfill and stored:
            # A desktop's whole past arriving is not a moment either, see
            # replace_imported().
            _write_account_field(conn, account_id, "milestones", None)
    return stored


def unsent_listens(account: Account, limit: int) -> list[dict]:
    """Beacon's own plays the paired server has not acknowledged, oldest
    first. Only this account's: a desktop can have held another login."""
    with _lock, _database() as conn:
        rows = conn.execute(
            "SELECT listens.* FROM listens JOIN accounts ON accounts.id = account_id"
            f" WHERE {_FIND_ACCOUNT} AND source = ? AND sent_at IS NULL ORDER BY ts LIMIT ?",
            (*account, _OWN_SOURCE, limit),
        ).fetchall()
    return [{field: row[field] for field in _WIRE_FIELDS} for row in rows]


def mark_sent(ids: list[str], now: float | None = None) -> None:
    stamp = int(time.time() if now is None else now)
    with _lock, _database() as conn:
        conn.executemany(
            "UPDATE listens SET sent_at = ? WHERE id = ?", ((stamp, id_) for id_ in ids)
        )


def forget_sent(account: Account) -> None:
    """A new pairing may be with a different server. Sending a play again to
    the same one changes nothing, so this needs no way of telling them apart."""
    with _lock, _database() as conn:
        conn.execute(
            "UPDATE listens SET sent_at = NULL WHERE account_id ="
            f" (SELECT id FROM accounts WHERE {_FIND_ACCOUNT})",
            account,
        )


def count_unsent(account: Account) -> int:
    with _lock, _database() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM listens JOIN accounts ON accounts.id = account_id"
            f" WHERE {_FIND_ACCOUNT} AND source = ? AND sent_at IS NULL",
            (*account, _OWN_SOURCE),
        ).fetchone()[0]


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


def _read_listens(account: Account) -> list[dict]:
    """Oldest first. An unreadable database reads as an empty log: a page of
    statistics is no reason to fail."""
    try:
        with _lock, _database() as conn:
            rows = conn.execute(
                "SELECT listens.* FROM listens JOIN accounts ON accounts.id = account_id"
                f" WHERE {_FIND_ACCOUNT} ORDER BY ts",
                account,
            ).fetchall()
    except (OSError, sqlite3.Error) as e:
        logger.warning(f"[play-history] reading the log failed: {e}")
        return []
    return [dict(row) for row in rows]


def summary(account: Account, now: float | None = None) -> dict:
    """Timestamps rather than days: only the browser knows the listener's
    time zone."""
    now = time.time() if now is None else now
    listens = _read_listens(account)
    own = [entry for entry in listens if entry["source"] == _OWN_SOURCE]
    since = now - _RECENT_DAYS * _DAY_SECONDS
    recent = Counter(e["song_id"] for e in own if e["ts"] >= since and e.get("song_id"))
    return {
        "available": True,
        "total": len(listens),
        "timestamps": [e["ts"] for e in listens],
        "live_since": min((e["ts"] for e in own), default=None),
        "recent_plays": dict(recent),
        "top": _charts(listens),
    }


def _merged_top(server: list[dict], unsent: list[dict]) -> list[dict]:
    merged = {item["id"]: dict(item) for item in server}
    for item in unsent:
        if item["id"] in merged:
            merged[item["id"]]["value"] += item["value"]
        else:
            merged[item["id"]] = item
    return sorted(merged.values(), key=lambda item: -item["value"])[:_TOP_N]


def with_unsent(account: Account, server: dict, now: float | None = None) -> dict:
    """The server's summary plus what it has not received yet, so a song just
    played counts at once."""
    now = time.time() if now is None else now
    unsent = unsent_listens(account, limit=-1)
    if not unsent:
        return server
    recent = Counter(server.get("recent_plays") or {})
    since = now - _RECENT_DAYS * _DAY_SECONDS
    recent.update(e["song_id"] for e in unsent if e["ts"] >= since and e.get("song_id"))
    earliest = min(e["ts"] for e in unsent)
    live_since = server.get("live_since")
    charts = _charts([{**entry, "source": _OWN_SOURCE} for entry in unsent])
    top = server.get("top") or {}
    return {
        **server,
        "total": server.get("total", 0) + len(unsent),
        "timestamps": sorted([*server.get("timestamps", []), *(e["ts"] for e in unsent)]),
        "live_since": earliest if live_since is None else min(live_since, earliest),
        "recent_plays": dict(recent),
        "top": {name: _merged_top(top.get(name, []), items) for name, items in charts.items()},
    }
