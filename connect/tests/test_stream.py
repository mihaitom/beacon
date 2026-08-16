"""Tests for GET /stream — resume_offset consumption timing.

Regression coverage for a bug where a device connecting to /stream and
disconnecting before FFmpeg produced any audio (most commonly a device's
first connection in a session, e.g. while a Sonos coordinator is still
settling) silently discarded the seek offset, so the *next* (real) connection
started the track from 0:00 while the app's own state still reported the
correct position.
"""

from unittest.mock import patch

from core.streamer import OutputFormat
from media import Track


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
