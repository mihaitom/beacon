"""Tests for GET /stream — resume_offset consumption timing.

Regression coverage for a bug where a device connecting to /stream and
disconnecting before FFmpeg produced any audio (most commonly a device's
first connection in a session, e.g. while a Sonos coordinator is still
settling) silently discarded the seek offset, so the *next* (real) connection
started the track from 0:00 while the app's own state still reported the
correct position.
"""

import asyncio
import logging
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import routes.stream as stream_routes
from core.session import build_status_dict, mark_interrupted
from core.streamer import FALLBACK_FORMAT, OutputFormat
from delivery import ChromecastDelivery
from media import Track
from routes.stream import (
    DisconnectSnapshot,
    _advance_or_end,
    _playback_duration,
    _dispatch_queued_track,
    _mark_disconnected_if_not_reconnected,
    _resolve_track,
    _resume_after_interruption,
    audio_stream,
)


async def _empty_stream(*args, **kwargs):
    """Simulates a connection that ends before producing any audio."""
    return
    yield b""  # pragma: no cover - makes this an async generator


async def _real_stream(*args, **kwargs):
    yield b"chunk-1"
    yield b"chunk-2"


def _drain(q) -> list:
    items = []
    while not q.empty():
        items.append(q.get_nowait())
    return items


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


# ── a device reopening the stream on its own ─────────────────────────────────
# Regression tests: a reconnect used to be served the same way a fresh
# dispatch is, i.e. from resume_offset — which by then reads 0, because the
# first connection of that dispatch consumed it. The device got the track
# from the beginning while the session's clock was a minute in, then reported
# ~0 as its position, which the resync loop took for a seek on the speaker
# and "corrected" position_offset by the full track position. Observed live
# 2026-08-23; see docs/playback-bugs/fixed-reconnect-restarted-track-poisoned-clock.md.


def _mid_track_session(client, default_session, elapsed: float):
    """A session that has already served audio for the current generation
    and whose clock stands `elapsed` seconds into the track — i.e. exactly
    what a device re-requesting the URL finds."""
    track = _configure_and_set_track(client, default_session)
    st = default_session.state
    st.clock.start(0.0)
    st.clock.play_start_time -= elapsed
    st.clock.resume_offset = 0.0  # consumed by the first connection
    st.streamed_generation = st.clock.play_generation
    return track


def test_a_reconnect_is_served_from_the_current_position(client, default_session):
    _mid_track_session(client, default_session, elapsed=59.0)

    with patch("routes.stream.stream_tracks", side_effect=_real_stream) as mocked:
        client.get("/stream")

    assert mocked.call_args.kwargs["start_offset"] == pytest.approx(59.0, abs=1.0)


def test_a_reconnect_rebases_the_stream_timeline(client, default_session):
    """The device's own reported position restarts with the new stream, so
    the frame the resync compares it against has to restart too — otherwise
    the next resync reads the device's fresh 0 as a minute-long backwards
    seek."""
    _mid_track_session(client, default_session, elapsed=59.0)

    with patch("routes.stream.stream_tracks", side_effect=_real_stream):
        client.get("/stream")

    clock = default_session.state.clock
    assert clock.track_start_position == pytest.approx(59.0, abs=1.0)
    assert clock.elapsed_since_stream_start() == pytest.approx(0.0, abs=1.0)


def test_a_fresh_dispatch_is_still_served_from_its_own_offset(client, default_session):
    """A slow device can take seconds to open its connection after a /play —
    that first connection must still get the dispatch's own offset, not
    wherever the clock has crept to in the meantime."""
    _configure_and_set_track(client, default_session)  # resume_offset = 42.0
    st = default_session.state
    st.clock.start(42.0)
    st.clock.play_start_time -= 6.0  # six seconds passed before the device connected
    st.streamed_generation = None

    with patch("routes.stream.stream_tracks", side_effect=_real_stream) as mocked:
        client.get("/stream")

    assert mocked.call_args.kwargs["start_offset"] == 42.0
    assert st.streamed_generation == st.clock.play_generation


def test_a_reconnect_after_playback_ended_is_not_resumed_mid_track(
    client, default_session
):
    """is_streaming is False here — the session's playback genuinely ended
    and the device is only now getting round to re-requesting the URL.
    Nothing to resume into."""
    _mid_track_session(client, default_session, elapsed=59.0)
    default_session.state.is_streaming = False

    with patch("routes.stream.stream_tracks", side_effect=_real_stream) as mocked:
        client.get("/stream")

    assert mocked.call_args.kwargs["start_offset"] == 0.0


# ── active_stream_connections stays balanced even when setup itself fails ───


async def test_active_stream_connections_rolls_back_when_setup_fails_before_streaming(
    client, default_session,
):
    """Regression test: the connection is counted (for
    _mark_disconnected_if_not_reconnected's grace-period check) *before*
    get_stream_url()'s own network round-trip (a real one for Plex) — if
    that then fails, the increment must be undone here too, not only in
    stream_with_completion()'s own finally, which this failure never
    reaches (the StreamingResponse — and therefore that generator — is
    never even created)."""
    _configure_and_set_track(client, default_session)
    before = default_session.state.active_stream_connections

    with patch(
        "media.subsonic.SubsonicClient.get_stream_url",
        side_effect=RuntimeError("media server unreachable"),
    ), pytest.raises(RuntimeError):
        await audio_stream(session_id=default_session.session_id)

    assert default_session.state.active_stream_connections == before


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


