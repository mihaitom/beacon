"""Tests for playback endpoints: /play, /stop, /pause, /resume, /status."""

import asyncio
import contextlib
import time
from unittest.mock import AsyncMock, patch

from core.session import compute_position
from core.streamer import FALLBACK_FORMAT, OutputFormat
from delivery import AirPlayDelivery, BaseDelivery, ChromecastDelivery, SonosDelivery
from media import SubsonicClient, Track
from routes.playback import (
    POSITION_RESYNC_THRESHOLD,
    PROVISIONAL_STARTUP_DELAY,
    _apply_position_offset,
    _resync_position_once,
    _resync_position_periodically,
)

# ── /status ──────────────────────────────────────────────────────────────────


def test_status_initial(client):
    r = client.get("/status")
    assert r.status_code == 200
    body = r.json()
    assert body["streaming"] is False
    assert body["paused"] is False
    assert body["targets"] == []
    assert body["current_song"] is None
    assert body["total_songs"] == 0


def test_status_reflects_state(client, default_session):
    default_session.state.is_streaming = True
    default_session.state.clock.is_paused = True
    r = client.get("/status")
    body = r.json()
    assert body["streaming"] is True
    assert body["paused"] is True


# ── /play ─────────────────────────────────────────────────────────────────────


def test_play_rejects_when_never_configured(client):
    # No /config call ever happened for this session, so it's not
    # authenticated yet — see core/session.py's require_authenticated_session.
    r = client.post("/play", json={"song_ids": ["abc"]})
    assert r.status_code == 401


def test_play_rejects_empty_track_list(client):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    r = client.post("/play", json={"song_ids": []})
    assert "error" in r.json()


def test_play_rejects_when_media_server_has_no_base_url(client, default_session):
    """Distinct from test_play_rejects_when_never_configured above: this
    session IS authenticated (default_session's own fixture default) but
    session.media itself has no base_url — the state right after a
    fresh SessionState() before its first-ever /config, still passing
    require_authenticated_session's own (weaker) check."""
    assert default_session.media.base_url == ""

    r = client.post("/play", json={"song_ids": ["1"]})

    assert r.status_code == 200
    assert "error" in r.json()


def test_play_fetches_track_and_sets_state(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})

    track = Track(
        id="1",
        title="Test Song",
        artist="Test Artist",
        duration=180,
        cover_art_id="cover-1",
    )
    with patch.object(default_session.media, "get_track", return_value=track):
        r = client.post("/play", json={"song_ids": ["1"]})

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "playing"
    assert default_session.state.is_streaming is True
    assert default_session.state.current_track is not None
    assert default_session.state.current_track.title == "Test Song"


def test_play_with_start_position_seeds_resume_offset_and_elapsed(
    client, default_session
):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})

    track = Track(
        id="1",
        title="Test Song",
        artist="Test Artist",
        duration=180,
        cover_art_id="cover-1",
    )
    with patch.object(default_session.media, "get_track", return_value=track):
        r = client.post("/play", json={"song_ids": ["1"], "start_position": 42.0})

    assert r.status_code == 200
    assert default_session.state.clock.resume_offset == 42.0
    elapsed = compute_position(default_session)
    assert 41.5 < elapsed <= 42.0 + 0.5


def test_play_clamps_start_position_to_track_duration(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})

    track = Track(
        id="1",
        title="Test Song",
        artist="Test Artist",
        duration=180,
        cover_art_id="cover-1",
    )
    with patch.object(default_session.media, "get_track", return_value=track):
        r = client.post("/play", json={"song_ids": ["1"], "start_position": 999.0})

    assert r.status_code == 200
    assert default_session.state.clock.resume_offset == 180.0


# ── seq ordering (out-of-order dispatch protection) ─────────────────────────
# See SessionState.play_seq/play_lock's comments and playback.ts's
# dispatchSeq — the frontend hands out a strictly increasing seq per
# /play(-url) dispatch so a request that's already been superseded (e.g. the
# first of two rapid Next clicks, if its response happens to land after the
# second's) never overwrites state or reaches the target device with a
# now-stale command.


def test_play_drops_request_with_stale_seq(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track_a = Track(id="a", title="A", artist="Artist", duration=180, cover_art_id="cover-a")
    track_b = Track(id="b", title="B", artist="Artist", duration=180, cover_art_id="cover-b")

    def get_track(track_id):
        return track_a if track_id == "a" else track_b

    with patch.object(default_session.media, "get_track", side_effect=get_track):
        # seq=2 arrives (and is accepted) first — as if it were dispatched
        # after seq=1 but its response/processing simply got there sooner.
        r2 = client.post("/play", json={"song_ids": ["b"], "seq": 2})
        assert r2.json()["status"] == "playing"
        assert default_session.state.current_track.id == "b"

        # seq=1 arrives after — it's older than what's already been
        # accepted, so it must not overwrite the newer track.
        r1 = client.post("/play", json={"song_ids": ["a"], "seq": 1})
        assert r1.json()["status"] == "superseded"
        assert default_session.state.current_track.id == "b"


def test_play_without_seq_is_never_treated_as_stale(client, default_session):
    # seq=0 (the default — any caller not sending one, e.g. other tests
    # above) always opts out of the staleness check, regardless of
    # session.play_seq's current value.
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Test Song", artist="Test Artist", duration=180, cover_art_id="c")
    with patch.object(default_session.media, "get_track", return_value=track):
        client.post("/play", json={"song_ids": ["1"], "seq": 5})
        r = client.post("/play", json={"song_ids": ["1"]})
    assert r.json()["status"] == "playing"


def test_play_url_drops_request_with_stale_seq(client, default_session):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        r2 = client.post(
            "/play-url",
            json={
                "target_name": "TV",
                "target_type": "chromecast",
                "title": "Station B",
                "url": "https://example.com/b.mp3",
                "seq": 2,
            },
        )
        assert r2.json()["status"] == "playing"

        r1 = client.post(
            "/play-url",
            json={
                "target_name": "TV",
                "target_type": "chromecast",
                "title": "Station A",
                "url": "https://example.com/a.mp3",
                "seq": 1,
            },
        )
    assert r1.json()["status"] == "superseded"
    assert default_session.state.radio_info["title"] == "Station B"
    # The stale dispatch must never have reached the device at all.
    play.assert_awaited_once()


def test_play_returns_error_for_unfetchable_track(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})

    with patch.object(
        default_session.media, "get_track", side_effect=RuntimeError("not found")
    ):
        r = client.post("/play", json={"song_ids": ["bad"]})

    assert "error" in r.json()


