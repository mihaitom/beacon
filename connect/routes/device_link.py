"""routes/device_link.py - a paired desktop app or a listener's own app talking
to this server.

/device-link/ is reachable without a session or CONNECT_TOKEN so that a
reverse proxy can let exactly this prefix past its login, the way it does for
/party/. Everything under it stands on the device key alone, and a key only
ever speaks for the account that made it. /device-keys, where a signed-in
listener makes one, deliberately stays outside that prefix.

The routes under /device-link/v1/ are the public interface for listeners' own
apps and may only grow (docs/help/faq/apps-and-api.md). The others are private
to the desktop app and change with it.
"""

import asyncio
import json
import logging
from collections import Counter

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from core import account_settings, api_keys, device_keys, lyrics_offsets, now_playing, play_history
from core.account_settings import LINKED_FIELDS
from core.auth import require_token
from core.device_keys import KeyOwner
from core.party import RateLimiter
from core.server_link import INVALID_KEY_DETAIL, KEY_HEADER
from core.session import SessionState, require_authenticated_session
from core.trusted_proxies import client_ip
from lyrics.shared import CONNECT_VERSION
from routes.coverart import cover_image
from routes.lyrics import auto_for_party
from routes.lyrics_offsets import OffsetsPatch
from routes.now_playing import NowPlayingReport, accept
from routes.play_history import Listen, Milestones, _own

logger = logging.getLogger("connect.device_link")

router = APIRouter(prefix="/device-link")
v1_router = APIRouter(prefix="/device-link/v1")
keys_router = APIRouter(prefix="/device-keys", dependencies=[Depends(require_token)])

limiter = RateLimiter()
_open_streams: Counter[str] = Counter()
# Keys are too long to guess; this keeps a broken client or a scanner from
# turning into a database read per request.
_KEY_FAILURES_PER_IP = (10, 300.0)

# Raised only for a change an existing app could not cope with.
API_VERSION = 1

# Generous for a display refreshing every second; the bound is against a
# loop nobody meant to write.
_V1_REQUESTS_PER_KEY = (120, 60.0)

_MAX_STREAMS_PER_KEY = 3
# Asked rather than subscribed to: playing can start in any of an account's
# sessions, including one that does not exist yet when the stream opens.
_NOW_PLAYING_POLL_SECONDS = 1.0
# Well inside the 60 seconds after which nginx gives up on a silent stream.
_KEEPALIVE_SECONDS = 15.0

_PUBLIC_PREFIX = "/device-link/v1/"
_PREFLIGHT_MAX_AGE_SECONDS = 600

_MAX_BATCH = 500
# A batch of ordinary rows is a few hundred KB.
_MAX_LISTENS_BODY = 4 * 1024 * 1024
_MAX_SETTINGS_BODY = 64 * 1024
_MAX_MILESTONES_BODY = 1024
_MAX_OFFSETS_BODY = 256 * 1024
_MAX_REPORT_BODY = 16 * 1024


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
    scopes: list[str] = Field(min_length=1, max_length=10)


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


async def _public_caller(owner: KeyOwner = Depends(_require_key)) -> KeyOwner:
    if not limiter.hit(f"v1:{owner.key_id}", *_V1_REQUESTS_PER_KEY):
        raise HTTPException(
            status_code=429,
            detail="Too many requests",
            headers={"Retry-After": str(int(_V1_REQUESTS_PER_KEY[1]))},
        )
    return owner


def _with_scope(scope: str, caller=_require_key):
    async def check(owner: KeyOwner = Depends(caller)) -> KeyOwner:
        if scope not in owner.scopes:
            raise HTTPException(status_code=403, detail="This key may not do that")
        return owner

    return check


_syncing = Depends(_with_scope(device_keys.SYNC))


def _reading(scope: str):
    return Depends(_with_scope(scope, _public_caller))


async def add_public_api_cors(request: Request, call_next):
    """Lets a page on any origin use /device-link/v1/. Safe as `*`: nothing
    there reads a cookie, only the key a page was given and sends itself.

    A middleware rather than an entry in CORSMiddleware's list, which goes
    by origin and not by path: the routes outside v1 keep their allow list.
    A preflight carries no key, so it is answered before anything checks one."""
    if not request.url.path.startswith(_PUBLIC_PREFIX):
        return await call_next(request)
    if request.method == "OPTIONS" and "access-control-request-method" in request.headers:
        return Response(
            status_code=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET",
                "Access-Control-Allow-Headers": KEY_HEADER,
                "Access-Control-Max-Age": str(_PREFLIGHT_MAX_AGE_SECONDS),
            },
        )
    response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Expose-Headers"] = "Retry-After"
    return response


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
    return {
        "device_link": 1,
        "username": owner.account.username,
        "scopes": sorted(owner.scopes),
    }