def test_get_stream_logs_when_the_track_actually_starts(client, default_session, caplog):
    """on_track_start() (the debug line stream_tracks() calls once per
    track — see stream_with_completion()'s own local function) only fires
    when a real ffmpeg process actually starts producing bytes, something
    the other tests' faked-out stream_tracks() never triggers itself."""

    async def _fires_on_track_start(track_urls, on_track_start=None, **kwargs):
        if on_track_start:
            on_track_start(0)
        yield b"chunk-1"

    _configure_and_set_track(client, default_session)

    with (
        patch("routes.stream.stream_tracks", side_effect=_fires_on_track_start),
        caplog.at_level(logging.DEBUG, logger="connect.stream"),
    ):
        client.get("/stream")

    assert "▶" in caplog.text
    assert "Song" in caplog.text  # the track's title, set by _configure_and_set_track


def test_head_stream_content_type_matches_cached_format(client, default_session):
    _configure_and_set_track(client, default_session)
    default_session.state.current_output_format = OutputFormat(
        ffmpeg_args=["-acodec", "copy", "-f", "ogg"], content_type="audio/ogg"
    )

    r = client.head("/stream")

    assert r.headers["content-type"].startswith("audio/ogg")


# ── Queue auto-advance (_advance_or_end / _dispatch_queued_track) ───────────
# See core/state.py's AppState.queue comment — connect auto-advances casting
# playback through a queue the frontend seeded via /play's song_ids,
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


# ── Autoplay fallback top-up (_maybe_autoplay_topup) ─────────────────────────
# The backend-side counterpart to stores/playback.ts's own maybeAutoplay() —
# see AppState.autoplay_enabled's comment for why this exists at all
# (casting has to keep going even with no frontend client around to run the
# frontend's own version).


async def test_advance_or_end_autoplay_tops_up_and_advances(default_session):
    """Queue exhausted, but Autoplay's on and the media client can supply
    similar songs — tops the queue up and advances into it instead of
    marking the stream ended, same as if the frontend had already
    extended the queue itself before the track ran out."""
    target = ChromecastDelivery("TV")
    generation = _playing_session(default_session, ["1"], target=target)
    default_session.state.autoplay_enabled = True
    similar_track = Track(id="2", title="Similar", artist="Artist", duration=200, cover_art_id="c")

    with (
        patch.object(default_session.media, "get_similar_songs2", return_value=[similar_track]),
        patch.object(default_session.media, "get_track", return_value=similar_track),
        patch("routes.stream.resolve_output_format", AsyncMock(return_value=FALLBACK_FORMAT)),
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play_mock,
    ):
        await _advance_or_end(default_session, generation)

    assert play_mock.await_count == 1
    assert default_session.state.queue == ["1", "2"]
    assert default_session.state.queue_index == 1
    assert default_session.state.is_streaming is True
    assert default_session.state.track_ended is False


async def test_advance_or_end_autoplay_disabled_marks_ended(default_session):
    """Off by default (see stores/autoplay.ts's own default) — a media
    client that *could* supply similar songs must not get called at all
    unless the setting's actually on."""
    target = ChromecastDelivery("TV")
    generation = _playing_session(default_session, ["1"], target=target)
    assert default_session.state.autoplay_enabled is False

    with patch.object(default_session.media, "get_similar_songs2") as similar_mock:
        await _advance_or_end(default_session, generation)

    assert similar_mock.call_count == 0
    assert default_session.state.queue == ["1"]
    assert default_session.state.is_streaming is False
    assert default_session.state.track_ended is True


async def test_advance_or_end_autoplay_skipped_under_repeat(default_session):
    """repeat-all/repeat-one already keep the queue from running out on
    their own (once the renderer's awake to react — see
    _advance_or_end()'s own docstring) — Autoplay staying quiet here
    matches stores/playback.ts's maybeAutoplay() making the exact same
    call for the exact same reason."""
    target = ChromecastDelivery("TV")
    generation = _playing_session(default_session, ["1"], target=target)
    default_session.state.autoplay_enabled = True
    default_session.state.repeat_mode = "all"

    with patch.object(default_session.media, "get_similar_songs2") as similar_mock:
        await _advance_or_end(default_session, generation)

    assert similar_mock.call_count == 0
    assert default_session.state.queue == ["1"]
    assert default_session.state.is_streaming is False


async def test_advance_or_end_autoplay_filters_songs_already_queued(default_session):
    """A small library's similar-songs pool circling back to something
    already in the queue must not re-add it — same by-id dedup reasoning
    as stores/playback.ts's maybeAutoplay()."""
    target = ChromecastDelivery("TV")
    generation = _playing_session(default_session, ["1"], target=target)
    default_session.state.autoplay_enabled = True
    already_queued = Track(id="1", title="Current", artist="Artist", duration=180, cover_art_id="c")

    with patch.object(
        default_session.media, "get_similar_songs2", return_value=[already_queued]
    ):
        await _advance_or_end(default_session, generation)

    assert default_session.state.queue == ["1"]
    assert default_session.state.is_streaming is False
    assert default_session.state.track_ended is True


async def test_advance_or_end_autoplay_skipped_without_similar_songs_support(default_session):
    """Plex has no equivalent (see SubsonicClient.get_similar_songs2's own
    comment) — duck-typed via hasattr(), so a media client missing the
    method entirely must fall straight through to "mark ended" rather than
    raising. A plain stand-in with only get_track (not the real
    SubsonicClient, which does have get_similar_songs2), same shape Plex's
    own MediaClient adapter has."""

    class NoSimilarSongsMedia:
        def get_track(self, track_id: str) -> Track:
            return Track(id=track_id, title="Current", artist="Artist", duration=180)

        def get_cover_art_url(self, cover_art_id: str, internal: bool = False) -> str | None:
            return None  # build_status_dict()'s "mark ended" broadcast reads this

    target = ChromecastDelivery("TV")
    generation = _playing_session(default_session, ["1"], target=target)
    default_session.state.autoplay_enabled = True

    with patch.object(default_session, "media", NoSimilarSongsMedia()):
        await _advance_or_end(default_session, generation)

    assert default_session.state.queue == ["1"]
    assert default_session.state.is_streaming is False
    assert default_session.state.track_ended is True


