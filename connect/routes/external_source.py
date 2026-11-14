"""routes/external_source.py - setting up the external source, registering
its songs, and passing its tab's page through.

Two routers on purpose. /external-source/ is the renderer's, behind the
connect token and a signed-in session like every other route. /external-ui/
is the page's: it runs sandboxed in an origin of its own and can send no
token, no session and no cookie, so the address itself carries the
credential (core/external_source.py's ui_secret). nginx gives it its own
location without the injected token, like /party/.

See docs/plans/external-source.md.
"""

import asyncio
import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core import external_source
from core.auth import require_token
from core.external_source import ExternalSourceError
from core.session import SessionState, require_authenticated_session

logger = logging.getLogger("connect.external_source")

router = APIRouter(prefix="/external-source", dependencies=[Depends(require_token)])
ui_router = APIRouter(prefix="/external-ui")

# A Docker install is shared by everyone signed in to it, and connect fetches
# whatever the address points at: only an admin may set it there. On the
# desktop the person signed in owns the machine.
_HOSTED = bool(os.getenv("BEACON_HOSTED"))

_PROBE_TIMEOUT = 5.0

# The page's requests, forwarded to its app: what describes the request, and
# nothing that identifies the listener or carries Beacon's credentials.
_UI_REQ_HEADERS = {
    "accept",
    "accept-language",
    "content-type",
    "range",
    "if-range",
    "if-none-match",
    "if-modified-since",
}
_UI_RESP_SKIP = {
    "connection",
    "transfer-encoding",
    "content-encoding",
    "date",
    "set-cookie",
    "content-security-policy",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "x-frame-options",
}

# The page arrives from Beacon's own address, so without this its scripts
# would run with Beacon's origin: its session, its storage, its cookies.
# `sandbox` without allow-same-origin gives it an opaque origin of its own;
# without allow-top-navigation it cannot take the app away from the listener.
_SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"

# The page's own fetches come from that opaque origin ("null") and are
# therefore cross-origin to connect. Nothing under /external-ui/ ever reads a
# cookie, so allowing every origin gives nothing away.
_CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, accept, range",
    "access-control-max-age": "600",
}

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # No redirects: an address checked against the app's own must not be
        # led somewhere else by the answer.
        _client = httpx.AsyncClient(follow_redirects=False, timeout=30)
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _may_configure(session: SessionState) -> bool:
    return session.account_is_admin or not _HOSTED


def _auth_header(config: dict) -> dict:
    return {"authorization": f"Bearer {config['token']}"} if config.get("token") else {}


async def _probe(config: dict) -> dict:
    """What the app says about itself at /v1, or why it said nothing."""
    try:
        response = await _get_client().get(
            f"{config['base_url']}/v1", headers=_auth_header(config), timeout=_PROBE_TIMEOUT
        )
    except Exception as e:
        return {"ok": False, "error": f"Not reachable: {e}"}
    if response.status_code == 401 or response.status_code == 403:
        return {"ok": False, "error": "The app refused the token"}
    if response.status_code != 200:
        return {"ok": False, "error": f"The app answered HTTP {response.status_code}"}
    try:
        info = response.json()
    except ValueError:
        return {"ok": False, "error": "The app's /v1 is not JSON"}
    if not isinstance(info, dict):
        return {"ok": False, "error": "The app's /v1 is not a JSON object"}
    capabilities = info.get("capabilities")
    return {
        "ok": True,
        "name": str(info.get("name") or ""),
        "version": str(info.get("version") or ""),
        "capabilities": [str(c) for c in capabilities] if isinstance(capabilities, list) else [],
    }


def _describe(config: dict | None, session: SessionState) -> dict:
    may_configure = _may_configure(session)
    if config is None:
        return {"configured": False, "may_configure": may_configure}
    described = {
        "configured": True,
        "may_configure": may_configure,
        "name": config["name"],
        "ui_path": f"/external-ui/{external_source.ui_secret()}/",
    }
    if may_configure:
        described["base_url"] = config["base_url"]
        described["has_token"] = bool(config["token"])
    return described


@router.get("")
async def get_external_source(session: SessionState = Depends(require_authenticated_session)):
    config = await asyncio.to_thread(external_source.load_config)
    return _describe(config, session)


