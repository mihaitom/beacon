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
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from core.streamer import FALLBACK_FORMAT, OutputFormat
from delivery import ChromecastDelivery
from media import Track
from routes.stream import (
    _advance_or_end,
    _dispatch_queued_track,
    _mark_disconnected_if_not_reconnected,
    audio_stream,
)


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


# ── Live analysis hookup (GET /visualizer's data source) ─────────────────────
# See core/audio_analysis.py's AudioAnalyzer — stream_with_completion()
# creates one per track whenever a live-analyzable target (Sonos/DLNA/
# Chromecast) is casting, feeds it every chunk, stops whatever the previous
# track's analyzer was, and closes it out once ffmpeg's done.


async def test_stream_creates_and_feeds_an_analyzer_for_a_live_analyzable_target(
    client, default_session,
):
    _configure_and_set_track(client, default_session)
    default_session.state.active_delivery = ChromecastDelivery("TV")
    # Not exercising the completion/auto-advance path here (see the
    # ffmpeg-failure/disconnect tests above and test_advance_or_end_* for
    # that) — False keeps stream_with_completion() from scheduling a
    # _fire_track_end() background task that would otherwise outlive this
    # test.
    default_session.state.is_streaming = False
    previous_analyzer = MagicMock(stop=AsyncMock())
    default_session.audio_analyzer = previous_analyzer

    new_analyzer = MagicMock(start=AsyncMock(), feed=MagicMock(), finish_feeding=MagicMock())
    analyzer_class = MagicMock(return_value=new_analyzer)

    with (
        patch("routes.stream.AudioAnalyzer", analyzer_class),
        patch("routes.stream.stream_tracks", side_effect=_real_stream),
    ):
        resp = await audio_stream(session_id=default_session.session_id)
        chunks = [chunk async for chunk in resp.body_iterator]

    assert chunks == [b"chunk-1", b"chunk-2"]
    previous_analyzer.stop.assert_awaited_once()
    assert default_session.audio_analyzer is new_analyzer
    new_analyzer.feed.assert_has_calls([call(b"chunk-1"), call(b"chunk-2")])
    new_analyzer.finish_feeding.assert_called_once()


async def test_stream_skips_analysis_for_a_non_analyzable_target(client, default_session):
    """AirPlay (and radio) can't be live-analyzed — see should_analyze()'s
    docstring — GET /visualizer just has nothing to send for these."""
    _configure_and_set_track(client, default_session)
    default_session.state.active_delivery = None  # no cast target at all
    default_session.state.is_streaming = False  # see the comment in the test above

    analyzer_class = MagicMock()

    with (
        patch("routes.stream.AudioAnalyzer", analyzer_class),
        patch("routes.stream.stream_tracks", side_effect=_real_stream),
    ):
        resp = await audio_stream(session_id=default_session.session_id)
        [_ async for _ in resp.body_iterator]

    analyzer_class.assert_not_called()
    assert default_session.audio_analyzer is None


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
    # third that finds the track essentially over (breaks out of the loop).
    remaining_readings = iter([100.0, 50.0, 0.3])

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