async def test_advance_or_end_autoplay_falls_back_when_similar_songs_lookup_fails(
    default_session,
):
    """The media server's similar-songs call can itself fail (network hiccup,
    5xx, ...) — must fall through to the normal "mark ended" broadcast
    rather than propagating and leaving state stuck mid-transition, same
    as the "track not found"/"dispatch failed" fallbacks above."""
    target = ChromecastDelivery("TV")
    generation = _playing_session(default_session, ["1"], target=target)
    default_session.state.autoplay_enabled = True

    with patch.object(
        default_session.media, "get_similar_songs2", side_effect=RuntimeError("navidrome 500")
    ):
        await _advance_or_end(default_session, generation)

    assert default_session.state.queue == ["1"]
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


async def test_dispatch_queued_track_passes_its_gain_to_resolve_output_format(default_session):
    """Regression test: resolve_output_format() needs to know the
    ReplayGain multiplier up front to rule out a stream-copy tier that
    can't actually apply it (see that function's own comment) — the same
    `gain` this reuses for the device dispatch itself (see this function's
    own docstring) must also reach resolve_output_format()."""
    target = ChromecastDelivery("TV")
    _playing_session(default_session, ["1", "2"], target=target)
    next_track = Track(id="2", title="Next", artist="Artist", duration=200, cover_art_id="c")

    with (
        patch(
            "routes.stream.resolve_output_format", AsyncMock(return_value=FALLBACK_FORMAT)
        ) as resolve_mock,
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
    ):
        await _dispatch_queued_track(default_session, target, next_track, gain=0.8)

    assert resolve_mock.call_args.kwargs["gain"] == 0.8


# ── stream_with_completion()'s failure handling ──────────────────────────────
# ffmpeg crashing mid-stream and a device simply disconnecting must be told
# apart: an ffmpeg failure gets caught and reported (is_streaming=False,
# broadcast) so the frontend doesn't keep believing playback is still live,
# but must NOT set track_ended — that would make the frontend think this
# track played to completion and auto-advance, when actually little or
# nothing of it was ever heard. A disconnect (CancelledError) is a routine
# event with an entirely different meaning and must not trigger either.


async def test_ffmpeg_failure_mid_stream_reports_not_streaming_without_marking_ended(
    client, default_session,
):
    _configure_and_set_track(client, default_session)

    async def _crashes_after_one_chunk(*args, **kwargs):
        yield b"partial-chunk"
        raise RuntimeError("ffmpeg exploded")

    q = default_session.event_bus.subscribe()

    with patch("routes.stream.stream_tracks", side_effect=_crashes_after_one_chunk):
        resp = await audio_stream(session_id=default_session.session_id)
        chunks = [chunk async for chunk in resp.body_iterator]

    assert chunks == [b"partial-chunk"]
    assert default_session.state.is_streaming is False
    # Unlike the natural "queue exhausted" path (_advance_or_end), a crash
    # mid-track must not read as "this track finished playing".
    assert default_session.state.track_ended is False
    payload = q.get_nowait()
    assert payload["streaming"] is False


async def test_client_disconnect_mid_stream_is_reraised_without_touching_state(
    client, default_session,
):
    _configure_and_set_track(client, default_session)

    async def _disconnects_after_one_chunk(*args, **kwargs):
        yield b"chunk"
        raise asyncio.CancelledError()

    q = default_session.event_bus.subscribe()

    with patch("routes.stream.stream_tracks", side_effect=_disconnects_after_one_chunk):
        resp = await audio_stream(session_id=default_session.session_id)
        assert default_session.state.active_stream_connections == 1
        gen = resp.body_iterator
        first = await gen.__anext__()
        assert first == b"chunk"
        with pytest.raises(asyncio.CancelledError):
            await gen.__anext__()

    # A disconnect is routine — state must be left exactly as it was, and
    # nothing broadcast, since nothing about playback actually changed.
    assert default_session.state.is_streaming is True
    assert q.empty()
    # The connection is genuinely gone now — the deferred grace-period check
    # (scheduled above, not awaited by this test) needs this to already be
    # accurate, not stuck counting a connection that no longer exists.
    assert default_session.state.active_stream_connections == 0


async def test_is_streaming_revives_once_a_bare_reconnect_produces_audio(
    client, default_session,
):
    """Regression test (2026-08-22): a bare device-initiated reconnect (no
    /play, /seek, or /resume involved — the device just re-requested this
    URL on its own) never goes through any of the handlers that otherwise
    set is_streaming back to True. Left stuck False (e.g. after a
    _mark_disconnected_if_not_reconnected trip, false-positive or not),
    position resync and auto-advance both stay permanently disabled for the
    rest of the track even once audio is audibly flowing again — this is
    what actually revives it, the moment real audio starts flowing."""
    _configure_and_set_track(client, default_session)
    default_session.state.is_streaming = False
    # Isolates this from the *separate*, pre-existing "queue exhausted"
    # completion path (_advance_or_end, see test_advance_or_end_* for that
    # one) — with no queue and is_paused=False, reviving is_streaming here
    # would otherwise immediately trigger that unrelated path too, which
    # sets it right back to False again before this test ever gets to
    # check it, for a reason that has nothing to do with what's under test
    # here.
    default_session.state.clock.is_paused = True

    q = default_session.event_bus.subscribe()

    with patch("routes.stream.stream_tracks", side_effect=_real_stream):
        client.get("/stream")

    assert default_session.state.is_streaming is True
    assert any(payload["streaming"] is True for payload in _drain(q))


