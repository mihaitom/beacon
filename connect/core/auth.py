"""core/auth.py - Token-based auth for the Connect API.

Without CONNECT_TOKEN in the environment a random token is generated - a
checked-in default would be public. It is persisted to .connect-token
(gitignored) so it survives restarts: in `pnpm dev` connect is started on its
own, and Electron's readConnectDefaults() (src/main/index.ts) learns the
token from that file.
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
