"""Tests for main.py's startup logging, log-record filtering, the asyncio
exception handler, and the periodic device-rediscovery task. See
test_shutdown.py for the lifespan's shutdown-side behavior (stopping active
deliveries)."""

import asyncio
import logging
import shutil
from unittest.mock import patch

from fastapi.testclient import TestClient

import main
from main import _asyncio_exception_handler, _periodic_discovery, _ShortNameFilter

# ── _ShortNameFilter ─────────────────────────────────────────────────────────


def _filtered_name(logger_name: str) -> str:
    record = logging.LogRecord(logger_name, logging.INFO, __file__, 1, "msg", None, None)
    _ShortNameFilter().filter(record)
    return record.name


def test_short_name_filter_strips_connect_prefix():
    assert _filtered_name("connect.playback") == "playback"


def test_short_name_filter_renames_bare_connect_to_main():
    assert _filtered_name("connect") == "main"


def test_short_name_filter_strips_pychromecast_prefix():
    assert _filtered_name("pychromecast.socket_client") == "socket_client"


def test_short_name_filter_renames_uvicorn_error_to_uvicorn():
    assert _filtered_name("uvicorn.error") == "uvicorn"


def test_short_name_filter_leaves_other_names_untouched():
    assert _filtered_name("delivery") == "delivery"


# ── _asyncio_exception_handler ───────────────────────────────────────────────


def test_asyncio_exception_handler_quiets_pyatv_session_noise(caplog):
    loop = object()  # never touched on this path
    with caplog.at_level(logging.DEBUG, logger="connect"):
        _asyncio_exception_handler(loop, {"message": "Unclosed client session"})

    assert "harmless" in caplog.text


def test_asyncio_exception_handler_delegates_everything_else():
    calls = []

    class _FakeLoop:
        def default_exception_handler(self, context):
            calls.append(context)

    context = {"message": "a real error", "exception": RuntimeError("boom")}
    _asyncio_exception_handler(_FakeLoop(), context)

    assert calls == [context]


# ── _periodic_discovery ──────────────────────────────────────────────────────


async def test_periodic_discovery_calls_discover_all_after_the_interval():
    with (
        patch("main.asyncio.sleep", side_effect=[None, asyncio.CancelledError()]),
        patch("main.discover_all") as discover_all,
    ):
        task = asyncio.create_task(_periodic_discovery())
        try:
            await task
        except asyncio.CancelledError:
            pass

    discover_all.assert_called_once()


async def test_periodic_discovery_survives_a_failed_scan_and_keeps_looping(caplog):
    call_count = 0

    async def _fake_discover_all():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("network unreachable")

    with (
        patch("main.asyncio.sleep", side_effect=[None, None, asyncio.CancelledError()]),
        patch("main.discover_all", side_effect=_fake_discover_all),
        caplog.at_level(logging.ERROR, logger="connect"),
    ):
        task = asyncio.create_task(_periodic_discovery())
        try:
            await task
        except asyncio.CancelledError:
            pass

    assert call_count == 2  # the failed scan didn't stop the loop from trying again
    assert "Periodic scan failed" in caplog.text


# ── lifespan startup logging ─────────────────────────────────────────────────
# Real startup/shutdown runs on TestClient's own __enter__/__exit__ (ASGI
# lifespan protocol) — see test_shutdown.py for the identical technique.


def test_lifespan_warns_when_ffmpeg_is_missing(caplog):
    with (
        patch.object(shutil, "which", return_value=None),
        caplog.at_level(logging.ERROR, logger="connect"),TestClient(main.app)
    ):
        pass

    assert "ffmpeg" in caplog.text.lower()
    assert "NOT FOUND" in caplog.text


def test_lifespan_warns_when_connect_token_is_explicitly_empty(caplog, monkeypatch):
    monkeypatch.setattr(main, "_CONNECT_TOKEN", "")
    with caplog.at_level(logging.WARNING, logger="connect"), TestClient(main.app):
        pass

    assert "no auth" in caplog.text.lower()


def test_lifespan_logs_a_custom_connect_token_without_printing_it(caplog, monkeypatch):
    monkeypatch.setattr(main, "_CONNECT_TOKEN", "a-real-secret-token")
    monkeypatch.setattr(main, "_CONNECT_TOKEN_GENERATED", False)
    with caplog.at_level(logging.INFO, logger="connect"), TestClient(main.app):
        pass

    assert "custom CONNECT_TOKEN set" in caplog.text
    # Unlike the auto-generated case (which does print the token, so it can
    # be copy-pasted for scripting — see that branch's own comment), an
    # explicitly-set one must never show up in the log.
    assert "a-real-secret-token" not in caplog.text


# ── debug_router registration gate ───────────────────────────────────────────
# A startup-time-only check (see main.py's own comment on why) — only
# reachable by actually re-executing the module, unlike everything else in
# this file. Reloaded back to normal in `finally` regardless of outcome:
# every other test file's own `from main import app` already holds its own
# reference to the *original* app object from first import, so this only
# risks main.app itself and process-wide logger levels, both restored below.
#
# Verified by actually requesting a /debug route rather than inspecting
# app.routes: on this FastAPI version, include_router() registers a lazy
# _IncludedRouter wrapper (no .path of its own, and no eagerly-flattened
# child APIRoute entries) rather than the plain APIRoute list older
# versions exposed, so a `getattr(r, "path", ...)` scan over app.routes
# silently matches nothing at all — for *any* router, gated or not. Going
# through TestClient instead exercises the same resolution FastAPI itself
# uses to serve a real request, so it isn't fooled by that.


def test_debug_router_registered_only_at_debug_log_level_or_louder(monkeypatch, tmp_path):
    import importlib

    import core.log_level as log_level_mod

    monkeypatch.setattr(log_level_mod, "_PATH", str(tmp_path / "log_level.txt"))
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    try:
        importlib.reload(main)
        with TestClient(main.app) as client:
            resp = client.get("/debug/test-tone.wav")
        assert resp.status_code == 200
    finally:
        monkeypatch.delenv("LOG_LEVEL", raising=False)
        importlib.reload(main)  # restore the normal (non-debug) app for every later test


def test_debug_router_absent_at_the_default_info_level(monkeypatch, tmp_path):
    import importlib

    import core.log_level as log_level_mod

    monkeypatch.setattr(log_level_mod, "_PATH", str(tmp_path / "log_level.txt"))
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    try:
        importlib.reload(main)
        with TestClient(main.app) as client:
            resp = client.get("/debug/test-tone.wav")
        # Not 404: with debug_router absent, the request falls through to
        # proxy_router's own catch-all `/{path:path}` (registered right
        # after it for exactly this reason — see main.py's comment above
        # the include_router calls), which requires a token and rejects
        # first on that, before ever getting far enough to 404.
        assert resp.status_code == 401
    finally:
        importlib.reload(main)