async def test_is_streaming_does_not_rebroadcast_when_already_true(client, default_session):
    """The common case (a normal /play-initiated connection, is_streaming
    already True) must not broadcast a redundant status on top of
    whatever /play itself already broadcast."""
    _configure_and_set_track(client, default_session)
    assert default_session.state.is_streaming is True
    default_session.state.clock.is_paused = True  # see the comment above

    q = default_session.event_bus.subscribe()

    with patch("routes.stream.stream_tracks", side_effect=_real_stream):
        client.get("/stream")

    assert q.empty()


async def test_a_real_drop_marks_the_broadcast_as_an_interruption(default_session, monkeypatch):
    """The frontend can only offer to pick playback back up if it can tell
    this streaming->false transition apart from an ordinary stop. Beacon
    deliberately does not resume by itself: a device stopping on its own and
    someone pressing stop on the speaker look identical from here."""
    monkeypatch.setattr("routes.stream.STREAM_DISCONNECT_GRACE_SECONDS", 0.01)
    default_session.state.is_streaming = True
    default_session.state.active_stream_connections = 0
    q = default_session.event_bus.subscribe()

    await _mark_disconnected_if_not_reconnected(
        default_session, my_generation=default_session.state.clock.play_generation,
    )

    payload = q.get_nowait()
    assert payload["interrupted"] is True
    assert payload["streaming"] is False


async def test_a_real_drop_freezes_the_clock_at_its_position(default_session, monkeypatch):
    """Regression test for a real prod bug (2026-08-24): elapsed() has no
    notion of is_streaming and keeps advancing with wall-clock time
    regardless, so leaving the clock running after a drop means whoever
    eventually taps "Resume" - sometimes minutes later - has
    _resume_after_interruption() seek past the track's own end. Freezing it
    here the same way /pause does is what makes that resume, whenever it
    comes, pick up from where the drop actually happened instead."""
    monkeypatch.setattr("routes.stream.STREAM_DISCONNECT_GRACE_SECONDS", 0.01)
    default_session.state.is_streaming = True
    default_session.state.active_stream_connections = 0
    default_session.state.current_track = MagicMock(duration=300)
    default_session.state.clock.start(0.0)
    default_session.state.clock.play_start_time -= 45.0  # 45s into the track

    await _mark_disconnected_if_not_reconnected(
        default_session, my_generation=default_session.state.clock.play_generation,
    )

    assert default_session.state.clock.is_paused is True
    assert default_session.state.clock.paused_elapsed == pytest.approx(45.0, abs=1.0)


async def test_an_ordinary_broadcast_is_not_marked_as_an_interruption(default_session):
    payload = build_status_dict(default_session)
    assert payload["interrupted"] is False


async def test_resume_after_interruption_resumes_from_the_frozen_position(
    default_session, monkeypatch,
):
    """Re-dispatch, not restart: _mark_disconnected_if_not_reconnected() froze
    the clock at the moment it declared the drop (the same way /pause does),
    and this resumes from exactly that - not from PlaybackClock.elapsed()'s
    own live value, which would have kept advancing with wall-clock time for
    however long the interruption sat unresolved. clock.resume() (the same
    path a real /resume takes) is what makes the fresh connection's -ss pick
    up there; it also bumps play_generation, retiring the resync task that
    belonged to the connection that died."""
    delivery = MagicMock()
    delivery.play = AsyncMock()
    default_session.state.active_delivery = delivery
    default_session.state.current_track = MagicMock(duration=300)
    default_session.state.clock.start(0.0)
    default_session.state.clock.pause(12.5)  # frozen where the drop happened
    monkeypatch.setattr("routes.stream._current_reconnect_args", lambda s: ("url", "t", "a", None, 300.0, "", "audio/mpeg"))

    before = default_session.state.clock.play_generation
    assert await _resume_after_interruption(default_session) is True

    delivery.play.assert_awaited_once()
    assert default_session.state.clock.resume_offset == pytest.approx(12.5)
    assert default_session.state.clock.is_paused is False
    assert default_session.state.clock.play_generation != before
    assert default_session.state.is_streaming is True


async def test_resume_after_interruption_clamps_an_unfrozen_clock_to_track_duration(
    default_session, monkeypatch,
):
    """Defensive fallback for a clock that wasn't frozen (shouldn't happen in
    practice - see the function's own docstring, every path that sets
    interrupted=True pauses it first). Without this clamp, a clock left
    running past the track's own end would seek there - which FFmpeg answers
    with silence and no error, not a failure anything here could detect.
    Regression coverage for a real prod bug (2026-08-24): a drop early in a
    222s track, resumed ~10 minutes later, produced a 200 response and no
    audio at all."""
    delivery = MagicMock()
    delivery.play = AsyncMock()
    default_session.state.active_delivery = delivery
    default_session.state.current_track = MagicMock(duration=300)
    default_session.state.clock.start(0.0)
    default_session.state.clock.play_start_time -= 1000.0  # elapsed() now far past duration
    monkeypatch.setattr("routes.stream._current_reconnect_args", lambda s: ("url", "t", "a", None, 300.0, "", "audio/mpeg"))

    assert await _resume_after_interruption(default_session) is True

    delivery.play.assert_awaited_once()
    assert default_session.state.clock.resume_offset == pytest.approx(300.0)


async def test_resume_after_interruption_does_nothing_without_a_target(default_session):
    default_session.state.active_delivery = None
    assert await _resume_after_interruption(default_session) is False


async def test_resume_after_interruption_reports_a_failed_dispatch(default_session, monkeypatch):
    """The device may be genuinely gone by the time someone clicks. That is
    a normal outcome, not a 500."""
    delivery = MagicMock()
    delivery.play = AsyncMock(side_effect=OSError("unreachable"))
    default_session.state.active_delivery = delivery
    default_session.state.current_track = MagicMock(duration=300)
    monkeypatch.setattr("routes.stream._current_reconnect_args", lambda s: ("url", "t", "a", None, 300.0, "", "audio/mpeg"))

    assert await _resume_after_interruption(default_session) is False


