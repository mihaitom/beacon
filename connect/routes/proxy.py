"""routes/proxy.py — transparent proxy for Navidrome API calls

Proxied paths (all routed internally to SERVER_INTERNAL_URL):
  /rest/{path}   → Subsonic API  (navidrome/rest/{path})
  /auth/{path}   → Navidrome Auth (navidrome/auth/{path})
  /{path}        → Navidrome REST API via /api/ nginx prefix (navidrome/api/{path})
                   (nginx strips /api/ before forwarding to the backend)
"""

import os

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.requests import ClientDisconnect

from core.auth import require_token

router = APIRouter(dependencies=[Depends(require_token)])

_INTERNAL_URL = (
    os.getenv("SERVER_INTERNAL_URL") or os.getenv("NAVIDROME_INTERNAL_URL", "")
).rstrip("/")

_SKIP_REQ = {"host", "connection", "transfer-encoding"}
_SKIP_RESP = {"transfer-encoding", "connection", "content-encoding"}

_ALL_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]


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
    return lowered.startswith((
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
    ))


async def _proxy(request: Request, target: str) -> StreamingResponse | JSONResponse:
    if not _INTERNAL_URL:
        return JSONResponse(
            {"error": "SERVER_INTERNAL_URL not configured"}, status_code=503
        )

    fwd_headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in _SKIP_REQ and not _is_forward_auth_header(k)
    }
    # No gzip from Navidrome: httpx would decompress but forward the original
    # Content-Length → mismatch. Identity prevents this issue.
    fwd_headers["accept-encoding"] = "identity"
    client = httpx.AsyncClient(follow_redirects=True, timeout=60)
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
        await client.aclose()
        return JSONResponse({"error": "client disconnected"}, status_code=499)
    except httpx.ConnectError as e:
        await client.aclose()
        return JSONResponse({"error": f"Navidrome not reachable: {e}"}, status_code=502)
    except httpx.TimeoutException as e:
        await client.aclose()
        return JSONResponse({"error": f"Navidrome Timeout: {e}"}, status_code=504)
    except Exception as e:
        # Catch-all so `client` (and its connection pool) always gets closed
        # — httpx can raise several other exceptions here (RemoteProtocolError,
        # ProtocolError, PoolTimeout, UnsupportedProtocol, ...) that aren't
        # worth enumerating individually but would otherwise leak the client
        # on every occurrence, on the single most frequently hit route in
        # the backend (every proxied Navidrome API call goes through here).
        await client.aclose()
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
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(
        streamed(),
        status_code=response.status_code,
        headers=resp_headers,
        media_type=response.headers.get("content-type"),
    )


@router.api_route("/rest/{path:path}", methods=_ALL_METHODS)
async def proxy_subsonic(path: str, request: Request):
    return await _proxy(request, f"{_INTERNAL_URL}/rest/{path}")


@router.api_route("/auth/{path:path}", methods=_ALL_METHODS)
async def proxy_auth(path: str, request: Request):
    return await _proxy(request, f"{_INTERNAL_URL}/auth/{path}")


# Catch-all: nginx strips "/api/" before forwarding, so, for example,
# "/api/album" is sent to the backend as "/album" → forward it here to navidrome/api/album.
# Register LAST so that specific Connect routes take precedence.
@router.api_route("/{path:path}", methods=_ALL_METHODS)
async def proxy_navidrome_api(path: str, request: Request):
    return await _proxy(request, f"{_INTERNAL_URL}/api/{path}")