@v1_router.get("/me")
def get_me(owner: KeyOwner = Depends(_public_caller)) -> dict:
    return {
        "username": owner.account.username,
        "scopes": sorted(owner.scopes),
        "beacon_version": CONNECT_VERSION,
        "api_version": API_VERSION,
    }


@v1_router.get("/history")
def get_history(
    owner: KeyOwner = _reading(device_keys.HISTORY),
    cursor: str | None = Query(default=None, pattern=r"^\d{1,18}\.\d{1,18}$"),
    since: int | None = Query(default=None, ge=0),
    until: int | None = Query(default=None, ge=0),
    limit: int = Query(default=100, ge=1, le=_MAX_BATCH),
) -> dict:
    try:
        return play_history.history_page(owner.account, cursor, since, until, limit)
    except play_history.StaleCursor as e:
        raise HTTPException(status_code=410, detail="cursor_expired") from e


def _public_top(top: dict) -> dict:
    """A list of fields of its own: the Stats page's chart entries may change
    with the page, this may not."""
    return {
        "songs": [
            {
                "title": item["label"],
                "artist": item["sublabel"],
                "album_id": item["album_id"],
                "plays": item["value"],
            }
            for item in top["songs"]
        ],
        "artists": [
            {"name": item["label"], "artist_id": item["artist_id"], "plays": item["value"]}
            for item in top["artists"]
        ],
        "albums": [
            {
                "title": item["label"],
                "artist": item["sublabel"],
                "album_id": item["album_id"],
                "plays": item["value"],
            }
            for item in top["albums"]
        ],
        "genres": [{"name": item["label"], "plays": item["value"]} for item in top["genres"]],
    }


@v1_router.get("/stats")
def get_stats(owner: KeyOwner = _reading(device_keys.STATS)) -> dict:
    summary = play_history.summary(owner.account)
    return {
        "total": summary["total"],
        "live_since": summary["live_since"],
        "top": _public_top(summary["top"]),
        "milestones": play_history.milestones(owner.account),
        "timestamps": summary["timestamps"],
    }


@v1_router.get("/now-playing")
def get_now_playing(owner: KeyOwner = _reading(device_keys.NOW_PLAYING)) -> dict:
    return now_playing.current(owner.account)


def _event(state: dict) -> str:
    return f"data: {json.dumps(state)}\n\n"


async def _now_playing_events(presented_key: str, owner: KeyOwner):
    """Counted in here, not by the route: a client gone before the first byte
    never starts this, and its `finally` would never give the place back.

    The key is looked up again at every keepalive, so that revoking ends an
    open stream and a stream counts as the device being in use."""
    _open_streams[owner.key_id] += 1
    try:
        yield "retry: 2000\n\n"
        shown = now_playing.current(owner.account)
        yield _event(shown)
        quiet = 0.0
        while True:
            await asyncio.sleep(_NOW_PLAYING_POLL_SECONDS)
            quiet += _NOW_PLAYING_POLL_SECONDS
            latest = now_playing.current(owner.account)
            if now_playing.differs(shown, latest):
                shown = latest
                yield _event(latest)
            if quiet >= _KEEPALIVE_SECONDS:
                quiet = 0.0
                still = await asyncio.to_thread(device_keys.resolve, presented_key)
                if still is None or device_keys.NOW_PLAYING not in still.scopes:
                    return
                yield ": keepalive\n\n"
    finally:
        _open_streams[owner.key_id] -= 1
        if _open_streams[owner.key_id] <= 0:
            del _open_streams[owner.key_id]


