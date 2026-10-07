"""routes/party.py - Party mode (see core/party.py for the model).

Two routers, two trust boundaries:
- `host_router` (/party-host/*, CONNECT_TOKEN): the desktop starts, ends and
  configures the party. Deliberately outside /party/, so a reverse proxy
  that lets /party/ past its login exposes none of it.
- `router` (/party/*): everything a guest touches - the page, its assets,
  the API and cover art. The only credential accepted here is the guest
  cookie (and the invite token, at /party/api/join only); CONNECT_TOKEN, the
  phone password and the integration key mean nothing under this prefix.

Guests never send a command type of their own. Each endpoint below builds
the one relay command it stands for, so the renderer only ever sees
party-wish, party-withdraw and - when a skip vote passes - next.
"""

import asyncio
import json
import logging
import re
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)
from pydantic import BaseModel

from core import fanart, party_library, party_queue, waveform
from core.audio_fanout import send_sentinel
from core.auth import require_token
from core.party import (
    DEFAULT_DURATION_HOURS,
    MAX_STREAMS_PER_GUEST,
    MAX_STREAMS_TOTAL,
    Guest,
    clean_name,
    listen_kbps_allowed,
    party,
)
from core.party_broadcast import Broadcaster
from core.session import registry
from core.state import PORT, get_local_ip
from core.trusted_proxies import client_ip, is_trusted_proxy
from routes.coverart import cover_image
from routes.radio import radio_favicon
from routes.remote import app_file_response, relay_command, relay_query, static_dir
from routes.stream import advance_now

logger = logging.getLogger("connect.party")

COOKIE_NAME = "beacon_party"

# Per guest unless noted: (hits, window in seconds).
JOIN_FAILURES_PER_IP = (10, 600)
JOINS_PER_IP = (20, 600)
WISHES = (10, 60)
WITHDRAWALS = (20, 60)
VOTES = (20, 60)
SEARCHES = (60, 60)
COVERS = (600, 60)
LYRICS = (30, 60)
WAVEFORMS = (30, 60)
MAX_VISUALIZER_STREAMS = 50
# Listening along. Two per guest, so a reconnect can open the new stream
# before the old one is noticed gone; a third ends the oldest instead.
MAX_LISTEN_PER_GUEST = 2
MAX_LISTEN_STREAMS = 50

# Ids as the media servers hand them out (Navidrome's hex, Jellyfin's GUIDs,
# Plex's rating keys, versions appended with "_") - and nothing that could
# turn into a path or a query once it reaches one of them.
_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
SEARCH_MAX_LENGTH = 100
PAGE_MAX = 50

# Relay errors the renderer raises on purpose (see stores/party.ts), and
# what a guest should see for each.
_REFUSALS = {
    "limit": 409,
    "duplicate": 409,
    "not-found": 404,
    "forbidden": 403,
    "radio": 409,
}

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
        "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
        "form-action 'self'"
    ),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


def is_party_path(path: str) -> bool:
    return path == "/party" or path.startswith("/party/")


async def add_security_headers(request: Request, call_next):
    """Middleware (see main.py): every /party/ answer, errors included,
    carries the headers above. CORS is stripped here as well - the guest
    page is same-origin by construction and no other site has any business
    reading these answers."""
    response = await call_next(request)
    if is_party_path(request.url.path):
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        for name in list(response.headers.keys()):
            if name.lower().startswith("access-control-"):
                del response.headers[name]
    return response


# ── Host (desktop, CONNECT_TOKEN) ───────────────────────────────────────────

host_router = APIRouter(prefix="/party-host", dependencies=[Depends(require_token)])


class EnableRequest(BaseModel):
    duration_hours: float = DEFAULT_DURATION_HOURS
    max_pending_per_guest: int = 3
    skip_ratio: float = 0.5
    listen_kbps: int = 0
    tab_id: str = ""


class ClaimRequest(BaseModel):
    tab_id: str


def _check_tab_id(tab_id: str) -> str | None:
    if not tab_id:
        return None
    if not _ID.match(tab_id):
        raise HTTPException(status_code=422, detail="Invalid tab id")
    return tab_id


class SettingsRequest(BaseModel):
    max_pending_per_guest: int
    skip_ratio: float
    listen_kbps: int = 0


