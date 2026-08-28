"""main.py — Beacon Connect: streams Navidrome tracks to Sonos / AirPlay

Startup:
  uv run python main.py
  uvicorn main:app --host 0.0.0.0 --port 7071
"""

import asyncio
import logging
import os
import shutil
import traceback
from contextlib import asynccontextmanager

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

# Must run before any core.*/routes.* import below — several of them read
# their config (CONNECT_TOKEN, NAVIDROME_INTERNAL_URL, ...) from os.environ at
# *module import time*, not lazily. Loading .env after those imports meant
# it was silently ignored — only working when the same variables happened
# to already be set as real shell/process env vars (e.g. via docker-compose,
# or exported manually), never via a plain .env file alone.
load_dotenv()

from core.auth import TOKEN as _CONNECT_TOKEN
from core.auth import TOKEN_WAS_GENERATED as _CONNECT_TOKEN_GENERATED
from core.log_level import TRACE as _TRACE_LEVEL
from core.log_level import apply as _apply_log_level
from core.log_level import initial_level as _initial_log_level
from core.log_level import is_at_least
from core.loop_health import monitor_loop_lag
from core.upnp_events import renew_due_subscriptions
from core.remote import reap_stale_remote, remote
from core.session import reap_stale_sessions, registry
from core.state import PORT, get_local_ip
from media import jellyfin_bridge, plex_bridge
from routes.debug import router as debug_router
from routes.devices import router as devices_router
from routes.discovery import discover_all
from routes.discovery import router as discovery_router
from routes.jellyfin_auth import router as jellyfin_auth_router
from routes.join import router as join_router
from routes.local_stream import router as local_stream_router
from routes.log_level import router as log_level_router
from routes.lyrics import router as lyrics_router
from routes.pairing import reap_stale_pairings
from routes.pairing import router as pairing_router
from routes.playback import router as playback_router
from routes.plex_auth import router as plex_auth_router
from routes.proxy import close as close_proxy_client
from routes.proxy import router as proxy_router
from routes.radio import router as radio_router
from routes.recommendations import router as recommendations_router
from routes.remote import router as remote_router
from routes.stream import router as stream_router
from routes.upnp import router as upnp_router
from routes.volume import router as volume_router
from routes.waveform import router as waveform_router


