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
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, StringConstraints, ValidationError

from core import (
    account_settings,
    api_keys,
    app_library,
    device_keys,
    lyrics_offsets,
    mdns,
    media_login,
    now_playing,
    play_history,
    server_link,
)
from core.account_settings import LINKED_FIELDS
from core.auth import require_token
from core.device_keys import KeyOwner
from core.party import RateLimiter
from core.server_link import INVALID_KEY_DETAIL, KEY_HEADER
from core.session import SessionState, require_authenticated_session
from core.trusted_proxies import client_ip
from lyrics.shared import CONNECT_VERSION
from media.login_errors import REASON_FORBIDDEN, REASON_REJECTED, classify_login_error
from routes import device_link_schema as schema
from routes import player_desktop, player_server
from routes.coverart import cover_image
from routes.lyrics import auto_for_party
from routes.lyrics_offsets import OffsetsPatch
from routes.now_playing import NowPlayingReport, accept
from routes.play_history import Listen, Milestones, Period, _own
from routes.player_commands import LIBRARY_COMMANDS, TRANSPORT_COMMANDS
from routes.radio import radio_favicon

logger = logging.getLogger("connect.device_link")

router = APIRouter(prefix="/device-link")
v1_router = APIRouter(prefix="/device-link/v1")
keys_router = APIRouter(prefix="/device-keys", dependencies=[Depends(require_token)])

limiter = RateLimiter()
_open_streams: Counter[str] = Counter()
_openapi_document: dict | None = None
# Keys are too long to guess; this keeps a broken client or a scanner from
# turning into a database read per request.
_KEY_FAILURES_PER_IP = (10, 300.0)

# Generous for a display refreshing every second; the bound is against a
# loop nobody meant to write.
_V1_REQUESTS_PER_KEY = (120, 60.0)
# Images count apart: a media browser opening a list asks for every cover in
# it at once.
_V1_IMAGES_PER_KEY = (600, 60.0)

_MAX_STREAMS_PER_KEY = 3
# When another stream ends cannot be known; this keeps a client from hammering.
_STREAM_RETRY_SECONDS = 15
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
_MAX_COMMAND_BODY = 8 * 1024


class IncomingListen(Listen):
    id: str = Field(pattern=r"^[0-9a-f]{32}$")
    ts: int = Field(ge=0)


class ListenBatch(BaseModel):
    listens: list[IncomingListen] = Field(max_length=_MAX_BATCH)
    backfill: bool = False


class SettingsPatch(BaseModel):
    settings: dict


class NewKey(BaseModel):
    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    scopes: list[str] = Field(min_length=1, max_length=10)


async def _require_key(
    request: Request, x_beacon_device_key: str | None = Header(default=None, max_length=200)
) -> KeyOwner:
    peer = request.client.host if request.client else ""
    ip = client_ip(peer, request.headers.get("x-forwarded-for"))
    failures = f"key-fail:{ip}"
    if limiter.exceeded(failures, *_KEY_FAILURES_PER_IP):
        raise HTTPException(
            status_code=429,
            detail="Too many attempts - try again later",
            headers={"Retry-After": str(int(_KEY_FAILURES_PER_IP[1]))},
        )
    owner = None
    if x_beacon_device_key:
        owner = await asyncio.to_thread(device_keys.resolve, x_beacon_device_key)
    if owner is None:
        limiter.hit(failures, *_KEY_FAILURES_PER_IP)
        limiter.prune(_KEY_FAILURES_PER_IP[1])
        raise HTTPException(status_code=401, detail=INVALID_KEY_DETAIL)
    return owner


def _within(bucket: str, budget: tuple[int, float]):
    async def caller(owner: KeyOwner = Depends(_require_key)) -> KeyOwner:
        if not limiter.hit(f"{bucket}:{owner.key_id}", *budget):
            raise HTTPException(
                status_code=429,
                detail="Too many requests",
                headers={"Retry-After": str(int(budget[1]))},
            )
        return owner

    return caller