def test_resume_interrupted_endpoint_reports_when_there_is_nothing_to_resume(client):
    r = client.post("/resume-interrupted")
    assert r.status_code == 200
    assert r.json() == {"resumed": False, "reason": "nothing to resume"}


def test_resume_interrupted_endpoint_is_a_no_op_while_already_streaming(client, default_session):
    """Two clients can both see the toast, and the device may reconnect on
    its own in between. Whoever is second must not re-dispatch on top of a
    stream that is already running."""
    default_session.state.is_streaming = True

    r = client.post("/resume-interrupted")

    assert r.json() == {"resumed": False, "reason": "already streaming"}


def test_resume_interrupted_endpoint_dispatches(client, default_session, monkeypatch):
    async def _ok(_session):
        return True

    monkeypatch.setattr("routes.stream._resume_after_interruption", _ok)

    assert client.post("/resume-interrupted").json() == {"resumed": True}


# ── _resolve_track ───────────────────────────────────────────────────────────


async def test_resolve_track_retries_a_transient_failure(default_session, monkeypatch):
    """Regression test (2026-08-22): a momentary media-server failure — DNS
    for it returning EAI_AGAIN while the library was under load — made
    auto-advance give up and end playback with a full queue still waiting.
    "Cannot resolve it right now" is not "there is nothing left to play"."""
    monkeypatch.setattr("routes.stream._TRACK_LOOKUP_RETRY_SECONDS", 0)
    track = MagicMock()
    calls = []

    def _flaky(track_id):
        calls.append(track_id)
        if len(calls) < 2:
            raise OSError("[Errno -3] Try again")
        return track

    default_session.media.get_track = _flaky

    assert await _resolve_track(default_session, "abc", "Auto-advance") is track
    assert len(calls) == 2


async def test_resolve_track_gives_up_after_a_bounded_number_of_attempts(
    default_session, monkeypatch,
):
    """It runs under play_lock, so a genuinely unreachable media server must
    not stall every other playback handler behind an unbounded retry."""
    monkeypatch.setattr("routes.stream._TRACK_LOOKUP_RETRY_SECONDS", 0)
    calls = []

    def _always_fails(track_id):
        calls.append(track_id)
        raise OSError("[Errno -3] Try again")

    default_session.media.get_track = _always_fails

    assert await _resolve_track(default_session, "abc", "Auto-advance") is None
    assert len(calls) == stream_routes._TRACK_LOOKUP_ATTEMPTS


async def test_resolve_track_does_not_block_the_event_loop(default_session):
    """The lookup is a synchronous HTTP client call; run inline it freezes
    every open /stream socket for the length of the request. Measured at
    4.71s live before this was moved onto a thread."""
    started = asyncio.Event()

    def _slow(track_id):
        started.set()
        time.sleep(0.2)
        return MagicMock()

    default_session.media.get_track = _slow
    lookup = asyncio.create_task(_resolve_track(default_session, "abc", "ctx"))
    await started.wait()

    # The loop is still responsive while the lookup is in flight — this
    # await would never resume if get_track() were called inline.
    ticked = False
    for _ in range(5):
        await asyncio.sleep(0)
        ticked = True
    assert ticked
    await lookup


# ── mark_interrupted ─────────────────────────────────────────────────────────
# Shared by the grace-period check below and by delivery/airplay.py, which
# reaches the same conclusion by an entirely different route: a push that
# failed, rather than a pull connection that never came back. The ordering
# inside it is load-bearing and was arrived at by two separate live bugs —
# see its docstring in core/session.py.


async def test_mark_interrupted_freezes_the_position_the_device_reached(default_session):
    """The clock has to be frozen at where playback actually got to, and
    that reading has to be taken *before* is_streaming flips:
    compute_position() reads that flag itself and returns 0.0 once it is
    False, so the obvious order leaves the clock parked at 0:00 and a later
    Resume restarting the track from the beginning.

    Deliberately asserted on the clock, not on the broadcast payload — that
    one carries elapsed=0 either way, since build_status_dict() calls
    compute_position() again after the flag is already down. Nothing reads
    it for the resume; /resume-interrupted goes off the clock below."""
    st = default_session.state
    st.current_track = Track(id="1", title="Song", artist="A", duration=200, cover_art_id="")
    st.is_streaming = True
    st.clock.start(0.0)
    st.clock.play_start_time = time.time() - 42.0

    await mark_interrupted(default_session)

    assert st.clock.elapsed() == pytest.approx(42.0, abs=1.5)


async def test_mark_interrupted_freezes_the_clock(default_session):
    """PlaybackClock.elapsed() has no notion of is_streaming and keeps
    advancing with the wall clock. Without freezing it, a resume minutes
    later seeks FFmpeg past the track's own end, which it answers with
    silence and no error (observed live 2026-08-24)."""
    st = default_session.state
    st.current_track = Track(id="1", title="Song", artist="A", duration=200, cover_art_id="")
    st.is_streaming = True
    st.clock.start(0.0)
    st.clock.play_start_time = time.time() - 30.0

    await mark_interrupted(default_session)
    frozen = st.clock.elapsed()
    await asyncio.sleep(0.05)

    assert st.clock.is_paused is True
    assert st.clock.elapsed() == pytest.approx(frozen)


async def test_mark_interrupted_says_nobody_asked_for_this(default_session):
    """The flag is what turns a plain "stopped" into the toast offering to
    pick playback back up — without it the music just goes quiet."""
    default_session.state.is_streaming = True

    q = default_session.event_bus.subscribe()
    await mark_interrupted(default_session)

    payload = q.get_nowait()
    assert payload["interrupted"] is True
    assert payload["streaming"] is False