def _apply_settings(max_pending: int, skip_ratio: float, listen_kbps: int) -> None:
    if not listen_kbps_allowed(listen_kbps):
        raise HTTPException(status_code=422, detail="Unsupported listen-along bitrate")
    party.settings.max_pending_per_guest = min(max(max_pending, 1), 50)
    party.settings.skip_ratio = min(max(skip_ratio, 0.0), 1.0)
    if listen_kbps != party.settings.listen_kbps:
        party.settings.listen_kbps = listen_kbps
        # Guests listening reconnect to a stream at the new bitrate, or hear
        # the end of it.
        party.stop_listening()
        party.rebuild()


def _host_status() -> dict:
    return {
        "enabled": party.is_active(),
        "expires_at": party.expires_at if party.enabled else None,
        "lan_ip": get_local_ip(),
        "port": PORT,
        "guests": party.guest_list(),
        "max_pending_per_guest": party.settings.max_pending_per_guest,
        "skip_ratio": party.settings.skip_ratio,
        "listen_kbps": party.settings.listen_kbps,
        "listeners": party.listeners if party.enabled else 0,
        "host_tab": party.host_tab if party.enabled else None,
    }


@host_router.post("/enable")
async def enable_party(req: EnableRequest):
    tab_id = _check_tab_id(req.tab_id)
    if not listen_kbps_allowed(req.listen_kbps):
        raise HTTPException(status_code=422, detail="Unsupported listen-along bitrate")
    token = party.enable(req.duration_hours)
    party.host_tab = tab_id
    _apply_settings(req.max_pending_per_guest, req.skip_ratio, req.listen_kbps)
    await party.broadcast()
    return {"token": token, **_host_status()}


@host_router.post("/rotate")
async def rotate_party():
    if not party.is_active():
        raise HTTPException(status_code=404)
    token = party.rotate()
    await party.broadcast()
    return {"token": token, **_host_status()}


@host_router.post("/disable")
async def disable_party():
    party.disable()
    await party.broadcast()
    return {"success": True}


@host_router.post("/claim")
async def claim_party(req: ClaimRequest):
    """This window answers guests from now on - see PartyState.host_tab. The
    one that did until now notices on its next status poll and lets go.

    With the invite token, like /enable and /rotate: the window taking over
    has to be able to show the code to more guests, and renewing the link
    instead would sign out everyone already there. Only the explicit
    actions hand it out; /status never does."""
    if not party.is_active():
        raise HTTPException(status_code=404)
    party.host_tab = _check_tab_id(req.tab_id)
    return {"token": party.invite_token, **_host_status()}


@host_router.get("/status")
async def party_status():
    # Never the invite token: only /enable, /rotate and /claim hand it out,
    # the same rule /remote/status follows for the phone password.
    return _host_status()


@host_router.post("/settings")
async def update_settings(req: SettingsRequest):
    _apply_settings(req.max_pending_per_guest, req.skip_ratio, req.listen_kbps)
    await party.broadcast()
    return _host_status()


class LyricsRequest(BaseModel):
    song_id: str
    synced: bool = False
    offset: float = 0.0
    lines: list[dict] = []


@host_router.post("/lyrics")
async def push_lyrics(req: LyricsRequest):
    """The host's lyrics for the song playing - the match and the sync
    offset it chose - for guests to read along with."""
    party.set_lyrics(req.song_id, req.synced, req.offset, req.lines)
    return {"success": True}


@host_router.delete("/guests/{guest_id}")
async def kick_guest(guest_id: str):
    if not party.kick(guest_id):
        raise HTTPException(status_code=404)
    await party.broadcast()
    return _host_status()


# ── Guests (/party/*) ───────────────────────────────────────────────────────

router = APIRouter(prefix="/party")


def _ip(request: Request) -> str:
    peer = request.client.host if request.client else "unknown"
    return client_ip(peer, request.headers.get("x-forwarded-for"))


def _is_https(request: Request) -> bool:
    if request.url.scheme == "https":
        return True
    peer = request.client.host if request.client else ""
    forwarded = request.headers.get("x-forwarded-proto", "")
    return is_trusted_proxy(peer) and forwarded.split(",")[0].strip().lower() == "https"


def _require_active() -> None:
    # 404 rather than 401 while there is no party: a switched-off feature
    # should look like nothing is there at all.
    if not party.is_active():
        raise HTTPException(status_code=404)


