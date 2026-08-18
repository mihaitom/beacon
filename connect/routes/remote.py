"""routes/remote.py — Remote Control: lets a phone on the LAN control this
Beacon instance's own local playback.

Two trust boundaries, two dependencies:
- `require_token` (core/auth.py's CONNECT_TOKEN) gates the control plane
  (/enable, /disable, /status, /keepalive) and the renderer-relay endpoints
  (/agent-events, /state POST, /query-response) — all machine-to-machine,
  called only by Electron's own renderer.
- `require_remote_password` (below) gates everything a phone talks to —
  a *different*, human-typed-into-an-untrusted-device credential (see
  core/remote.py's module docstring). Nothing here ever accepts
  X-Connect-Token as an alternative to it.

Command/query relay: the renderer is the only thing that can actually control
local playback (all of it lives in the Pinia stores — connect has no IPC into
Electron's renderer process), so every phone-issued command/query is relayed
via RemoteState's two EventBuses exactly like an SSE status push, just with
the roles reversed — see core/remote.py's RemoteState docstring.
"""

import asyncio
import json
import logging
import secrets
import sys
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from core.auth import require_token
from core.remote import remote
from core.session import SessionState, get_session
from core.state import get_local_ip, PORT
from routes.radio import radio_favicon as _fetch_radio_favicon

logger = logging.getLogger("connect.remote")
router = APIRouter(prefix="/remote")

# How long a phone-issued data query (tracks/playlists/radio-stations) waits
# for the renderer to answer via POST /query-response before giving up.
QUERY_TIMEOUT = 8.0


def _static_dir() -> Path:
    # PyInstaller (onedir or onefile) sets sys._MEIPASS to the bundle's
    # resource directory — packaging/connect-server.spec bundles static/
    # there (see its `datas`). In dev, this file lives at connect/routes/
    # remote.py, so parent.parent is connect/ itself.
    base = Path(sys._MEIPASS) if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent
    return base / "static" / "remote"


def require_remote_password(
    x_remote_password: str | None = Header(default=None),
    password: str | None = Query(default=None),
) -> None:
    """FastAPI dependency for every phone-facing endpoint below. 404s
    (not 401) when the feature is off — a disabled feature should be
    unreachable, not merely unauthenticated. EventSource can't set custom
    headers, hence the ?password= fallback — same reasoning as
    core/auth.py's require_token ?token= fallback."""
    if not remote.enabled or not remote.password:
        raise HTTPException(status_code=404)
    provided = x_remote_password or password
    if not provided or not secrets.compare_digest(provided, remote.password):
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── Control plane (renderer -> connect, CONNECT_TOKEN) ──────────────────────


@router.post("/enable", dependencies=[Depends(require_token)])
async def enable_remote():
    password, pin = remote.enable()
    return {"password": password, "pin": pin, "lan_ip": get_local_ip(), "port": PORT}


@router.post("/disable", dependencies=[Depends(require_token)])
async def disable_remote():
    remote.disable()
    return {"success": True}


@router.get("/status", dependencies=[Depends(require_token)])
async def remote_status():
    # Never re-serves `password` — only /enable's direct response does, so a
    # renderer that lost its copy (e.g. app restarted) can't silently pull it
    # back out of /status; see stores/remoteControl.ts's own comment on why
    # it treats that as "needs to regenerate", not "fetch and continue".
    return {
        "enabled": remote.enabled,
        "pin": remote.pin if remote.enabled else None,
        "lan_ip": get_local_ip(),
        "port": PORT,
    }


@router.post("/keepalive", dependencies=[Depends(require_token)])
async def remote_keepalive():
    remote.touch_keepalive()
    return {"success": True}


# ── Renderer-facing relay (renderer <-> connect, CONNECT_TOKEN) ─────────────


class StateSnapshotRequest(BaseModel):
    snapshot: dict


class QueryResponseRequest(BaseModel):
    request_id: str
    data: dict


@router.post("/state", dependencies=[Depends(require_token)])
async def push_state(req: StateSnapshotRequest):
    remote.snapshot = req.snapshot
    await remote.event_bus.broadcast(req.snapshot)
    return {"success": True}


