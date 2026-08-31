"""Tests for core/session.py — SessionRegistry, get_session, reap_stale_sessions."""

import asyncio
import time

from delivery import ChromecastDelivery
from media import Track


def test_get_or_create_returns_same_instance_for_same_id():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    a = asyncio.run(registry.get_or_create("session-a"))
    b = asyncio.run(registry.get_or_create("session-a"))
    assert a is b


def test_get_or_create_isolates_different_ids():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    a = asyncio.run(registry.get_or_create("session-a"))
    b = asyncio.run(registry.get_or_create("session-b"))
    assert a is not b

    a.state.current_track = Track("1", "Song A", "Artist", 100, "")
    assert b.state.current_track is None


def test_get_returns_none_for_unknown_session_without_creating():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    assert registry.get("nope") is None
    assert registry.all() == []


def test_get_does_not_touch_last_seen():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    session = asyncio.run(registry.get_or_create("session-a"))
    session.last_seen = 0.0

    registry.get("session-a")

    assert session.last_seen == 0.0


def test_require_authenticated_session_does_not_create_a_session(client):
    """An unauthenticated caller (anyone with just CONNECT_TOKEN) hitting a
    require_authenticated_session-gated route with an arbitrary, never-seen
    X-Connect-Session must not be able to grow the registry — see
    core/session.py's require_authenticated_session docstring."""
    from core.session import registry

    r = client.get("/discover", headers={"X-Connect-Session": "never-seen-before"})

    assert r.status_code == 401
    assert registry.get("never-seen-before") is None


def test_get_session_falls_back_to_default_with_no_header_or_query():
    from core.session import DEFAULT_SESSION_ID, SessionRegistry, get_session

    registry = SessionRegistry()
    # get_session uses the module-level registry, so patch it via the
    # function's own closure isn't possible without importing the module —
    # exercise the real module-level registry, isolated by the autouse
    # reset_state fixture in conftest.py.
    import core.session as session_module

    original_registry = session_module.registry
    session_module.registry = registry
    try:
        session = asyncio.run(get_session(x_connect_session=None, session=None))
        assert session.session_id == DEFAULT_SESSION_ID
    finally:
        session_module.registry = original_registry


def test_get_session_prefers_header_over_query():
    from core.session import get_session

    session = asyncio.run(get_session(x_connect_session="from-header", session="from-query"))
    assert session.session_id == "from-header"


def test_get_session_uses_query_when_no_header():
    from core.session import get_session

    session = asyncio.run(get_session(x_connect_session=None, session="from-query"))
    assert session.session_id == "from-query"


def test_remove_pops_session():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    asyncio.run(registry.get_or_create("session-a"))
    removed = asyncio.run(registry.remove("session-a"))
    assert removed is not None
    assert removed.session_id == "session-a"
    assert registry.get("session-a") is None


def test_remove_missing_session_returns_none():
    from core.session import SessionRegistry

    registry = SessionRegistry()
    assert asyncio.run(registry.remove("nope")) is None


# ── reap_once ─────────────────────────────────────────────────────────────────


def test_reap_once_removes_idle_session_past_timeout():
    from core.session import SESSION_IDLE_TIMEOUT, reap_once, registry

    session = asyncio.run(registry.get_or_create("stale-session"))
    session.last_seen = time.time() - SESSION_IDLE_TIMEOUT - 1

    reaped = asyncio.run(reap_once())

    assert reaped == ["stale-session"]
    assert registry.get("stale-session") is None


def test_reap_once_leaves_recently_touched_session_alone():
    from core.session import reap_once, registry

    asyncio.run(registry.get_or_create("fresh-session"))

    reaped = asyncio.run(reap_once())

    assert reaped == []
    assert registry.get("fresh-session") is not None


def _stale_session(session_id: str, uri: str | None, streaming: bool = False):
    """A session whose last_seen is past the timeout, holding a delivery
    whose device reports `uri` as what it is currently playing (None = can't
    say). `streaming` is what the session itself believes about its own
    playback."""
    from unittest.mock import AsyncMock

    from core.session import SESSION_IDLE_TIMEOUT, registry

    session = asyncio.run(registry.get_or_create(session_id))
    delivery = ChromecastDelivery("TV")
    delivery.stop = AsyncMock()
    delivery.current_uri = AsyncMock(return_value=uri)
    session.state.active_delivery = delivery
    session.state.is_streaming = streaming
    session.last_seen = time.time() - SESSION_IDLE_TIMEOUT - 1
    return session, delivery


# ── what "idle" must not mean ────────────────────────────────────────────────


