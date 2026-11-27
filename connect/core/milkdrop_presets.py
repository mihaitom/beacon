"""core/milkdrop_presets.py - the Milkdrop presets a listener uploaded.

Stored already converted, as the JSON Butterchurn loads: the conversion from
a .milk file happens in the browser (see the renderer's
services/milkdrop/convert.ts), and storing its result means no device has to
do it again.

One row per preset, each stamped with when it last changed, and a deleted one
stays as a row without a preset: a paired desktop and its server
(core/server_link.py) exchange rows, the newer one winning, and a deletion
has to travel like any other change.

Lives in the play-history database for the sake of its `accounts`.
"""

import json
import time

from core import play_history
from core.play_history import Account

# Far beyond any collection somebody would curate by hand; the bound is
# against a runaway script on a route a device key can reach.
MAX_PER_ACCOUNT = 2_000
# The largest preset in Butterchurn's own packs is about 60 KB converted.
MAX_PRESET_BYTES = 512_000
MAX_NAME_LENGTH = 200


def index(account: Account) -> list[dict]:
    """Every preset this account has, deleted ones included, without their
    contents - enough to list them and to see which side is newer."""
    with play_history.transaction() as conn:
        rows = conn.execute(
            "SELECT preset_id, name, updated_at, preset IS NULL AS deleted"
            " FROM milkdrop_presets JOIN accounts ON accounts.id = account_id"
            " WHERE server_type = ? AND server_url = ? AND username = ?"
            " ORDER BY name COLLATE NOCASE",
            account,
        ).fetchall()
    return [
        {
            "id": row["preset_id"],
            "name": row["name"],
            "updated_at": row["updated_at"],
            "deleted": bool(row["deleted"]),
        }
        for row in rows
    ]


def rows(account: Account, preset_ids: list[str]) -> list[dict]:
    """Whole rows, as they travel between devices: `preset` is None for a
    deleted one."""
    if not preset_ids:
        return []
    marks = ",".join("?" * len(preset_ids))
    with play_history.transaction() as conn:
        found = conn.execute(
            "SELECT preset_id, name, preset, updated_at"
            " FROM milkdrop_presets JOIN accounts ON accounts.id = account_id"
            " WHERE server_type = ? AND server_url = ? AND username = ?"
            f" AND preset_id IN ({marks})",
            (*account, *preset_ids),
        ).fetchall()
    return [
        {
            "id": row["preset_id"],
            "name": row["name"],
            "preset": json.loads(row["preset"]) if row["preset"] is not None else None,
            "updated_at": row["updated_at"],
        }
        for row in found
    ]


def get(account: Account, preset_id: str) -> dict | None:
    """One preset to show, or None when there is none (or it was deleted)."""
    found = rows(account, [preset_id])
    if not found or found[0]["preset"] is None:
        return None
    return found[0]


def merge(account: Account, incoming: list[dict]) -> list[str]:
    """Takes each row that is newer than what is here, or new. A new preset
    past MAX_PER_ACCOUNT is left out; a change to one already here never is.
    Returns the ids that were taken."""
    taken: list[str] = []
    with play_history.transaction() as conn:
        account_id = play_history.account_row(conn, account)
        count = conn.execute(
            "SELECT COUNT(*) FROM milkdrop_presets WHERE account_id = ?", (account_id,)
        ).fetchone()[0]
        for row in incoming:
            preset = json.dumps(row["preset"]) if row["preset"] is not None else None
            current = conn.execute(
                "SELECT updated_at FROM milkdrop_presets WHERE account_id = ? AND preset_id = ?",
                (account_id, row["id"]),
            ).fetchone()
            if current is not None:
                if current["updated_at"] >= row["updated_at"]:
                    continue
                conn.execute(
                    "UPDATE milkdrop_presets SET name = ?, preset = ?, updated_at = ?"
                    " WHERE account_id = ? AND preset_id = ?",
                    (row["name"], preset, row["updated_at"], account_id, row["id"]),
                )
            else:
                if count >= MAX_PER_ACCOUNT:
                    continue
                conn.execute(
                    "INSERT INTO milkdrop_presets (account_id, preset_id, name, preset, updated_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (account_id, row["id"], row["name"], preset, row["updated_at"]),
                )
                count += 1
            taken.append(row["id"])
    return taken


def put(account: Account, preset_id: str, name: str, preset: dict | None) -> bool:
    """A change made here, now - an upload, or with `preset` None a
    deletion. False when it was not taken (the account is full)."""
    # Never behind a stamp already stored: a clock set back would otherwise
    # make this change lose to the one it replaces.
    existing = rows(account, [preset_id])
    stamp = time.time()
    if existing:
        stamp = max(stamp, existing[0]["updated_at"] + 0.001)
    row = {"id": preset_id, "name": name, "preset": preset, "updated_at": stamp}
    return merge(account, [row]) == [preset_id]