# ── _mark_disconnected_if_not_reconnected ────────────────────────────────────
# Regression coverage for a real prod bug (2026-08-21): a Sonos speaker
# dropping its GET /stream connection mid-track and never reconnecting left
# is_streaming stuck True forever, so the position-resync loop
# (routes/playback.py) kept polling the now-silent device and misread its
# persisting position=0 reading as an endless string of "external rewinds" —
# position_offset ratcheted more negative every single resync tick while the
# frontend looped near 0:00 with no audio. See that function's own docstring.


async def test_marks_not_streaming_when_nothing_reconnects_within_the_grace_period(
    default_session, monkeypatch,
):
    monkeypatch.setattr("routes.stream.STREAM_DISCONNECT_GRACE_SECONDS", 0.01)
    default_session.state.is_streaming = True
    default_session.state.active_stream_connections = 0  # the one connection already dropped

    q = default_session.event_bus.subscribe()

    await _mark_disconnected_if_not_reconnected(
        default_session, my_generation=default_session.state.clock.play_generation,
    )

    assert default_session.state.is_streaming is False
    payload = q.get_nowait()
    assert payload["streaming"] is False


def _snapshot(**over):
    kw = {
        "label": "OVERWERK — Toccata", "duration": 411, "position": 270.1,
        "blocked_for": 0.02, "bytes_delivered": 11_400_000, "wall": 270.0,
        "loop_lag_30s": 0.0, "loop_lag_120s": 0.0,
    }
    kw.update(over)
    return DisconnectSnapshot(**kw)


async def test_a_real_drop_logs_the_captured_snapshot(default_session, monkeypatch, caplog):
    """The snapshot's whole purpose is to make the next real drop
    diagnosable, so it has to reach the log on the branch that concluded
    a drop actually happened."""
    monkeypatch.setattr("routes.stream.STREAM_DISCONNECT_GRACE_SECONDS", 0.01)
    default_session.state.is_streaming = True
    default_session.state.active_stream_connections = 0

    with caplog.at_level(logging.ERROR, logger="connect.stream"):
        await _mark_disconnected_if_not_reconnected(
            default_session,
            my_generation=default_session.state.clock.play_generation,
            snapshot=_snapshot(blocked_for=41.5, loop_lag_30s=2.25),
        )

    msg = "\n".join(r.message for r in caplog.records)
    assert "did not come back" in msg
    assert "blocked_for=41.50s" in msg
    assert "loop_lag_30s=2.25s" in msg
    assert "position=270.1s" in msg


async def test_a_pause_does_not_log_a_drop(default_session, monkeypatch, caplog):
    """Regression test (2026-08-22): pausing cancels the stream generator
    exactly like a device dropping does, and the snapshot used to be logged
    right there — so an ordinary pause produced "Device dropped /stream
    mid-track" in the log. Left alone that would bury the rare real event
    this instrumentation exists to catch, which is the whole reason the
    snapshot is logged from here instead."""
    monkeypatch.setattr("routes.stream.STREAM_DISCONNECT_GRACE_SECONDS", 0.01)
    default_session.state.is_streaming = True
    default_session.state.active_stream_connections = 0
    default_session.state.clock.pause(270.1)

    with caplog.at_level(logging.ERROR, logger="connect.stream"):
        await _mark_disconnected_if_not_reconnected(
            default_session,
            my_generation=default_session.state.clock.play_generation,
            snapshot=_snapshot(),
        )

    assert default_session.state.is_streaming is True
    assert not caplog.records


async def test_the_grace_period_still_works_without_a_snapshot(default_session, monkeypatch, caplog):
    """snapshot is optional — the disconnect handling itself must not
    depend on diagnostic instrumentation being wired up."""
    monkeypatch.setattr("routes.stream.STREAM_DISCONNECT_GRACE_SECONDS", 0.01)
    default_session.state.is_streaming = True
    default_session.state.active_stream_connections = 0

    with caplog.at_level(logging.ERROR, logger="connect.stream"):
        await _mark_disconnected_if_not_reconnected(
            default_session, my_generation=default_session.state.clock.play_generation,
        )

    assert default_session.state.is_streaming is False
    assert "did not come back" in "\n".join(r.message for r in caplog.records)


async def test_does_not_mark_not_streaming_while_another_connection_is_still_open(
    default_session, monkeypatch,
):
    """Multi-target casting (e.g. Chromecast + DLNA at once) can have more
    than one GET /stream connection open for the same session — one
    dropping (and this check running for it) must not declare the whole
    session dead while a *different* connection is still up and playing.
    Covers both a fresh reconnect of the same device and an unrelated
    device that was never affected — active_stream_connections doesn't
    distinguish the two, by design (see that field's own comment)."""
    monkeypatch.setattr("routes.stream.STREAM_DISCONNECT_GRACE_SECONDS", 0.01)
    default_session.state.is_streaming = True
    default_session.state.active_stream_connections = 1  # another connection still live

    q = default_session.event_bus.subscribe()

    await _mark_disconnected_if_not_reconnected(
        default_session, my_generation=default_session.state.clock.play_generation,
    )

    assert default_session.state.is_streaming is True
    assert q.empty()


async def test_does_not_mark_not_streaming_once_a_newer_generation_took_over(
    default_session, monkeypatch,
):
    """A /play, /seek, or /resume landing during the grace period bumps
    play_generation — this stale check must not touch a session that isn't
    even playing the track that disconnected anymore."""
    monkeypatch.setattr("routes.stream.STREAM_DISCONNECT_GRACE_SECONDS", 0.01)
    default_session.state.is_streaming = True
    default_session.state.active_stream_connections = 0
    stale_generation = default_session.state.clock.play_generation
    default_session.state.clock.play_generation += 1  # a newer /play superseded this track

    q = default_session.event_bus.subscribe()

    await _mark_disconnected_if_not_reconnected(default_session, my_generation=stale_generation)

    assert default_session.state.is_streaming is True
    assert q.empty()


