"""core/auth.py — Token-based auth for the Connect API.

When CONNECT_TOKEN isn't set via the environment (e.g. docker-compose, where
it's genuinely fixed configuration), a random token is generated instead of
falling back to a hardcoded default — a checked-in constant would be public
(open source) and give no real protection. That token is then persisted to
.connect-token (next to this file's package, gitignored, installation-
specific) and reused on subsequent restarts rather than regenerated every
time: Beacon's Electron main process reads the same file (see
src/main/index.ts's readConnectDefaults()) to learn the token without either
side hardcoding or being told the other's secret — the two processes are
started independently (Electron doesn't spawn/manage the Python backend, see
the project plan), so a stable, file-shared secret is what lets them agree
without one being launched from the other.
"""

import os
import secrets
from pathlib import Path

from fastapi import Header, HTTPException, Query

_TOKEN_FILE = Path(__file__).resolve().parent.parent / ".connect-token"


def _resolve_token() -> tuple[str, bool]:
    """Returns (token, was_generated). Precedence: explicit CONNECT_TOKEN env
    var, then a previously-persisted generated token, then a freshly
    generated + persisted one."""
    env_token = os.getenv("CONNECT_TOKEN")
    if env_token:
        return env_token, False

    try:
        existing = _TOKEN_FILE.read_text().strip()
        if existing:
            return existing, True
    except FileNotFoundError:
        pass

    generated = secrets.token_hex(32)
    try:
        _TOKEN_FILE.write_text(generated)
    except OSError:
        pass  # Falls back to a fresh token next restart — not fatal, just loses stability.
    return generated, True


TOKEN, TOKEN_WAS_GENERATED = _resolve_token()


def require_token(
    x_connect_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
) -> None:
    """FastAPI dependency — enforces CONNECT_TOKEN when configured."""
    if not TOKEN:
        return
    provided = x_connect_token or token
    if not provided or not secrets.compare_digest(provided, TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")