def require_same_origin(request: Request) -> None:
    """SameSite=Strict already keeps the cookie off cross-site requests;
    this is the second lock on everything that changes something. An
    Origin that is present has to be this host - a browser always sends one
    with a POST/DELETE fetch, so only non-browser clients get by without."""
    origin = request.headers.get("origin")
    if origin is None:
        return
    host = request.headers.get("host", "")
    if origin == "null" or urlsplit(origin).netloc.lower() != host.lower():
        raise HTTPException(status_code=403, detail="Cross-origin request refused")


def require_guest(request: Request) -> Guest:
    _require_active()
    guest = party.guest(request.cookies.get(COOKIE_NAME))
    if guest is None:
        raise HTTPException(status_code=401, detail="Not joined")
    return guest


def _limit(key: str, rule: tuple[int, int]) -> None:
    if not party.limiter.hit(key, *rule):
        raise HTTPException(status_code=429, detail="Too many requests - slow down")


def _check_id(value: str) -> str:
    if not _ID.match(value):
        raise HTTPException(status_code=400, detail="Invalid id")
    return value


class JoinRequest(BaseModel):
    token: str
    name: str


@router.post("/api/join", dependencies=[Depends(require_same_origin)])
async def join(req: JoinRequest, request: Request):
    _require_active()
    ip = _ip(request)
    if party.limiter.exceeded(f"join-fail:{ip}", *JOIN_FAILURES_PER_IP):
        raise HTTPException(status_code=429, detail="Too many attempts - try again later")
    if not party.token_matches(req.token[:200]):
        party.limiter.hit(f"join-fail:{ip}", *JOIN_FAILURES_PER_IP)
        raise HTTPException(status_code=401, detail="This party link is no longer valid")
    name = clean_name(req.name)
    if name is None:
        raise HTTPException(status_code=400, detail="Please enter a name")
    if party.has_guest_named(name):
        raise HTTPException(status_code=409, detail="That name is taken")
    _limit(f"join:{ip}", JOINS_PER_IP)
    joined = party.join(name, ip)
    if joined is None:
        raise HTTPException(status_code=503, detail="This party is full")
    sid, guest = joined
    await party.broadcast()
    response = JSONResponse({"name": guest.name})
    response.set_cookie(
        COOKIE_NAME,
        sid,
        max_age=max(int(party.expires_at - time.time()), 60),
        path="/party",
        httponly=True,
        samesite="strict",
        secure=_is_https(request),
    )
    return response


@router.post("/api/leave", dependencies=[Depends(require_same_origin)])
async def leave(request: Request):
    sid = request.cookies.get(COOKIE_NAME)
    guest = party.guest(sid)
    if guest is not None:
        party.kick(guest.guest_id)
        await party.broadcast()
    response = JSONResponse({"success": True})
    response.delete_cookie(COOKIE_NAME, path="/party")
    return response


@router.get("/api/state")
async def get_state(guest: Guest = Depends(require_guest)):
    return party.personalise(guest)


@router.get("/api/events")
async def guest_events(request: Request, guest: Guest = Depends(require_guest)):
    total = sum(party.streams.values())
    if party.streams.get(guest.guest_id, 0) >= MAX_STREAMS_PER_GUEST or total >= MAX_STREAMS_TOTAL:
        raise HTTPException(status_code=429, detail="Too many open connections")
    queue = party.event_bus.subscribe()
    party.streams[guest.guest_id] = party.streams.get(guest.guest_id, 0) + 1
    sid = request.cookies.get(COOKIE_NAME)

    async def generator():
        try:
            yield "retry: 3000\n\n"
            # Someone arriving changes the skip threshold for everyone.
            await party.broadcast()
            yield f"data: {json.dumps(party.personalise(guest))}\n\n"
            while True:
                try:
                    await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    # A party that ran out of time ends without a broadcast.
                    if party.guest(sid) is not None:
                        yield ": heartbeat\n\n"
                        continue
                # Ended, renewed or kicked: tell the page once and hang up.
                if party.guest(sid) is None:
                    yield 'data: {"ended": true}\n\n'
                    return
                yield f"data: {json.dumps(party.personalise(guest))}\n\n"
        finally:
            party.event_bus.unsubscribe(queue)
            party.streams[guest.guest_id] -= 1
            if party.streams[guest.guest_id] <= 0:
                party.streams.pop(guest.guest_id, None)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