async def test_a_finished_track_that_auto_advanced_is_not_a_drop(
    default_session, monkeypatch,
):
    """AirPlay closes its GET /stream connection when the track's bytes run
    out, and since it streams incrementally now (see delivery/airplay.py's
    _ResponseReader) that happens at the *end* of the track rather than
    long before it — right where this check is armed and waiting.

    What saves it is that auto-advance starts a new clock, which bumps
    play_generation. Asserted through the real dispatch path rather than by
    incrementing the counter by hand, so this stays true if that path ever
    stops going through clock.start()."""
    monkeypatch.setattr("routes.stream.STREAM_DISCONNECT_GRACE_SECONDS", 0.01)
    st = default_session.state
    st.is_streaming = True
    st.active_stream_connections = 0
    finished_generation = st.clock.play_generation

    delivery = MagicMock()
    delivery.play = AsyncMock()
    monkeypatch.setattr(
        "routes.stream.resolve_output_format", AsyncMock(return_value=FALLBACK_FORMAT)
    )
    default_session.media = MagicMock()
    default_session.media.get_stream_url = MagicMock(return_value="http://nav/x")
    default_session.media.get_cover_art_url = MagicMock(return_value=None)
    next_track = Track(id="2", title="Next", artist="A", duration=180, cover_art_id="")

    assert await _dispatch_queued_track(default_session, delivery, next_track, 1.0) is True

    q = default_session.event_bus.subscribe()
    await _mark_disconnected_if_not_reconnected(
        default_session, my_generation=finished_generation
    )

    assert st.is_streaming is True
    assert q.empty()


async def test_does_not_mark_not_streaming_while_legitimately_paused(default_session, monkeypatch):
    """Some DLNA renderers drop their HTTP connection to /stream on pause
    instead of idling the open socket — that's not a dead stream, it's a
    normal pause, and isn't expected to reconnect until /resume asks it
    to. This stale check must not flip is_streaming (and broadcast a
    spurious 'stopped' to every client watching the session) for that."""
    monkeypatch.setattr("routes.stream.STREAM_DISCONNECT_GRACE_SECONDS", 0.01)
    default_session.state.is_streaming = True
    default_session.state.active_stream_connections = 0
    default_session.state.clock.pause(30.0)

    q = default_session.event_bus.subscribe()

    await _mark_disconnected_if_not_reconnected(
        default_session, my_generation=default_session.state.clock.play_generation,
    )

    assert default_session.state.is_streaming is True
    assert q.empty()


async def test_does_not_rebroadcast_when_already_not_streaming(default_session, monkeypatch):
    """The track can finish normally (_advance_or_end already marking
    is_streaming False, or auto-advancing to a next track) during the grace
    period — this stale check must not re-broadcast a redundant 'not
    streaming' on top of whatever already happened."""
    monkeypatch.setattr("routes.stream.STREAM_DISCONNECT_GRACE_SECONDS", 0.01)
    default_session.state.is_streaming = False
    default_session.state.active_stream_connections = 0

    q = default_session.event_bus.subscribe()

    await _mark_disconnected_if_not_reconnected(
        default_session, my_generation=default_session.state.clock.play_generation,
    )

    assert q.empty()


# ── Live analysis is no longer part of the stream itself ────────────────────
# It follows GET /visualizer's subscribers now (see core/visualizer_feed.py
# and test_visualizer_feed.py), decoding the track from the media server
# rather than tapping these chunks — this loop neither creates, feeds nor
# tears down an analyzer any more.


async def test_casting_alone_starts_no_analysis(client, default_session):
    """Regression guard for the whole point of that split: casting used to
    spawn a second ffmpeg and run ~43 FFTs/s for the length of every track
    whether or not anyone had the visualizer open, throwing every frame
    away."""
    _configure_and_set_track(client, default_session)
    default_session.state.active_delivery = ChromecastDelivery("TV")
    # Not exercising the completion/auto-advance path here (see the
    # ffmpeg-failure/disconnect tests above and test_advance_or_end_* for
    # that) — False keeps stream_with_completion() from scheduling a
    # _fire_track_end() background task that would otherwise outlive this
    # test.
    default_session.state.is_streaming = False

    with patch("routes.stream.stream_tracks", side_effect=_real_stream):
        resp = await audio_stream(session_id=default_session.session_id)
        chunks = [chunk async for chunk in resp.body_iterator]

    assert chunks == [b"chunk-1", b"chunk-2"]
    assert default_session.visualizer.analyzer is None
    assert default_session.visualizer._task is None


# ── Scheduling the track-end signal on a normal completion ──────────────────


async def test_stream_schedules_fire_track_end_with_the_remaining_duration(client, default_session):
    """A normal (non-crashing, non-disconnecting) completion — still
    streaming, unpaused, same generation — schedules _fire_track_end()
    with however much of the track's duration is left on the clock, not a
    fixed/zero wait. See _fire_track_end()'s own docstring for why that
    matters: waiting the wrong amount either cuts the tail of the track or
    auto-advances early."""
    _configure_and_set_track(client, default_session)
    default_session.state.clock.start(0.0)  # sets play_start_time

    captured = {}

    def _capture_and_discard(coro):
        # Inspect the not-yet-started coroutine's bound arguments rather
        # than actually running it — _fire_track_end()'s own behavior is
        # covered separately via _advance_or_end()'s tests above.
        captured["wait"] = coro.cr_frame.f_locals["wait"]
        coro.close()
        return MagicMock()

    with (
        patch("routes.stream.stream_tracks", side_effect=_real_stream),
        patch("routes.stream.asyncio.create_task", side_effect=_capture_and_discard),
    ):
        resp = await audio_stream(session_id=default_session.session_id)
        [_ async for _ in resp.body_iterator]

    # Track duration is 180s (see _configure_and_set_track), started just
    # now — essentially all of it should still be remaining.
    assert captured["wait"] == pytest.approx(180.0, abs=0.5)