@v1_router.get("/now-playing/events")
async def get_now_playing_events(
    owner: KeyOwner = _reading(device_keys.NOW_PLAYING),
    x_beacon_device_key: str = Header(max_length=200),
) -> StreamingResponse:
    if _open_streams[owner.key_id] >= _MAX_STREAMS_PER_KEY:
        raise HTTPException(status_code=429, detail="Too many open streams")
    return StreamingResponse(
        _now_playing_events(x_beacon_device_key, owner),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@v1_router.get("/now-playing/cover")
async def get_now_playing_cover(owner: KeyOwner = _reading(device_keys.NOW_PLAYING)) -> Response:
    found = now_playing.cover_of(owner.account)
    if found is None:
        raise HTTPException(status_code=404, detail="No cover for what is playing")
    response = await cover_image(*found)
    # The same address shows the next song's cover in three minutes.
    response.headers["Cache-Control"] = "no-store"
    return response


@v1_router.get("/now-playing/lyrics")
async def get_now_playing_lyrics(owner: KeyOwner = _reading(device_keys.LYRICS)) -> dict:
    """Only for what is playing: a free search would turn a key into a way to
    query the lyrics providers, and each lookup tells them what somebody
    listens to. The correction stays apart from `lines` so that an app can
    show the times as the sheet has them."""
    song = now_playing.current(owner.account).get("song")
    if song is None:
        raise HTTPException(status_code=404, detail="No song is playing")
    try:
        found = await auto_for_party(song)
    except Exception as e:
        logger.warning(f"[device-link] Lyrics lookup failed: {e}")
        found = None
    offset = await asyncio.to_thread(lyrics_offsets.offset_of, owner.account, song["id"])
    return {
        "song_id": song["id"],
        "synced": bool(found and found["synced"]),
        "lines": [
            {"time": line["time"], "text": line["text"]}
            for line in (found or {"lines": []})["lines"]
        ],
        "offset": offset,
    }


@router.put("/now-playing")
async def put_now_playing(request: Request, owner: KeyOwner = _syncing) -> dict:
    report = await _parsed(request, NowPlayingReport, _MAX_REPORT_BODY)
    wanted = await asyncio.to_thread(
        accept, owner.account, f"key:{owner.key_id}", report.model_dump()
    )
    return {"wanted": wanted}


@router.delete("/now-playing")
def delete_now_playing(owner: KeyOwner = _syncing) -> dict:
    now_playing.forget_report(f"key:{owner.key_id}")
    return {"status": "ok"}


@router.post("/listens")
async def post_listens(request: Request, owner: KeyOwner = _syncing) -> dict:
    batch = await _parsed(request, ListenBatch, _MAX_LISTENS_BODY)
    stored = await asyncio.to_thread(
        play_history.receive_listens,
        owner.account,
        [entry.model_dump() for entry in batch.listens],
        batch.backfill,
    )
    return {"stored": stored}


@router.get("/summary")
def get_summary(owner: KeyOwner = _syncing) -> dict:
    return {
        **play_history.summary(owner.account),
        "milestones": play_history.milestones(owner.account),
    }


@router.put("/milestones")
async def put_milestones(request: Request, owner: KeyOwner = _syncing) -> dict:
    seen = await _parsed(request, Milestones, _MAX_MILESTONES_BODY)
    await asyncio.to_thread(play_history.save_milestones, owner.account, seen.model_dump())
    return {"status": "ok"}


@router.get("/settings")
def get_settings(owner: KeyOwner = _syncing) -> dict:
    if owner.settings_identity is None:
        return {}
    stored = account_settings.load(*owner.settings_identity)
    return {k: v for k, v in stored.items() if k in LINKED_FIELDS}


@router.patch("/settings")
async def patch_settings(request: Request, owner: KeyOwner = _syncing) -> dict:
    patch = await _parsed(request, SettingsPatch, _MAX_SETTINGS_BODY)
    # An unknown field is a newer desktop's, and stays there.
    known = {k: v for k, v in patch.settings.items() if k in LINKED_FIELDS}
    if owner.settings_identity is not None and known:
        await asyncio.to_thread(account_settings.save, *owner.settings_identity, known)
    return {"status": "ok"}


@router.get("/api-keys")
def get_api_keys(owner: KeyOwner = _syncing) -> dict:
    """The installation's keys, for a device they were confirmed for when its
    key was made. They end up in a file on that computer, hence one by one."""
    if device_keys.API_KEYS not in owner.scopes:
        return {"keys": {}}
    return {"keys": {service: api_keys.get(service) for service in api_keys.SERVICES}}


@router.get("/lyrics-offsets")
def get_lyrics_offsets(owner: KeyOwner = _syncing) -> dict:
    return {"offsets": lyrics_offsets.load(owner.account)}


@router.patch("/lyrics-offsets")
async def patch_lyrics_offsets(request: Request, owner: KeyOwner = _syncing) -> dict:
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
            scopes=new_key.scopes,
        )
    except device_keys.InvalidScopes as e:
        raise HTTPException(status_code=422, detail="Invalid scopes") from e
    except device_keys.TooManyKeys as e:
        raise HTTPException(status_code=409, detail="Too many device keys") from e


@keys_router.delete("/{key_id}")
def delete_device_key(
    key_id: str, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    if not device_keys.revoke(_require_account(session), key_id):
        raise HTTPException(status_code=404, detail="No such key")
    return {"status": "ok"}
