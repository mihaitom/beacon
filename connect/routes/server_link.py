"""routes/server_link.py - this desktop's pairing with a Beacon server, for
its Settings page. The account comes from the verified session. See
core/server_link.py."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core import device_keys, server_link, shared_claims
from core.auth import require_token
from core.server_link import LinkError
from core.session import SessionState, require_authenticated_session
from routes.play_history import _own

router = APIRouter(prefix="/server-link", dependencies=[Depends(require_token)])


class PairRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    key: str = Field(min_length=1, max_length=200)


def _require_available() -> None:
    if not server_link.AVAILABLE:
        raise HTTPException(status_code=404, detail="Not available on this installation")


@router.get("")
def get_link(session: SessionState = Depends(require_authenticated_session)) -> dict:
    return server_link.status(_own(session))


@router.put("", dependencies=[Depends(_require_available)])
def pair(req: PairRequest, session: SessionState = Depends(require_authenticated_session)) -> dict:
    account = _own(session)
    if account is None:
        raise HTTPException(status_code=409, detail="This account has no play history")
    try:
        return server_link.pair(
            account, device_keys.settings_identity_of(session), req.url, req.key
        )
    except LinkError as e:
        return {"available": True, "linked": False, "error": e.state}


@router.delete("", dependencies=[Depends(_require_available)])
def unpair(_session: SessionState = Depends(require_authenticated_session)) -> dict:
    shared_claims.withdraw()
    server_link.unpair()
    return {"available": True, "linked": False}