_public_caller = _within("v1", _V1_REQUESTS_PER_KEY)
_image_caller = _within("v1-images", _V1_IMAGES_PER_KEY)


def _with_scope(scope: str, caller=_require_key):
    async def check(owner: KeyOwner = Depends(caller)) -> KeyOwner:
        if scope not in owner.scopes:
            raise HTTPException(status_code=403, detail="This key may not do that")
        return owner

    return check


_syncing = Depends(_with_scope(device_keys.SYNC))


def _reading(scope: str):
    return Depends(_with_scope(scope, _public_caller))


def _picturing(scope: str):
    return Depends(_with_scope(scope, _image_caller))


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
                "Access-Control-Allow-Methods": "GET, POST",
                "Access-Control-Allow-Headers": f"{KEY_HEADER}, Content-Type",
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


_REFUSALS = {
    401: {"description": "Wrong or revoked key"},
    403: {"description": "This key does not have the right for this route"},
    429: {"description": "Too many requests or open streams"},
}


@v1_router.get("/openapi.json", include_in_schema=False)
def get_openapi_document() -> dict:
    """Without a key: an assistant has to be able to read this before anyone
    hands it one. It holds no data, only the shape of the routes."""
    global _openapi_document
    if _openapi_document is None:
        _openapi_document = schema.document(v1_router.routes)
    return _openapi_document


@v1_router.get(
    "/me",
    response_model=schema.Me,
    responses=_REFUSALS,
    description="Who this key belongs to and what it may do. Works with any key.",
)
def get_me(owner: KeyOwner = Depends(_public_caller)) -> dict:
    return {
        "username": owner.account.username,
        "scopes": sorted(owner.scopes),
        "beacon_version": CONNECT_VERSION,
        # AVAILABLE: this is a desktop app.
        "player": "desktop" if server_link.AVAILABLE else "server",
        "api_version": schema.API_VERSION,
    }


@v1_router.get(
    "/history",
    response_model=schema.HistoryPage,
    responses={
        **_REFUSALS,
        410: {"description": "The cursor has expired: forget what you have, start without one"},
    },
    description=(
        "Plays in the order they arrived, not the order they were played: a desktop app that "
        "was offline delivers plays days old. Keep `next_cursor` and ask with it later for what "
        "is new. To show plays by date, sort by `ts` yourself."
    ),
)
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


@v1_router.get(
    "/stats",
    response_model=schema.Stats,
    responses=_REFUSALS,
    description=(
        "Totals and top lists. There is no current streak, since a day depends on the "
        "listener's time zone: work it out from `timestamps`."
    ),
)
def get_stats(owner: KeyOwner = _reading(device_keys.STATS)) -> dict:
    summary = play_history.summary(owner.account)
    return {
        "total": summary["total"],
        "live_since": summary["live_since"],
        "top": _public_top(summary["top"]),
        "milestones": play_history.milestones(owner.account),
        "timestamps": summary["timestamps"],
    }


@v1_router.get(
    "/now-playing",
    response_model=schema.NowPlaying,
    responses=_REFUSALS,
    description=(
        "What this account is listening to, on a speaker or on one of its own devices. Carry "
        "`position` forward from `at` instead of asking every second."
    ),
)
async def get_now_playing(owner: KeyOwner = _reading(device_keys.NOW_PLAYING)) -> dict:
    return now_playing.current(owner.account)


def _event(state: dict) -> str:
    return f"data: {json.dumps(state)}\n\n"


async def _now_playing_events(presented_key: str, owner: KeyOwner):
    """The key is looked up again at every keepalive, so that revoking ends an
    open stream and a stream counts as the device being in use."""
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


