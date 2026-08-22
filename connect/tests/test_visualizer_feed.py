"""Tests for core/visualizer_feed.py — *when* the cast visualizer's analysis
runs, which is the entire job of that module. The analysis itself (decode,
FFT, pacing) is core/audio_analysis.py's and covered by
test_audio_analysis.py; AudioAnalyzer is patched out here so no ffmpeg
process is ever spawned, and what's asserted is which analyzers get created,
with what source/position, and when they get torn down again.

The behavior these exist for: analysis used to start unconditionally for
every cast, whether or not anybody had the visualizer open — a second ffmpeg
plus ~43 FFTs/s per stream, producing frames nothing consumed."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.state import TEST_TONE_TRACK_ID
from core.visualizer_feed import VisualizerFeed
from delivery import AirPlayDelivery, SonosDelivery
from media.base import Track


def _track(track_id: str = "track-1") -> Track:
    return Track(
        id=track_id,
        title="Toccata",
        artist="OVERWERK",
        album="Adventures",
        duration=411,
        cover_art_id="cover-1",
    )


@pytest.fixture
def casting_session(default_session):
    """A session mid-cast to a Sonos speaker, 30s into a track — the state a
    visualizer opening mid-playback actually finds."""
    st = default_session.state
    st.current_track = _track()
    st.is_streaming = True
    st.active_delivery = SonosDelivery("Küche")
    st.clock.start(0.0)
    st.clock.play_start_time -= 30.0  # 30s in
    default_session.media.get_stream_url = MagicMock(return_value="http://nav/stream/track-1")
    return default_session


@pytest.fixture(autouse=True)
def _fast_supervisor():
    """The supervisor's own re-check interval, shortened so the tests that
    exercise a *silently* changed state (one whose handler doesn't notify(),
    i.e. everything except /stop) don't have to wait out the real one."""
    with patch("core.visualizer_feed._SUPERVISE_INTERVAL", 0.01):
        yield


@pytest.fixture
def fake_analyzer():
    """Stands in for AudioAnalyzer — records construction arguments so the
    source URL and start position each run is created with are assertable,
    without a real decoder behind them."""
    created = []

    def _make(**kwargs):
        analyzer = MagicMock()
        analyzer.kwargs = kwargs
        analyzer.start = AsyncMock()
        analyzer.stop = AsyncMock()
        created.append(analyzer)
        return analyzer

    with patch("core.visualizer_feed.AudioAnalyzer", side_effect=_make):
        yield created


async def _settle(feed: VisualizerFeed) -> None:
    """Let the supervisor notice and finish reconciling. Long enough for a
    few of its (shortened, see _fast_supervisor) re-check intervals, since
    most of what these tests change is exactly the kind of state it only
    finds by looking rather than by being told."""
    await asyncio.sleep(0.06)


# ── nothing runs while nobody is watching ────────────────────────────────────


async def test_no_analysis_without_a_subscriber(casting_session, fake_analyzer):
    """The whole point: a cast with nobody watching decodes nothing."""
    await _settle(casting_session.visualizer)

    assert fake_analyzer == []
    assert casting_session.visualizer.analyzer is None
    assert casting_session.visualizer._task is None


async def test_subscribing_starts_analysis_of_what_is_playing(casting_session, fake_analyzer):
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert len(fake_analyzer) == 1
        assert feed.analyzer is fake_analyzer[0]
        fake_analyzer[0].start.assert_awaited_once()
        assert fake_analyzer[0].kwargs["source_url"] == "http://nav/stream/track-1"
    finally:
        await feed.shutdown()


async def test_analysis_starts_at_the_current_playback_position(casting_session, fake_analyzer):
    """A visualizer opened mid-track must pick playback up where it is —
    the decoder seeks there, which is what makes starting late possible at
    all (see core/audio_analysis.py's module docstring)."""
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert fake_analyzer[0].kwargs["start_offset"] == pytest.approx(30.0, abs=1.0)
    finally:
        await feed.shutdown()


async def test_analysis_carries_the_streams_replaygain(casting_session, fake_analyzer):
    casting_session.state.current_track_gain = 0.6
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert fake_analyzer[0].kwargs["gain"] == 0.6
    finally:
        await feed.shutdown()


async def test_the_last_unsubscriber_stops_analysis(casting_session, fake_analyzer):
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    analyzer = feed.analyzer

    feed.unsubscribe()
    await _settle(feed)

    analyzer.stop.assert_awaited_once()
    assert feed.analyzer is None
    # No supervisor left running either, once there's nothing to supervise.
    assert feed._task is None


async def test_analysis_survives_one_of_two_watchers_leaving(casting_session, fake_analyzer):
    feed = casting_session.visualizer
    feed.subscribe()
    feed.subscribe()
    await _settle(feed)
    analyzer = feed.analyzer

    feed.unsubscribe()
    await _settle(feed)
    try:
        analyzer.stop.assert_not_awaited()
        assert feed.analyzer is analyzer
        assert len(fake_analyzer) == 1  # not restarted either
    finally:
        await feed.shutdown()


# ── what is analyzed follows what is playing ─────────────────────────────────


async def test_a_track_change_restarts_analysis_for_the_new_track(casting_session, fake_analyzer):
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    first = feed.analyzer

    st = casting_session.state
    st.current_track = _track("track-2")
    st.clock.start(0.0)
    casting_session.media.get_stream_url = MagicMock(return_value="http://nav/stream/track-2")
    await _settle(feed)
    try:
        first.stop.assert_awaited_once()
        assert len(fake_analyzer) == 2
        assert feed.analyzer is fake_analyzer[1]
        assert fake_analyzer[1].kwargs["source_url"] == "http://nav/stream/track-2"
    finally:
        await feed.shutdown()