# ── Format detection threading (resolve_output_format) ─────────────────────
# conftest.py's autouse _stub_output_format fixture makes /play resolve the
# plain mp3 fallback by default; these tests override it to exercise the
# actual threading of a non-fallback decision through to the delivery call
# and session.state — see core/streamer.py's resolve_output_format().


def test_play_passes_resolved_content_type_to_target_and_caches_it(
    client, default_session
):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="c")
    flac_copy = OutputFormat(
        ffmpeg_args=["-acodec", "copy", "-f", "flac"], content_type="audio/flac"
    )

    with (
        patch.object(default_session.media, "get_track", return_value=track),
        patch("routes.playback.resolve_output_format", AsyncMock(return_value=flac_copy)),
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play_mock,
    ):
        r = client.post(
            "/play",
            json={"song_ids": ["1"], "target_name": "TV", "target_type": "chromecast"},
        )

    assert r.json()["status"] == "playing"
    assert play_mock.call_args.args[-1] == "audio/flac"
    assert default_session.state.current_output_format is flac_copy


def test_play_sets_current_track_before_dispatching_to_target(client, default_session):
    """Regression test: a fast-responding device can open its own GET
    /stream/{session_id} connection back to us before target.play() below
    even returns — audio_stream() must already see the new track by then
    (session.state.current_track set before the dispatch, not after), or
    the device gets a 204 "No track loaded" and just never plays it
    (observed live with Sonos)."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="c")
    seen_current_track_ids = []

    async def fake_play(*_args, **_kwargs):
        current = default_session.state.current_track
        seen_current_track_ids.append(current.id if current else None)

    with (
        patch.object(default_session.media, "get_track", return_value=track),
        patch.object(ChromecastDelivery, "play", new=AsyncMock(side_effect=fake_play)),
    ):
        r = client.post(
            "/play",
            json={"song_ids": ["1"], "target_name": "TV", "target_type": "chromecast"},
        )

    assert r.json()["status"] == "playing"
    assert seen_current_track_ids == ["1"]


def test_play_rolls_back_state_when_delivery_dispatch_fails(client, default_session):
    """The state-before-dispatch reordering above (see the previous test)
    must not leave a track/delivery marked "current" when target.play()
    actually fails — otherwise the next periodic /events tick would report
    the new (never-started) track as playing instead of the old one."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    old_track = Track(id="old", title="Old", artist="Artist", duration=180, cover_art_id="c")
    new_track = Track(id="new", title="New", artist="Artist", duration=200, cover_art_id="c")

    with (
        patch.object(default_session.media, "get_track", return_value=old_track),
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
    ):
        client.post(
            "/play", json={"song_ids": ["old"], "target_name": "TV", "target_type": "chromecast"}
        )
    assert default_session.state.current_track.id == "old"

    with (
        patch.object(default_session.media, "get_track", return_value=new_track),
        patch.object(
            ChromecastDelivery, "play", new=AsyncMock(side_effect=RuntimeError("unreachable"))
        ),
    ):
        r = client.post(
            "/play", json={"song_ids": ["new"], "target_name": "TV", "target_type": "chromecast"}
        )

    assert "error" in r.json()
    assert default_session.state.current_track.id == "old"
    assert default_session.state.is_streaming is True
    # The failed dispatch's queue (["new"]) must not have overwritten the
    # still-actually-playing "old" track's own queue.
    assert default_session.state.queue == ["old"]
    assert default_session.state.queue_index == 0


# ── Queue auto-advance seeding (see routes/stream.py's _advance_or_end()) ──────


def test_play_seeds_queue_from_song_ids(client, default_session):
    """/play's song_ids becomes session.state.queue verbatim — the whole
    remaining queue, not just the track actually dispatched — so
    routes/stream.py's _advance_or_end() can auto-advance through it
    without needing the frontend to re-dispatch each track itself."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="c")

    with patch.object(default_session.media, "get_track", return_value=track):
        r = client.post("/play", json={"song_ids": ["1", "2", "3"]})

    assert r.json()["status"] == "playing"
    assert default_session.state.queue == ["1", "2", "3"]
    assert default_session.state.queue_index == 0


def test_play_dispatches_track_at_queue_index(client, default_session):
    """queue_index picks which song_ids entry is the one actually dispatched
    (and stored as current) — the whole point of song_ids now carrying
    already-played history too, not just current+upcoming (see
    AppState.queue's comment)."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="2", title="Song 2", artist="Artist", duration=180, cover_art_id="c")

    with patch.object(default_session.media, "get_track", return_value=track) as get_track:
        r = client.post("/play", json={"song_ids": ["1", "2", "3"], "queue_index": 1})

    assert r.json()["status"] == "playing"
    get_track.assert_called_once_with("2")
    assert default_session.state.queue == ["1", "2", "3"]
    assert default_session.state.queue_index == 1


def test_play_refuses_a_target_claimed_by_another_session(client, default_session):
    """/play shares _claim_or_takeover() with /play-url (see that endpoint's
    own identical test) — a device already claimed elsewhere is refused
    rather than silently stolen, unless force=True."""
    import asyncio

    from core.claims import claims

    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="c")
    asyncio.run(claims.claim("chromecast", "TV", "other-session"))

    with patch.object(default_session.media, "get_track", return_value=track):
        r = client.post(
            "/play",
            json={
                "song_ids": ["1"],
                "target_name": "TV",
                "target_type": "chromecast",
            },
        )

    assert r.json()["error"] == "device_in_use"
    assert default_session.state.is_streaming is False


def test_play_clamps_out_of_range_queue_index(client, default_session):
    """An out-of-range queue_index (a confused/outdated client) falls back to
    0 instead of raising or dispatching nothing."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="c")

    with patch.object(default_session.media, "get_track", return_value=track) as get_track:
        r = client.post("/play", json={"song_ids": ["1", "2"], "queue_index": 5})

    assert r.json()["status"] == "playing"
    get_track.assert_called_once_with("1")
    assert default_session.state.queue_index == 0


def test_update_queue_replaces_the_whole_queue(client, default_session):
    """POST /queue fully replaces session.state.queue/queue_index (history
    included) after a renderer-side reorder/add/remove — without this,
    _advance_or_end() would keep auto-advancing through whatever /play
    originally seeded, and no *other* client sharing this session would ever
    see the edit (see build_status_dict())."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="c")

    with patch.object(default_session.media, "get_track", return_value=track):
        client.post("/play", json={"song_ids": ["1", "2", "3"]})

    r = client.post("/queue", json={"song_ids": ["0", "1", "3", "2"], "queue_index": 1})

    assert r.json()["status"] == "ok"
    assert default_session.state.queue == ["0", "1", "3", "2"]
    assert default_session.state.queue_index == 1