class _CountedStream(StreamingResponse):
    """Holds one of its key's places for as long as it is being answered. Not
    the generator's `finally`: a client gone before the first byte never
    starts the generator, and the place would stay taken."""

    def __init__(self, key_id: str, content, **kwargs):
        super().__init__(content, **kwargs)
        self._key_id = key_id

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            _open_streams[self._key_id] -= 1
            if _open_streams[self._key_id] <= 0:
                del _open_streams[self._key_id]


def _take_stream_place(owner: KeyOwner) -> None:
    """Released by _CountedStream. With no await between the check and the
    count, concurrent opens cannot all pass."""
    if _open_streams[owner.key_id] >= _MAX_STREAMS_PER_KEY:
        raise HTTPException(
            status_code=429,
            detail="Too many open streams",
            headers={"Retry-After": str(_STREAM_RETRY_SECONDS)},
        )
    _open_streams[owner.key_id] += 1


@v1_router.get(
    "/now-playing/events",
    response_model=None,
    responses={
        **_REFUSALS,
        200: {
            "description": "Each `data:` line holds the same JSON as /now-playing",
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        },
    },
    description=(
        "Server-sent events: the state at the start, then on a new song, pause, resume, seek or "
        "stop. Lines starting with `:` are keepalives. Ends when the key is revoked. A browser's "
        "EventSource cannot send the key header: read the stream with fetch instead."
    ),
)
async def get_now_playing_events(
    owner: KeyOwner = _reading(device_keys.NOW_PLAYING),
    x_beacon_device_key: str = Header(max_length=200),
) -> StreamingResponse:
    _take_stream_place(owner)
    return _CountedStream(
        owner.key_id,
        _now_playing_events(x_beacon_device_key, owner),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@v1_router.get(
    "/now-playing/cover",
    response_model=None,
    responses={
        **_REFUSALS,
        200: {
            "description": "The image",
            "content": {"image/*": {"schema": {"type": "string", "format": "binary"}}},
        },
        404: {"description": "Radio, nothing playing, or a song without a cover"},
    },
    description=(
        "The cover of the song playing now. The address stays the same from song to song: "
        "fetch it again when the song changes."
    ),
)
async def get_now_playing_cover(
    owner: KeyOwner = _picturing(device_keys.NOW_PLAYING),
) -> Response:
    found = now_playing.cover_of(owner.account)
    if found is None:
        raise HTTPException(status_code=404, detail="No cover for what is playing")
    response = await cover_image(*found)
    # The same address shows the next song's cover in three minutes.
    response.headers["Cache-Control"] = "no-store"
    return response


@v1_router.get(
    "/now-playing/lyrics",
    response_model=schema.Lyrics,
    responses={**_REFUSALS, 404: {"description": "Radio, or nothing playing"}},
    description=(
        "The lyrics of the song playing now. A line is reached at `position - offset >= time`. "
        "There is no search."
    ),
)
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


# ── the player ───────────────────────────────────────────────────────────


def _player():
    """The desktop app steers its window, a server the account's casts."""
    return player_desktop if server_link.AVAILABLE else player_server


_PLAYER_REFUSALS = {
    **_REFUSALS,
    409: {"description": "Nothing to steer right now, or `media_login_rejected` (see /library)"},
}


@v1_router.get(
    "/player",
    response_model=schema.Player,
    responses=_REFUSALS,
    description=(
        "The player this key steers: on a server the account's casts, on the desktop app its "
        "window. Carry `position` forward from `at` instead of asking every second."
    ),
)
async def get_player(owner: KeyOwner = _reading(device_keys.CONTROL)) -> dict:
    return _player().state(owner)


def _player_paused(state: dict) -> bool:
    return state["state"] != "playing"


async def _player_events(presented_key: str, owner: KeyOwner):
    """As _now_playing_events(): asked once a second, the key looked up again
    at every keepalive."""
    yield "retry: 2000\n\n"
    shown = _player().state(owner)
    yield _event(shown)
    quiet = 0.0
    while True:
        await asyncio.sleep(_NOW_PLAYING_POLL_SECONDS)
        quiet += _NOW_PLAYING_POLL_SECONDS
        latest = _player().state(owner)
        if now_playing.differs(shown, latest, paused=_player_paused):
            shown = latest
            yield _event(latest)
        if quiet >= _KEEPALIVE_SECONDS:
            quiet = 0.0
            still = await asyncio.to_thread(device_keys.resolve, presented_key)
            if still is None or device_keys.CONTROL not in still.scopes:
                return
            yield ": keepalive\n\n"


@v1_router.get(
    "/player/events",
    response_model=None,
    responses={
        **_REFUSALS,
        200: {
            "description": "Each `data:` line holds the same JSON as /player",
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        },
    },
    description=(
        "Server-sent events: the state at the start, then on every change but the position "
        "moving on. Lines starting with `:` are keepalives. Ends when the key is revoked."
    ),
)
async def get_player_events(
    owner: KeyOwner = _reading(device_keys.CONTROL),
    x_beacon_device_key: str = Header(max_length=200),
) -> StreamingResponse:
    _take_stream_place(owner)
    return _CountedStream(
        owner.key_id,
        _player_events(x_beacon_device_key, owner),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@v1_router.post(
    "/player/commands",
    response_model=schema.Done,
    responses={
        **_PLAYER_REFUSALS,
        422: {"description": "An unknown command, or one missing what it needs"},
        502: {"description": "The speaker or the desktop app did not carry it out"},
        503: {"description": "The desktop app's window is not connected"},
        504: {"description": "The desktop app did not answer in time"},
    },
    description=(
        "One command, answered once it has been carried out. `play_*` and `queue_*` need the "
        "library right."
    ),
)
async def post_player_command(
    request: Request,
    owner: KeyOwner = _reading(device_keys.CONTROL),
    x_beacon_device_key: str = Header(max_length=200),
) -> dict:
    cmd = await _parsed(request, schema.PlayerCommand, _MAX_COMMAND_BODY)
    if cmd.type in LIBRARY_COMMANDS:
        if device_keys.LIBRARY not in owner.scopes:
            raise HTTPException(status_code=403, detail="This key may not do that")
    elif cmd.type not in TRANSPORT_COMMANDS:
        raise HTTPException(status_code=422, detail="Unknown command")
    if server_link.AVAILABLE:
        await player_desktop.command(owner, cmd)
    else:
        # A server starts what it plays itself, with the key's own login.
        library = None
        if cmd.type in LIBRARY_COMMANDS:
            library = await _library_client(owner, x_beacon_device_key)
        await player_server.command(owner, cmd, library)
    return {"status": "ok"}


@v1_router.get(
    "/player/devices",
    response_model=schema.DeviceList,
    responses=_PLAYER_REFUSALS,
    description=(
        "The speakers this player can play on, for the `devices` command. `rescan=true` "
        "searches the network again, which takes a few seconds."
    ),
)
async def get_player_devices(
    rescan: bool = False,
    owner: KeyOwner = _reading(device_keys.CONTROL),
    x_beacon_device_key: str = Header(max_length=200),
) -> dict:
    if server_link.AVAILABLE:
        return await player_desktop.devices(owner, rescan)
    # The login only tells whether the account is an admin, which may decide
    # whether it can cast at all; a key without one gets the plain answer.
    library = None
    if device_keys.LIBRARY in owner.scopes:
        try:
            library = await _library_client(owner, x_beacon_device_key)
        except HTTPException:
            library = None
    return await player_server.devices(owner, rescan, library)


@v1_router.get(
    "/player/cover",
    response_model=None,
    responses={
        **_REFUSALS,
        200: {
            "description": "The image",
            "content": {"image/*": {"schema": {"type": "string", "format": "binary"}}},
        },
        404: {"description": "Nothing playing, or nothing to show for it"},
    },
    description=(
        "The cover of the song in the player, or the station's logo. The address stays the "
        "same: fetch it again when the song changes."
    ),
)
async def get_player_cover(
    size: int = Query(default=256, ge=16, le=1024),
    owner: KeyOwner = _picturing(device_keys.CONTROL),
) -> Response:
    response = await _player().cover(owner, size)
    response.headers["Cache-Control"] = "no-store"
    return response


# ── library ──────────────────────────────────────────────────────────────

# Per key, so a Plex client's looked-up music section is not looked up again
# on every request. Keyed by the login too: a new key has a new one.
_library_clients: dict[str, tuple[dict, object]] = {}

_LIBRARY_REFUSALS = {
    **_REFUSALS,
    409: {
        "description": "`media_login_rejected`: the media server no longer accepts the login "
        "this key was made with. Make a new key"
    },
    502: {"description": "The media server could not be reached"},
}


async def _library_client(owner: KeyOwner, presented: str):
    login = await asyncio.to_thread(device_keys.media_login_of, presented)
    if login is None:
        raise HTTPException(status_code=409, detail="media_login_rejected")
    cached = _library_clients.get(owner.key_id)
    if cached is not None and cached[0] == login:
        return cached[1]
    client = media_login.client_for(login)
    _library_clients[owner.key_id] = (login, client)
    return client


async def _library_media(
    owner: KeyOwner = _reading(device_keys.LIBRARY),
    x_beacon_device_key: str = Header(max_length=200),
):
    return await _library_client(owner, x_beacon_device_key)


async def _library_images(
    owner: KeyOwner = _picturing(device_keys.LIBRARY),
    x_beacon_device_key: str = Header(max_length=200),
):
    return await _library_client(owner, x_beacon_device_key)


async def _asked(lookup):
    """A refused login is the key's to fix; anything else is the server's."""
    try:
        return await lookup
    except Exception as e:
        if classify_login_error(e) in (REASON_REJECTED, REASON_FORBIDDEN):
            raise HTTPException(status_code=409, detail="media_login_rejected") from e
        logger.warning(f"[device-link] Library lookup failed: {e}")
        raise HTTPException(status_code=502, detail="The media server did not answer") from e


@v1_router.get(
    "/library/songs",
    response_model=schema.SongList,
    responses=_LIBRARY_REFUSALS,
    description="Songs matching `search`.",
)
async def get_library_songs(
    search: str = Query(min_length=1, max_length=200),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=_MAX_BATCH),
    media=Depends(_library_media),
) -> dict:
    return await _asked(app_library.songs(media, search, offset, limit))


@v1_router.get(
    "/library/albums",
    response_model=schema.AlbumList,
    responses=_LIBRARY_REFUSALS,
    description="Albums matching `search`, or every album by name without one. Page with "
    "`offset` until fewer than `limit` come back.",
)
async def get_library_albums(
    search: str = Query(default="", max_length=200),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=_MAX_BATCH),
    media=Depends(_library_media),
) -> dict:
    return await _asked(app_library.albums(media, search, offset, limit))


