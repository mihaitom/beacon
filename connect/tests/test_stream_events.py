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
from core.visualizer_feed import ASSUMED_DEVICE_LEAD_SECONDS
from delivery import ChromecastDelivery, SonosDelivery
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
    # Not what this test is about — see the "debug" section below for
    # last_release_debug coverage. A bare MagicMock's attribute is
    # truthy/non-None by default, which json.dumps() can't serialize.
    analyzer.last_release_debug = None
    default_session.visualizer.analyzer = analyzer

    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator
    try:
        frame = await gen.__anext__()
    finally:
        await gen.aclose()

    assert frame == f"data: {json.dumps({'bands': [1.0, 2.0, 3.0]})}\n\n"


async def test_visualizer_includes_debug_when_the_analyzer_has_one(default_session):
    """core/audio_analysis.py's AudioAnalyzer.last_release_debug — the
    debug overlay's own data, radio only (see that attribute's own
    docstring for why a track never sets it)."""
    analyzer = MagicMock()
    analyzer.frames = asyncio.Queue()
    analyzer.frames.put_nowait([1.0])
    analyzer.last_release_debug = (12.34, 12.1)
    # Not what this test is about — see the lead-specific test below. Same
    # MagicMock-attribute pitfall as last_release_debug above.
    analyzer.last_release_lead = None
    default_session.visualizer.analyzer = analyzer

    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator
    try:
        frame = await gen.__anext__()
    finally:
        await gen.aclose()

    assert (
        frame
        == f"data: {json.dumps({'bands': [1.0], 'debug': {'visualizer': 12.34, 'cast': 12.1}})}\n\n"
    )


async def test_visualizer_includes_lead_when_the_analyzer_has_one(default_session):
    """Radio-relayed-Sonos only — see AudioAnalyzer.last_release_lead's own
    comment for why the delta above can't tell "still the fixed guess"
    apart from "a real measurement landed" without this."""
    analyzer = MagicMock()
    analyzer.frames = asyncio.Queue()
    analyzer.frames.put_nowait([1.0])
    analyzer.last_release_debug = (12.34, 12.1)
    analyzer.last_release_lead = (4.7, False)
    default_session.visualizer.analyzer = analyzer

    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator
    try:
        frame = await gen.__anext__()
    finally:
        await gen.aclose()

    payload = json.loads(frame.removeprefix("data: ").rstrip("\n"))
    assert payload["debug"]["lead"] == {"seconds": 4.7, "measured": False}


async def test_visualizer_omits_lead_when_the_analyzer_has_none(default_session):
    """The track case, and radio via Chromecast/DLNA/direct-Sonos (a real
    device position, nothing fixed/measured to report) — omitted from the
    payload entirely rather than sent as null, same convention as `debug`
    itself for a track."""
    analyzer = MagicMock()
    analyzer.frames = asyncio.Queue()
    analyzer.frames.put_nowait([1.0])
    analyzer.last_release_debug = (12.34, 12.1)
    analyzer.last_release_lead = None
    default_session.visualizer.analyzer = analyzer

    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator
    try:
        frame = await gen.__anext__()
    finally:
        await gen.aclose()

    payload = json.loads(frame.removeprefix("data: ").rstrip("\n"))
    assert "lead" not in payload["debug"]


async def test_visualizer_omits_debug_for_a_track(default_session):
    analyzer = MagicMock()
    analyzer.frames = asyncio.Queue()
    analyzer.frames.put_nowait([1.0])
    analyzer.last_release_debug = None
    default_session.visualizer.analyzer = analyzer

    resp = await visualizer_events(session=default_session)
    gen = resp.body_iterator
    try:
        frame = await gen.__anext__()
    finally:
        await gen.aclose()

    assert "debug" not in json.loads(frame.removeprefix("data: ").rstrip("\n"))


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
        analyzer.last_release_debug = None  # see the other test's identical note
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


# ── radio_buffering ─────────────────────────────────────────────────────────
# See core/session.py's radio_is_buffering() for the two ways the backend
# knows a cast device is still filling its own startup buffer, and why the
# second one had to exist at all.


def _casting_radio(session, delivery=None):
    st = session.state
    st.radio_info = {"url": "http://station/live", "title": "Some Station", "relayed": True}
    st.is_streaming = True
    st.active_delivery = delivery or SonosDelivery("Küche")
    st.clock.start()
    return st


def test_radio_buffering_follows_the_tracker_when_there_is_one(default_session):
    _casting_radio(default_session, ChromecastDelivery("Wohnzimmer"))
    tracker = MagicMock()
    tracker.ready = False
    default_session.radio_position_tracker = tracker
    assert build_status_dict(default_session)["radio_buffering"] is True
    tracker.ready = True
    assert build_status_dict(default_session)["radio_buffering"] is False


def test_radio_buffering_covers_a_relayed_sonos_that_has_no_tracker(default_session):
    """The case that used to report False for the whole run, on the device
    with the largest measured buffer of the three: a relayed Sonos is
    excluded from position tracking entirely (it reports a flat 0.00s over
    x-rincon-mp3radio://), so `not tracker` read as "done buffering" and the
    seek bar counted up from 0:00 while the speaker was still silent."""
    st = _casting_radio(default_session)
    default_session.radio_position_tracker = None
    assert build_status_dict(default_session)["radio_buffering"] is True
    # ...and clears once the device's own expected lead has elapsed.
    st.clock.play_start_time -= ASSUMED_DEVICE_LEAD_SECONDS + 0.5
    assert build_status_dict(default_session)["radio_buffering"] is False


def test_radio_buffering_prefers_a_measured_lag_over_the_fixed_guess(default_session):
    """Once the ICY round trip has measured this device's real buffer, the
    indicator clears when that says audio starts — the same measurement
    _FirstByteClock paces the visualizer with, so the two agree."""
    st = _casting_radio(default_session)
    default_session.radio_position_tracker = None
    default_session.radio_icy_measured_lag = 1.0
    st.clock.play_start_time -= 2.0  # past the measurement, well short of the guess
    assert build_status_dict(default_session)["radio_buffering"] is False


def test_radio_buffering_is_false_for_local_playback(default_session):
    """No cast device in the picture — the browser's own <audio> handles
    its own buffering and nothing here should claim otherwise."""
    st = _casting_radio(default_session)
    st.active_delivery = None
    default_session.radio_position_tracker = None
    assert build_status_dict(default_session)["radio_buffering"] is False


def test_radio_buffering_is_false_while_paused(default_session):
    st = _casting_radio(default_session)
    default_session.radio_position_tracker = None
    st.clock.is_paused = True
    assert build_status_dict(default_session)["radio_buffering"] is False