def test_reap_once_never_reaps_a_session_that_is_still_streaming():
    """The 2026-08-23 incident (see
    docs/playback-bugs/fixed-cast-stops-after-30-minutes.md). Nothing about
    casting touches last_seen once a track is under way — the /events
    heartbeat needs an open app window, and a GET /stream connection touches
    the session once, when the device opens it. So an 80-minute mix played
    with every tab closed ages its own session past the timeout while it is
    audibly playing, and the reap stopped the speaker 31 minutes in."""
    from core.session import reap_once, registry

    session, delivery = _stale_session("long-track", uri=None, streaming=True)

    reaped = asyncio.run(reap_once())

    assert reaped == []
    assert registry.get("long-track") is session
    delivery.stop.assert_not_awaited()
    # Not even asked: what it plays is irrelevant while we know we're casting.
    delivery.current_uri.assert_not_awaited()


def test_reap_once_leaves_a_paused_cast_alone():
    """Same reasoning one step later: somebody may well come back to it, and
    stopping the device under them is the same rudeness."""
    from core.session import reap_once, registry

    session, delivery = _stale_session("paused-cast", uri=None, streaming=True)
    session.state.clock.is_paused = True

    assert asyncio.run(reap_once()) == []
    assert registry.get("paused-cast") is not None
    delivery.stop.assert_not_awaited()


# ── what a reap does to the device it finds ──────────────────────────────────


def test_reap_once_stops_delivery_and_releases_claims():
    from core.claims import claims
    from core.session import reap_once, registry
    from core.state import stream_url

    _, delivery = _stale_session("stale-with-delivery", stream_url("stale-with-delivery"))
    asyncio.run(claims.claim("chromecast", "TV", "stale-with-delivery"))

    asyncio.run(reap_once())

    delivery.stop.assert_awaited_once()
    assert claims.owner_of("chromecast", "TV") is None
    assert registry.get("stale-with-delivery") is None


def test_reap_once_leaves_a_device_playing_someone_elses_stream_alone():
    """Same speaker, different owner: the device answers with a URL that
    isn't this session's stream (another instance's port, or another
    session's id), so stopping it would cut off playback nobody asked to
    end — the 2026-08-22 incident, where a second Beacon instance on the
    same host lost its cast to exactly this."""
    from core.session import reap_once, registry

    _, delivery = _stale_session("stale-taken-over", "http://10.0.0.5:9071/stream/other")

    reaped = asyncio.run(reap_once())

    delivery.stop.assert_not_awaited()
    assert reaped == ["stale-taken-over"]  # the session still goes away
    assert registry.get("stale-taken-over") is None


def test_reap_once_still_stops_a_device_that_cannot_report_its_uri():
    """AirPlay and anything else without a transport to query — unchanged
    behaviour, and the safer default for a session that has already stopped
    streaming: a speaker left playing forever is worse than a stop that was
    already justified while the session lived."""
    from core.session import reap_once

    _, delivery = _stale_session("stale-silent-device", None)

    asyncio.run(reap_once())

    delivery.stop.assert_awaited_once()


def test_reap_once_survives_a_device_that_errors_on_the_uri_lookup():
    from unittest.mock import AsyncMock

    from core.session import reap_once

    _, delivery = _stale_session("stale-uri-error", None)
    delivery.current_uri = AsyncMock(side_effect=RuntimeError("device unreachable"))

    asyncio.run(reap_once())  # must not raise

    delivery.stop.assert_awaited_once()  # unknown counts as ours


def test_reap_once_still_reaps_a_session_whose_delivery_wont_stop():
    from unittest.mock import AsyncMock

    from core.session import reap_once, registry

    _, delivery = _stale_session("stale-unresponsive", None)
    delivery.stop = AsyncMock(side_effect=RuntimeError("device unreachable"))

    reaped = asyncio.run(reap_once())  # must not raise

    assert reaped == ["stale-unresponsive"]
    assert registry.get("stale-unresponsive") is None


def test_device_is_still_ours_compares_against_the_station_url_for_radio():
    """Radio never goes through our own /stream — the station URL is what
    was handed to the device, so that's what its answer has to match."""
    from core.session import _device_is_still_ours

    session, _ = _stale_session("radio-session", "http://radio/stream")
    session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}

    assert asyncio.run(_device_is_still_ours(session)) is True


async def test_reap_stale_sessions_calls_reap_once_after_the_interval():
    from unittest.mock import AsyncMock, patch

    from core.session import reap_stale_sessions

    with (
        patch("core.session.asyncio.sleep", side_effect=[None, asyncio.CancelledError()]),
        patch("core.session.reap_once", new=AsyncMock()) as reap_once_mock,
    ):
        task = asyncio.create_task(reap_stale_sessions())
        try:
            await task
        except asyncio.CancelledError:
            pass

    reap_once_mock.assert_awaited_once()


# ── radio metadata watch lifecycle ──────────────────────────────────────────