@v1_router.get(
    "/library/albums/{album_id}",
    response_model=schema.AlbumWithSongs,
    responses={**_LIBRARY_REFUSALS, 404: {"description": "No such album"}},
    description="An album and its songs, in order.",
)
async def get_library_album(album_id: str, media=Depends(_library_media)) -> dict:
    found = await _asked(app_library.album(media, album_id))
    if found is None:
        raise HTTPException(status_code=404, detail="No such album")
    return found


@v1_router.get(
    "/library/playlists",
    response_model=schema.PlaylistList,
    responses=_LIBRARY_REFUSALS,
    description="The playlists this account can see.",
)
async def get_library_playlists(media=Depends(_library_media)) -> dict:
    return await _asked(app_library.playlists(media))


@v1_router.get(
    "/library/playlists/{playlist_id}",
    response_model=schema.PlaylistWithSongs,
    responses={**_LIBRARY_REFUSALS, 404: {"description": "No such playlist"}},
    description="A playlist and its songs, in order.",
)
async def get_library_playlist(playlist_id: str, media=Depends(_library_media)) -> dict:
    found = await _asked(app_library.playlist(media, playlist_id))
    if found is None:
        raise HTTPException(status_code=404, detail="No such playlist")
    return found


@v1_router.get(
    "/library/radio-stations",
    response_model=schema.StationList,
    responses=_LIBRARY_REFUSALS,
    description="The radio stations kept on the media server, or on Beacon for one without.",
)
async def get_library_radio_stations(media=Depends(_library_media)) -> dict:
    return await _asked(app_library.radio_stations(media))