def test_update_queue_advances_play_seq_when_one_is_given(client, default_session):
    """A nonzero seq updates session.play_seq the same way /play and
    /play-url's own dispatch does — shared ordering across all three, since
    each of them writes session.state.queue/queue_index (see QueueRequest.seq)."""
    assert default_session.play_seq == 0

    client.post("/queue", json={"song_ids": ["1", "2"], "seq": 5})

    assert default_session.play_seq == 5


def test_update_queue_is_noop_without_an_active_queue(client, default_session):
    """Nothing playing yet (session.state.queue still empty, e.g. before the
    first /play) — silently does nothing rather than seeding a queue with no
    current track at its head."""
    r = client.post("/queue", json={"song_ids": ["1", "2"]})

    assert r.json()["status"] == "ok"
    assert default_session.state.queue == []


def test_update_queue_rejects_stale_seq(client, default_session):
    """A /queue edit carrying a lower seq than a dispatch this session already
    accepted is dropped — same ordering /play/-url already rely on, since all
    three write session.state.queue/queue_index (see PlayRequest.seq)."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="c")

    with patch.object(default_session.media, "get_track", return_value=track):
        client.post("/play", json={"song_ids": ["1", "2"], "seq": 10})

    r = client.post("/queue", json={"song_ids": ["1", "9"], "seq": 5})

    assert r.json()["status"] == "superseded"
    # The stale request's own song_ids never got applied.
    assert default_session.state.queue == ["1", "2"]


def test_status_reports_queue(client, default_session):
    """build_status_dict() (GET /status and the SSE /events stream) surfaces
    the full queue/current index/count so every client sharing this session
    can mirror it, not just whichever one dispatched /play."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="2", title="Song 2", artist="Artist", duration=180, cover_art_id="c")

    with patch.object(default_session.media, "get_track", return_value=track):
        client.post("/play", json={"song_ids": ["1", "2", "3"], "queue_index": 1})

    body = client.get("/status").json()
    assert body["queue"] == ["1", "2", "3"]
    assert body["current_song_index"] == 1
    assert body["total_songs"] == 3


def test_play_and_queue_sync_shuffle_repeat_and_original_queue(client, default_session):
    """/play and /queue both store+broadcast shuffle/repeat_mode/
    original_queue alongside the queue itself — standing preferences every
    client sharing the session should see, and (for shuffle) needs the same
    original_queue to revert to when toggling shuffle off locally."""
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="c")

    with patch.object(default_session.media, "get_track", return_value=track):
        client.post(
            "/play",
            json={
                "song_ids": ["2", "1", "3"],
                "queue_index": 1,
                "original_queue": ["1", "2", "3"],
                "shuffle": True,
                "repeat_mode": "all",
            },
        )

    assert default_session.state.original_queue == ["1", "2", "3"]
    assert default_session.state.shuffle is True
    assert default_session.state.repeat_mode == "all"

    r = client.post(
        "/queue",
        json={
            "song_ids": ["1", "2", "3"],
            "queue_index": 0,
            "original_queue": ["1", "2", "3"],
            "shuffle": False,
            "repeat_mode": "one",
        },
    )
    assert r.json()["status"] == "ok"
    assert default_session.state.shuffle is False
    assert default_session.state.repeat_mode == "one"

    body = client.get("/status").json()
    assert body["original_queue"] == ["1", "2", "3"]
    assert body["shuffle"] is False
    assert body["repeat_mode"] == "one"


def test_resume_reuses_cached_content_type_without_reprobing(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="c")
    aac_copy = OutputFormat(
        ffmpeg_args=["-acodec", "copy", "-f", "adts"], content_type="audio/aac"
    )

    with (
        patch.object(default_session.media, "get_track", return_value=track),
        patch("routes.playback.resolve_output_format", AsyncMock(return_value=aac_copy)),
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
    ):
        client.post(
            "/play",
            json={"song_ids": ["1"], "target_name": "TV", "target_type": "chromecast"},
        )

    default_session.state.clock.is_paused = True

    with (
        patch(
            "routes.playback.resolve_output_format", AsyncMock(side_effect=AssertionError(
                "resume must not re-probe — it should reuse the cached format"
            ))
        ),
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as resume_play,
    ):
        r = client.post("/resume")

    assert r.status_code == 200
    assert resume_play.call_args.args[-1] == "audio/aac"


