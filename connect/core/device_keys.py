"""core/device_keys.py - the keys a Beacon server gives out to paired desktops.

A desktop app has its own connect and its own login, so a server cannot tell
from a request whose desktop is calling. A key answers that: a listener makes
one while signed in on the server, and it speaks for that one account from
then on, whichever address the desktop reaches the media server by.

The key is `<id>.<secret>`: the id finds the row, so the secret's hash is the
only thing compared, and in constant time. Only the hash is stored.

The account settings are filed under a different identity from the play
history (see SessionState.settings_identity). That one is partly what the
renderer claimed, so it is only kept when its name is the verified one: a key
outlives the session that made it, and must not reach further than it did.
"""

import hashlib
import json
import secrets
import time
import uuid
from typing import NamedTuple

from core import play_history
from core.play_history import Account

# More devices than anyone has; the bound is against a runaway script.
MAX_KEYS_PER_ACCOUNT = 20

# last_used_at is shown in days and hours. Without this, every request would
# be a database write.
_LAST_USED_RESOLUTION_SECONDS = 60

_NO_SUCH_KEY_HASH = hashlib.sha256(b"").hexdigest()


class TooManyKeys(Exception):
    pass


class KeyOwner(NamedTuple):
    key_id: str
    account: Account
    settings_identity: tuple[str, str, str] | None


def settings_identity_of(session) -> tuple[str, str, str] | None:
    """The session's settings identity, if its name is the verified one.
    Compared without case: a Subsonic login is not case sensitive."""
    identity = session.settings_identity
    if not identity or identity[2].casefold() != session.account_username.casefold():
        return None
    return identity


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def create(
    account: Account,
    label: str,
    settings_identity: tuple[str, str, str] | None,
    now: float | None = None,
) -> dict:
    """The only time the key itself exists outside the device it goes to."""
    created_at = int(time.time() if now is None else now)
    key_id = uuid.uuid4().hex
    secret = secrets.token_urlsafe(32)
    with play_history.transaction() as conn:
        account_id = play_history.account_row(conn, account)
        count = conn.execute(
            "SELECT COUNT(*) FROM device_keys WHERE account_id = ?", (account_id,)
        ).fetchone()[0]
        if count >= MAX_KEYS_PER_ACCOUNT:
            raise TooManyKeys
        conn.execute(
            "INSERT INTO device_keys"
            " (id, account_id, key_hash, label, settings_identity, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                key_id,
                account_id,
                _hash(secret),
                label,
                None if settings_identity is None else json.dumps(settings_identity),
                created_at,
            ),
        )
    return {"id": key_id, "key": f"{key_id}.{secret}", "label": label, "created_at": created_at}


def list_keys(account: Account) -> list[dict]:
    with play_history.transaction() as conn:
        rows = conn.execute(
            "SELECT device_keys.id, label, created_at, last_used_at FROM device_keys"
            " JOIN accounts ON accounts.id = account_id"
            " WHERE server_type = ? AND server_url = ? AND username = ?"
            " ORDER BY created_at",
            account,
        ).fetchall()
    return [dict(row) for row in rows]


def revoke(account: Account, key_id: str) -> bool:
    """False when this account has no such key, somebody else's included."""
    with play_history.transaction() as conn:
        cursor = conn.execute(
            "DELETE FROM device_keys WHERE id = ? AND account_id ="
            " (SELECT id FROM accounts WHERE server_type = ? AND server_url = ? AND username = ?)",
            (key_id, *account),
        )
        return cursor.rowcount > 0


def resolve(presented: str, now: float | None = None) -> KeyOwner | None:
    """Whose key this is, or None for one that is wrong or revoked."""
    key_id, _, secret = presented.partition(".")
    stamp = int(time.time() if now is None else now)
    with play_history.transaction() as conn:
        row = conn.execute(
            "SELECT device_keys.*, server_type, server_url, username FROM device_keys"
            " JOIN accounts ON accounts.id = account_id WHERE device_keys.id = ?",
            (key_id,),
        ).fetchone()
        stored = row["key_hash"] if row else _NO_SUCH_KEY_HASH
        if not secrets.compare_digest(_hash(secret), stored) or row is None:
            return None
        last_used = row["last_used_at"]
        if last_used is None or stamp - last_used >= _LAST_USED_RESOLUTION_SECONDS:
            conn.execute("UPDATE device_keys SET last_used_at = ? WHERE id = ?", (stamp, key_id))
    identity = row["settings_identity"]
    return KeyOwner(
        key_id,
        Account(row["server_type"], row["server_url"], row["username"]),
        None if identity is None else tuple(json.loads(identity)),
    )
