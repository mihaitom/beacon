"""routes/lyrics_offsets.py - the per-song lyrics timing corrections that
follow an account. The account comes from the verified session. See
core/lyrics_offsets.py."""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, StringConstraints

from core import lyrics_offsets, server_link
from core.auth import require_token
from core.session import SessionState, require_authenticated_session
from routes.play_history import _own

router = APIRouter(prefix="/lyrics-offsets", dependencies=[Depends(require_token)])

SongId = Annotated[str, StringConstraints(min_length=1, max_length=200)]
# Longer than any song; only keeps a hand-made request out.
Seconds = Annotated[float, Field(ge=-86_400, le=86_400, allow_inf_nan=False)]


class OffsetsPatch(BaseModel):
    offsets: dict[SongId, Seconds] = Field(max_length=500)


@router.get("")
def get_offsets(session: SessionState = Depends(require_authenticated_session)) -> dict:
    account = _own(session)
    if account is None:
        return {"offsets": {}}
    linked = server_link.pull_lyrics_offsets(account)
    if linked:
        # A mirror, so the corrections are still there with the server away.
        lyrics_offsets.save(account, linked)
    return {"offsets": lyrics_offsets.load(account)}


@router.put("")
def put_offsets(
    patch: OffsetsPatch, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    account = _own(session)
    if account is not None and patch.offsets:
        lyrics_offsets.save(account, patch.offsets)
        server_link.note_lyrics_offsets(account, patch.offsets)
    return {"status": "ok"}
