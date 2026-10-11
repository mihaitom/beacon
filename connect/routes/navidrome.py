"""routes/navidrome.py — Navidrome's own API, for the smart playlist editor.

Smart playlist rules can only be read and written through Navidrome's native
API, which wants a JWT issued for the account's password rather than the
Subsonic credential the session holds (see
docs/plans/smart-playlist-builder.md). The frontend sends the password once
to /navidrome/session; connect logs in with it, keeps the token on the
session and forgets the password.

Only the playlist endpoints are forwarded with that token. The rest of that
API includes user administration, and a token held here must not be a way
into it. (routes/proxy.py's catch-all, an older pass-through to the same API
for a deployment with NAVIDROME_INTERNAL_URL, answers every other path under
this prefix - without the token.)
"""

import asyncio
import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from core.auth import require_token
from core.session import SessionState, require_authenticated_session
from media.subsonic import SubsonicClient

logger = logging.getLogger("connect.navidrome")

router = APIRouter(prefix="/navidrome", dependencies=[Depends(require_token)])

# What the frontend reads to ask for the password (again): no token yet, or
# Navidrome no longer accepts the one there was. Both are 403s with a detail,
# never 401: the frontend reads a 401 from connect as its own session having
# lapsed and signs the user out of Beacon (services/connect/http.ts).
LOGIN_REQUIRED = "navidrome_login_required"
PASSWORD_REJECTED = "navidrome_password_rejected"

# Navidrome's ids are base62 today; older ones were UUIDs.
_PLAYLIST_ID = re.compile(r"[A-Za-z0-9-]+")


class SessionRequest(BaseModel):
    password: str


def _navidrome(session: SessionState) -> SubsonicClient:
    media = session.media
    if not isinstance(media, SubsonicClient) or media.server_software != "navidrome":
        raise HTTPException(status_code=404, detail="Not a Navidrome session")
    return media


@router.post("/session")
async def login(
    req: SessionRequest, session: SessionState = Depends(require_authenticated_session)
):
    media = _navidrome(session)
    # The name Navidrome itself reported at /config, not one the request
    # could claim: the token must belong to the account already signed in.
    username = session.account_username or media.username
    try:
        token = await asyncio.to_thread(media.navidrome_login, username, req.password)
    except Exception as e:
        logger.warning(f"[navidrome] Login request failed: {e}")
        raise HTTPException(status_code=502, detail="Navidrome could not be reached") from e
    if token is None:
        raise HTTPException(status_code=403, detail=PASSWORD_REJECTED)
    session.navidrome_token = token
    return {"status": "ok"}


async def _forward(
    method: str, path: str, session: SessionState, body: dict | None = None, params=None
) -> Response:
    media = _navidrome(session)
    if not session.navidrome_token:
        raise HTTPException(status_code=403, detail=LOGIN_REQUIRED)
    try:
        response = await asyncio.to_thread(
            media.navidrome_request, method, path, session.navidrome_token, body, params
        )
    except Exception as e:
        logger.warning(f"[navidrome] {method} /api/{path} failed: {e}")
        raise HTTPException(status_code=502, detail="Navidrome could not be reached") from e
    if response.status_code == 401:
        session.navidrome_token = ""
        raise HTTPException(status_code=403, detail=LOGIN_REQUIRED)
    # Navidrome extends the token's life with every answer; keeping the
    # newest one is what stops it from expiring while the editor is open.
    refreshed = response.headers.get("x-nd-authorization")
    if refreshed:
        session.navidrome_token = refreshed
    if response.status_code >= 400:
        # Navidrome's own refusal, as a detail: a bare 403 reads to the
        # frontend as something in front of connect blocking it, and makes
        # it back off all polling (services/connect/pollGate.ts).
        raise HTTPException(
            status_code=response.status_code if response.status_code < 500 else 502,
            detail=_navidrome_error(response),
        )
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type"),
    )


@router.get("/api/playlist")
async def list_playlists(
    request: Request, session: SessionState = Depends(require_authenticated_session)
):
    # The list's own paging and sorting (_start, _end, _sort, ...) pass
    # through; they only ever narrow what this endpoint returns.
    return await _forward("GET", "playlist", session, params=dict(request.query_params))


@router.post("/api/playlist")
async def create_playlist(
    body: dict, session: SessionState = Depends(require_authenticated_session)
):
    return await _forward("POST", "playlist", session, body=body)


@router.get("/api/playlist/{playlist_id}")
async def get_playlist(
    playlist_id: str, session: SessionState = Depends(require_authenticated_session)
):
    return await _forward("GET", f"playlist/{_segment(playlist_id)}", session)


@router.put("/api/playlist/{playlist_id}")
async def update_playlist(
    playlist_id: str, body: dict, session: SessionState = Depends(require_authenticated_session)
):
    return await _forward("PUT", f"playlist/{_segment(playlist_id)}", session, body=body)


def _segment(playlist_id: str) -> str:
    """A playlist id as one path segment. Anything that could step out of
    /api/playlist/ (a slash, a dot-dot) is refused rather than escaped."""
    if not _PLAYLIST_ID.fullmatch(playlist_id):
        raise HTTPException(status_code=400, detail="Invalid playlist id")
    return playlist_id


def _navidrome_error(response) -> str:
    """Navidrome's own message from an error answer ({"error": "..."})."""
    try:
        message = response.json().get("error")
    except Exception:
        message = None
    return f"Navidrome: {message or response.status_code}"