def test_play_url_resets_cached_format_to_fallback(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(id="1", title="Song", artist="Artist", duration=180, cover_art_id="c")
    flac_copy = OutputFormat(
        ffmpeg_args=["-acodec", "copy", "-f", "flac"], content_type="audio/flac"
    )

    with (
        patch.object(default_session.media, "get_track", return_value=track),
        patch("routes.playback.resolve_output_format", AsyncMock(return_value=flac_copy)),
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
    ):
        client.post(
            "/play",
            json={"song_ids": ["1"], "target_name": "TV", "target_type": "chromecast"},
        )
    assert default_session.state.current_output_format is flac_copy

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        client.post(
            "/play-url",
            json={
                "target_name": "TV",
                "target_type": "chromecast",
                "title": "Radio",
                "url": "http://example.com/radio.mp3",
            },
        )

    assert default_session.state.current_output_format is FALLBACK_FORMAT


# ── /play-url URL scheme ─────────────────────────────────────────────────────
# For AirPlay this URL is fetched server-side (see delivery/airplay.py), not
# just handed to the device — restricted to http(s) so it can't be used to
# make the backend read e.g. a local file:// path.


def test_play_url_rejects_non_http_scheme(client, default_session):
    r = client.post(
        "/play-url",
        json={
            "target_name": "TV",
            "target_type": "chromecast",
            "title": "Test",
            "url": "file:///etc/passwd",
        },
    )
    assert "error" in r.json()
    assert default_session.state.is_streaming is False


def test_play_url_rejects_when_no_target_resolves(client, default_session):
    """No targets/target_name given, and nothing already casting to fall
    back to (see resolve_target()'s `previous` parameter) — there's simply
    nothing for this to dispatch to."""
    r = client.post(
        "/play-url",
        json={"title": "Radio", "url": "http://example.com/radio.mp3"},
    )
    assert r.json() == {"error": "No target configured"}
    assert default_session.state.is_streaming is False


def test_play_url_accepts_https_scheme(client, default_session):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        r = client.post(
            "/play-url",
            json={
                "target_name": "TV",
                "target_type": "chromecast",
                "title": "Test",
                "url": "https://example.com/stream.mp3",
            },
        )
    assert r.json()["status"] == "playing"
    play.assert_awaited_once()


def test_play_url_releases_the_claim_when_delivery_fails(client, default_session):
    """See /play's identical comment: a failed dispatch must not leave the
    device locked to this session (device_in_use for every other client)
    with nothing actually playing on it."""
    from core.claims import claims

    with patch.object(
        ChromecastDelivery, "play", new=AsyncMock(side_effect=RuntimeError("unreachable"))
    ):
        r = client.post(
            "/play-url",
            json={
                "target_name": "TV",
                "target_type": "chromecast",
                "title": "Test",
                "url": "https://example.com/stream.mp3",
            },
        )

    assert r.json() == {"error": "unreachable"}
    assert claims.owner_of("chromecast", "TV") is None


# ── Phase 2 takeover (force=True) ───────────────────────────────────────────


def test_play_url_rejects_claimed_target_without_force(client, default_session, caplog):
    import asyncio
    import logging

    from core.claims import claims

    asyncio.run(claims.claim("chromecast", "TV", "other-session"))

    with caplog.at_level(logging.INFO, logger="connect.playback"):
        r = client.post(
            "/play-url",
            json={
                "target_name": "TV",
                "target_type": "chromecast",
                "title": "Test",
                "url": "http://example.com/stream.mp3",
            },
        )

    body = r.json()
    assert body["error"] == "device_in_use"
    assert default_session.state.is_streaming is False
    # Logged even when refused — a radio start attempt shouldn't go
    # completely silent just because the device was already claimed.
    messages = "\n".join(rec.message for rec in caplog.records)
    assert "Radio 'Test'" in messages


def test_play_url_with_force_displaces_other_sessions_claim(client, default_session):
    import asyncio

    from core.claims import claims
    from core.session import registry
    from delivery import ChromecastDelivery

    other = asyncio.run(registry.get_or_create("other-session"))
    other.state.is_streaming = True
    other_delivery = ChromecastDelivery("TV")
    other.state.active_delivery = other_delivery
    asyncio.run(claims.claim("chromecast", "TV", "other-session"))

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch.object(ChromecastDelivery, "stop", new=AsyncMock()) as other_stop,
    ):
        r = client.post(
            "/play-url",
            json={
                "force": True,
                "target_name": "TV",
                "target_type": "chromecast",
                "title": "Test",
                "url": "http://example.com/stream.mp3",
            },
        )

    assert r.json()["status"] == "playing"
    other_stop.assert_awaited_once()
    assert other.state.active_delivery is None
    assert other.state.is_streaming is False
    assert claims.owner_of("chromecast", "TV") == default_session.session_id


# ── Duplicate-dispatch cooldown ─────────────────────────────────────────────
# Backend-side safety net for a client (buggy or otherwise) that re-issues
# /play or /play-url for the same target in a tight loop — see
# _is_duplicate_dispatch()'s docstring and the frontend regression it backs
# up (use-connect-playback.ts's radio auto-forward effect used to do exactly
# this, spamming Sonos with SetAVTransportURI/Play roughly every 500ms).


def test_play_url_does_not_redispatch_same_target_and_url_within_cooldown(
    client, default_session
):
    body = {
        "target_name": "TV",
        "target_type": "chromecast",
        "title": "Test",
        "url": "http://example.com/stream.mp3",
    }
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play_mock:
        r1 = client.post("/play-url", json=body)
        r2 = client.post("/play-url", json=body)

    assert r1.json()["status"] == "playing"
    # Still reports success — a suppressed duplicate isn't an error — but the
    # device itself only actually gets told to play once.
    assert r2.json()["status"] == "playing"
    play_mock.assert_awaited_once()


def test_play_url_redispatches_once_the_cooldown_has_elapsed(client, default_session):
    body = {
        "target_name": "TV",
        "target_type": "chromecast",
        "title": "Test",
        "url": "http://example.com/stream.mp3",
    }
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play_mock:
        client.post("/play-url", json=body)
        default_session.state.last_dispatch_at -= 2.0
        client.post("/play-url", json=body)

    assert play_mock.await_count == 2


def test_play_url_redispatches_immediately_for_a_different_url(
    client, default_session
):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play_mock:
        client.post(
            "/play-url",
            json={
                "target_name": "TV",
                "target_type": "chromecast",
                "title": "Test",
                "url": "http://example.com/stream.mp3",
            },
        )
        client.post(
            "/play-url",
            json={
                "target_name": "TV",
                "target_type": "chromecast",
                "title": "Other",
                "url": "http://example.com/other.mp3",
            },
        )

    assert play_mock.await_count == 2


def test_play_does_not_redispatch_same_target_and_track_within_cooldown(
    client, default_session
):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    track = Track(
        id="1", title="Test Song", artist="Test Artist", duration=180, cover_art_id="c"
    )
    body = {
        "target_name": "TV",
        "target_type": "chromecast",
        "song_ids": ["1"],
    }
    with (
        patch.object(default_session.media, "get_track", return_value=track),
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play_mock,
    ):
        client.post("/play", json=body)
        client.post("/play", json=body)

    play_mock.assert_awaited_once()


def test_stop_clears_dispatch_key_so_the_next_play_is_not_suppressed(
    client, default_session
):
    """A real /stop between two identical dispatches means the second one is
    a genuine restart, not a runaway duplicate — must not be swallowed just
    because it happens to land inside the cooldown window."""
    body = {
        "target_name": "TV",
        "target_type": "chromecast",
        "title": "Test",
        "url": "http://example.com/stream.mp3",
    }
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play_mock,
        patch.object(ChromecastDelivery, "stop", new=AsyncMock()),
    ):
        client.post("/play-url", json=body)
        client.post("/stop")
        client.post("/play-url", json=body)

    assert play_mock.await_count == 2