def _search_params(search: str, offset: int, limit: int) -> dict:
    return {
        "search": search.strip()[:SEARCH_MAX_LENGTH],
        "offset": max(offset, 0),
        "limit": min(max(limit, 1), PAGE_MAX),
    }


async def _library(query: str, params: dict, from_server) -> dict:
    """A guest's library lookup: answered by the media server while the host
    casts, so it works while the host's window sleeps, and by that window
    otherwise (see core/party_library.py)."""
    session = party.host_cast()
    if session is None:
        return await relay_query(query, params)
    try:
        result = await from_server(session.media)
    except Exception as e:
        logger.warning(f"[party] {query} from the media server failed: {e}")
        raise HTTPException(status_code=503, detail="The music server is not answering") from e
    # Songs a guest may wish for next: their titles are known from here on
    # when they turn up in the cast queue (see PartyState.songs).
    songs = result.get("items", []) if query == "songs-request" else result.get("songs", [])
    for song in songs:
        party.remember_song(song)
    return result


@router.get("/api/songs")
async def search_songs(
    search: str = "", offset: int = 0, limit: int = 30, guest: Guest = Depends(require_guest)
):
    _limit(f"search:{guest.guest_id}", SEARCHES)
    params = _search_params(search, offset, limit)
    result = await _library(
        "songs-request",
        params,
        lambda media: party_library.search_songs(
            media, params["search"], params["offset"], params["limit"]
        ),
    )
    return {
        "items": [party.guest_song(s) for s in result.get("items", [])],
        "total": result.get("total", 0),
    }


@router.get("/api/albums")
async def search_albums(
    search: str = "", offset: int = 0, limit: int = 30, guest: Guest = Depends(require_guest)
):
    _limit(f"search:{guest.guest_id}", SEARCHES)
    params = _search_params(search, offset, limit)
    result = await _library(
        "albums-request",
        params,
        lambda media: party_library.search_albums(
            media, params["search"], params["offset"], params["limit"]
        ),
    )
    return {
        "items": [party.guest_album(a) for a in result.get("items", [])],
        "total": result.get("total", 0),
    }


@router.get("/api/albums/{album_id}")
async def get_album(album_id: str, guest: Guest = Depends(require_guest)):
    _limit(f"search:{guest.guest_id}", SEARCHES)
    album_id = _check_id(album_id)
    result = await _library(
        "album-request",
        {"albumId": album_id},
        lambda media: party_library.get_album(media, album_id),
    )
    album = result.get("album")
    if not album:
        raise HTTPException(status_code=404)
    return {
        "album": party.guest_album(album),
        "songs": [party.guest_song(s) for s in result.get("songs", [])],
    }


async def _on_cast(edit) -> None:
    """A wish or withdrawal applied to the host's cast queue by connect
    itself (core/party_queue.py), told to the guests straight away."""
    try:
        await edit
    except party_queue.Refusal as e:
        raise HTTPException(status_code=_REFUSALS[e.code], detail=e.code) from e
    party.rebuild()
    await party.broadcast()


async def _relay_guest_command(command_type: str, payload: dict) -> None:
    try:
        await relay_command(command_type, payload)
    except HTTPException as e:
        status = _REFUSALS.get(str(e.detail))
        if status is None:
            raise
        raise HTTPException(status_code=status, detail=str(e.detail))


class WishRequest(BaseModel):
    song_id: str


@router.post("/api/wishes", dependencies=[Depends(require_same_origin)])
async def wish(req: WishRequest, guest: Guest = Depends(require_guest)):
    _limit(f"wish:{guest.guest_id}", WISHES)
    session = party.host_cast()
    if session is not None:
        await _on_cast(
            party_queue.wish(
                party,
                session,
                _check_id(req.song_id),
                guest.guest_id,
                guest.name,
                secrets.token_urlsafe(12),
            )
        )
        return {"success": True}
    await _relay_guest_command(
        "party-wish",
        {
            "songId": _check_id(req.song_id),
            "guestId": guest.guest_id,
            "guestName": guest.name,
            "maxPending": party.settings.max_pending_per_guest,
        },
    )
    return {"success": True}


@router.delete("/api/wishes/{request_id}", dependencies=[Depends(require_same_origin)])
async def withdraw(request_id: str, guest: Guest = Depends(require_guest)):
    _limit(f"withdraw:{guest.guest_id}", WITHDRAWALS)
    session = party.host_cast()
    if session is not None:
        await _on_cast(party_queue.withdraw(party, session, _check_id(request_id), guest.guest_id))
        return {"success": True}
    await _relay_guest_command(
        "party-withdraw", {"requestId": _check_id(request_id), "guestId": guest.guest_id}
    )
    return {"success": True}


