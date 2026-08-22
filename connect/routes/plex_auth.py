"""routes/plex_auth.py — POST /plex/pin/initiate, /plex/pin/check, /plex/resources

Plex authenticates an *account* via plex.tv, not a per-server URL+password
like Subsonic/Jellyfin (see media/plex.py's module docstring) — this is a
three-step exchange instead of jellyfin_auth.py's one/two:

1. /plex/pin/initiate creates a PIN and returns an app.plex.tv/auth link
   the frontend opens in the system browser (see ServerLoginView.vue).
2. /plex/pin/check is polled until the user approves it there — once
   approved, the response carries the Plex *account* token (not yet a
   server-scoped one).
3. /plex/resources (given that account token) lists the Plex Media
   Servers this account can reach, each with its own server-scoped
   accessToken — the frontend picks one and sends *that* token to /config,
   same as it already does for Jellyfin's AccessToken.

Session-less, like jellyfin_auth.py's routes — there's no session to
attach any of this to yet.
"""

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.auth import require_token
from media.plex import (
    check_pin,
    client_identifier,
    create_pin,
    get_account_username,
    list_resources,
)

logger = logging.getLogger("connect.plex_auth")
router = APIRouter(dependencies=[Depends(require_token)])


@router.post("/plex/pin/initiate")
async def plex_pin_initiate():
    try:
        pin = create_pin()
    except Exception as e:
        logger.warning(f"[plex-pin] initiate failed: {e}")
        raise HTTPException(status_code=502, detail=f"Plex request failed: {e}") from e

    auth_url = (
        "https://app.plex.tv/auth#?"
        f"clientID={client_identifier()}&code={pin['code']}"
        "&context[device][product]=Beacon"
    )
    return {"id": pin["id"], "code": pin["code"], "auth_url": auth_url}


class PlexPinCheckRequest(BaseModel):
    id: int


@router.post("/plex/pin/check")
async def plex_pin_check(req: PlexPinCheckRequest):
    """Polled by the login screen every couple of seconds. Returns
    {"authenticated": false} while the user hasn't approved the PIN in the
    browser tab yet."""
    try:
        token = check_pin(req.id)
    except Exception as e:
        logger.warning(f"[plex-pin] check failed: {e}")
        raise HTTPException(status_code=502, detail=f"Plex request failed: {e}") from e

    if not token:
        return {"authenticated": False}

    # Best-effort only — SettingsView.vue's account strip showing a blank
    # username line is a cosmetic gap, not a reason to fail an otherwise-
    # successful login.
    try:
        username = get_account_username(token)
    except Exception as e:
        logger.warning(f"[plex-pin] account username lookup failed: {e}")
        username = ""
    return {"authenticated": True, "account_token": token, "username": username}


class PlexResourcesRequest(BaseModel):
    account_token: str


@router.post("/plex/resources")
async def plex_resources(req: PlexResourcesRequest):
    try:
        servers = list_resources(req.account_token)
    except httpx.HTTPStatusError as e:
        logger.warning(f"[plex-resources] rejected: {e}")
        raise HTTPException(
            status_code=401, detail="Plex rejected the supplied account token"
        ) from e
    except Exception as e:
        logger.warning(f"[plex-resources] failed: {e}")
        raise HTTPException(status_code=502, detail=f"Plex request failed: {e}") from e
    return {"servers": servers}