# ── /stop ─────────────────────────────────────────────────────────────────────


def test_stop_resets_state(client, default_session):
    default_session.state.is_streaming = True
    default_session.state.current_track = Track("1", "Song", "Artist", 60, "")

    r = client.post("/stop")
    assert r.status_code == 200
    assert r.json()["status"] == "stopped"
    assert default_session.state.is_streaming is False
    assert default_session.state.current_track is None


def test_stop_stops_and_clears_a_still_draining_analyzer(client, default_session):
    """Unlike a track finishing normally (routes/stream.py's
    finish_feeding() lets the analyzer keep draining what it already
    buffered), playback is genuinely ending here — nothing left for GET
    /visualizer to read, so it's torn down outright rather than left to
    drain on its own."""
    analyzer = AsyncMock()
    default_session.audio_analyzer = analyzer

    client.post("/stop")

    analyzer.stop.assert_awaited_once()
    assert default_session.audio_analyzer is None


def test_stop_clears_queue(client, default_session):
    default_session.state.queue = ["1", "2", "3"]
    default_session.state.queue_index = 1

    client.post("/stop")

    assert default_session.state.queue == []
    assert default_session.state.queue_index == 0


def test_stop_is_idempotent(client, default_session):
    r1 = client.post("/stop")
    r2 = client.post("/stop")
    assert r1.json()["status"] == "stopped"
    assert r2.json()["status"] == "stopped"


# ── /pause + /resume ──────────────────────────────────────────────────────────


def test_pause_sets_paused_flag(client, default_session):
    default_session.media = SubsonicClient("http://nav")
    default_session.state.is_streaming = True
    default_session.state.clock.play_start_time = time.time() - 30

    r = client.post("/pause")
    assert r.status_code == 200
    assert r.json()["paused"] is True
    assert default_session.state.clock.is_paused is True
    assert default_session.state.clock.paused_elapsed > 0


def test_resume_clears_paused_flag(client, default_session):
    default_session.media = SubsonicClient("http://nav")
    default_session.state.clock.is_paused = True
    default_session.state.clock.paused_elapsed = 30.0
    default_session.state.clock.play_start_time = time.time() - 30

    r = client.post("/resume")
    assert r.status_code == 200
    assert r.json()["paused"] is False
    assert default_session.state.clock.is_paused is False


def test_pause_resume_roundtrip_with_position_offset(client, default_session):
    """resume_offset must be the raw position so resume doesn't double-apply
    the device's buffering lag (a negative position_offset)."""
    default_session.media = SubsonicClient("http://nav")
    default_session.state.is_streaming = True
    default_session.state.current_track = Track("1", "Song", "Artist", 180, "")
    default_session.state.clock.play_start_time = time.time() - 30
    default_session.state.clock.position_offset = -4.0

    r = client.post("/pause")
    assert r.json()["paused"] is True
    assert abs(default_session.state.clock.paused_elapsed - 26.0) < 1.0
    assert abs(default_session.state.clock.resume_offset - 30.0) < 1.0

    client.post("/resume")
    assert abs(default_session.state.clock.position_offset - (-4.0)) < 0.01


def test_resume_is_a_no_op_while_already_playing(client, default_session):
    """Regression for a real prod symptom (2026-08-20): a duplicate /resume
    call — observed from a stray OS media-key/media-widget action arriving
    after a real one already took effect, see mediaSession.ts's own fix —
    landing while the track is already playing must not reseek: clock.
    resume() unconditionally jumps back to resume_offset, which is only
    ever updated by pause()/seek_to(), so an extra resume() mid-track
    discarded everything actually played since the *last real* pause and
    forced a needless fresh /stream reconnect on top — read live as
    playback/lyrics repeatedly snapping back near the last pause point."""
    default_session.media = SubsonicClient("http://nav")
    default_session.state.is_streaming = True
    default_session.state.current_track = Track("1", "Song", "Artist", 180, "")
    default_session.state.clock.play_start_time = time.time() - 45
    default_session.state.clock.resume_offset = 3.5  # frozen at a much earlier pause

    r = client.post("/resume")
    assert r.status_code == 200
    assert r.json()["paused"] is False
    # Untouched — a real reseek-to-resume_offset would have moved this to
    # ~44.9s ago instead.
    assert abs(default_session.state.clock.play_start_time - (time.time() - 45)) < 1.0


def test_resume_then_resync_does_not_corrupt_position_offset_after_deep_pause(
    client, default_session
):
    """Integration-level regression for the same real prod bug
    test_resume_re_zeroes_track_start_position_to_resume_offset covers at
    the PlaybackClock level: /resume reconnects the stream (fresh -ss seek),
    and a Sonos device resets its own reported position on exactly that
    kind of reconnect — periodic resync polling shortly after must not
    misread that as the *track* itself having jumped back near its start."""
    default_session.media = SubsonicClient("http://nav")
    default_session.state.is_streaming = True
    default_session.state.current_track = Track("1", "Song", "Artist", 180, "")
    default_session.state.active_delivery = SonosDelivery("Arbeitszimmer")
    default_session.state.clock.position_offset = -1.15
    default_session.state.clock.pause(145.6)

    with patch.object(SonosDelivery, "play", new=AsyncMock()):
        client.post("/resume")

    # Sonos resetting its own position counter on the fresh reconnect —
    # ~8s in, matching how long it took this resync check to land.
    with patch.object(SonosDelivery, "get_position", new=AsyncMock(return_value=8.0)):
        asyncio.run(
            _resync_position_once(default_session, default_session.state.active_delivery)
        )

    # Must stay a small, plausible correction — not off by ~145s (the
    # pre-resume elapsed position), the way the unfixed bug corrupted it to.
    assert default_session.state.clock.position_offset > -10.0


def test_pause_without_configured_media_returns_error(client, default_session):
    """A session that never received /config — e.g. freshly re-created after
    the backend reaped the previous one during a long idle period (see
    core/session.py's SESSION_IDLE_TIMEOUT) — must not silently report
    "paused": true with nothing actually paused; the frontend relies on this
    error to detect the loss and reset to disconnected."""
    default_session.state.is_streaming = True
    default_session.state.clock.play_start_time = time.time() - 30

    r = client.post("/pause")
    assert r.status_code == 200
    assert "error" in r.json()
    assert default_session.state.clock.is_paused is False


