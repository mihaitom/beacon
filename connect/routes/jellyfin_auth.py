"""routes/jellyfin_auth.py — POST /jellyfin/login, Quick Connect

Converts a Jellyfin username/password into an AccessToken + user id via
Jellyfin's own /Users/AuthenticateByName, so the frontend can then call
POST /config exactly like it already does for Subsonic (see
routes/devices.py's ConfigRequest.credential, which expects an
already-resolved token for both server types, not a raw password).
Session-less, like /config's own first call — there's no session to attach
this to yet.

Quick Connect is an alternate login path: /jellyfin/quickconnect/initiate
starts a request and returns a short code the user approves on another
already-authenticated device (or Jellyfin's own web UI); the frontend then
polls /jellyfin/quickconnect/connect with the returned secret until it
reports authenticated=true, at which point that same call has already
exchanged the secret for a real token — no separate exchange step needed.
"""

import asyncio
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.auth import require_token
from media.jellyfin import (
    authenticate_by_name,
    authenticate_with_quick_connect,
    check_quick_connect_authenticated,
    initiate_quick_connect,
)

logger = logging.getLogger("connect.jellyfin_auth")
router = APIRouter(dependencies=[Depends(require_token)])


class JellyfinLoginRequest(BaseModel):
    url: str
    username: str
    password: str


@router.post("/jellyfin/login")
async def jellyfin_login(req: JellyfinLoginRequest):
    try:
        return await asyncio.to_thread(
            authenticate_by_name, req.url, req.username, req.password
        )
    except httpx.HTTPStatusError as e:
        logger.warning(f"[jellyfin-login] {req.url} rejected credentials: {e}")
        raise HTTPException(
            status_code=401, detail="Jellyfin rejected the supplied credentials"
        ) from e
    except Exception as e:
        logger.warning(f"[jellyfin-login] {req.url} unreachable: {e}")
        raise HTTPException(
            status_code=502, detail=f"Jellyfin not reachable: {e}"
        ) from e


class JellyfinQuickConnectInitiateRequest(BaseModel):
    url: str


@router.post("/jellyfin/quickconnect/initiate")
async def jellyfin_quickconnect_initiate(req: JellyfinQuickConnectInitiateRequest):
    try:
        return await asyncio.to_thread(initiate_quick_connect, req.url)
    except httpx.HTTPStatusError as e:
        logger.warning(f"[jellyfin-quickconnect] {req.url} initiate rejected: {e}")
        raise HTTPException(
            status_code=400,
            detail="Jellyfin rejected the Quick Connect request — is it enabled on the server?",
        ) from e
    except Exception as e:
        logger.warning(f"[jellyfin-quickconnect] {req.url} unreachable: {e}")
        raise HTTPException(
            status_code=502, detail=f"Jellyfin not reachable: {e}"
        ) from e


class JellyfinQuickConnectConnectRequest(BaseModel):
    url: str
    secret: str


@router.post("/jellyfin/quickconnect/connect")
async def jellyfin_quickconnect_connect(req: JellyfinQuickConnectConnectRequest):
    """Polled by the login screen every couple of seconds. Returns
    {"authenticated": false} while the user hasn't approved the request on
    another device yet — once they have, this same call also does the
    secret→token exchange and returns {"authenticated": true, token,
    user_id, username} in one step, so the frontend never needs a third
    endpoint."""
    try:
        authenticated = await asyncio.to_thread(
            check_quick_connect_authenticated, req.url, req.secret
        )
    except Exception as e:
        logger.warning(f"[jellyfin-quickconnect] {req.url} status check failed: {e}")
        raise HTTPException(
            status_code=502, detail=f"Jellyfin not reachable: {e}"
        ) from e

    if not authenticated:
        return {"authenticated": False}

    try:
        result = await asyncio.to_thread(
            authenticate_with_quick_connect, req.url, req.secret
        )
    except httpx.HTTPStatusError as e:
        logger.warning(f"[jellyfin-quickconnect] {req.url} exchange rejected: {e}")
        raise HTTPException(
            status_code=401, detail="Jellyfin rejected the Quick Connect exchange"
        ) from e
    return {"authenticated": True, **result}
