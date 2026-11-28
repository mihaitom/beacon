"""routes/audiomuse.py - AudioMuse-AI for the renderer (core/audiomuse.py).

  GET  /audiomuse/settings   address and key status, for Settings
  PUT  /audiomuse/settings   store the address and/or the key
  GET  /audiomuse/status     whether this session can use it, and why not
  POST /audiomuse/mix        songs for Autoplay and the radios

The mix answers 503 for every "use what you used before" case, so the
renderer has a single thing to fall back on; the reason is in the body for
the log.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
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