def test_resume_without_configured_media_returns_error(client, default_session):
    default_session.state.clock.is_paused = True
    default_session.state.clock.paused_elapsed = 30.0

    r = client.post("/resume")
    assert r.status_code == 200
    assert "error" in r.json()
    assert default_session.state.clock.is_paused is True


def test_pause_delegates_to_the_active_delivery(client, default_session):
    default_session.media = SubsonicClient("http://nav")
    default_session.state.is_streaming = True
    default_session.state.clock.play_start_time = time.time() - 30
    default_session.state.active_delivery = ChromecastDelivery("TV")

    with patch.object(ChromecastDelivery, "pause", new=AsyncMock()) as pause:
        r = client.post("/pause")

    assert r.json()["paused"] is True
    pause.assert_awaited_once()


def test_resume_returns_an_error_when_the_delivery_reconnect_fails(client, default_session):
    """Matches /play's contract: a JSON {"error": ...} body, not an
    unhandled exception surfacing as a 500 — the device may have gone
    unreachable while paused."""
    default_session.media = SubsonicClient("http://nav")
    default_session.state.clock.is_paused = True
    default_session.state.clock.paused_elapsed = 30.0
    default_session.state.active_delivery = ChromecastDelivery("TV")

    with patch.object(
        ChromecastDelivery, "play", new=AsyncMock(side_effect=RuntimeError("unreachable"))
    ):
        r = client.post("/resume")

    assert r.json() == {"error": "unreachable"}


def test_seek_returns_an_error_when_the_delivery_reconnect_fails(client, default_session):
    default_session.media = SubsonicClient("http://nav")
    default_session.state.is_streaming = True
    default_session.state.active_delivery = ChromecastDelivery("TV")

    with patch.object(
        ChromecastDelivery, "play", new=AsyncMock(side_effect=RuntimeError("unreachable"))
    ):
        r = client.post("/seek", json={"position": 30.0})

    assert r.json() == {"error": "unreachable"}


# ── /seek with position_offset ────────────────────────────────────────────────


def test_seek_accounts_for_position_offset(client, default_session):
    default_session.state.is_streaming = True
    default_session.state.current_track = Track("1", "Song", "Artist", 180, "")
    default_session.state.clock.position_offset = -4.0

    r = client.post("/seek", json={"position": 50.0})
    assert r.status_code == 200
    # raw wall-clock position should be 50 - (-4) = 54
    assert abs(default_session.state.clock.resume_offset - 54.0) < 0.01

    elapsed = compute_position(default_session)
    assert abs(elapsed - 50.0) < 0.5


def test_seek_near_zero_clamps_raw_position(client, default_session):
    default_session.state.is_streaming = True
    default_session.state.current_track = Track("1", "Song", "Artist", 180, "")
    default_session.state.clock.position_offset = 4.0

    client.post("/seek", json={"position": 1.0})
    assert default_session.state.clock.resume_offset == 0.0


# ── /resume + /seek reconnect to radio's own URL, not the track /stream proxy ──
# Radio has no track loaded (current_track stays None — see /play-url), so
# reconnecting via the FFmpeg /stream/{session_id} proxy 204s with nothing to
# play. Regression coverage for that: both must replay radio_info["url"].


def test_resume_reconnects_to_radio_url_not_stream_proxy(client, default_session):
    default_session.media = SubsonicClient("http://nav")
    default_session.state.is_streaming = True
    default_session.state.radio_info = {"title": "Radio FM", "url": "http://stream/radio"}
    default_session.state.active_delivery = ChromecastDelivery("TV")
    default_session.state.clock.is_paused = True

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        r = client.post("/resume")

    assert r.status_code == 200
    play.assert_awaited_once_with(
        "http://stream/radio", "Radio FM", "", None, None, "", "audio/mpeg"
    )


def test_seek_while_playing_reconnects_to_radio_url(client, default_session):
    default_session.state.is_streaming = True
    default_session.state.radio_info = {"title": "Radio FM", "url": "http://stream/radio"}
    default_session.state.active_delivery = ChromecastDelivery("TV")
    default_session.state.clock.is_paused = False

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        client.post("/seek", json={"position": 0})

    play.assert_awaited_once_with(
        "http://stream/radio", "Radio FM", "", None, None, "", "audio/mpeg"
    )


def test_resume_still_uses_stream_proxy_for_a_regular_track(client, default_session):
    default_session.media = SubsonicClient("http://nav")
    default_session.state.is_streaming = True
    default_session.state.current_track = Track("1", "Song", "Artist", 180, "")
    default_session.state.active_delivery = ChromecastDelivery("TV")
    default_session.state.clock.is_paused = True

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        client.post("/resume")

    url = play.call_args.args[0]
    assert url.startswith("http://") and "/stream/" in url


# ── _apply_position_offset ──────────────────────────────────────────────────────


def test_apply_position_offset_fixed_for_airplay(default_session):
    default_session.state.is_streaming = True
    default_session.state.clock.play_start_time = time.time()
    default_session.state.clock.play_generation = 1

    target = AirPlayDelivery("HomePod")
    import asyncio

    asyncio.run(_apply_position_offset(default_session, target, generation=1))

    assert default_session.state.clock.position_offset == -AirPlayDelivery.FIXED_OFFSET


def test_apply_position_offset_calibrates_for_sonos(default_session):
    """Device lags behind the wall clock -> position_offset must be negative."""
    default_session.state.is_streaming = True
    default_session.state.clock.play_start_time = time.time() - 5.0
    default_session.state.clock.play_generation = 1

    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=1.5)):
        asyncio.run(_apply_position_offset(default_session, target, generation=1))

    # device is ~1.5s in, wall-clock elapsed ~5.5s (incl. the 0.5s poll delay) -> offset ~-4s
    assert -4.5 < default_session.state.clock.position_offset < -3.5