async def _hang_forever(url, on_title_change):
    """Stands in for core.icy_metadata.watch() — a real one only ever
    returns when cancelled or when the station has nothing more to say
    (see that module's own tests), neither of which these lifecycle tests
    care about; they only care whether SessionState starts/cancels the
    right task."""
    await asyncio.sleep(3600)


def test_start_radio_metadata_watch_starts_a_cancellable_background_task():
    from unittest.mock import patch

    from core.session import SessionState

    async def run():
        session = SessionState("s")
        with patch("core.session.icy_metadata.watch", new=_hang_forever):
            session.start_radio_metadata_watch("http://station/a")
            assert session._radio_metadata_task is not None
            assert not session._radio_metadata_task.done()

    asyncio.run(run())


def test_start_radio_metadata_watch_is_a_no_op_for_the_same_url():
    """See its own docstring - a casting client's periodic /play-url
    retries must not restart (and so briefly drop) the watch every time."""
    from unittest.mock import patch

    from core.session import SessionState

    async def run():
        session = SessionState("s")
        with patch("core.session.icy_metadata.watch", new=_hang_forever):
            session.start_radio_metadata_watch("http://station/a")
            first_task = session._radio_metadata_task
            session.start_radio_metadata_watch("http://station/a")
            assert session._radio_metadata_task is first_task

    asyncio.run(run())


def test_start_radio_metadata_watch_retries_a_task_that_already_finished():
    """A station with no ICY support returns for good on its own (see
    icy_metadata.watch()'s own docstring) - correctly never restarted for
    that same, still-uninteresting URL. A task that instead died from an
    unexpected exception looks identical from here (also done()), and must
    not be mistaken for "still running" and left dead forever."""
    from unittest.mock import patch

    from core.session import SessionState

    async def already_done(url, on_title_change):
        return

    async def run():
        session = SessionState("s")
        with patch("core.session.icy_metadata.watch", new=already_done):
            session.start_radio_metadata_watch("http://station/a")
            await asyncio.sleep(0)  # let the task actually finish
            first_task = session._radio_metadata_task
            assert first_task.done()

            session.start_radio_metadata_watch("http://station/a")

            assert session._radio_metadata_task is not first_task

    asyncio.run(run())


def test_start_radio_metadata_watch_restarts_for_a_different_url():
    from unittest.mock import patch

    from core.session import SessionState

    async def run():
        session = SessionState("s")
        with patch("core.session.icy_metadata.watch", new=_hang_forever):
            session.start_radio_metadata_watch("http://station/a")
            first_task = session._radio_metadata_task
            session.start_radio_metadata_watch("http://station/b")
            assert session._radio_metadata_task is not first_task
            assert first_task.cancelled() or first_task.cancelling()

    asyncio.run(run())


def test_stop_radio_metadata_watch_cancels_the_task_and_clears_the_title():
    from unittest.mock import patch

    from core.session import SessionState

    async def run():
        session = SessionState("s")
        with patch("core.session.icy_metadata.watch", new=_hang_forever):
            session.start_radio_metadata_watch("http://station/a")
            session._set_radio_title("Artist - Track")
            task = session._radio_metadata_task

            session.stop_radio_metadata_watch()

            assert session.radio_title is None
            assert session._radio_metadata_task is None
            assert task.cancelled() or task.cancelling()

    asyncio.run(run())


def test_stop_radio_metadata_watch_is_a_harmless_no_op_when_nothing_is_running():
    from core.session import SessionState

    session = SessionState("s")
    session.stop_radio_metadata_watch()  # must not raise
    assert session.radio_title is None


def test_reap_once_cancels_a_running_radio_metadata_watch():
    from unittest.mock import patch

    from core.session import reap_once, registry

    session, _ = _stale_session("stale-radio", None)

    async def run():
        with patch("core.session.icy_metadata.watch", new=_hang_forever):
            session.start_radio_metadata_watch("http://station/a")
            task = session._radio_metadata_task

            await reap_once()

            assert registry.get("stale-radio") is None
            assert task.cancelled() or task.cancelling()

    asyncio.run(run())


# ── track_label ────────────────────────────────────────────────────────────────


def test_track_label_formats_artist_and_title(default_session):
    from core.session import track_label

    default_session.state.current_track = Track("1", "Song Title", "Artist Name", 200, "")

    assert track_label(default_session) == "Artist Name - Song Title"


def test_track_label_omits_dash_when_no_artist(default_session):
    from core.session import track_label

    default_session.state.current_track = Track("1", "Song Title", "", 200, "")

    assert track_label(default_session) == "Song Title"


def test_track_label_uses_radio_title_when_no_track(default_session):
    from core.session import track_label

    default_session.state.radio_info = {"title": "Radio FM", "url": "http://stream"}

    assert track_label(default_session) == "Radio FM"


def test_track_label_none_when_nothing_playing(default_session):
    from core.session import track_label

    assert track_label(default_session) is None