# ── how long a track actually plays ──────────────────────────────────────────
# The end of a track is scheduled off this, so anything it gets wrong is
# heard as the tail being cut off (or, the other way, a gap before the next
# track starts).


def test_playback_duration_prefers_the_measured_length_over_whole_second_metadata(
    client, default_session
):
    """A music server reports whole seconds (media/base.py's Track.duration
    is an int, and Jellyfin's/Plex's adapters truncate) — ffmpeg measured
    the file itself to hundredths. Scheduling off the metadata figure ends
    the track up to a second early, which is audible on one that stops
    abruptly."""
    _configure_and_set_track(client, default_session)  # metadata says 180
    default_session.state.current_output_format = OutputFormat(source_duration=180.73)

    assert _playback_duration(default_session.state) == pytest.approx(180.73)


def test_playback_duration_falls_back_to_metadata_when_nothing_was_probed(
    client, default_session
):
    # The forced/probe-failed fallback tiers carry no measured length.
    _configure_and_set_track(client, default_session)
    default_session.state.current_output_format = FALLBACK_FORMAT

    assert _playback_duration(default_session.state) == pytest.approx(180.0)


def test_playback_duration_ignores_a_measurement_that_disagrees_wildly(
    client, default_session
):
    """A probe that measured something else entirely (a redirect to a
    different file, a live stream that reported a bogus length) must not be
    able to hold a finished track open — or cut a long one short."""
    _configure_and_set_track(client, default_session)  # metadata says 180
    default_session.state.current_output_format = OutputFormat(source_duration=3600.0)

    assert _playback_duration(default_session.state) == pytest.approx(180.0)


def test_playback_duration_accepts_the_usual_sub_second_disagreement(
    client, default_session
):
    # Rounding alone puts these up to a second apart — that's the normal
    # case this exists for, not a suspicious one.
    _configure_and_set_track(client, default_session)
    default_session.state.current_output_format = OutputFormat(source_duration=180.99)

    assert _playback_duration(default_session.state) == pytest.approx(180.99)


def test_playback_duration_is_zero_for_radio_with_no_known_length(
    client, default_session
):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    default_session.state.current_track = Track(
        id="r", title="Radio", artist="Station", duration=0, cover_art_id=""
    )
    default_session.state.current_output_format = OutputFormat(source_duration=None)

    assert _playback_duration(default_session.state) == 0.0


async def test_fire_track_end_waits_out_the_last_half_second_instead_of_cutting_it(
    client, default_session
):
    """Regression test: the wait loop used to break at 0.5s remaining and
    advance the queue there, which hands the device a new URI while it is
    still playing the tail of the current track — the last half second was
    simply gone from every track. Only inaudible on tracks that fade out or
    end in silence, which is why it survived this long."""
    _configure_and_set_track(client, default_session)
    default_session.state.clock.start(0.0)

    captured = {}

    def _capture_task(coro):
        captured["coro"] = coro
        return MagicMock()

    with (
        patch("routes.stream.stream_tracks", side_effect=_real_stream),
        patch("routes.stream.asyncio.create_task", side_effect=_capture_task),
    ):
        resp = await audio_stream(session_id=default_session.session_id)
        [_ async for _ in resp.body_iterator]

    # Half a second left: the old loop treated this as "done" and advanced.
    remaining_readings = iter([0.4, 0.2, 0.0])
    with (
        patch.object(
            default_session.state.clock,
            "seconds_until",
            side_effect=lambda duration: next(remaining_readings),
        ),
        patch("routes.stream.asyncio.sleep", new=AsyncMock()) as sleep_mock,
    ):
        await captured["coro"]

    # It slept those last fractions out rather than ending the track on them.
    assert sleep_mock.await_count == 2
    assert sleep_mock.await_args_list[0].args[0] == pytest.approx(0.4)
    assert sleep_mock.await_args_list[1].args[0] == pytest.approx(0.2)
    assert default_session.state.track_ended is True


async def test_fire_track_end_repolls_until_the_track_actually_finishes(
    client, default_session
):
    """_fire_track_end()'s own wait loop: re-measures the live clock on
    each poll rather than sleeping the original estimate in one go, so a
    mid-wait correction (see its own docstring) gets picked up within one
    more poll instead of never. Captures the real (not discarded, unlike
    the test above) coroutine and runs it directly against a clock
    reporting decreasing amounts of remaining time."""
    _configure_and_set_track(client, default_session)
    default_session.state.clock.start(0.0)

    captured = {}

    def _capture_task(coro):
        captured["coro"] = coro
        return MagicMock()

    with (
        patch("routes.stream.stream_tracks", side_effect=_real_stream),
        patch("routes.stream.asyncio.create_task", side_effect=_capture_task),
    ):
        resp = await audio_stream(session_id=default_session.session_id)
        [_ async for _ in resp.body_iterator]

    # Two polls that still find real time left (sleep, re-measure), then a
    # third that finds the track over (breaks out of the loop). 0.3s counts
    # as real time left now — see _TRACK_END_TOLERANCE.
    remaining_readings = iter([100.0, 50.0, 0.0])

    with (
        patch.object(
            default_session.state.clock,
            "seconds_until",
            side_effect=lambda duration: next(remaining_readings),
        ),
        patch("routes.stream.asyncio.sleep", new=AsyncMock()) as sleep_mock,
    ):
        await captured["coro"]

    assert sleep_mock.await_count == 2
    # _advance_or_end() ran for real once the loop broke — no queue/active
    # delivery here, so it fell through to the "mark ended" branch.
    assert default_session.state.track_ended is True