def test_apply_position_offset_ignores_implausible_reading_then_calibrates(
    default_session,
):
    """Regression test: a device reporting a position far ahead of the wall
    clock this early (observed with a DLNA renderer reporting a stale ~56s
    reading mere seconds into a brand new stream) must not get calibrated in
    as a bogus large offset — keep polling for a plausible reading instead."""
    default_session.state.is_streaming = True
    default_session.state.clock.play_start_time = time.time()
    default_session.state.clock.play_generation = 1

    target = SonosDelivery("Wohnzimmer")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(side_effect=[56.0, 1.5])):
        asyncio.run(_apply_position_offset(default_session, target, generation=1))

    # Must have used the second (plausible) reading, not the bogus first one —
    # a -53s-ish offset would mean this assertion range is wrong.
    assert -1.5 < default_session.state.clock.position_offset < 1.5


def test_apply_position_offset_calibrates_correctly_with_start_position(
    default_session,
):
    """Regression test: connecting mid-track (start_position > 0) must not
    corrupt the calibration. device_pos is relative to the post-seek FFmpeg
    stream (starts near 0), not to the track, so it must be compared against
    wall-clock time since the stream was requested — not since track-relative
    play_start_time, which is backdated by start_position.
    """
    start_position = 10.0
    default_session.state.is_streaming = True
    default_session.state.clock.play_start_time = time.time() - start_position
    default_session.state.clock.track_start_position = start_position
    default_session.state.clock.play_generation = 1

    target = SonosDelivery("Arbeitszimmer")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=1.0)):
        asyncio.run(_apply_position_offset(default_session, target, generation=1))

    # device is ~1s into the post-seek stream, ~0.5s of that is the poll delay
    # -> offset should be a small buffering correction, NOT ~-start_position (-10s).
    assert -2.0 < default_session.state.clock.position_offset < 2.0


def test_apply_position_offset_returns_when_nothing_supports_position(default_session):
    """No FIXED_OFFSET (AirPlay's estimate-based path) and no
    SUPPORTS_POSITION delivery either — nothing this function can do
    anything with, must give up immediately rather than loop forever
    waiting for a reading that can never come."""

    class _NoPositionDelivery(BaseDelivery):
        async def play(self, *args, **kwargs) -> None:
            pass

        async def stop(self) -> None:
            pass

    default_session.state.is_streaming = True
    default_session.state.clock.play_start_time = time.time()
    default_session.state.clock.play_generation = 1

    target = _NoPositionDelivery("mystery-device")
    import asyncio

    asyncio.run(
        asyncio.wait_for(
            _apply_position_offset(default_session, target, generation=1), timeout=1.0
        )
    )

    assert default_session.state.clock.position_offset == 0.0


def test_apply_position_offset_stops_polling_once_streaming_stops_mid_wait(default_session):
    """Two things in one natural sequence: no reading yet (None) keeps
    polling, then playback stops externally before the next poll — which
    must notice and give up rather than keep polling for the rest of the
    10s deadline."""
    default_session.state.is_streaming = True
    default_session.state.clock.play_start_time = time.time()
    default_session.state.clock.play_generation = 1

    target = SonosDelivery("Küche")
    import asyncio

    async def _fake_get_position():
        default_session.state.is_streaming = False

    with patch.object(target, "get_position", new=_fake_get_position):
        asyncio.run(_apply_position_offset(default_session, target, generation=1))

    # Left at the provisional startup-delay guess set before polling began —
    # never got a plausible reading to calibrate a real offset from.
    assert default_session.state.clock.position_offset == -PROVISIONAL_STARTUP_DELAY


def test_apply_position_offset_retries_after_a_transient_get_position_error(default_session):
    default_session.state.is_streaming = True
    default_session.state.clock.play_start_time = time.time()
    default_session.state.clock.play_generation = 1

    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(
        target,
        "get_position",
        new=AsyncMock(side_effect=[RuntimeError("SOAP fault"), 0.5]),
    ):
        asyncio.run(_apply_position_offset(default_session, target, generation=1))

    # Used the second, successful reading rather than aborting on the
    # first transient failure.
    assert default_session.state.clock.position_offset != 0.0


def test_apply_position_offset_abandons_on_track_change(default_session):
    default_session.state.is_streaming = True
    default_session.state.clock.play_start_time = time.time()
    # A new /play already bumped the generation by the time the
    # calibration task gets to run its first poll.
    default_session.state.clock.play_generation = 2

    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=5.0)):
        asyncio.run(_apply_position_offset(default_session, target, generation=1))

    assert default_session.state.clock.position_offset == 0.0


# ── _resync_position_once / _resync_position_periodically ───────────────────
# Regression coverage for "let me poll the device's own position so an
# external seek — scrubbing on the device's own remote/app instead of
# through Beacon — doesn't leave the displayed position stuck on the old
# wall-clock model" (_apply_position_offset above deliberately only
# calibrates once, at track start — see its own docstring).


def test_resync_position_once_ignores_small_drift(default_session):
    default_session.state.clock.play_start_time = time.time() - 10.0
    default_session.state.clock.position_offset = 0.0
    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=10.2)):
        asyncio.run(_resync_position_once(default_session, target))

    # 0.2s off wall-clock is ordinary jitter, not a real change — must not
    # have recalibrated at all.
    assert default_session.state.clock.position_offset == 0.0


def test_resync_position_once_ignores_small_drift_on_top_of_large_offset(default_session):
    """Regression for a real prod symptom: once a track has a legitimately
    large standing offset (here -6.0s, e.g. from an earlier real device
    pause), a *further* small drift on top of it must stay ignored the same
    way test_resync_position_once_ignores_small_drift's fresh-offset case
    does — comparing the raw device/wall-clock delta against
    POSITION_RESYNC_THRESHOLD on its own (instead of how much it would
    actually *change* position_offset) recalibrated on every single ~8s
    check once the standing offset itself exceeded the threshold, forever,
    which read live as the position UI jittering nonstop for the rest of
    the track."""
    default_session.state.clock.play_start_time = time.time() - 40.0
    default_session.state.clock.position_offset = -6.0
    target = SonosDelivery("Küche")
    import asyncio

    # wall_elapsed ≈ 40.0s; device at 34.3s is delta=-5.7s from that — past
    # POSITION_RESYNC_THRESHOLD on its own, but only 0.3s away from the
    # already-applied -6.0s offset.
    with patch.object(target, "get_position", new=AsyncMock(return_value=34.3)):
        asyncio.run(_resync_position_once(default_session, target))

    assert default_session.state.clock.position_offset == -6.0