async def test_a_seek_restarts_analysis_at_the_new_position(casting_session, fake_analyzer):
    """Same track, different position — play_generation is what catches
    this (and /resume, which moves playback the same way). Without the
    restart, the running decoder would keep producing frames for the
    position the track *was* at."""
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    first = feed.analyzer

    casting_session.state.clock.seek_to(180.0)
    await _settle(feed)
    try:
        first.stop.assert_awaited_once()
        assert len(fake_analyzer) == 2
        assert fake_analyzer[1].kwargs["start_offset"] == pytest.approx(180.0, abs=1.0)
    finally:
        await feed.shutdown()


async def test_playback_stopping_stops_analysis(casting_session, fake_analyzer):
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    analyzer = feed.analyzer

    casting_session.state.is_streaming = False  # what routes/playback.py's /stop sets
    await _settle(feed)
    try:
        analyzer.stop.assert_awaited_once()
        assert feed.analyzer is None
    finally:
        await feed.shutdown()


async def test_analysis_starts_once_playback_does_for_an_already_open_visualizer(
    casting_session, fake_analyzer
):
    """The visualizer can be open before anything plays — nothing to analyze
    yet isn't the same as nothing to analyze ever."""
    casting_session.state.is_streaming = False
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    assert fake_analyzer == []

    casting_session.state.is_streaming = True
    await _settle(feed)
    try:
        assert len(fake_analyzer) == 1
    finally:
        await feed.shutdown()


# ── what can't be analyzed ───────────────────────────────────────────────────


async def test_no_analysis_for_an_airplay_target(casting_session, fake_analyzer):
    """See core/audio_analysis.py's module docstring: AirPlay's position is
    an estimate rather than something calibrated against the device, so
    frames couldn't be released at the right moment anyway."""
    casting_session.state.active_delivery = AirPlayDelivery("Wohnzimmer")
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert fake_analyzer == []
    finally:
        await feed.shutdown()


async def test_no_analysis_for_radio(casting_session, fake_analyzer):
    """A station URL plays straight on the device with no track behind it
    (routes/playback.py's /play-url) — nothing to seek into."""
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert fake_analyzer == []
    finally:
        await feed.shutdown()


async def test_the_test_tone_is_fetched_from_loopback(casting_session, fake_analyzer):
    """routes/debug.py's synthesized tone isn't a library track — resolving
    its id against the media server would fail. It exists to check the
    visualizer's own timing, so it has to reach this path (see that
    module's docstring)."""
    casting_session.state.current_track = _track(TEST_TONE_TRACK_ID)
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert "127.0.0.1" in fake_analyzer[0].kwargs["source_url"]
        casting_session.media.get_stream_url.assert_not_called()
    finally:
        await feed.shutdown()


async def test_a_failing_url_lookup_is_logged_and_leaves_no_analyzer(
    casting_session, fake_analyzer, caplog
):
    """A media server that's briefly unreachable must not take the
    supervisor down with it — the next tick tries again."""
    casting_session.media.get_stream_url = MagicMock(side_effect=RuntimeError("no route"))
    feed = casting_session.visualizer
    feed.subscribe()
    with caplog.at_level("WARNING", logger="connect.visualizer"):
        await _settle(feed)
    try:
        assert fake_analyzer == []
        assert feed.analyzer is None
        assert "Could not resolve" in caplog.text
        assert not feed._task.done()
    finally:
        await feed.shutdown()


async def test_a_track_change_during_url_resolution_discards_the_stale_start(
    casting_session, fake_analyzer
):
    """Resolving a track id is a real network round-trip for Plex. If
    playback has moved on by the time it returns, starting that analyzer
    would decode from a position nothing is playing at any more."""
    st = casting_session.state
    looked_up = []

    def _lookup(track_id):
        if not looked_up:  # playback moves on while the first lookup runs
            st.current_track = _track("track-2")
            st.clock.start(0.0)
        looked_up.append(track_id)
        return f"http://nav/stream/{track_id}"

    casting_session.media.get_stream_url = MagicMock(side_effect=_lookup)
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        # The stale one never started; the supervisor's next pass picks up
        # the track that's actually playing.
        assert looked_up == ["track-1", "track-2"]
        assert [a.kwargs["source_url"] for a in fake_analyzer] == ["http://nav/stream/track-2"]
        assert feed.analyzer is fake_analyzer[0]
        assert feed._key == (st.clock.play_generation, "track-2")
    finally:
        await feed.shutdown()


# ── teardown ─────────────────────────────────────────────────────────────────


async def test_shutdown_stops_analysis_and_the_supervisor(casting_session, fake_analyzer):
    """A session being reaped (core/session.py's reap_once()) takes its
    decoder and supervisor task with it, subscribers or not."""
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    analyzer = feed.analyzer

    await feed.shutdown()
    await _settle(feed)

    analyzer.stop.assert_awaited_once()
    assert feed.analyzer is None
    assert feed._task is None


async def test_unsubscribing_below_zero_cannot_strand_a_running_analyzer(
    casting_session, fake_analyzer
):
    feed = casting_session.visualizer
    feed.unsubscribe()
    feed.unsubscribe()
    feed.subscribe()
    await _settle(feed)
    try:
        assert feed._subscribers == 1
        assert feed.analyzer is fake_analyzer[0]
    finally:
        await feed.shutdown()
