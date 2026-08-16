"""routes/proxy.py — transparent proxy for Navidrome/Jellyfin/Plex API calls

Proxied paths:
  /rest/{path}   → Subsonic API (session.media.internal_url/rest/{path}) for a
                   Subsonic session, or media/jellyfin_bridge.py /
                   media/plex_bridge.py for a Jellyfin/Plex one — see
                   proxy_subsonic. session.media.internal_url is whatever
                   URL was submitted at login, optionally overridden by
                   NAVIDROME_INTERNAL_URL (Subsonic only — see
                   routes/devices.py's configure()).
  /auth/{path}   → Navidrome Auth (NAVIDROME_INTERNAL_URL/auth/{path}) — dead
                   code path, nothing in this frontend calls it, kept for
                   completeness/third-party API consumers.
  /{path}        → Navidrome REST API via /api/ nginx prefix
                   (NAVIDROME_INTERNAL_URL/api/{path}) — same, unused by this
                   frontend (nginx strips /api/ before forwarding here)
"""

import os

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.requests import ClientDisconnect

from core.auth import require_token
from core.session import SessionState, get_session
from media import JellyfinClient, PlexClient, jellyfin_bridge, plex_bridge

router = APIRouter(dependencies=[Depends(require_token)])

_NAVIDROME_INTERNAL_URL = os.getenv("NAVIDROME_INTERNAL_URL", "").rstrip("/")

_SKIP_REQ = {"host", "connection", "transfer-encoding"}
_SKIP_RESP = {"transfer-encoding", "connection", "content-encoding"}

_ALL_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]

# Shared across every proxied request — created lazily (see _get_client())
# and closed once at app shutdown (see close(), called from main.py's
# lifespan). This used to be a fresh httpx.AsyncClient per request, which
# meant no connection reuse at all: every single proxied Subsonic/Navidrome
# API call (getAlbum, getCoverArt, ...) paid for a brand new TCP (+TLS, if
# Navidrome is behind https) handshake on top of its own request latency —
# on the single most frequently hit route in this backend, since literally
# every Navidrome API call goes through here. Reusing one client (and its
# connection pool) across requests is httpx's own documented recommendation
# for exactly this reason, and is what a browser or any other real HTTP
# client already does via keep-alive.
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(follow_redirects=True, timeout=60)
    return _client