@v1_router.get(
    "/library/radio-stations/{station_id}/logo",
    response_model=None,
    responses={
        **_LIBRARY_REFUSALS,
        200: {
            "description": "The image",
            "content": {"image/*": {"schema": {"type": "string", "format": "binary"}}},
        },
        404: {"description": "No such station, or no logo found for it"},
    },
    description="The station's logo, found from its home page, at least `size` pixels when "
    "the station has one that large.",
)
async def get_library_station_logo(
    station_id: str,
    size: int = Query(default=128, ge=16, le=512),
    media=Depends(_library_images),
) -> Response:
    stations = (await _asked(app_library.radio_stations(media)))["items"]
    station = next((s for s in stations if s["id"] == station_id), None)
    if station is None or not station["home_page_url"]:
        raise HTTPException(status_code=404, detail="No logo for this station")
    return await radio_favicon(url=station["home_page_url"], min_size=size, hint="")


@v1_router.get(
    "/library/cover/{cover_art_id}",
    response_model=None,
    responses={
        **_LIBRARY_REFUSALS,
        200: {
            "description": "The image",
            "content": {"image/*": {"schema": {"type": "string", "format": "binary"}}},
        },
        404: {"description": "No such cover"},
    },
    description="A cover by the `cover_art_id` of a song, album or playlist above.",
)
async def get_library_cover(cover_art_id: str, media=Depends(_library_images)) -> Response:
    return await cover_image(media, cover_art_id)


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