class ExternalSourceSettings(BaseModel):
    name: str = Field(max_length=60)
    base_url: str = Field(max_length=500)
    # None keeps the stored token, so the dialog never needs to show it.
    token: str | None = Field(default=None, max_length=500)


@router.put("")
async def put_external_source(
    req: ExternalSourceSettings,
    session: SessionState = Depends(require_authenticated_session),
):
    if not _may_configure(session):
        raise HTTPException(status_code=403, detail="Server administrator rights required")
    current = await asyncio.to_thread(external_source.load_config)
    token = req.token if req.token is not None else (current or {}).get("token", "")
    try:
        config = await asyncio.to_thread(external_source.save_config, req.name, req.base_url, token)
    except ExternalSourceError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    logger.info(f"[external-source] Set to {config['base_url']} ({config['name']})")
    return {**_describe(config, session), "probe": await _probe(config)}


@router.delete("")
async def delete_external_source(session: SessionState = Depends(require_authenticated_session)):
    if not _may_configure(session):
        raise HTTPException(status_code=403, detail="Server administrator rights required")
    await asyncio.to_thread(external_source.clear_config)
    logger.info("[external-source] Removed")
    return _describe(None, session)


@router.get("/probe")
async def probe_external_source(session: SessionState = Depends(require_authenticated_session)):
    config = await asyncio.to_thread(external_source.load_config)
    if config is None:
        raise HTTPException(status_code=404, detail="No external source is set up")
    return await _probe(config)


class ExternalItem(BaseModel):
    # camelCase: the page's own spelling, as the docs give it.
    audioUrl: str = Field(max_length=2000)
    title: str | None = Field(default=None, max_length=500)
    artist: str | None = Field(default=None, max_length=500)
    album: str | None = Field(default=None, max_length=500)
    coverUrl: str | None = Field(default=None, max_length=2000)
    duration: float | None = None


@router.post("/items")
async def register_item(
    req: ExternalItem,
    session: SessionState = Depends(require_authenticated_session),
):
    """A song the page asked to play, as a Subsonic song with an `ext:` id
    the renderer can queue like any other."""
    try:
        track = await asyncio.to_thread(external_source.register, req.model_dump())
    except ExternalSourceError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"song": external_source.subsonic_song(track)}


# --- the tab's page ----------------------------------------------------------


def _page_headers(extra: dict | None = None) -> dict:
    return {
        **(extra or {}),
        **_CORS,
        "content-security-policy": _SANDBOX,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
    }


@ui_router.options("/{secret}/{path:path}")
async def ui_preflight(secret: str, path: str):
    if not external_source.ui_secret_matches(secret):
        raise HTTPException(status_code=404)
    return Response(status_code=204, headers=_CORS)


@ui_router.api_route(
    "/{secret}/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
)
async def ui_passthrough(secret: str, path: str, request: Request):
    """The app's `ui/` folder, page, assets and the page's own API alike."""
    if not external_source.ui_secret_matches(secret):
        raise HTTPException(status_code=404)
    config = await asyncio.to_thread(external_source.load_config)
    if config is None:
        raise HTTPException(status_code=404, detail="No external source is set up")

    headers = {k: v for k, v in request.headers.items() if k.lower() in _UI_REQ_HEADERS}
    headers.update(_auth_header(config))
    headers["accept-encoding"] = "identity"
    client = _get_client()
    try:
        upstream = await client.send(
            client.build_request(
                request.method,
                f"{config['base_url']}/ui/{path}",
                params=list(request.query_params.multi_items()),
                headers=headers,
                content=await request.body(),
            ),
            stream=True,
        )
    except httpx.TimeoutException:
        return Response("The external source did not answer in time", 504, _page_headers())
    except Exception as e:
        logger.warning(f"[external-source] Page request failed: {e}")
        return Response("The external source is not reachable", 502, _page_headers())

    passed = {k: v for k, v in upstream.headers.items() if k.lower() not in _UI_RESP_SKIP}

    async def streamed():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        streamed(),
        status_code=upstream.status_code,
        headers=_page_headers(passed),
        media_type=upstream.headers.get("content-type"),
    )
