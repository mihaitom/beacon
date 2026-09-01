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
from core.visualizer_feed import _ASSUMED_DEVICE_LEAD_SECONDS, VisualizerFeed, _FirstByteClock
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


async def test_subscribing_starts_analysis_of_an_airplay_target(casting_session, fake_analyzer):
    """AirPlay used to be excluded here (its position is a fixed estimate,
    not something calibrated against the device) — see
    core/audio_analysis.py's module docstring for why that no longer rules
    it out: this module decodes the source itself and never taps the bytes
    actually going to the device, so the estimate only has to be good
    enough to seek a fresh decoder to roughly the right spot."""
    casting_session.state.active_delivery = AirPlayDelivery("Wohnzimmer")
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert len(fake_analyzer) == 1
        assert feed.analyzer is fake_analyzer[0]
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


# ── _FirstByteClock — radio's elapsed_fn ────────────────────────────────────
# Regression coverage for two real bugs found live 2026-09-01: zeroing at
# construction (attach time) instead of the first actual byte made every
# frame permanently "late" and get dropped (a visualizer stuck at ~0.5fps);
# and zero lead at all read as playing ahead of the audio actually coming
# out of the speaker ("massiv out of sync"), once the first bug stopped
# hiding it.


class _FakeSource:
    def __init__(self, chunks: list[bytes]):
        self._chunks = list(chunks)

    async def read(self, n: int) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""


class TestFirstByteClock:
    def test_elapsed_is_zero_before_any_read_at_all(self):
        clock = _FirstByteClock()
        assert clock.elapsed() == 0.0

    async def test_empty_reads_do_not_start_the_clock(self):
        clock = _FirstByteClock()
        source = clock.wrap(_FakeSource([b"", b"", b""]))

        for _ in range(3):
            assert await source.read(4096) == b""
        assert clock.elapsed() == 0.0

    async def test_zeroes_on_the_first_non_empty_read_not_on_construction(self):
        # Construction happens well before anything is actually read (a
        # stand-in for the relay's own fetch/demux/ffmpeg/queue latency) —
        # elapsed() must count from the read, not from construction, which
        # never calls time.monotonic() at all (see _FirstByteClock.__init__).
        clock = _FirstByteClock()  # no monotonic() call yet
        times = iter([104.0, 106.0 + _ASSUMED_DEVICE_LEAD_SECONDS])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            source = clock.wrap(_FakeSource([b"real-data"]))
            assert await source.read(4096) == b"real-data"  # marks at t=104

            assert clock.elapsed() == pytest.approx(2.0)

    async def test_only_the_first_read_marks_the_clock(self):
        # mark() itself only calls time.monotonic() once — the guard that
        # makes the second read a no-op short-circuits before it would call
        # it again, so this sequence has one entry per *actual* call, not
        # one per read.
        times = iter([101.0, 101.0 + _ASSUMED_DEVICE_LEAD_SECONDS])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            clock = _FirstByteClock()
            source = clock.wrap(_FakeSource([b"first", b"second"]))
            await source.read(4096)  # marks at t=101
            await source.read(4096)  # must NOT re-mark

            assert clock.elapsed() == pytest.approx(0.0)

    async def test_clamps_at_zero_rather_than_going_negative(self):
        # Real time hasn't advanced past the assumed device lead yet —
        # elapsed() must read 0, not a negative "already playing" value.
        times = iter([100.0, 100.5])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            clock = _FirstByteClock()
            source = clock.wrap(_FakeSource([b"data"]))
            await source.read(4096)

            assert clock.elapsed() == 0.0


# ── radio, routed through core/radio_relay.py's shared relay ───────────────


class _FakeRelay:
    """subscribe_pcm()/unsubscribe_pcm() — see core/radio_relay.py's
    PcmSubscription. A subscription is always available immediately (no
    "not ready yet" state to fake here): the relay hands out a queue-backed
    subscription the moment it's asked, whether or not its ffmpeg has
    started producing bytes into it yet — the analyzer just blocks on its
    first read() until real data arrives, same as it would for a real,
    momentarily-quiet pipe."""

    def __init__(self, url: str, pcm_subscription=None):
        self.url = url
        self._pcm_subscription = pcm_subscription if pcm_subscription is not None else object()
        self.unsubscribed_pcm: list[object] = []

    def subscribe_pcm(self):
        return self._pcm_subscription

    def unsubscribe_pcm(self, subscription):
        self.unsubscribed_pcm.append(subscription)


async def test_analysis_starts_for_relayed_radio(casting_session, fake_analyzer):
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    pcm_subscription = object()
    casting_session.radio_relay = _FakeRelay(
        "http://radio/stream", pcm_subscription=pcm_subscription
    )
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert len(fake_analyzer) == 1
        # Wrapped in a _FirstByteClock-backed source, not handed straight
        # through — see that class's own docstring for why the clock has
        # to zero on the first real read rather than on attach.
        pcm_source = fake_analyzer[0].kwargs["pcm_source"]
        assert pcm_source._source is pcm_subscription
        # No track to decode a second time — this is the one thing that
        # tells AudioAnalyzer.start() to read from pcm_source instead of
        # spawning its own ffmpeg (see its own docstring).
        assert fake_analyzer[0].kwargs.get("source_url", "") == ""
    finally:
        await feed.shutdown()


async def test_relayed_radio_wires_a_cleanup_that_unsubscribes_from_the_relay(
    casting_session, fake_analyzer
):
    """AudioAnalyzer's cleanup callback (see its own `cleanup` parameter,
    invoked once at the end of a real stop()) is how the relay learns this
    analyzer is gone — without it, a left-behind subscription queue would
    sit in RadioRelay._pcm_subscribers forever, quietly leaking one per
    analyzer restart (track/station change, subscriber churn) for the life
    of the session. fake_analyzer replaces AudioAnalyzer itself (its real
    stop() has its own direct test in test_audio_analysis.py), so this
    checks the callback visualizer_feed.py hands it is the right one by
    invoking it directly, the way a real stop() would."""
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    relay = _FakeRelay("http://radio/stream")
    casting_session.radio_relay = relay
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    assert relay.unsubscribed_pcm == []

    fake_analyzer[0].kwargs["cleanup"]()

    assert relay.unsubscribed_pcm == [relay._pcm_subscription]
    await feed.shutdown()


async def test_relayed_radio_still_respects_the_deliverable_target_types_gate(
    casting_session, fake_analyzer
):
    """should_analyze() (device-type gating) still applies to a relayed
    station — being relayed doesn't make every delivery type analyzable.
    No active delivery at all is the simplest way to fail that gate (same
    as test_should_analyze_false_for_no_targets at the pure-function
    level, exercised here through the actual VisualizerFeed gate)."""
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    casting_session.radio_relay = _FakeRelay("http://radio/stream")
    casting_session.state.active_delivery = None
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert fake_analyzer == []
    finally:
        await feed.shutdown()


async def test_a_relayed_radio_analyzer_stops_when_playback_stops(casting_session, fake_analyzer):
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    casting_session.radio_relay = _FakeRelay("http://radio/stream")
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    assert len(fake_analyzer) == 1

    casting_session.state.is_streaming = False
    feed.notify()
    await _settle(feed)
    try:
        fake_analyzer[0].stop.assert_awaited_once()
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