def test_resync_position_once_recalibrates_on_forward_seek(default_session):
    """A device position well *ahead* of the wall-clock model must still be
    trusted here — unlike _apply_position_offset's startup-only guard, this
    is exactly the "skipped forward on the device itself" case this exists
    to catch, not a stale reading to reject."""
    default_session.state.clock.play_start_time = time.time() - 10.0
    default_session.state.clock.position_offset = 0.0
    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=40.0)):
        asyncio.run(_resync_position_once(default_session, target))

    assert default_session.state.clock.position_offset > POSITION_RESYNC_THRESHOLD


def test_resync_position_once_recalibrates_on_backward_seek(default_session):
    default_session.state.clock.play_start_time = time.time() - 40.0
    default_session.state.clock.position_offset = 0.0
    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=10.0)):
        asyncio.run(_resync_position_once(default_session, target))

    assert default_session.state.clock.position_offset < -POSITION_RESYNC_THRESHOLD


def test_resync_position_once_ignores_reading_past_track_duration(default_session):
    default_session.state.current_track = Track("1", "Song", "Artist", 180, "")
    default_session.state.clock.play_start_time = time.time() - 10.0
    default_session.state.clock.position_offset = 0.0
    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=500.0)):
        asyncio.run(_resync_position_once(default_session, target))

    assert default_session.state.clock.position_offset == 0.0


def test_resync_position_once_ignores_a_reset_to_zero_once_wall_clock_is_past_duration(
    default_session,
):
    """Regression for a real prod symptom: once the wall clock has already
    reached the track's own duration (the ffmpeg-done-early overrun window
    routes/stream.py's _fire_track_end polls through), SonosDelivery's
    get_position() reporting a bare 0:00:00 — what a stopped/idle transport
    with nothing playing looks like, indistinguishable from a genuine
    rewind-to-the-start at the value level alone — must not be trusted as a
    real seek. Recalibrating onto it corrupts position_offset by roughly the
    entire elapsed wall-clock duration, which clock.seconds_until() (read
    directly by _fire_track_end) then reports as a ballooning "remaining"
    estimate instead of ever reaching zero — observed live as a track never
    auto-advancing and its displayed position visibly snapping back to
    0:00 (2026-08-20)."""
    default_session.state.current_track = Track("1", "Song", "Artist", 180, "")
    default_session.state.clock.play_start_time = time.time() - 320.0
    default_session.state.clock.position_offset = -1.07
    target = SonosDelivery("Arbeitszimmer")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=0.0)):
        asyncio.run(_resync_position_once(default_session, target))

    assert default_session.state.clock.position_offset == -1.07


def test_resync_position_once_still_recalibrates_a_real_rewind_well_before_duration(
    default_session,
):
    """The guard above is specifically about wall_elapsed already being at/
    past the track's own duration — a genuine rewind-to-the-start mid-track
    (well short of duration) must still recalibrate normally."""
    default_session.state.current_track = Track("1", "Song", "Artist", 180, "")
    default_session.state.clock.play_start_time = time.time() - 40.0
    default_session.state.clock.position_offset = 0.0
    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=0.0)):
        asyncio.run(_resync_position_once(default_session, target))

    assert default_session.state.clock.position_offset < -POSITION_RESYNC_THRESHOLD


def test_resync_position_once_ignores_negative_reading(default_session):
    default_session.state.clock.play_start_time = time.time() - 10.0
    default_session.state.clock.position_offset = 0.0
    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=-1.0)):
        asyncio.run(_resync_position_once(default_session, target))

    assert default_session.state.clock.position_offset == 0.0


def test_resync_position_once_ignores_get_position_failure(default_session):
    default_session.state.clock.play_start_time = time.time() - 10.0
    default_session.state.clock.position_offset = 0.0
    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(side_effect=OSError("unreachable"))):
        asyncio.run(_resync_position_once(default_session, target))

    assert default_session.state.clock.position_offset == 0.0


def test_resync_position_periodically_returns_immediately_for_airplay(default_session):
    """No SUPPORTS_POSITION delivery at all -> must return before ever
    sleeping/polling, not loop forever waiting for a reading that can never
    come (AirPlay has no position feedback — see FIXED_OFFSET instead)."""
    default_session.state.is_streaming = True
    target = AirPlayDelivery("HomePod")
    import asyncio

    asyncio.run(
        asyncio.wait_for(
            _resync_position_periodically(default_session, target, generation=1), timeout=1.0
        )
    )


def test_resync_position_periodically_stops_on_generation_mismatch(default_session, monkeypatch):
    monkeypatch.setattr("routes.playback.POSITION_RESYNC_INTERVAL", 0.01)
    default_session.state.is_streaming = True
    # A new /play (or /seek, or /resume) already bumped the generation by
    # the time this task gets to run its first check.
    default_session.state.clock.play_generation = 2
    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=5.0)) as get_position:
        asyncio.run(
            asyncio.wait_for(
                _resync_position_periodically(default_session, target, generation=1), timeout=1.0
            )
        )
    get_position.assert_not_called()


async def _run_briefly(coro) -> None:
    """Runs `coro` (expected to loop forever) for a short bounded window,
    then cancels it — used below to assert on behavior *during* a few loop
    iterations of _resync_position_periodically(), which otherwise never
    returns on its own within a single test."""
    task = asyncio.ensure_future(coro)
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=0.05)
    except asyncio.TimeoutError:
        pass
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def test_resync_position_periodically_calls_resync_once_per_interval(
    default_session, monkeypatch
):
    monkeypatch.setattr("routes.playback.POSITION_RESYNC_INTERVAL", 0.01)
    default_session.state.is_streaming = True
    default_session.state.clock.play_generation = 1
    target = SonosDelivery("Küche")

    with patch("routes.playback._resync_position_once", new=AsyncMock()) as resync_once:
        await _run_briefly(
            _resync_position_periodically(default_session, target, generation=1)
        )

    resync_once.assert_awaited()


def test_resync_position_periodically_skips_polling_while_paused(default_session, monkeypatch):
    monkeypatch.setattr("routes.playback.POSITION_RESYNC_INTERVAL", 0.01)
    default_session.state.is_streaming = True
    default_session.state.clock.play_generation = 1
    default_session.state.clock.is_paused = True
    target = SonosDelivery("Küche")
    import asyncio

    with patch.object(target, "get_position", new=AsyncMock(return_value=5.0)) as get_position:
        asyncio.run(
            _run_briefly(_resync_position_periodically(default_session, target, generation=1))
        )
    get_position.assert_not_called()