@router.post("/query-response", dependencies=[Depends(require_token)])
async def query_response(req: QueryResponseRequest):
    remote.resolve_pending(req.request_id, req.data)
    return {"success": True}


@router.get("/agent-events", dependencies=[Depends(require_token)])
async def agent_events():
    """The renderer's single long-lived SSE subscription — carries both
    playback commands and data-query requests issued by phones. Flips
    renderer_connected for the duration of the connection so phone-facing
    endpoints can fail fast (503) instead of hanging when nothing is
    listening (e.g. Beacon quit but connect is still running in dev)."""
    queue = remote.command_bus.subscribe()
    remote.renderer_connected = True

    async def generator():
        try:
            yield "retry: 2000\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(payload)}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            remote.command_bus.unsubscribe(queue)
            remote.renderer_connected = False

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Phone-facing: pairing ────────────────────────────────────────────────


class LoginRequest(BaseModel):
    pin: str


@router.post("/login")
async def remote_login(req: LoginRequest, request: Request):
    if not remote.enabled or not remote.pin:
        raise HTTPException(status_code=404)

    ip = request.client.host if request.client else "unknown"
    if remote.is_locked_out(ip):
        raise HTTPException(status_code=429, detail="Too many attempts — try again later")

    if not secrets.compare_digest(req.pin, remote.pin):
        remote.record_failed_attempt(ip)
        raise HTTPException(status_code=401, detail="Incorrect PIN")

    remote.clear_attempts(ip)
    return {"password": remote.password}


# ── Phone-facing: state + commands (require_remote_password) ───────────────


class CommandRequest(BaseModel):
    type: str
    payload: dict = {}


@router.get("/state", dependencies=[Depends(require_remote_password)])
async def get_state():
    return remote.snapshot


@router.get("/events", dependencies=[Depends(require_remote_password)])
async def phone_events():
    queue = remote.event_bus.subscribe()

    async def generator():
        try:
            yield "retry: 2000\n\n"
            yield f"data: {json.dumps(remote.snapshot)}\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(payload)}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            remote.event_bus.unsubscribe(queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/command", dependencies=[Depends(require_remote_password)])
async def send_command(req: CommandRequest):
    if not remote.renderer_connected:
        raise HTTPException(status_code=503, detail="Beacon is not connected")
    await remote.command_bus.broadcast({"kind": "command", "type": req.type, "payload": req.payload})
    return JSONResponse({"success": True}, status_code=202)


async def _query(query_type: str, payload: dict) -> dict:
    if not remote.renderer_connected:
        raise HTTPException(status_code=503, detail="Beacon is not connected")
    request_id = uuid.uuid4().hex
    future = remote.new_pending(request_id)
    await remote.command_bus.broadcast(
        {"kind": "query", "request_id": request_id, "type": query_type, "payload": payload}
    )
    try:
        return await asyncio.wait_for(future, timeout=QUERY_TIMEOUT)
    except (TimeoutError, asyncio.TimeoutError):
        raise HTTPException(status_code=504, detail="Beacon did not respond in time")
    finally:
        remote.drop_pending(request_id)


@router.get("/songs", dependencies=[Depends(require_remote_password)])
async def list_songs(search: str = "", offset: int = 0, limit: int = 50):
    return await _query("songs-request", {"search": search, "offset": offset, "limit": limit})


@router.get("/playlists", dependencies=[Depends(require_remote_password)])
async def list_playlists():
    return await _query("playlists-request", {})


@router.get("/playlists/{playlist_id}", dependencies=[Depends(require_remote_password)])
async def get_playlist(playlist_id: str):
    return await _query("playlist-request", {"playlistId": playlist_id})


@router.get("/radio-stations", dependencies=[Depends(require_remote_password)])
async def list_radio_stations():
    return await _query("radio-request", {})


@router.get("/devices", dependencies=[Depends(require_remote_password)])
async def list_devices():
    return await _query("devices-request", {})