@router.get("/charts")
def get_charts(period: Period = "all_time", owner: KeyOwner = _syncing) -> dict:
    """The Stats charts over one window, for a paired desktop. Like the other
    routes outside v1 this one is private to the desktop app."""
    return play_history.period_charts(owner.account, period)


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
async def create_device_key(
    new_key: NewKey, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    account = _require_account(session)
    # AVAILABLE means this is a desktop app, which pairs with a server itself.
    if server_link.AVAILABLE and device_keys.SERVER_ONLY_SCOPES & set(new_key.scopes):
        raise HTTPException(status_code=422, detail="Invalid scopes")
    try:
        made = await asyncio.to_thread(
            device_keys.create,
            account,
            new_key.label,
            device_keys.settings_identity_of(session),
            scopes=new_key.scopes,
            login=media_login.capture(session.media),
            session_id=session.session_id,
        )
    except device_keys.InvalidScopes as e:
        raise HTTPException(status_code=422, detail="Invalid scopes") from e
    except device_keys.TooManyKeys as e:
        raise HTTPException(status_code=409, detail="Too many device keys") from e
    await mdns.sync()
    return made


@keys_router.delete("/{key_id}")
async def delete_device_key(
    key_id: str, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    revoked = await asyncio.to_thread(device_keys.revoke, _require_account(session), key_id)
    if not revoked:
        raise HTTPException(status_code=404, detail="No such key")
    # Its decrypted login goes with it. Music it started plays on, as any
    # cast does after its window closed.
    _library_clients.pop(key_id, None)
    player_server.forget_key(key_id)
    await mdns.sync()
    return {"status": "ok"}
