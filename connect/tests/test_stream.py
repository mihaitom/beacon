"""Tests for GET /stream — resume_offset consumption timing.

Regression coverage for a bug where a device connecting to /stream and
disconnecting before FFmpeg produced any audio (most commonly a device's
first connection in a session, e.g. while a Sonos coordinator is still
settling) silently discarded the seek offset, so the *next* (real) connection
started the track from 0:00 while the app's own state still reported the
correct position.
"""

from unittest.mock import AsyncMock, patch

from core.streamer import FALLBACK_FORMAT, OutputFormat
from delivery import ChromecastDelivery
from media import Track
from routes.stream import _advance_or_end, _dispatch_queued_track


async def _empty_stream(*args, **kwargs):
    """Simulates a connection that ends before producing any audio."""
    return
    yield b""  # pragma: no cover - makes this an async generator


async def _real_stream(*args, **kwargs):
    yield b"chunk-1"
    yield b"chunk-2"


def _configure_and_set_track(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="")
    default_session.state.current_track = track
    default_session.state.is_streaming = True
    default_session.state.clock.resume_offset = 42.0
    return track


def test_empty_connection_does_not_consume_resume_offset(client, default_session):
    _configure_and_set_track(client, default_session)

    with patch("routes.stream.stream_tracks", side_effect=_empty_stream):
        client.get("/stream")

    assert default_session.state.clock.resume_offset == 42.0


def test_connection_with_audio_consumes_resume_offset(client, default_session):
    _configure_and_set_track(client, default_session)

    with patch("routes.stream.stream_tracks", side_effect=_real_stream):
        client.get("/stream")

    assert default_session.state.clock.resume_offset == 0.0


def test_abandoned_then_real_connection_preserves_offset_for_the_real_one(
    client, default_session
):
    """The exact scenario from the bug report: an aborted first connection
    must not cost the real (second) connection its seek offset."""
    _configure_and_set_track(client, default_session)

    with patch("routes.stream.stream_tracks", side_effect=_empty_stream):
        client.get("/stream")
    assert default_session.state.clock.resume_offset == 42.0

    with patch("routes.stream.stream_tracks", side_effect=_real_stream) as mocked:
        client.get("/stream")
    assert default_session.state.clock.resume_offset == 0.0
    # The real connection must have received the still-intact offset for -ss.
    assert mocked.call_args.kwargs["start_offset"] == 42.0


def test_stale_connection_does_not_clear_a_newer_generations_offset(
    client, default_session
):
    """If a new /seek (bumping play_generation) happens while an old,
    abandoned connection is still in flight, that old connection reaching
    its first chunk must not clobber the new generation's offset."""
    _configure_and_set_track(client, default_session)

    async def _stale_stream(*args, **kwargs):
        # A newer generation starts *after* this connection began streaming,
        # simulating a race between an old connection and a fresh /seek.
        default_session.state.clock.play_generation += 1
        default_session.state.clock.resume_offset = 99.0
        yield b"stale-chunk"

    with patch("routes.stream.stream_tracks", side_effect=_stale_stream):
        client.get("/stream")

    assert default_session.state.clock.resume_offset == 99.0


# ── Content-Type reflects the cached format decision ────────────────────────
# See core/streamer.py's resolve_output_format() — routes/playback.py resolves
# the real source format once at /play and caches it on session.state; /stream
# must read that instead of always claiming audio/mpeg, so HEAD/GET and the
# actual ffmpeg invocation never disagree with what's on the wire.


def test_get_stream_content_type_matches_cached_flac_format(client, default_session):
    _configure_and_set_track(client, default_session)
    default_session.state.current_output_format = OutputFormat(
        ffmpeg_args=["-acodec", "copy", "-f", "flac"], content_type="audio/flac"
    )

    with patch("routes.stream.stream_tracks", side_effect=_real_stream) as mocked:
        r = client.get("/stream")

    assert r.headers["content-type"].startswith("audio/flac")
    assert mocked.call_args.kwargs["output_format"].content_type == "audio/flac"


def test_get_stream_content_type_defaults_to_mp3(client, default_session):
    _configure_and_set_track(client, default_session)

    with patch("routes.stream.stream_tracks", side_effect=_real_stream):
        r = client.get("/stream")

    assert r.headers["content-type"].startswith("audio/mpeg")


def test_head_stream_content_type_matches_cached_format(client, default_session):
    _configure_and_set_track(client, default_session)
    default_session.state.current_output_format = OutputFormat(
        ffmpeg_args=["-acodec", "copy", "-f", "ogg"], content_type="audio/ogg"
    )

    r = client.head("/stream")

    assert r.headers["content-type"].startswith("audio/ogg")


# ── Queue auto-advance (_advance_or_end / _dispatch_queued_track) ───────────
# See core/state.py's AppState.queue comment — connect auto-advances casting
# playback through a queue the frontend seeded via /play's track_ids,
# instead of only ever marking track_ended and waiting for the (possibly
# asleep) renderer to notice and re-dispatch.