async def close() -> None:
    """Closes the shared client — called once from main.py's lifespan on
    app shutdown. A no-op if _get_client() was never actually called (e.g.
    a test run that only ever exercises the "not configured" 503 branch
    below, or a deployment that never got a proxied request at all)."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _is_forward_auth_header(name: str) -> bool:
    """True for SSO forward-auth headers (Authentik, Authelia, oauth2-proxy, ...)
    a reverse proxy in front of this backend may inject, identifying whoever is
    browsing. Subsonic API auth is self-contained (u/p or t/s params) and must
    never be influenced by who happens to be browsing — forwarding these to
    Navidrome lets its ExtAuth (ND_EXTAUTH_TRUSTEDSOURCES) silently authenticate
    every proxied request as the browser's SSO identity instead of the Subsonic
    credentials actually being sent, which breaks logging into any Navidrome
    account other than the browsing user's own (e.g. testing multi-user support
    with a second Navidrome account fails with a Subsonic "not authorized"
    error, even for an admin account, because Navidrome never actually
    authenticates as that account at all)."""
    lowered = name.lower()
    return lowered.startswith(
        (
            "x-authentik-",
            "x-auth-request-",  # oauth2-proxy behind nginx's auth_request module
            "x-forwarded-user",  # oauth2-proxy acting as its own reverse proxy
            "x-forwarded-email",
            "x-forwarded-groups",
            "x-forwarded-preferred-username",
            "x-forwarded-access-token",
            "remote-user",
            "remote-groups",
            "remote-email",
            "remote-name",
        )
    )


async def _proxy(request: Request, target: str) -> StreamingResponse | JSONResponse:
    """Forwards `request` to `target` — callers are responsible for deciding
    what `target` is and rejecting an unconfigured/empty one themselves (see
    proxy_subsonic's session-derived internal_url vs proxy_auth/
    proxy_navidrome_api's fixed NAVIDROME_INTERNAL_URL), since "configured"
    means something different for each."""
    fwd_headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in _SKIP_REQ and not _is_forward_auth_header(k)
    }
    # No gzip from Navidrome: httpx would decompress but forward the original
    # Content-Length → mismatch. Identity prevents this issue.
    fwd_headers["accept-encoding"] = "identity"
    client = _get_client()
    try:
        req = client.build_request(
            method=request.method,
            url=target,
            params=dict(request.query_params),
            headers=fwd_headers,
            content=await request.body(),
        )
        response = await client.send(req, stream=True)
    except ClientDisconnect:
        # Browser aborted the request (navigation, component unmount, flaky
        # network) before we finished reading its body — nothing meaningful
        # to forward, and no one is listening for this response either way.
        # Without this, it surfaces as an unhandled-exception traceback at
        # ERROR level on every occurrence, even though it's an expected,
        # benign network condition, not a real backend fault.
        return JSONResponse({"error": "client disconnected"}, status_code=499)
    except httpx.ConnectError as e:
        return JSONResponse({"error": f"Navidrome not reachable: {e}"}, status_code=502)
    except httpx.TimeoutException as e:
        return JSONResponse({"error": f"Navidrome Timeout: {e}"}, status_code=504)
    except Exception as e:
        # Catch-all — httpx can raise several other exceptions here
        # (RemoteProtocolError, ProtocolError, PoolTimeout,
        # UnsupportedProtocol, ...) that aren't worth enumerating
        # individually. Doesn't close `client` (see _get_client()'s
        # comment) — it's the shared, module-level client now, reused by
        # every other in-flight and future request, not something this one
        # failed request owns.
        return JSONResponse({"error": f"Proxy error: {e}"}, status_code=502)

    # If the origin sent a compressed body, httpx already decompressed it, so the
    # original Content-Length no longer matches — drop it. Otherwise (e.g. audio
    # streams), keep it so the browser gets accurate length / Range support.
    skip_resp = set(_SKIP_RESP)
    if "content-encoding" in response.headers:
        skip_resp.add("content-length")

    resp_headers = {
        k: v for k, v in response.headers.items() if k.lower() not in skip_resp
    }

    async def streamed():
        # Closes this specific response (releasing its connection back to
        # the shared client's pool for reuse) — not the client itself,
        # which stays open across requests. See _get_client()'s comment.
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()

    return StreamingResponse(
        streamed(),
        status_code=response.status_code,
        headers=resp_headers,
        media_type=response.headers.get("content-type"),
    )


@router.api_route("/rest/{path:path}", methods=_ALL_METHODS)
async def proxy_subsonic(
    path: str, request: Request, session: SessionState = Depends(get_session)
):
    # get_session (not require_authenticated_session): nothing calls this
    # for an unconfigured session in practice (stores/auth.ts's
    # _authenticate() relies entirely on /config's own server-side
    # media.ping() check now, no separate client-side pre-flight — see its
    # comment) — kept as get_session anyway so a stray pre-/config request
    # 503s cleanly below instead of 401ing confusingly.
    if isinstance(session.media, JellyfinClient):
        return await jellyfin_bridge.handle(path, request, session.media)
    if isinstance(session.media, PlexClient):
        return await plex_bridge.handle(path, request, session.media)
    # Session-derived, not the fixed NAVIDROME_INTERNAL_URL env var: this is
    # whatever URL was actually submitted at login (session.media.base_url),
    # with NAVIDROME_INTERNAL_URL only ever applying as an *optional* override
    # on top of it (see routes/devices.py's configure() — SubsonicClient
    # itself falls back to base_url when no override was given). Using the
    # env var directly here, independently of the session, used to mean
    # browsing/streaming/cover-art traffic silently went wherever
    # NAVIDROME_INTERNAL_URL pointed regardless of which server the user
    # actually authenticated against — correct only by coincidence when the
    # two happened to be the same value.
    internal_url = session.media.internal_url
    if not internal_url:
        return JSONResponse(
            {"error": "No media server configured for this session — call /config first"},
            status_code=503,
        )
    return await _proxy(request, f"{internal_url}/rest/{path}")


@router.api_route("/auth/{path:path}", methods=_ALL_METHODS)
async def proxy_auth(path: str, request: Request):
    if not _NAVIDROME_INTERNAL_URL:
        return JSONResponse(
            {"error": "NAVIDROME_INTERNAL_URL not configured"}, status_code=503
        )
    return await _proxy(request, f"{_NAVIDROME_INTERNAL_URL}/auth/{path}")


# Catch-all: nginx strips "/api/" before forwarding, so, for example,
# "/api/album" is sent to the backend as "/album" → forward it here to navidrome/api/album.
# Register LAST so that specific Connect routes take precedence.
@router.api_route("/{path:path}", methods=_ALL_METHODS)
async def proxy_navidrome_api(path: str, request: Request):
    if not _NAVIDROME_INTERNAL_URL:
        return JSONResponse(
            {"error": "NAVIDROME_INTERNAL_URL not configured"}, status_code=503
        )
    return await _proxy(request, f"{_NAVIDROME_INTERNAL_URL}/api/{path}")