class _ShortNameFilter(logging.Filter):
    """Strip the redundant "connect."/"pychromecast." prefix from logger
    names (and rename the bare "connect" root logger to "main"), so log
    lines read e.g. "lyrics" / "socket_client" instead of "connect.lyrics" /
    "pychromecast.socket_client" — shorter and lines up with the other
    loggers (delivery, sonos, pyatv, ...). pychromecast logs its own
    connection/reconnection events under several dotted submodule names
    (controllers, socket_client, discovery, ...), all noisier than our own
    loggers even at INFO — this only fixes their alignment, not their
    verbosity, since they're genuinely informative (e.g. a cast device
    dropping off Wi-Fi and reconnecting).
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name.startswith("connect."):
            record.name = record.name.removeprefix("connect.")
        elif record.name == "connect":
            record.name = "main"
        elif record.name.startswith("pychromecast."):
            record.name = record.name.removeprefix("pychromecast.")
        elif record.name == "uvicorn.error":
            # "uvicorn.error" is just uvicorn's logger for general
            # startup/shutdown messages (not actual errors) — rename to
            # avoid the misleading "error" in the name.
            record.name = "uvicorn"
        return True


_LEVEL_COLORS = {
    _TRACE_LEVEL: "\033[90m",  # gray — the third-party SOAP/HTTP noise TRACE turns on
    logging.DEBUG: "\033[34m",  # blue
    logging.INFO: "\033[32m",  # green
    logging.WARNING: "\033[38;5;208m",  # orange
    logging.ERROR: "\033[31m",  # red
    logging.CRITICAL: "\033[1;31m",  # bold red
}
_COLOR_RESET = "\033[0m"
# Always on: `docker logs`/piped output isn't a real terminal (isatty() would
# say False), but the raw ANSI codes still render fine wherever the log is
# actually viewed. Opt out via NO_COLOR (https://no-color.org/).
_USE_COLOR = not os.getenv("NO_COLOR")


class _ColorLevelFormatter(logging.Formatter):
    """Colors just the level name by log level — the rest of the line keeps
    the terminal's default color.
    """

    def __init__(self, format=None, datefmt=None, use_color: bool = True, **kwargs):
        super().__init__(fmt=format, datefmt=datefmt, **kwargs)
        self._use_color = use_color

    def format(self, record: logging.LogRecord) -> str:
        original = record.levelname
        padded = f"{original:<7}"
        color = _LEVEL_COLORS.get(record.levelno) if self._use_color else None
        record.levelname = f"{color}{padded}{_COLOR_RESET}" if color else padded
        try:
            return super().format(record)
        finally:
            record.levelname = original


_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)-9s %(message)s"
_LOG_DATEFMT = "%H:%M:%S"
_root_handler = logging.StreamHandler()
_root_handler.setFormatter(
    _ColorLevelFormatter(_LOG_FORMAT, datefmt=_LOG_DATEFMT, use_color=_USE_COLOR)
)
_root_handler.addFilter(_ShortNameFilter())
logging.basicConfig(level=logging.INFO, handlers=[_root_handler])
logger = logging.getLogger("connect")

# The level Settings' log-level dropdown last persisted, falling back to
# the LOG_LEVEL env var only when nothing's been persisted yet — see
# core/log_level.py. Also decides, once, whether routes/debug.py's
# diagnostic router gets registered at all (see near the bottom of this
# file) — Debug or louder, same as delivery/manager.py's Sonos device-filter
# bypass, rather than that router's own separate flag from before this
# setting could gate it too.
_INITIAL_LOG_LEVEL = _initial_log_level()

# Reformat uvicorn's own loggers (startup/error/access) to match the format
# used above, so every log line — ours and uvicorn's — looks the same.
# uvicorn.access logs every incoming request — noisy enough that it's only
# ever turned on at TRACE (see core/log_level.py's apply()), same as the
# other third-party libraries.
UVICORN_LOG_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "()": _ColorLevelFormatter,
            "format": _LOG_FORMAT,
            "datefmt": _LOG_DATEFMT,
            "use_color": _USE_COLOR,
        },
        "access": {
            "()": _ColorLevelFormatter,
            "format": _LOG_FORMAT,
            "datefmt": _LOG_DATEFMT,
            "use_color": _USE_COLOR,
        },
    },
    "filters": {
        "short_name": {"()": _ShortNameFilter},
    },
    "handlers": {
        "default": {
            "class": "logging.StreamHandler",
            "formatter": "default",
            "filters": ["short_name"],
            "stream": "ext://sys.stdout",
        },
        "access": {
            "class": "logging.StreamHandler",
            "formatter": "access",
            "filters": ["short_name"],
            "stream": "ext://sys.stdout",
        },
    },
    "loggers": {
        "uvicorn": {"handlers": ["default"], "level": "INFO", "propagate": False},
        "uvicorn.error": {"level": "INFO"},
        "uvicorn.access": {
            "handlers": ["access"],
            "level": "INFO" if _INITIAL_LOG_LEVEL == "TRACE" else "WARNING",
            "propagate": False,
        },
    },
}

# Applies _INITIAL_LOG_LEVEL to our own logger tree (connect → also covers
# children connect.streamer / connect.playback / ...) and, only at TRACE,
# the third-party libraries (SoCo, pyatv, httpx/httpcore) and uvicorn.access
# — see core/log_level.py. persist=False: this value just came from disk
# (or the LOG_LEVEL env var fallback) — writing it straight back would be a
# no-op at best and could stomp a deliberate LOG_LEVEL override with a
# stale persisted INFO at worst. routes/log_level.py's POST persists for
# real, once the user actually changes it from Settings.
_apply_log_level(_INITIAL_LOG_LEVEL, persist=False)


def _asyncio_exception_handler(loop, context):
    """Quiet down pyatv's "Unclosed client session"/"Unclosed connector"
    noise (logged by asyncio's default handler as an ERROR with a multi-line
    object repr) into a single readable debug line. Everything else still
    goes through the default handler."""
    message = context.get("message", "")
    if message in ("Unclosed client session", "Unclosed connector"):
        logger.debug(f"asyncio: {message} (stale pyatv session, harmless)")
        return
    loop.default_exception_handler(context)


_DISCOVERY_INTERVAL = 60 * 60  # rescan for new Sonos/AirPlay/Chromecast devices hourly

# UPnP event subscriptions are leases — see core/upnp_events.py. Checked far
# more often than they expire so one slow pass can't let a lease lapse; a
# lapsed subscription is silent, and silence here reads exactly like "the
# device reported no problems".
_SUBSCRIPTION_RENEWAL_INTERVAL = 60


async def _renew_upnp_subscriptions() -> None:
    while True:
        await asyncio.sleep(_SUBSCRIPTION_RENEWAL_INTERVAL)
        try:
            await renew_due_subscriptions()
        except Exception:
            logger.exception("[upnp] Subscription renewal pass failed")


async def _periodic_discovery() -> None:
    while True:
        await asyncio.sleep(_DISCOVERY_INTERVAL)
        try:
            await discover_all()
        except Exception:
            logger.exception("[discover] Periodic scan failed")


@asynccontextmanager
async def lifespan(_: FastAPI):
    asyncio.get_event_loop().set_exception_handler(_asyncio_exception_handler)
    local_ip = get_local_ip()
    logger.info(f"🎵 Stream: http://{local_ip}:{PORT}/stream")
    logger.info(f"🔌 API:    http://{local_ip}:{PORT}/")

    if shutil.which("ffmpeg"):
        logger.info("✅ ffmpeg found")
    else:
        logger.error("❌ ffmpeg NOT FOUND — streaming will fail!")

    if not _CONNECT_TOKEN:
        logger.warning(
            "⚠️  CONNECT_TOKEN explicitly set to empty — the Connect API has no auth!"
        )
    elif _CONNECT_TOKEN_GENERATED:
        logger.info(
            f"🔒 Token auth enabled (auto-generated, persisted in connect/.connect-token): "
            f"{_CONNECT_TOKEN}\n"
            "   Set CONNECT_TOKEN explicitly (see docker-compose.yaml) instead if a fixed "
            "value is needed, e.g. for scripting direct API access."
        )
    else:
        logger.info("🔒 Token auth enabled (custom CONNECT_TOKEN set)")
    logger.info("⏳ Waiting for /config (media server credentials)")

    discovery_task = asyncio.create_task(_periodic_discovery())
    reaper_task = asyncio.create_task(reap_stale_sessions())
    remote_reaper_task = asyncio.create_task(reap_stale_remote())
    pairing_reaper_task = asyncio.create_task(reap_stale_pairings())
    loop_lag_task = asyncio.create_task(monitor_loop_lag())
    upnp_renewal_task = asyncio.create_task(_renew_upnp_subscriptions())
    background_tasks = (
        discovery_task,
        reaper_task,
        remote_reaper_task,
        pairing_reaper_task,
        loop_lag_task,
        upnp_renewal_task,
    )
    try:
        yield
    finally:
        for task in background_tasks:
            task.cancel()
        # Actually letting each task run its own cancellation (rather than
        # just requesting it and moving on) matters here: an event loop that
        # closes with a task still merely *scheduled* to cancel — not yet
        # actually cancelled — logs "Task was destroyed but it is pending!"
        # on exit, on every plain Ctrl+C. return_exceptions=True is what
        # keeps that CancelledError from propagating out of gather() itself
        # once each task raises it, same as the finally block already does
        # per-delivery below for its own exceptions.
        await asyncio.gather(*background_tasks, return_exceptions=True)
        # A killed process (dev-mode Ctrl+C, packaged app quitting) can't run
        # the Electron before-quit round-trip that normally disables Remote
        # Control (see App.vue) — disable it here too so a still-running
        # `connect` from a previous launch (the dev flow) never inherits a
        # stale enabled state for the next one.
        remote.disable()
        await close_proxy_client()
        await jellyfin_bridge.close()
        await plex_bridge.close()
        # Stop actively-casting devices before the process actually exits —
        # Sonos/Chromecast/DLNA/AirPlay have no way to know this backend
        # died, so they'd otherwise just keep playing whatever they were
        # last streamed, regardless of *why* this process is shutting down
        # (dev-mode Ctrl+C, the packaged Electron app quitting, a manual
        # restart, ...). More reliable than only asking a still-connected
        # frontend to call /stop itself first (see the Electron main
        # process's requestQuit(), which does that for the normal "app
        # window closes" case) — this backstops every shutdown path
        # uniformly, including ones where nothing is left to ask.
        for session in registry.all():
            if session.state.active_delivery:
                try:
                    await session.state.active_delivery.stop()
                except Exception:
                    logger.exception(
                        f"[shutdown] Failed to stop delivery for session {session.session_id}"
                    )


app = FastAPI(
    title="Beacon Connect",
    lifespan=lifespan,
    # Swagger UI / ReDoc / the raw OpenAPI schema are unauthenticated by
    # FastAPI's own design (they live outside any router, so require_token
    # never applies to them) — would be reachable at /api/docs through nginx
    # just like anything else, listing every endpoint and its parameters to
    # anyone who finds the deployment. Always off — no real deployment need
    # for it to ever be reachable.
    docs_url=None,
    openapi_url=None,
    redoc_url=None,
)
_ALLOWED_ORIGINS_ENV = os.getenv("ALLOWED_ORIGINS", "")
_ALLOWED_ORIGINS: list[str] = (
    [o.strip() for o in _ALLOWED_ORIGINS_ENV.split(",") if o.strip()]
    if _ALLOWED_ORIGINS_ENV
    else ["null"]  # Electron file:// origin appears as "null"
)
app.add_middleware(
    CORSMiddleware,
    # No cookies are ever used for auth here (X-Connect-Token/X-Connect-Session
    # are explicit headers the frontend sets itself, never browser-attached) —
    # allow_credentials=True combined with the "null" origin fallback below
    # would otherwise be a textbook CORS misconfiguration for no actual benefit.
    allow_credentials=False,
    allow_headers=["*"],
    allow_methods=["*"],
    allow_origins=_ALLOWED_ORIGINS,
    allow_origin_regex=r"http://localhost(:[0-9]+)?",
    # Response headers are hidden from JS on a CORS response unless
    # explicitly exposed, even though they're already visible in the raw
    # HTTP response — routes/radio.py's X-Has-Transparency is read by
    # services/imageTransparency.ts via response.headers.get(), which would
    # otherwise silently always come back null despite the header actually
    # being there.
    expose_headers=["X-Has-Transparency"],
)


@app.middleware("http")
async def _suppress_shutdown_cancellation(request: Request, call_next):
    """uvicorn's timeout_graceful_shutdown (see uvicorn.run() below) cancels
    whatever request is still in flight once it expires — expected, and
    exactly what makes quitting mid-request prompt instead of waiting the
    request out. Left to reach uvicorn's own ASGI runner uncaught, that
    CancelledError gets logged as "Exception in ASGI application" with a
    full traceback, indistinguishable in the logs from a real crash. Added
    last, so this ends up the outermost middleware and catches it before it
    gets that far — the connection is going away either way, so a 503
    nobody will read is as good a response as any."""
    try:
        return await call_next(request)
    except asyncio.CancelledError:
        logger.debug(f"[shutdown] Request cancelled: {request.method} {request.url.path}")
        return Response(status_code=503)


app.include_router(stream_router)
# After stream_router, which owns /stream/{session_id} — a different
# segment count, so the two never compete, but keeping them adjacent
# makes that obvious rather than something to re-derive.
app.include_router(local_stream_router)
app.include_router(playback_router)
app.include_router(devices_router)
app.include_router(jellyfin_auth_router)
app.include_router(plex_auth_router)
app.include_router(discovery_router)
app.include_router(volume_router)
app.include_router(join_router)
app.include_router(log_level_router)
app.include_router(pairing_router)
app.include_router(lyrics_router)
app.include_router(waveform_router)
app.include_router(radio_router)
app.include_router(recommendations_router)
app.include_router(upnp_router)
# Diagnostic-only (routes/debug.py) — registered at Debug log level or
# louder (see _INITIAL_LOG_LEVEL's own comment), not something a real
# deployment running at its default Info needs exposed. A startup-time
# check only: switching the level up from Settings mid-session doesn't
# retroactively register it, same as it wouldn't un-register on switching
# back down — a niche-enough tool (visualizer-timing calibration) that
# needing an actual restart for this specifically is an acceptable
# trade for not having to make route registration itself dynamic.
# Registered before proxy_router deliberately: that one ends in a catch-all
# `/{path:path}` route requiring require_token, which would otherwise
# shadow /debug/* — Starlette matches routes in registration order, first
# match wins.
if is_at_least("DEBUG"):
    app.include_router(debug_router)
# Same ordering reason as debug_router above: /remote/* (including its own
# /remote/app/{path:path} static-file catch-all) must be registered before
# proxy_router's broader /{path:path}.
app.include_router(remote_router)
app.include_router(proxy_router)


if __name__ == "__main__":
    try:
        # Pass the app object directly — string-based import ("main:app") breaks
        # in PyInstaller bundles because the module loader works differently.
        #
        # timeout_graceful_shutdown matters specifically for casting: a device
        # streaming audio holds an HTTP connection open for as long as the
        # track plays, and uvicorn's own default is to wait for every open
        # connection to close by itself before ever running the lifespan
        # shutdown above — the one that actually calls active_delivery.stop()
        # to tell the device to stop. Without a limit, quitting mid-cast (e.g.
        # the packaged Electron app's requestQuit()) waited out the rest of
        # whatever was playing before the backend process actually exited.
        uvicorn.run(
            app,
            host="0.0.0.0",
            port=PORT,
            log_config=UVICORN_LOG_CONFIG,
            reload=False,
            timeout_graceful_shutdown=3,
        )
    except Exception:
        traceback.print_exc()