def _playing_session(default_session, queue, queue_index=0, target=None):
    """Sets up default_session.state as "actively streaming
    queue[queue_index] to `target`" — the precondition _advance_or_end()
    assumes (see its own is_streaming/is_paused/play_generation guard).
    Returns the generation to call it with."""
    st = default_session.state
    st.current_track = Track(
        id=queue[queue_index], title="Current", artist="Artist", duration=180, cover_art_id="c"
    )
    st.is_streaming = True
    st.active_delivery = target
    st.queue = queue
    st.queue_index = queue_index
    st.clock.start(0.0)
    return st.clock.play_generation


async def test_advance_or_end_dispatches_next_queued_track(default_session):
    target = ChromecastDelivery("TV")
    generation = _playing_session(default_session, ["1", "2"], target=target)
    next_track = Track(id="2", title="Next", artist="Artist", duration=200, cover_art_id="c")

    with (
        patch.object(default_session.media, "get_track", return_value=next_track),
        patch("routes.stream.resolve_output_format", AsyncMock(return_value=FALLBACK_FORMAT)),
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play_mock,
    ):
        await _advance_or_end(default_session, generation)

    assert play_mock.await_count == 1
    assert default_session.state.queue_index == 1
    assert default_session.state.current_track.id == "2"
    assert default_session.state.is_streaming is True
    assert default_session.state.track_ended is False


async def test_advance_or_end_marks_ended_when_queue_exhausted(default_session):
    target = ChromecastDelivery("TV")
    generation = _playing_session(default_session, ["1"], target=target)

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play_mock:
        await _advance_or_end(default_session, generation)

    assert play_mock.await_count == 0
    assert default_session.state.queue_index == 0
    assert default_session.state.is_streaming is False
    assert default_session.state.track_ended is True


async def test_advance_or_end_marks_ended_when_no_active_delivery(default_session):
    """No cast target (local-only playback) — nothing for auto-advance to
    dispatch to, same "mark ended" fallback as an exhausted queue."""
    generation = _playing_session(default_session, ["1", "2"], target=None)

    await _advance_or_end(default_session, generation)

    assert default_session.state.is_streaming is False
    assert default_session.state.track_ended is True


async def test_advance_or_end_skips_stale_generation(default_session):
    """A newer /play, /seek or /stop already superseded this track-end
    signal — same staleness guard _fire_track_end() always had."""
    target = ChromecastDelivery("TV")
    generation = _playing_session(default_session, ["1", "2"], target=target)
    default_session.state.clock.play_generation += 1  # a newer dispatch already happened

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play_mock:
        await _advance_or_end(default_session, generation)

    assert play_mock.await_count == 0
    assert default_session.state.queue_index == 0
    # Untouched, not marked ended either — a stale signal must not overwrite
    # whatever the newer, real dispatch already put in place.
    assert default_session.state.is_streaming is True


async def test_advance_or_end_falls_back_when_next_track_not_found(default_session):
    target = ChromecastDelivery("TV")
    generation = _playing_session(default_session, ["1", "2"], target=target)

    with patch.object(default_session.media, "get_track", side_effect=RuntimeError("gone")):
        await _advance_or_end(default_session, generation)

    assert default_session.state.queue_index == 0
    assert default_session.state.is_streaming is False
    assert default_session.state.track_ended is True


async def test_advance_or_end_falls_back_when_dispatch_fails(default_session):
    target = ChromecastDelivery("TV")
    generation = _playing_session(default_session, ["1", "2"], target=target)
    next_track = Track(id="2", title="Next", artist="Artist", duration=200, cover_art_id="c")

    with (
        patch.object(default_session.media, "get_track", return_value=next_track),
        patch("routes.stream.resolve_output_format", AsyncMock(return_value=FALLBACK_FORMAT)),
        patch.object(
            ChromecastDelivery, "play", new=AsyncMock(side_effect=RuntimeError("unreachable"))
        ),
    ):
        await _advance_or_end(default_session, generation)

    # Falls back to "mark ended" instead of leaving state stuck mid-
    # transition — queue_index must not advance past a track that never
    # actually started.
    assert default_session.state.queue_index == 0
    assert default_session.state.is_streaming is False
    assert default_session.state.track_ended is True


async def test_dispatch_queued_track_updates_state_and_schedules_background_tasks(
    default_session,
):
    target = ChromecastDelivery("TV")
    _playing_session(default_session, ["1", "2"], target=target)
    next_track = Track(id="2", title="Next", artist="Artist", duration=200, cover_art_id="c")

    with (
        patch("routes.stream.resolve_output_format", AsyncMock(return_value=FALLBACK_FORMAT)),
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play_mock,
    ):
        dispatched = await _dispatch_queued_track(default_session, target, next_track, gain=1.0)

    assert dispatched is True
    assert play_mock.await_count == 1
    assert default_session.state.current_track.id == "2"
    assert default_session.state.is_streaming is True
