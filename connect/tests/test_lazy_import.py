"""Tests for delivery/lazy_import.py — importing heavy protocol libraries
off the event loop without racing another thread through a shared
dependency."""

import asyncio
import threading
import time
from unittest.mock import patch

from delivery.lazy_import import import_in_thread


def test_concurrent_imports_are_serialized_not_raced():
    """Regression test: a device scan starts every protocol's discovery at
    once (routes/discovery.py's asyncio.gather), and each ran its first
    import in its own OS thread via asyncio.to_thread — genuinely
    concurrent. Two different top-level imports (pyatv for AirPlay,
    async_upnp_client for DLNA) that both transitively pull in aiohttp could
    race through it: confirmed live (2026-08-24) as "cannot import name
    'HeadersParser' from partially initialized module 'aiohttp.http_parser'
    (most likely due to a circular import)" on a fresh instance's first
    scan. This asserts the actual import call is never entered a second time
    while one is already in flight."""
    in_progress = threading.Event()
    overlap_detected = threading.Event()

    def fake_import_module(name):
        if in_progress.is_set():
            overlap_detected.set()
        in_progress.set()
        try:
            # Long enough that two real OS threads (the bug's actual
            # mechanism — asyncio.to_thread, not just interleaved coroutines)
            # would overlap here if nothing serialized them.
            time.sleep(0.05)
        finally:
            in_progress.clear()
        return object()

    async def _run():
        await asyncio.gather(
            import_in_thread("fake_module_a"),
            import_in_thread("fake_module_b"),
            import_in_thread("fake_module_c"),
        )

    with patch("delivery.lazy_import.importlib.import_module", side_effect=fake_import_module):
        asyncio.run(_run())

    assert not overlap_detected.is_set()


def test_import_in_thread_still_returns_the_real_module():
    """The lock changes *when* the import runs, not what it returns — a
    real, importable module still comes back normally."""
    module = asyncio.run(import_in_thread("json"))
    assert module.__name__ == "json"