@router.get("/device-volume", dependencies=[Depends(require_remote_password)])
async def get_device_volume(type: str, name: str):
    return await _query("device-volume-request", {"deviceType": type, "name": name})


# ── Phone-facing: media (cover art / radio favicons) ────────────────────────
# Neither of these go through the renderer/agent relay — they're pure image
# fetches connect can serve directly, same as the desktop's own
# coverArtUrl()/radioFaviconUrl() do (services/subsonic/client.ts,
# services/connect/radio.ts). Deliberately NOT just handing the phone those
# same URLs though: both embed the real CONNECT_TOKEN as a query param
# (unavoidable there — an <img src> can't send a custom header, and
# core/auth.py's require_token needs it somewhere), which is fine for
# Beacon's own browser context but would hand the phone full API access if
# reused here — the same trust-boundary violation require_remote_password
# exists to prevent in the first place (see this module's own docstring).
# These two give the phone an equivalent that only ever needs its own
# password.


@router.get("/cover-art", dependencies=[Depends(require_remote_password)])
async def remote_cover_art(id: str, session: SessionState = Depends(get_session)):
    """Redirects to a direct, LAN-reachable, freshly-authenticated cover art
    URL — session.media.get_cover_art_url(internal=True) (media/subsonic.py
    et al.) is the exact same method that already lets LAN cast devices
    (Sonos, Chromecast, ...) fetch artwork directly; a phone on the same LAN
    can use it exactly the same way. No CONNECT_TOKEN anywhere in it — it
    points straight at the actual media server, not through connect's own
    /rest/* proxy (routes/proxy.py), which is what the desktop's own
    coverArtUrl() goes through and is the thing this endpoint exists to
    avoid handing the phone."""
    url = session.media.get_cover_art_url(id, internal=True)
    if not url:
        raise HTTPException(status_code=404)
    return RedirectResponse(url)


@router.get("/radio-favicon", dependencies=[Depends(require_remote_password)])
async def remote_radio_favicon(url: str, min_size: int = 0):
    """Thin re-export of routes/radio.py's /radio-favicon under the phone's
    own auth — that function's body never actually touches CONNECT_TOKEN
    itself (it's plain URL validation + fetch-and-relay of a third-party
    image), so there's nothing to duplicate here beyond the dependency."""
    return await _fetch_radio_favicon(url=url, min_size=min_size)


# ── Phone-facing: static web client ──────────────────────────────────────
# Only gated on the feature being enabled — not on the password — so the
# app shell can load before pairing happens (the shell itself then prompts
# for the PIN/handles the QR deep-link and only starts calling the
# password-gated endpoints above once it has one).


@router.get("/app")
async def redirect_remote_app_to_trailing_slash():
    # Without the trailing slash, every relative asset reference in
    # index.html (app.css, app.js, and app.js's own relative imports like
    # ./js/api.js) resolves against /remote/ instead of /remote/app/ — the
    # classic "directory URL needs a trailing slash" issue any static file
    # server (nginx, Apache, ...) handles the same way. Without this, those
    # requests land on /remote/app.js etc., which fall through to
    # proxy_router's CONNECT_TOKEN-gated catch-all and 401 — the phone never
    # gets a working app shell at all, just a blank page (everything in
    # index.html starts class="hidden" until app.js itself removes it).
    if not remote.enabled:
        raise HTTPException(status_code=404)
    return RedirectResponse(url="/remote/app/", status_code=308)


@router.get("/app/{path:path}")
async def serve_remote_app(path: str = "index.html"):
    if not remote.enabled:
        raise HTTPException(status_code=404)

    static_dir = _static_dir()
    requested = (static_dir / path).resolve()
    # Guard against path traversal escaping static_dir (e.g. `../../etc/passwd`)
    # before ever touching the filesystem with it.
    if static_dir not in requested.parents and requested != static_dir:
        raise HTTPException(status_code=404)

    if requested.is_file():
        return FileResponse(requested)
    # SPA fallback — the hash-router handles the actual sub-path client-side.
    index = static_dir / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(status_code=404)
