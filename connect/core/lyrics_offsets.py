"""core/lyrics_offsets.py - the timing corrections a listener made per song.

Kept per song rather than as one list in the account settings: those are
written whole, so a device holding an older copy would take back a correction
made elsewhere in the meantime. A correction is an hour's handwork spread over
months, and this is what keeps it.

Lives in the play-history database for the sake of its `accounts`.
"""

from core import play_history
from core.play_history import Account

# Far beyond anybody's handwork; the bound is against a runaway script on a
# route a device key can reach.
MAX_PER_ACCOUNT = 20_000


def load(account: Account) -> dict[str, float]:
    """Every song this account ever corrected. Zero is a correction taken
    back, not an absence: a device still holding the old value needs to hear
    it."""
    with play_history.transaction() as conn:
        rows = conn.execute(
            "SELECT song_id, seconds FROM lyrics_offsets"
            " JOIN accounts ON accounts.id = account_id"
            " WHERE server_type = ? AND server_url = ? AND username = ?",
            account,
        ).fetchall()
    return {row["song_id"]: row["seconds"] for row in rows}


def offset_of(account: Account, song_id: str) -> float:
    with play_history.transaction() as conn:
        row = conn.execute(
            "SELECT seconds FROM lyrics_offsets"
            " JOIN accounts ON accounts.id = account_id"
            " WHERE server_type = ? AND server_url = ? AND username = ? AND song_id = ?",
            (*account, song_id),
        ).fetchone()
    return row["seconds"] if row else 0.0


def save(account: Account, offsets: dict[str, float]) -> None:
    with play_history.transaction() as conn:
        account_id = play_history.account_row(conn, account)
        count = conn.execute(
            "SELECT COUNT(*) FROM lyrics_offsets WHERE account_id = ?", (account_id,)
        ).fetchone()[0]
        for song_id, seconds in offsets.items():
            changed = conn.execute(
                "UPDATE lyrics_offsets SET seconds = ? WHERE account_id = ? AND song_id = ?",
                (seconds, account_id, song_id),
            ).rowcount
            if changed or count >= MAX_PER_ACCOUNT:
                continue
            conn.execute(
                "INSERT INTO lyrics_offsets (account_id, song_id, seconds) VALUES (?, ?, ?)",
                (account_id, song_id, seconds),
            )
            count += 1
