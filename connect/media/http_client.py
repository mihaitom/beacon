"""media/http_client.py — one pooled HTTP client for every media-server call.

The adapters in this package used to reach for `httpx.get()`/`httpx.post()`,
the module-level convenience functions. Each of those builds a client, opens
a connection, does a DNS lookup and a TLS handshake, makes one request, and
throws the whole thing away. Browsing a large library turns that into
thousands of connection setups: measured on beacon-dev 2026-08-22, enough of
a burst to overrun the host's DNS stub until it started answering `EAI_AGAIN`,
which then took out a cast session (see docs/playback-bugs.md).

routes/proxy.py already learned this lesson and keeps a long-lived
`httpx.AsyncClient`; this is the same thing for the synchronous side. It is
also what the Electron-only app this backend grew out of never had to think
about: its renderer talked to the media server through the browser, which
pools connections and caches DNS on its own.

Auth never lives on the client — every adapter passes credentials per request
(Subsonic as query params, Jellyfin and Plex as headers) — so one client can
serve every session and every configured server at once. httpx keeps a
separate connection pool per host internally, and `httpx.Client` is safe to
share across threads, which matters because these calls run inside
`asyncio.to_thread()`.
"""

import atexit
import threading

import httpx

# Generous enough for a library view loading many covers at once, bounded so
# a runaway caller cannot exhaust the media server's own connection limit.
# keepalive_expiry outlives the gaps between requests while someone scrolls,
# which is the whole point of pooling here.
_LIMITS = httpx.Limits(max_connections=32, max_keepalive_connections=16, keepalive_expiry=60.0)

_client: httpx.Client | None = None
_lock = threading.Lock()


def client() -> httpx.Client:
    """The shared client, created on first use.

    Lazy rather than created at import time so importing this package (tests
    included) never opens sockets or resolves anything by itself.
    """
    global _client
    if _client is None:
        with _lock:
            if _client is None:
                _client = httpx.Client(limits=_LIMITS, follow_redirects=True)
    return _client


def get(url: str, **kwargs) -> httpx.Response:
    return client().get(url, **kwargs)


def post(url: str, **kwargs) -> httpx.Response:
    return client().post(url, **kwargs)


def close() -> None:
    """Drop the pool. Registered with atexit so a packaged app shutting down
    doesn't leave sockets open; also lets tests reset between cases."""
    global _client
    with _lock:
        if _client is not None:
            _client.close()
            _client = None


atexit.register(close)
