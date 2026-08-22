"""Tests for GET /events and GET /visualizer — the SSE channels
stores/playback.ts's connect.$subscribe()/reconcileFromStatus() and the
fullscreen visualizer's 'cast' mode (AudioVisualizer.vue) read from.

Both route handlers are open-ended `while True` streams, so these drive
their async generators directly (`resp.body_iterator`) rather than through
the ASGI/TestClient stack — a synchronous client.get() would just hang
waiting for a response body that never ends, same reasoning as
test_stream.py's direct audio_stream() calls for stream_with_completion()'s
failure paths."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.session import build_status_dict
from routes.stream import status_events, visualizer_events


async def _time_out(coro, timeout):
    """Stand-in for asyncio.wait_for() that fails instantly instead of
    after a real ~2s/1s wait — closes `coro` first (the real queue.get()
    call the patched-out wait_for would otherwise have awaited) so it
    doesn't linger as an unawaited-coroutine warning."""
    coro.close()
    raise TimeoutError()


# ── GET /events ───────────────────────────────────────────────────────────


async def test_events_opens_with_a_retry_directive_then_the_current_status(default_session):
    resp = await status_events(session=default_session)
    gen = resp.body_iterator
    try:
        first = await gen.__anext__()
        second = await gen.__anext__()
    finally:
        await gen.aclose()

    assert first == "retry: 2000\n\n"
    assert second == f"data: {json.dumps(build_status_dict(default_session))}\n\n"


async def test_events_forwards_a_broadcast_to_the_subscribed_client(default_session):
    resp = await status_events(session=default_session)
    gen = resp.body_iterator
    try:
        await gen.__anext__()  # retry directive
        await gen.__anext__()  # initial snapshot
        # Already queued before the next __anext__() asks for it, so this
        # resolves immediately rather than waiting out the real 2s timeout.
        await default_session.event_bus.broadcast({"hello": "world"})
        forwarded = await gen.__anext__()
    finally:
        await gen.aclose()

    assert forwarded == f"data: {json.dumps({'hello': 'world'})}\n\n"


async def test_events_unsubscribes_its_queue_once_the_connection_closes(default_session):
    resp = await status_events(session=default_session)
    gen = resp.body_iterator
    await gen.__anext__()
    assert len(default_session.event_bus._queues) == 1

    await gen.aclose()

    # Otherwise every reconnect (tab refocus, network blip, ...) would leak
    # a queue onto this session's EventBus forever.
    assert default_session.event_bus._queues == []


async def test_events_heartbeats_on_timeout_when_nothing_is_streaming(default_session):
    resp = await status_events(session=default_session)
    gen = resp.body_iterator
    try:
        await gen.__anext__()
        await gen.__anext__()
        with patch("routes.stream.asyncio.wait_for", _time_out):
            tick = await gen.__anext__()
    finally:
        await gen.aclose()

    assert tick == ": heartbeat\n\n"


async def test_events_resends_status_on_timeout_while_actively_streaming(default_session):
    """Keeps stores/playback.ts's position extrapolation (lastServerElapsed)
    calibrated even across a quiet ~2s gap with no state change to
    broadcast — a plain heartbeat here instead would leave the frontend
    extrapolating from an increasingly stale anchor."""
    default_session.state.is_streaming = True
    resp = await status_events(session=default_session)
    gen = resp.body_iterator
    try:
        await gen.__anext__()
        await gen.__anext__()
        with patch("routes.stream.asyncio.wait_for", _time_out):
            tick = await gen.__anext__()
    finally:
        await gen.aclose()

    assert tick == f"data: {json.dumps(build_status_dict(default_session))}\n\n"


# ── GET /visualizer ───────────────────────────────────────────────────────


async def test_visualizer_idles_when_no_analyzer_is_active(default_session):
    default_session.visualizer.analyzer = None
    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator
    try:
        with patch("routes.stream.asyncio.sleep", AsyncMock()):
            tick = await gen.__anext__()
    finally:
        await gen.aclose()

    assert tick == ": idle\n\n"


async def test_visualizer_forwards_a_frame_from_the_active_analyzer(default_session):
    analyzer = MagicMock()
    analyzer.frames = asyncio.Queue()
    analyzer.frames.put_nowait([1.0, 2.0, 3.0])
    default_session.visualizer.analyzer = analyzer

    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator
    try:
        frame = await gen.__anext__()
    finally:
        await gen.aclose()

    assert frame == f"data: {json.dumps({'bands': [1.0, 2.0, 3.0]})}\n\n"


async def test_visualizer_heartbeats_while_the_active_analyzer_has_no_frame_yet(default_session):
    analyzer = MagicMock()
    analyzer.frames = asyncio.Queue()  # never fed — nothing to get()
    default_session.visualizer.analyzer = analyzer

    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator
    try:
        with patch("routes.stream.asyncio.wait_for", _time_out):
            tick = await gen.__anext__()
    finally:
        await gen.aclose()

    assert tick == ": heartbeat\n\n"


async def test_visualizer_switches_from_idle_to_forwarding_once_a_track_starts_analyzing(
    default_session,
):
    """The feed's analyzer is re-read every loop iteration, not captured
    once — core/visualizer_feed.py replaces it on every track change and
    seek, and an already-open /visualizer connection must pick that up
    rather than staying stuck idling against the analyzer (or lack of one)
    from when it first connected."""
    default_session.visualizer.analyzer = None
    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator
    try:
        with patch("routes.stream.asyncio.sleep", AsyncMock()):
            idle_tick = await gen.__anext__()

        analyzer = MagicMock()
        analyzer.frames = asyncio.Queue()
        analyzer.frames.put_nowait([4.0])
        default_session.visualizer.analyzer = analyzer

        frame = await gen.__anext__()
    finally:
        await gen.aclose()

    assert idle_tick == ": idle\n\n"
    assert frame == f"data: {json.dumps({'bands': [4.0]})}\n\n"


async def test_visualizer_stops_cleanly_on_cancellation(default_session):
    default_session.visualizer.analyzer = None
    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator

    with patch("routes.stream.asyncio.sleep", AsyncMock()):
        await gen.__anext__()  # parked inside the idle branch
        # A disconnecting client cancels the underlying task — must end the
        # generator quietly rather than letting CancelledError escape and
        # show up as a server error in the logs.
        with pytest.raises(StopAsyncIteration):
            await gen.athrow(asyncio.CancelledError())


async def test_visualizer_subscribes_while_connected_and_releases_on_disconnect(
    default_session,
):
    """An open connection here is what makes the analysis run at all (see
    core/visualizer_feed.py) — so the subscription has to be tied to the
    generator's own lifetime, released however it ends."""
    feed = default_session.visualizer
    feed.analyzer = None
    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator

    assert feed._subscribers == 0  # nothing runs until the body is iterated
    with patch("routes.stream.asyncio.sleep", AsyncMock()):
        await gen.__anext__()
        assert feed._subscribers == 1
    await gen.aclose()

    assert feed._subscribers == 0


async def test_visualizer_releases_its_subscription_on_cancellation(default_session):
    feed = default_session.visualizer
    feed.analyzer = None
    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator

    with patch("routes.stream.asyncio.sleep", AsyncMock()):
        await gen.__anext__()
        with pytest.raises(StopAsyncIteration):
            await gen.athrow(asyncio.CancelledError())

    assert feed._subscribers == 0
