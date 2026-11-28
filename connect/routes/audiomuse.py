"""routes/audiomuse.py - AudioMuse-AI for the renderer (core/audiomuse.py).

  GET  /audiomuse/settings   address and key status, for Settings
  PUT  /audiomuse/settings   store the address and/or the key
  GET  /audiomuse/status     whether this session can use it, and why not
  POST /audiomuse/mix        songs for Autoplay and the radios
  POST /audiomuse/path       the songs between the one playing and another
  POST /audiomuse/search     songs by their sound or their lyrics, in words

The last three answer 503 whenever AudioMuse cannot, so the renderer has a
single thing to react to (fall back, or say so); the reason is in the body
for the log.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints

from core import api_keys, audiomuse
from core.auth import require_token
from core.session import SessionState, require_authenticated_session

router = APIRouter(prefix="/audiomuse", dependencies=[Depends(require_token)])

ItemId = Annotated[str, StringConstraints(min_length=1, max_length=200)]


class SettingsRequest(BaseModel):
    # None leaves a value as it is; "" clears it.
    url: str | None = Field(default=None, max_length=500)
    key: str | None = Field(default=None, max_length=500)


class MixItem(BaseModel):
    id: ItemId
    type: Literal["song", "artist"] = "song"


class MixRequest(BaseModel):
    method: Literal["similar", "discovery", "blend"]
    add: list[MixItem] = Field(min_length=1, max_length=20)
    subtract: list[MixItem] = Field(default_factory=list, max_length=50)
    n: int = Field(default=10, ge=1, le=100)
    exclude: list[ItemId] = Field(default_factory=list, max_length=1000)


@router.get("/settings")
def get_settings() -> dict:
    return audiomuse.settings_status()


# Sync `def`: writes files, see routes/api_keys.py.
@router.put("/settings")
def put_settings(req: SettingsRequest) -> dict:
    if req.url is not None:
        try:
            audiomuse.set_url(req.url)
        except ValueError as e:
            raise HTTPException(status_code=400, detail="Not an http(s) address") from e
    if req.key is not None:
        api_keys.set(audiomuse.SERVICE, req.key)
        audiomuse.forget_cached_state()
    return audiomuse.settings_status()


@router.get("/status")
async def get_status(session: SessionState = Depends(require_authenticated_session)) -> dict:
    return await audiomuse.session_status(session.media)


@router.post("/mix", response_model=None)
async def post_mix(
    req: MixRequest, session: SessionState = Depends(require_authenticated_session)
) -> dict | JSONResponse:
    try:
        songs = await audiomuse.mix(
            session.media,
            req.method,
            [item.model_dump() for item in req.add],
            [item.model_dump() for item in req.subtract],
            req.n,
            req.exclude,
        )
    except audiomuse.AudioMuseError as e:
        return JSONResponse(status_code=503, content={"detail": e.reason})
    return {"songs": songs}


class PathRequest(BaseModel):
    start: ItemId
    end: ItemId


class SearchRequest(BaseModel):
    kind: Literal["sound", "lyrics"]
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    n: int = Field(default=20, ge=1, le=50)


@router.post("/path", response_model=None)
async def post_path(
    req: PathRequest, session: SessionState = Depends(require_authenticated_session)
) -> dict | JSONResponse:
    try:
        songs = await audiomuse.path(session.media, req.start, req.end)
    except audiomuse.AudioMuseError as e:
        return JSONResponse(status_code=503, content={"detail": e.reason})
    return {"songs": songs}


@router.post("/search", response_model=None)
async def post_search(
    req: SearchRequest, session: SessionState = Depends(require_authenticated_session)
) -> dict | JSONResponse:
    try:
        songs = await audiomuse.search(session.media, req.kind, req.query, req.n)
    except audiomuse.AudioMuseError as e:
        return JSONResponse(status_code=503, content={"detail": e.reason})
    return {"songs": songs}


class MoodRequest(BaseModel):
    mood: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    n: int = Field(default=50, ge=1, le=100)
    exclude: list[ItemId] = Field(default_factory=list, max_length=1000)


@router.get("/moods", response_model=None)
async def get_moods(
    session: SessionState = Depends(require_authenticated_session),
) -> dict | JSONResponse:
    try:
        return {"moods": await audiomuse.moods()}
    except audiomuse.AudioMuseError as e:
        return JSONResponse(status_code=503, content={"detail": e.reason})


@router.post("/mood", response_model=None)
async def post_mood(
    req: MoodRequest, session: SessionState = Depends(require_authenticated_session)
) -> dict | JSONResponse:
    try:
        songs = await audiomuse.mood_mix(session.media, req.mood, req.n, req.exclude)
    except audiomuse.AudioMuseError as e:
        return JSONResponse(status_code=503, content={"detail": e.reason})
    return {"songs": songs}


@router.get("/similar-artists", response_model=None)
async def get_similar_artists(
    id: str = Query(min_length=1, max_length=200),
    n: int = Query(default=12, ge=1, le=30),
    session: SessionState = Depends(require_authenticated_session),
) -> dict | JSONResponse:
    try:
        artists = await audiomuse.similar_artists(session.media, id, n)
    except audiomuse.AudioMuseError as e:
        return JSONResponse(status_code=503, content={"detail": e.reason})
    return {"artists": artists}