@router.post("/api/skip", dependencies=[Depends(require_same_origin)])
async def vote_skip(guest: Guest = Depends(require_guest)):
    _limit(f"vote:{guest.guest_id}", VOTES)
    if not party.can_skip():
        raise HTTPException(status_code=409, detail="Skipping is not available right now")
    if party.vote(guest.guest_id):
        # The skip happens before the broadcast so nobody sees the counter
        # reset for a song that is still playing. While the host casts,
        # connect skips itself - the host's window may be asleep.
        session = party.host_cast()
        if session is not None:
            await advance_now(session)
        else:
            await relay_command("next", {})
    await party.broadcast()
    return {"success": True}


@router.delete("/api/skip", dependencies=[Depends(require_same_origin)])
async def unvote_skip(guest: Guest = Depends(require_guest)):
    _limit(f"vote:{guest.guest_id}", VOTES)
    party.unvote(guest.guest_id)
    await party.broadcast()
    return {"success": True}


@router.get("/api/cover")
async def cover(id: str = Query(...), guest: Guest = Depends(require_guest)):
    """Only artwork a guest has been shown (core/party.py's
    remember_cover), and only as bytes - see routes/coverart.py's
    cover_image for why never a redirect."""
    _limit(f"cover:{guest.guest_id}", COVERS)
    if id not in party.covers:
        raise HTTPException(status_code=404)
    session = registry.get(party.host_session_id) if party.host_session_id else None
    if session is None or session.media is None:
        raise HTTPException(status_code=404)
    return await cover_image(session.media, id)


# The size the app's own Now Playing asks for (NowPlayingView.vue), so a
# guest gets the logo the host's lookup already resolved and cached.
RADIO_LOGO_SIZE = 512


@router.get("/api/radio-logo")
async def radio_logo(guest: Guest = Depends(require_guest)):
    """The playing station's logo, as bytes. Takes no address: what is
    looked up is the host's station or nothing (`k` in the URL is only
    there to change it per station)."""
    _limit(f"cover:{guest.guest_id}", COVERS)
    if party.radio_logo is None:
        raise HTTPException(status_code=404)
    homepage, hint = party.radio_logo
    return await radio_favicon(url=homepage, min_size=RADIO_LOGO_SIZE, hint=hint)


# Waveform decodes already running, by song: guests of one party all ask for
# the same song at the same moment, and share one decode. Dropped as soon as
# it is done - waveforms are never kept (see core/waveform.py).
_waveforms_running: dict[str, asyncio.Task] = {}


async def _decode_waveform(song_id: str) -> list[float]:
    url = await party._stream_url(song_id)
    return await waveform.get_waveform(song_id, url) if url else []


@router.get("/api/waveform")
async def guest_waveform(id: str = Query(...), guest: Guest = Depends(require_guest)):
    """The seek-bar waveform of a song playing now - the host's current one
    or the one a guest listening along still hears. Nothing else."""
    song_id = _check_id(id)
    _limit(f"waveform:{guest.guest_id}", WAVEFORMS)
    if song_id not in party.playing_song_ids():
        raise HTTPException(status_code=404)
    task = _waveforms_running.get(song_id)
    if task is None:
        task = asyncio.create_task(_decode_waveform(song_id))
        _waveforms_running[song_id] = task
        task.add_done_callback(lambda _: _waveforms_running.pop(song_id, None))
    return {"peaks": await asyncio.shield(task)}


@router.get("/api/lyrics")
async def lyrics(guest: Guest = Depends(require_guest)):
    """The playing song's lyrics as the host has them. Nothing a guest
    names is looked up - this is the host's copy or nothing."""
    _limit(f"lyrics:{guest.guest_id}", LYRICS)
    current = party.current_lyrics()
    if current is None:
        return {"song_id": None, "synced": False, "offset": 0.0, "lines": []}
    return current


