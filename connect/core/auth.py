"""core/auth.py - Token-based auth for the Connect API.

The token is not configuration: whatever starts connect hands one over in
CONNECT_INTERNAL_TOKEN (the desktop app, the Docker image's start.sh), and
otherwise connect generates its own and persists it to .connect-token
(gitignored), where `pnpm dev`'s Electron and vite read it. Scripts and
apps of your own use a device key (routes/device_link.py) instead.
"""

import os
import secrets
from pathlib import Path

from fastapi import Header, HTTPException, Query

_TOKEN_FILE = Path(__file__).resolve().parent.parent / ".connect-token"
_HANDOFF_ENV = "CONNECT_INTERNAL_TOKEN"


def _resolve_token() -> str:
    """The launcher's token, then a previously persisted one, then a freshly
    generated and persisted one."""
    handed_over = os.getenv(_HANDOFF_ENV)
    if handed_over:
        return handed_over

    try:
        existing = _TOKEN_FILE.read_text().strip()
        if existing:
            return existing
    except FileNotFoundError:
        pass

    generated = secrets.token_hex(32)
    try:
        _TOKEN_FILE.write_text(generated)
    except OSError:
        pass  # Falls back to a fresh token next restart — not fatal, just loses stability.
    return generated


TOKEN = _resolve_token()


def require_token(
    x_connect_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
) -> None:
    """FastAPI dependency — enforces the Connect API token."""
    provided = x_connect_token or token
    if not provided or not secrets.compare_digest(provided, TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")
