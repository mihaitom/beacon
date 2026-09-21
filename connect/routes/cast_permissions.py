"""routes/cast_permissions.py — the admin's allow-list of accounts that may
cast to LAN devices on this deployment.

Server-scoped and admin-only. The server identity is taken from the
session (the one /config verified), never from query parameters — that is
the whole reason this is not a route in routes/account_settings.py, which
takes its identity from the caller and would let anyone grant themselves
permission. See core/cast_permissions.py and docs/cast-permissions.md.
"""

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core import cast_permissions
from core.auth import require_token
from core.session import SessionState, require_authenticated_session
from media import jellyfin_bridge

logger = logging.getLogger("connect.cast_permissions")
router = APIRouter(prefix="/cast-permissions", dependencies=[Depends(require_token)])

# Only these servers can offer an account list for the admin UI (see
# docs/cast-permissions.md). Plex has no server-side user list and cannot
# even resolve the casting account's name, so a rule there would match on
# something unverified.
_SUPPORTED_SERVER_TYPES = ("subsonic", "jellyfin")


def _require_admin(session: SessionState) -> None:
    """403 unless this session is a verified admin of a supported server.
    The frontend hides the section for everyone else; this is the actual
    gate."""
    if session.account_server_type not in _SUPPORTED_SERVER_TYPES:
        raise HTTPException(
            status_code=403,
            detail="Cast permissions are not available for this server type",
        )
    if not session.account_is_admin:
        raise HTTPException(status_code=403, detail="Server administrator rights required")


def _dedupe(names: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for name in names:
        key = name.casefold()
        if name and key not in seen:
            seen.add(key)
            out.append(name)
    return out


async def _suggested_accounts(session: SessionState) -> tuple[list[str], bool]:
    """(suggestions, lists_users) for the account picker.

    The suggestions always include every account that has ever authenticated
    against this server through this Beacon (core/cast_permissions.py's
    known_accounts, recorded in /config), which is the only list that works
    across server types: no provider Beacon speaks to can be enumerated
    uniformly.

    On top of that, the media server is asked for its own account list where
    it will actually answer. Jellyfin's `/Users` returns every account. A
    Subsonic-compatible server is asked too, since the OpenSubsonic spec
    says an admin's `getUsers.view` returns every user — but Navidrome
    answers with the calling user alone (verified v0.50 through master),
    indistinguishable from a genuine one-account server, so a single result
    is treated as "no usable list". `lists_users` says whether the server
    itself offered a full list; the frontend uses it to explain why an
    account that has never signed in may be missing.
    """
    names = await asyncio.to_thread(
        cast_permissions.known_accounts,
        session.account_server_type,
        session.account_server_url,
    )
    lists_users = False
    if session.account_server_type == "jellyfin":
        try:
            data = await jellyfin_bridge.get_users({}, session.media)
            names += [
                user["username"]
                for user in data.get("users", {}).get("user", [])
                if user.get("username")
            ]
            lists_users = True
        except Exception as e:
            # A non-admin would not reach here (see _require_admin), but a
            # transient failure must still leave the section usable.
            logger.warning(f"[cast-permissions] Could not list Jellyfin users: {e}")
    else:
        get_users = getattr(session.media, "get_users", None)
        if get_users is not None:
            try:
                users = await asyncio.to_thread(get_users)
                names += [user["username"] for user in users if user.get("username")]
                lists_users = len(users) > 1
            except Exception as e:
                logger.warning(f"[cast-permissions] Could not list server users: {e}")
    return _dedupe(names), lists_users


class CastPermissionsUpdate(BaseModel):
    accounts: list[str]
    mode: Literal["allowlist", "blocklist"] = "allowlist"
    default_allow: bool = False


@router.get("")
async def get_cast_permissions(session: SessionState = Depends(require_authenticated_session)):
    _require_admin(session)
    accounts = await asyncio.to_thread(
        cast_permissions.allowed_accounts,
        session.account_server_type,
        session.account_server_url,
    )
    current = await asyncio.to_thread(
        cast_permissions.policy,
        session.account_server_type,
        session.account_server_url,
    )
    # Never configured: everyone may cast. Reported as the allowlist with
    # unlisted accounts allowed, which is the same statement and saves back
    # unchanged if the admin touches nothing.
    mode, default_allow = current if current is not None else ("allowlist", True)
    suggested, lists_users = await _suggested_accounts(session)
    return {
        "accounts": accounts,
        "mode": mode,
        "default_allow": default_allow,
        "suggested_accounts": suggested,
        "lists_users": lists_users,
    }


@router.put("")
async def update_cast_permissions(
    req: CastPermissionsUpdate,
    session: SessionState = Depends(require_authenticated_session),
):
    _require_admin(session)
    accounts, mode, default_allow = await asyncio.to_thread(
        cast_permissions.set_policy,
        session.account_server_type,
        session.account_server_url,
        req.accounts,
        req.mode,
        req.default_allow,
    )
    logger.info(
        f"[cast-permissions] {session.account_username or session.display_name} set "
        f"{mode} ({len(accounts)} account(s), unlisted "
        f"{'allowed' if default_allow else 'blocked'}) on {session.account_server_url}"
    )
    return {"accounts": accounts, "mode": mode, "default_allow": default_allow}