@router.get("/api/backdrop")
async def backdrop(index: int | None = None, guest: Guest = Depends(require_guest)):
    """One of the playing artist's Fanart.tv backgrounds, from connect's own
    Fanart.tv cache: the one the host shows, or - for a guest stepping
    through them - one of the host's list by position. Never a URL a guest
    names."""
    _limit(f"cover:{guest.guest_id}", COVERS)
    if index is None:
        url = party.backdrop_url
    elif 0 <= index < len(party.backdrop_urls):
        url = party.backdrop_urls[index]
    else:
        url = None
    if not url:
        raise HTTPException(status_code=404)
    data = fanart.get_cached_image(url)
    if data is None:
        fetched = await fanart.fetch_image(url)
        if fetched is None:
            raise HTTPException(status_code=404)
        data, _content_type = fetched
        fanart.store_image(url, data)
    return Response(
        content=data,
        media_type=fanart.content_type_for(url),
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/api/visualizer")
async def visualizer(guest: Guest = Depends(require_guest)):
    """The bars while the host casts - see core/party.py's
    watch_visualizer. Idle comments otherwise, so the page can tell a
    quiet stream from a dropped one."""
    if len(party.visualizer_queues) >= MAX_VISUALIZER_STREAMS:
        raise HTTPException(status_code=429, detail="Too many open connections")
    queue = party.watch_visualizer()

    async def generator():
        try:
            yield "retry: 3000\n\n"
            while party.guest_alive(guest):
                try:
                    bands = await asyncio.wait_for(queue.get(), timeout=1.0)
                except TimeoutError:
                    yield ": idle\n\n"
                    continue
                yield f"data: {json.dumps({'bands': [round(b, 3) for b in bands]})}\n\n"
        finally:
            party.unwatch_visualizer(queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@dataclass
class _Listener:
    guest_id: str
    broadcaster: Broadcaster
    queue: asyncio.Queue
    opened_at: float


# Open listen-along streams, by the connection id the page made up for each.
_listeners: dict[str, _Listener] = {}


def _end_listener(conn: str) -> None:
    listener = _listeners.pop(conn, None)
    if listener is not None:
        listener.broadcaster.unsubscribe(listener.queue)
        send_sentinel(listener.queue)


@router.get("/api/listen")
async def listen(request: Request, c: str = Query(...), guest: Guest = Depends(require_guest)):
    """The live stream of what the host hears (core/party_broadcast.py).
    `c` is an id the page makes up for this one connection, to ask
    /api/listen/start where in the stream its audio begins."""
    conn = _check_id(c)
    existing = _listeners.get(conn)
    if existing is not None:
        if existing.guest_id != guest.guest_id:
            raise HTTPException(status_code=409, detail="Connection id in use")
        # The same player asking again: Safari probes a media URL with a
        # two-byte range request and then fetches it once more. The newer
        # request is the one that plays.
        _end_listener(conn)
    mine = sorted(
        (key for key, value in _listeners.items() if value.guest_id == guest.guest_id),
        key=lambda key: _listeners[key].opened_at,
    )
    while len(mine) >= MAX_LISTEN_PER_GUEST:
        _end_listener(mine.pop(0))
    if len(_listeners) >= MAX_LISTEN_STREAMS:
        raise HTTPException(status_code=429, detail="Too many open connections")
    broadcaster = await party.listen()
    if broadcaster is None:
        raise HTTPException(status_code=404)
    queue = broadcaster.subscribe()
    _listeners[conn] = _Listener(guest.guest_id, broadcaster, queue, time.monotonic())
    label = f"guest {guest.guest_id} conn {conn[:6]}"
    logger.info(
        f"[party] Listening along: {label}, range={request.headers.get('range') or '-'}, "
        f"{(request.headers.get('user-agent') or '-')[:80]}"
    )

    async def generator():
        sent = 0
        opened = time.monotonic()
        try:
            while party.guest_alive(guest):
                try:
                    chunk = await asyncio.wait_for(queue.get(), timeout=5.0)
                except TimeoutError:
                    continue
                if chunk is None:
                    return
                sent += len(chunk)
                yield chunk
        finally:
            if _listeners.get(conn) is not None and _listeners[conn].queue is queue:
                _end_listener(conn)
            logger.info(
                f"[party] Stopped listening along: {label} after "
                f"{time.monotonic() - opened:.1f}s, {sent // 1024} KiB sent"
            )

    return StreamingResponse(
        generator(),
        media_type="audio/aac",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/api/listen/start")
async def listen_start(c: str = Query(...), guest: Guest = Depends(require_guest)):
    """Where connection `c`'s audio begins, in stream time - null until
    its first audio has been handed to it."""
    listener = _listeners.get(_check_id(c))
    if listener is None or listener.guest_id != guest.guest_id:
        raise HTTPException(status_code=404)
    return {
        "epoch": listener.broadcaster.epoch,
        "start": listener.broadcaster.start_time(listener.queue),
    }


_listen_visualizers = 0


@router.get("/api/listen/visualizer")
async def listen_visualizer(guest: Guest = Depends(require_guest)):
    """The bars for a guest listening along, from the stream's own audio:
    batches of [stream time, bands], which the page shows once it hears
    that stream time. Counted against the same cap as /api/visualizer."""
    global _listen_visualizers
    if len(party.visualizer_queues) + _listen_visualizers >= MAX_VISUALIZER_STREAMS:
        raise HTTPException(status_code=429, detail="Too many open connections")
    broadcaster = party.broadcaster
    if broadcaster is None or broadcaster.stopped:
        raise HTTPException(status_code=404)
    queue = broadcaster.watch_bands()
    _listen_visualizers += 1

    async def generator():
        global _listen_visualizers
        try:
            yield "retry: 3000\n\n"
            while party.guest_alive(guest):
                try:
                    frames = await asyncio.wait_for(queue.get(), timeout=1.0)
                except TimeoutError:
                    yield ": idle\n\n"
                    continue
                if frames is None:
                    return
                payload = {
                    "epoch": broadcaster.epoch,
                    "frames": [[round(t, 3), [round(b, 2) for b in bands]] for t, bands in frames],
                }
                yield f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"
        finally:
            broadcaster.unwatch_bands(queue)
            _listen_visualizers -= 1

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


# ── Guest page ───────────────────────────────────────────────────────────

# The page is its own Vue build (src/party/, built into static/party/ by
# `pnpm build:party`). The two icons are the phone remote's, by explicit
# name: nothing else of the remote is reachable from here, so /party/
# exposes nothing a reverse proxy rule did not mean to.
_SHARED = {
    "icon-192.png": "remote/icon-192.png",
    "apple-touch-icon.png": "remote/apple-touch-icon.png",
}

# Stands in index.html for the per-response nonce below.
NONCE_PLACEHOLDER = "__CSP_NONCE__"


def party_static() -> Path:
    return static_dir().parent / "party"


def _resolve_page_file(path: str) -> Path | None:
    if path in _SHARED:
        return static_dir().parent / _SHARED[path]
    root = party_static().resolve()
    requested = (root / path).resolve()
    if root not in requested.parents:
        return None
    return requested if requested.is_file() else None


def _page_response(index: Path) -> Response:
    """index.html with a fresh nonce. Vuetify writes its theme into a
    <style> element at runtime; rather than allowing inline styles across
    the board, the CSP allows exactly the one carrying this nonce, which
    the page hands to Vuetify (src/party/main.ts)."""
    nonce = secrets.token_urlsafe(16)
    html = index.read_text(encoding="utf-8").replace(NONCE_PLACEHOLDER, nonce)
    csp = SECURITY_HEADERS["Content-Security-Policy"].replace(
        "style-src 'self'", f"style-src 'self' 'nonce-{nonce}'"
    )
    return HTMLResponse(
        html,
        headers={"Content-Security-Policy": csp, "Cache-Control": "no-store"},
    )


@router.api_route("/{path:path}", methods=["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def nothing_else(path: str):
    """Anything not routed above ends here rather than in proxy_router's
    catch-all, so nothing under /party/ ever reaches a handler meant for
    the app."""
    raise HTTPException(status_code=404)


@router.get("")
async def redirect_to_trailing_slash():
    _require_active()
    return RedirectResponse(url="/party/", status_code=308)


@router.get("/{path:path}")
async def serve_page(path: str = "", if_none_match: str | None = Header(default=None)):
    _require_active()
    if path.startswith("api/"):
        raise HTTPException(status_code=404)
    target = _resolve_page_file(path) if path and path != "index.html" else None
    if target is not None:
        return app_file_response(target, if_none_match)
    # Only the page itself falls back - an unknown asset is a 404, not the
    # page under the wrong content type.
    if path and path != "index.html" and "." in path.rsplit("/", 1)[-1]:
        raise HTTPException(status_code=404)
    index = party_static() / "index.html"
    if not index.is_file():
        raise HTTPException(status_code=404)
    return _page_response(index)
