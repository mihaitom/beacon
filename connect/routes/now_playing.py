"""routes/now_playing.py - a Beacon window saying what it plays by itself.

A cast is known to connect anyway. Playing in the browser or in the desktop
app is not, so the window reports it for the account's own apps
(core/now_playing.py). Only while one of them wants to know: the answer says
so, and a window told no stays quiet until the next song.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, model_validator

from core import device_keys, now_playing, server_link
from core.auth import require_token
from core.play_history import Account
from core.session import SessionState, require_authenticated_session
from routes.play_history import _own

router = APIRouter(prefix="/now-playing", dependencies=[Depends(require_token)])

_MAX_TEXT = 2000


class ReportedSong(BaseModel):
    id: str = Field(min_length=1, max_length=512)
    title: str = Field(max_length=_MAX_TEXT)
    artist: str = Field(default="", max_length=_MAX_TEXT)
    album: str = Field(default="", max_length=_MAX_TEXT)
    duration: float = Field(default=0, ge=0)
    cover_art_id: str = Field(default="", max_length=_MAX_TEXT)


class ReportedRadio(BaseModel):
    station: str = Field(max_length=_MAX_TEXT)
    title: str | None = Field(default=None, max_length=_MAX_TEXT)


class NowPlayingReport(BaseModel):
    song: ReportedSong | None = None
    radio: ReportedRadio | None = None
    position: float | None = Field(default=None, ge=0)
    paused: bool = False
    devices: list[str] = Field(default=[], max_length=32)

    @model_validator(mode="after")
    def _one_thing_at_a_time(self):
        if (self.song is None) == (self.radio is None):
            raise ValueError("A report is about a song or a station")
        return self


def accept(account: Account, source: str, report: dict) -> bool:
    """Kept only while one of the account's keys may read it. Whether it was."""
    if not device_keys.account_has_scope(account, device_keys.NOW_PLAYING):
        now_playing.forget_report(source)
        return False
    now_playing.store_report(source, account, report)
    return True


@router.post("/report")
def post_report(
    report: NowPlayingReport, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    account = _own(session)
    if account is None:
        return {"wanted": False}
    if server_link.is_linked(account):
        return {"wanted": server_link.relay_now_playing(report.model_dump())}
    return {"wanted": accept(account, f"session:{session.session_id}", report.model_dump())}


@router.delete("/report")
def delete_report(session: SessionState = Depends(require_authenticated_session)) -> dict:
    account = _own(session)
    if account is not None and server_link.is_linked(account):
        server_link.relay_now_playing(None)
    now_playing.forget_report(f"session:{session.session_id}")
    return {"status": "ok"}
