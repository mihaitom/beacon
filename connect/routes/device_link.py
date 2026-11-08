"""routes/device_link.py - a paired desktop app talking to this server.

/device-link/ is reachable without a session or CONNECT_TOKEN so that a
reverse proxy can let exactly this prefix past its login, the way it does for
/party/. Everything under it stands on the device key alone, and a key only
ever speaks for the account that made it. /device-keys, where a signed-in
listener makes one, deliberately stays outside that prefix.
"""

import asyncio

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from core import account_settings, api_keys, device_keys, lyrics_offsets, play_history
from core.account_settings import LINKED_FIELDS
from core.auth import require_token
from core.device_keys import KeyOwner
from core.party import RateLimiter
from core.server_link import INVALID_KEY_DETAIL
from core.session import SessionState, require_authenticated_session
from core.trusted_proxies import client_ip
from routes.lyrics_offsets import OffsetsPatch
from routes.play_history import Listen, Milestones, _own

router = APIRouter(prefix="/device-link")
keys_router = APIRouter(prefix="/device-keys", dependencies=[Depends(require_token)])

limiter = RateLimiter()
# Keys are too long to guess; this keeps a broken client or a scanner from
# turning into a database read per request.
_KEY_FAILURES_PER_IP = (10, 300.0)

_MAX_BATCH = 500
# A batch of ordinary rows is a few hundred KB.
_MAX_LISTENS_BODY = 4 * 1024 * 1024
_MAX_SETTINGS_BODY = 64 * 1024
_MAX_MILESTONES_BODY = 1024
_MAX_OFFSETS_BODY = 256 * 1024


class IncomingListen(Listen):
    id: str = Field(pattern=r"^[0-9a-f]{32}$")
    ts: int = Field(ge=0)


class ListenBatch(BaseModel):
    listens: list[IncomingListen] = Field(max_length=_MAX_BATCH)
    backfill: bool = False


class SettingsPatch(BaseModel):
    settings: dict


class NewKey(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    share_api_keys: bool = False


async def _require_key(
    request: Request, x_beacon_device_key: str | None = Header(default=None, max_length=200)
) -> KeyOwner:
    peer = request.client.host if request.client else ""
    ip = client_ip(peer, request.headers.get("x-forwarded-for"))
    failures = f"key-fail:{ip}"
    if limiter.exceeded(failures, *_KEY_FAILURES_PER_IP):
        raise HTTPException(status_code=429, detail="Too many attempts - try again later")
    owner = None
    if x_beacon_device_key:
        owner = await asyncio.to_thread(device_keys.resolve, x_beacon_device_key)
    if owner is None:
        limiter.hit(failures, *_KEY_FAILURES_PER_IP)
        limiter.prune(_KEY_FAILURES_PER_IP[1])
        raise HTTPException(status_code=401, detail=INVALID_KEY_DETAIL)
    return owner


async def _parsed(request: Request, model: type[BaseModel], limit: int):
    """The body, read only after the key has passed and only up to `limit`.
    A body declared as a handler parameter would be read before either."""
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            raise HTTPException(status_code=413, detail="Request too large")
    try:
        return model.model_validate_json(bytes(body))
    except ValidationError as e:
        raise HTTPException(status_code=422, detail="Invalid request") from e


@router.get("/info")
def get_info(owner: KeyOwner = Depends(_require_key)) -> dict:
    return {"device_link": 1, "username": owner.account.username}


@router.post("/listens")
async def post_listens(request: Request, owner: KeyOwner = Depends(_require_key)) -> dict:
    batch = await _parsed(request, ListenBatch, _MAX_LISTENS_BODY)
    stored = await asyncio.to_thread(
        play_history.receive_listens,
        owner.account,
        [entry.model_dump() for entry in batch.listens],
        batch.backfill,
    )
    return {"stored": stored}


@router.get("/summary")
def get_summary(owner: KeyOwner = Depends(_require_key)) -> dict:
    return {
        **play_history.summary(owner.account),
        "milestones": play_history.milestones(owner.account),
    }


@router.put("/milestones")
async def put_milestones(request: Request, owner: KeyOwner = Depends(_require_key)) -> dict:
    seen = await _parsed(request, Milestones, _MAX_MILESTONES_BODY)
    await asyncio.to_thread(play_history.save_milestones, owner.account, seen.model_dump())
    return {"status": "ok"}


@router.get("/settings")
def get_settings(owner: KeyOwner = Depends(_require_key)) -> dict:
    if owner.settings_identity is None:
        return {}
    stored = account_settings.load(*owner.settings_identity)
    return {k: v for k, v in stored.items() if k in LINKED_FIELDS}


@router.patch("/settings")
async def patch_settings(request: Request, owner: KeyOwner = Depends(_require_key)) -> dict:
    patch = await _parsed(request, SettingsPatch, _MAX_SETTINGS_BODY)
    # An unknown field is a newer desktop's, and stays there.
    known = {k: v for k, v in patch.settings.items() if k in LINKED_FIELDS}
    if owner.settings_identity is not None and known:
        await asyncio.to_thread(account_settings.save, *owner.settings_identity, known)
    return {"status": "ok"}


@router.get("/api-keys")
def get_api_keys(owner: KeyOwner = Depends(_require_key)) -> dict:
    """The installation's keys, for a device they were confirmed for when its
    key was made. They end up in a file on that computer, hence one by one."""
    if not owner.may_read_api_keys:
        return {"keys": {}}
    return {"keys": {service: api_keys.get(service) for service in api_keys.SERVICES}}


@router.get("/lyrics-offsets")
def get_lyrics_offsets(owner: KeyOwner = Depends(_require_key)) -> dict:
    return {"offsets": lyrics_offsets.load(owner.account)}


@router.patch("/lyrics-offsets")
async def patch_lyrics_offsets(request: Request, owner: KeyOwner = Depends(_require_key)) -> dict:
    patch = await _parsed(request, OffsetsPatch, _MAX_OFFSETS_BODY)
    await asyncio.to_thread(lyrics_offsets.save, owner.account, patch.offsets)
    return {"status": "ok"}


def _require_account(session: SessionState):
    account = _own(session)
    if account is None:
        raise HTTPException(status_code=409, detail="This account has no play history")
    return account


@keys_router.get("")
def list_device_keys(session: SessionState = Depends(require_authenticated_session)) -> dict:
    return {"keys": device_keys.list_keys(_require_account(session))}


@keys_router.post("")
def create_device_key(
    new_key: NewKey, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    account = _require_account(session)
    try:
        return device_keys.create(
            account,
            new_key.label.strip(),
            device_keys.settings_identity_of(session),
            may_read_api_keys=new_key.share_api_keys,
        )
    except device_keys.TooManyKeys as e:
        raise HTTPException(status_code=409, detail="Too many device keys") from e


@keys_router.delete("/{key_id}")
def delete_device_key(
    key_id: str, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    if not device_keys.revoke(_require_account(session), key_id):
        raise HTTPException(status_code=404, detail="No such key")
    return {"status": "ok"}
