"""routes/play_history.py - the log behind the Stats page's dated figures.

Every route takes the account from the session /config verified, which
CONNECT_TOKEN alone does not identify (see core/play_history.py). A server
administrator may read another account on the same server, nothing more.
The path avoids "log" and "track", which ad-blocker lists match on.
"""

import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core import cast_permissions, lastfm, play_history, play_history_import
from core.auth import require_token
from core.play_history import Account
from core.session import SessionState, require_authenticated_session

router = APIRouter(prefix="/play-history", dependencies=[Depends(require_token)])

_MAX_TEXT = 2000


class Listen(BaseModel):
    song_id: str = Field(max_length=_MAX_TEXT)
    title: str = Field(max_length=_MAX_TEXT)
    artist: str = Field(default="", max_length=_MAX_TEXT)
    artist_id: str = Field(default="", max_length=_MAX_TEXT)
    album: str = Field(default="", max_length=_MAX_TEXT)
    album_id: str = Field(default="", max_length=_MAX_TEXT)
    cover_art_id: str = Field(default="", max_length=_MAX_TEXT)
    genre: str = Field(default="", max_length=_MAX_TEXT)
    duration: float = Field(default=0, ge=0)


class ImportRequest(BaseModel):
    source: Literal["lastfm", "listenbrainz"]
    username: str = Field(min_length=1, max_length=200)


class Milestones(BaseModel):
    plays: int = Field(ge=0)
    hours: int = Field(ge=0)
    streak: int = Field(ge=0)
    records: int = Field(default=0, ge=0)


def _own(session: SessionState) -> Account | None:
    """None for a session the server gave no name for (possible on Plex):
    with nothing to file it under, it has no log."""
    if not session.account_username:
        return None
    return Account(
        session.account_server_type, session.account_server_url, session.account_username
    )


def _known_accounts(session: SessionState) -> list[str]:
    return cast_permissions.known_accounts(session.account_server_type, session.account_server_url)


def _require_admin(session: SessionState) -> None:
    if not session.account_is_admin:
        raise HTTPException(status_code=403, detail="Server administrator rights required")


def _empty_summary() -> dict:
    return {
        "available": False,
        "total": 0,
        "timestamps": [],
        "live_since": None,
        "recent_plays": {},
        "top": {"songs": [], "artists": [], "albums": [], "genres": []},
    }


# Sync `def` wherever only files are touched: FastAPI runs those in its
# threadpool, which keeps blocking IO off the event loop.
@router.post("")
def record_listen(
    listen: Listen, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    account = _own(session)
    if account is None:
        return {"recorded": False}
    return {"recorded": play_history.record(account, listen.model_dump())}


@router.get("/summary")
def get_summary(
    username: str | None = None,
    session: SessionState = Depends(require_authenticated_session),
) -> dict:
    own = _own(session)
    if username is not None and (own is None or username != own.username):
        _require_admin(session)
        if username not in _known_accounts(session):
            raise HTTPException(status_code=404, detail="No such account on this server")
        return play_history.summary(
            Account(session.account_server_type, session.account_server_url, username)
        )
    if own is None:
        return {**_empty_summary(), "milestones": None}
    return {**play_history.summary(own), "milestones": play_history.milestones(own)}


@router.get("/accounts")
def get_accounts(session: SessionState = Depends(require_authenticated_session)) -> dict:
    _require_admin(session)
    return {"accounts": sorted(_known_accounts(session), key=str.casefold)}


@router.put("/milestones")
def put_milestones(
    seen: Milestones, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    account = _own(session)
    if account is not None:
        play_history.save_milestones(account, seen.model_dump())
    return {"status": "ok"}


@router.get("/import")
async def get_import(session: SessionState = Depends(require_authenticated_session)) -> dict:
    account = _own(session)
    if account is None:
        return {"status": "none"}
    saved = await asyncio.to_thread(play_history.import_state, account)
    return play_history_import.status(account, saved)


@router.post("/import")
async def start_import(
    req: ImportRequest, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    account = _own(session)
    if account is None:
        raise HTTPException(status_code=409, detail="This account has no play history")
    if req.source == "lastfm" and not lastfm.is_configured():
        raise HTTPException(status_code=409, detail="No Last.fm API key configured")
    saved = await asyncio.to_thread(play_history.import_state, account)
    play_history_import.start(account, req.source, req.username, saved)
    return play_history_import.status(account, saved)
