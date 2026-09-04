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

from core import visualizer_feed
from core.state import TEST_TONE_TRACK_ID
from core.visualizer_feed import (
    ASSUMED_DEVICE_LEAD_SECONDS,
    VisualizerFeed,
    _FirstByteClock,
    _OffsetTrackerClock,
)
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


async def test_track_analyzer_passes_the_general_clock_as_the_debug_cast_elapsed_fn(
    casting_session, fake_analyzer
):
    """GET /visualizer's debug overlay isn't radio-only — see core/audio_
    analysis.py's AudioAnalyzer docstring for why a track still benefits
    from this even though elapsed_fn is already the same function: it
    still surfaces a real backlog in this analyzer's own release pipeline,
    or in SSE/render delivery, that content_position vs. a *live* re-read
    of the same clock would otherwise hide. Reported live 2026-09-05: the
    listener wanting it available for track casts, not just Sonos radio."""
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        debug_cast_elapsed_fn = fake_analyzer[0].kwargs["debug_cast_elapsed_fn"]
        assert debug_cast_elapsed_fn() == pytest.approx(
            casting_session.state.clock.elapsed(), abs=0.05
        )
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


def test_assumed_device_lead_matches_the_measured_sonos_value():
    """Not a behavior test — every test below reads the constant
    symbolically and would pass regardless of its value. A tripwire
    instead, so an edit that quietly drifts this back toward the old,
    unverified 3.0s guess (see the constant's own history — it went stale
    the moment a *relayed* Sonos became this class's common case again,
    2026-09-04) doesn't go unnoticed: this is the value
    scripts/icy_sync_probe.py actually measured against real Sonos
    hardware on the x-rincon-mp3radio:// dispatch delivery/sonos.py now
    uses for that case."""
    assert ASSUMED_DEVICE_LEAD_SECONDS == 4.7


class _LagHolder:
    """Stands in for the session — _FirstByteClock only ever reads
    radio_icy_measured_lag off it (see that class's own docstring for why
    it's read fresh on every elapsed() call rather than captured once)."""

    def __init__(self, lag: float | None = None) -> None:
        self.radio_icy_measured_lag = lag


class TestFirstByteClock:
    def test_elapsed_is_zero_before_any_read_at_all(self):
        clock = _FirstByteClock(_LagHolder())
        assert clock.elapsed() == 0.0

    def test_zeroes_on_mark_not_on_construction(self):
        # Construction happens well before this run's first PCM byte is
        # actually decoded (a stand-in for this analyzer's own ffmpeg
        # connect/first-response latency) — elapsed() must count from
        # mark(), not from construction, which never calls
        # time.monotonic() at all (see _FirstByteClock.__init__).
        clock = _FirstByteClock(_LagHolder())  # no monotonic() call yet
        times = iter([104.0, 106.0 + ASSUMED_DEVICE_LEAD_SECONDS])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            clock.mark()  # marks at t=104

            assert clock.elapsed() == pytest.approx(2.0)

    def test_only_the_first_mark_takes_effect(self):
        # mark() itself only calls time.monotonic() once — the guard that
        # makes a later call a no-op short-circuits before it would call it
        # again, so this sequence has one entry per *actual* call, not one
        # per mark().
        times = iter([101.0, 101.0 + ASSUMED_DEVICE_LEAD_SECONDS])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            clock = _FirstByteClock(_LagHolder())
            clock.mark()  # marks at t=101
            clock.mark()  # must NOT re-mark

            assert clock.elapsed() == pytest.approx(0.0)

    def test_the_measured_icy_lag_does_not_steer_this_clock(self):
        """Retracted after measuring it. Four consecutive runs against a
        real Sonos on 2026-09-05 gave 16.63s, 3.48s, 3.01s and 1.43s for the
        same setup, a station restart moved it again, and the uncalibrated
        fixed estimate stayed the closest match by ear throughout — so a
        measurement sitting on the session must not pull the lead around."""
        holder = _LagHolder(lag=2.0)
        times = iter([100.0, 106.0])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            clock = _FirstByteClock(holder)
            clock.mark()  # marks at t=100

            # 6s of wall time minus the fixed 4.7s estimate, not the 2.0s
            # sitting in radio_icy_measured_lag.
            assert clock.elapsed() == pytest.approx(6.0 - ASSUMED_DEVICE_LEAD_SECONDS)

    def test_a_lag_landing_mid_run_does_not_move_the_clock(self):
        """The failure mode this prevents is specifically a *drifting* one:
        every ICY sample comes out below the real figure (a device reports a
        title once decoded, which is earlier than played), so the
        session-wide minimum sinks as more samples arrive. Following it made
        the sync worse the longer a station played."""
        holder = _LagHolder(lag=None)
        times = iter([100.0, 103.0, 106.0])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            clock = _FirstByteClock(holder)
            clock.mark()  # marks at t=100
            assert clock.elapsed() == pytest.approx(max(0.0, 3.0 - ASSUMED_DEVICE_LEAD_SECONDS))

            holder.radio_icy_measured_lag = 1.5
            # Same clock, same run — and the same lead as before.
            assert clock.elapsed() == pytest.approx(6.0 - ASSUMED_DEVICE_LEAD_SECONDS)

    def test_the_correction_shifts_the_fixed_estimate(self):
        """What is left to calibrate with, now that the measurement is out
        of the loop — see first_byte_lead_correction()."""
        monkey = pytest.MonkeyPatch()
        monkey.setenv(visualizer_feed.FIRST_BYTE_LEAD_CORRECTION_ENV, "0.8")
        times = iter([100.0, 106.0])
        try:
            with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
                clock = _FirstByteClock(_LagHolder(lag=None))
                clock.mark()
                assert clock.elapsed() == pytest.approx(6.0 - (ASSUMED_DEVICE_LEAD_SECONDS + 0.8))
        finally:
            monkey.undo()

    def test_debug_lead_reports_the_fixed_guess_when_nothing_is_measured(self):
        clock = _FirstByteClock(_LagHolder(lag=None))
        assert clock.debug_lead() == (ASSUMED_DEVICE_LEAD_SECONDS, False)

    def test_debug_lead_reports_the_estimate_even_when_a_measurement_exists(self):
        """The overlay has to name the lead the clock is *using*. Reporting
        a measurement that no longer steers anything would send whoever
        reads it looking for a cause in the wrong place — which is the one
        job this overlay has."""
        clock = _FirstByteClock(_LagHolder(lag=2.31))
        assert clock.debug_lead() == (ASSUMED_DEVICE_LEAD_SECONDS, False)

    def test_the_fixed_guess_is_not_given_the_output_latency_twice(self):
        """ASSUMED_DEVICE_LEAD_SECONDS was itself calibrated by ear against
        real audio, so the output stage is already inside it. Adding
        first_byte_lead_correction() on top would double-count it — and that is
        an easy mistake to make when wiring a correction into both
        branches."""
        clock = _FirstByteClock(_LagHolder(lag=None))
        assert clock.debug_lead() == (ASSUMED_DEVICE_LEAD_SECONDS, False)


class TestLeadCorrections:
    """See core/visualizer_feed.py's _LEAD_CORRECTION_DEFAULT — one value per
    clock, because the error was observed to track the code path rather than
    the device: Chromecast and DLNA (both _OffsetTrackerClock) behaved alike
    and unlike Sonos (_FirstByteClock)."""

    def test_both_default_to_no_correction(self, monkeypatch):
        """A retraction, not an oversight. The first figure measured this
        way came from a beep station whose beeps were all the same pitch,
        which cannot tell "early" from "a whole interval late" — so it was
        never a measurement, and defaulting to it would bake a guess into
        every install."""
        monkeypatch.delenv(visualizer_feed.FIRST_BYTE_LEAD_CORRECTION_ENV, raising=False)
        monkeypatch.delenv(visualizer_feed.TRACKER_LEAD_CORRECTION_ENV, raising=False)
        assert visualizer_feed.first_byte_lead_correction() == 0.0
        assert visualizer_feed.tracker_lead_correction() == 0.0

    def test_each_path_is_configured_independently(self, monkeypatch):
        """One shared number would only ever be right for one of the two."""
        monkeypatch.setenv(visualizer_feed.FIRST_BYTE_LEAD_CORRECTION_ENV, "1.2")
        monkeypatch.setenv(visualizer_feed.TRACKER_LEAD_CORRECTION_ENV, "0.4")
        assert visualizer_feed.first_byte_lead_correction() == pytest.approx(1.2)
        assert visualizer_feed.tracker_lead_correction() == pytest.approx(0.4)

    def test_a_negative_correction_is_allowed(self, monkeypatch):
        """The direction isn't known in advance — a clock running *late*
        needs its lead reduced, and refusing that would make half the
        calibration range unreachable."""
        monkeypatch.setenv(visualizer_feed.TRACKER_LEAD_CORRECTION_ENV, "-0.8")
        assert visualizer_feed.tracker_lead_correction() == pytest.approx(-0.8)

    def test_a_non_numeric_value_falls_back_instead_of_raising(self, monkeypatch):
        """A calibration aid must not be able to take radio casting down
        with it over a typo."""
        monkeypatch.setenv(visualizer_feed.FIRST_BYTE_LEAD_CORRECTION_ENV, "about a second")
        assert visualizer_feed.first_byte_lead_correction() == 0.0

    def test_clamps_at_zero_rather_than_going_negative(self):
        # Real time hasn't advanced past the assumed device lead yet —
        # elapsed() must read 0, not a negative "already playing" value.
        times = iter([100.0, 100.5])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            clock = _FirstByteClock(_LagHolder())
            clock.mark()

            assert clock.elapsed() == 0.0


# ── _OffsetTrackerClock — radio's elapsed_fn when RadioPositionTracker is
# available (Chromecast/DLNA/Sonos) ─────────────────────────────────────────
# Regression coverage for a real bug found live 2026-09-02, right after
# fixing the one above it (an unrelated offset bug that made every frame
# read as permanently late — see _start_radio_analyzer()'s own comment):
# the raw, offset-corrected tracker value only actually changes once per
# RadioPositionTracker poll (~every 0.5s), so without smoothing,
# _release_frames() only ever found a frame due right at that instant —
# capping the effective frame rate at roughly the poll rate (~2fps
# observed) instead of the ~43fps this is sized for.


class _FakeTracker:
    def __init__(
        self, position: float = 0.0, ready: bool = False, lag: float | None = None
    ) -> None:
        self.position = position
        self.ready = ready
        # None by default — every existing test below constructs a tracker
        # this way and must keep seeing the pre-buffer_lag() behaviour
        # unchanged; only TestOffsetTrackerClockBufferLag sets this.
        self._lag = lag
        # Lets TestOffsetTrackerClockBufferLag.test_lag_is_applied_only_once
        # assert this was queried exactly once, without depending on the
        # numeric interplay between the fold and the extrapolation smoothing.
        self.buffer_lag_calls = 0

    def elapsed_fn(self) -> float:
        return self.position

    def buffer_lag(self) -> float | None:
        # Mirrors core/radio_position.py's own gate — RadioPositionTracker.
        # buffer_lag() also returns None until `ready`.
        self.buffer_lag_calls += 1
        return self._lag if self.ready else None


class _TrackerHolder:
    """Stands in for the session, whose radio_position_tracker the clock
    follows rather than pinning one at construction — /play-url replaces it
    on every dispatch."""

    def __init__(self, tracker: _FakeTracker | None) -> None:
        self.radio_position_tracker = tracker


class TestOffsetTrackerClock:
    def test_subtracts_the_baseline_captured_on_the_first_decoded_byte(self):
        tracker = _FakeTracker(position=60.0)
        clock = _OffsetTrackerClock(_TrackerHolder(tracker))
        clock.mark()

        assert clock.elapsed() == 0.0

    def test_reads_zero_until_the_first_byte_is_marked(self):
        """The baseline is deliberately not taken at construction: spawning
        ffmpeg and it producing its first decoded byte are seconds apart on
        a cast station, and the tracker climbs the whole time. Charging
        that gap to content time left every frame of the run that far ahead
        of the device — reported live 2026-09-03 alongside the second-fetch
        problem, and the half of it that no change of source can fix."""
        tracker = _FakeTracker(position=60.0)
        clock = _OffsetTrackerClock(_TrackerHolder(tracker))

        assert clock.elapsed() == 0.0
        tracker.position = 62.0  # 2s of ffmpeg startup, still nothing decoded
        assert clock.elapsed() == 0.0

        clock.mark()
        assert clock.elapsed() == 0.0  # content_position 0 is *now*
        tracker.position = 64.0
        assert clock.elapsed() == pytest.approx(2.0)

    def test_does_not_extrapolate_before_ready(self):
        """The device may still be sitting in its own startup stall — see
        core/radio_position.py's own RadioPositionTracker.elapsed_fn() for
        why extrapolating through that would grow a number with nothing
        real behind it. A raw, unsmoothed step is what this returns
        instead, until `ready` says the device is genuinely moving."""
        tracker = _FakeTracker(position=0.0, ready=False)
        clock = _OffsetTrackerClock(_TrackerHolder(tracker))
        clock.mark()
        times = iter([100.0, 105.0, 110.0])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            assert clock.elapsed() == 0.0
            assert clock.elapsed() == 0.0  # still 0 — no extrapolation yet
            tracker.ready = True
            # Still the same raw value on this call — the switch to ready
            # anchors from here, not from whenever ready secretly became
            # true underneath.
            assert clock.elapsed() == 0.0

    def test_extrapolates_forward_between_polls_once_ready(self):
        tracker = _FakeTracker(position=10.0, ready=True)
        clock = _OffsetTrackerClock(_TrackerHolder(tracker))
        clock.mark()
        times = iter([100.0, 100.2, 100.4])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            assert clock.elapsed() == pytest.approx(0.0)  # anchors at t=100.0
            assert clock.elapsed() == pytest.approx(0.2)  # +0.2s, no new poll yet
            assert clock.elapsed() == pytest.approx(0.4)  # +0.4s, still the same poll

    def test_a_fresh_poll_resets_the_extrapolation_anchor(self):
        """A real device position landing mid-extrapolation must be
        trusted immediately, not blended — matching
        core/radio_position.py's own "held constant, not extrapolated"
        RadioPositionTracker.elapsed_fn() one layer down, this class's own
        raw input."""
        tracker = _FakeTracker(position=10.0, ready=True)
        clock = _OffsetTrackerClock(_TrackerHolder(tracker))
        clock.mark()
        times = iter([100.0, 100.3, 100.3, 100.35])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            assert clock.elapsed() == pytest.approx(0.0)  # anchors at t=100.0
            assert clock.elapsed() == pytest.approx(0.3)  # extrapolated, +0.3s
            tracker.position = 10.6  # a real poll landed: device moved 0.6s
            assert clock.elapsed() == pytest.approx(0.6)  # trusted immediately
            # New anchor is *this* moment (t=100.3), not the old one —
            # +0.05s from here, not +0.05s stacked on the extrapolated 0.6.
            assert clock.elapsed() == pytest.approx(0.65)

    def test_a_lagging_poll_does_not_snap_the_clock_backward(self):
        """The actual bug reported live 2026-09-02: extrapolation running a
        hair ahead of the device's real rate is expected jitter (or just
        the round-trip latency between when a poll landed inside
        RadioPositionTracker and when this class next happens to read it),
        not evidence of a rewind — radio never plays backward. Snapping
        down to a lower freshly-polled value would freeze
        _release_frames() until content_position caught back down to
        match, on top of whatever real gap already existed — seen live as
        the visualizer running fast for a stretch and then freezing for
        0.5-1s, repeating roughly every poll."""
        tracker = _FakeTracker(position=10.0, ready=True)
        clock = _OffsetTrackerClock(_TrackerHolder(tracker))
        clock.mark()
        tracker.position = 10.5
        times = iter([100.0, 100.4])
        with patch("core.visualizer_feed.time.monotonic", side_effect=lambda: next(times)):
            assert clock.elapsed() == pytest.approx(0.5)  # anchors at t=100.0
            # Extrapolated to 0.5 + 0.4 = 0.9 by now — but the device's own
            # fresh poll only shows 0.7 (jitter, not a real rewind). Must
            # not drop back to 0.7.
            tracker.position = 10.7
            assert clock.elapsed() == pytest.approx(0.9)


# ── _OffsetTrackerClock — folding RadioPositionTracker.buffer_lag() into the
# baseline ────────────────────────────────────────────────────────────────
# Regression coverage for the bug found live 2026-09-03/04, after the whole
# radio-visualizer architecture switched to tapping the relay's own device-
# audio fan-out with a private ffmpeg (see core/audio_analysis.py's module
# docstring): the tests above establish that _OffsetTrackerClock's baseline
# subtraction fixes the *absolute-vs-relative* offset problem, but on their
# own they also describe (see e.g. test_reads_zero_until_the_first_byte_is_
# marked's "content_position 0 is *now*") a clock that, algebraically,
# reduces to plain wall-clock time since mark() once a device is playing
# steadily — the device's own startup-buffering delay cancels out of
# `tracker.elapsed_fn() - baseline` instead of surviving it, so every frame
# this clock ever released came out exactly that many seconds ahead of what
# the device was actually playing. Worst on Chromecast (~10-11s of its own
# startup buffer measured live, see core/radio_position.py's module
# docstring), smaller but still audible on DLNA and Sonos.
class TestOffsetTrackerClockBufferLag:
    def test_lag_shifts_the_baseline_once_ready(self):
        tracker = _FakeTracker(position=0.0, ready=False)
        clock = _OffsetTrackerClock(_TrackerHolder(tracker))
        clock.mark()  # baseline = 0.0, device still buffering

        tracker.position = 2.0
        tracker.ready = True
        tracker._lag = 8.0  # this device's own measured startup buffer

        # Without the fix, raw would be max(0, 2.0 - 0.0) = 2.0 here —
        # content already "due" despite the 8s the device is known to have
        # spent buffering before any of it became audible. With the fix,
        # the lag folds into the baseline first: 2.0 - (0.0 + 8.0) clamps
        # to 0.0 — correctly still nothing due, since none of this content
        # is audible yet either.
        assert clock.elapsed() == 0.0

    def test_output_latency_is_folded_in_alongside_the_measured_lag(self):
        """The Chromecast half of the 2026-09-05 report. A polled position
        says where the device's *decoder* is; the output stage after it —
        HDMI hand-off, an amplifier, a TV — reports nothing and is invisible
        to any protocol-level measurement. Reported live: the visualizer ran
        about a second ahead of the audio on Chromecast in the same way it
        did on Sonos, which shares no measurement code with this path at
        all. Two independent methods do not acquire the same bias by
        chance, so the correction belongs here rather than in either
        measurement."""
        tracker = _FakeTracker(position=0.0, ready=False)
        clock = _OffsetTrackerClock(_TrackerHolder(tracker))
        clock.mark()  # baseline = 0.0

        tracker.position = 5.5
        tracker.ready = True
        tracker._lag = 5.0

        # baseline becomes 0.0 + 5.0 + tracker_lead_correction(). With the
        # default of 0 that is 5.5 - 5.0 = 0.5s of content already due.
        assert clock.elapsed() == pytest.approx(0.5)

        # Configured, it shifts the baseline by exactly that much more —
        # 5.5 - (5.0 + 0.5) = 0.0, nothing due yet.
        monkey = pytest.MonkeyPatch()
        monkey.setenv(visualizer_feed.TRACKER_LEAD_CORRECTION_ENV, "0.5")
        try:
            fresh = _OffsetTrackerClock(_TrackerHolder(tracker))
            fresh.mark()
            assert fresh.elapsed() == 0.0
        finally:
            monkey.undo()

    def test_lag_is_applied_only_once(self):
        """A device's own buffering delay is a steady pipeline constant for
        the run (Chromecast's own decode+HDMI pipeline, DLNA's own render
        buffer, Sonos's own buffer over the http:// dispatch delivery/
        sonos.py uses) — not something expected to wander, and re-adding a
        later reading of it would keep compounding onto _baseline forever
        instead of settling once. buffer_lag() itself is only ever queried
        the one time this needs it, not on every elapsed() call."""
        tracker = _FakeTracker(position=10.0, ready=True, lag=8.0)
        clock = _OffsetTrackerClock(_TrackerHolder(tracker))
        clock.mark()

        with patch("core.visualizer_feed.time.monotonic", return_value=100.0):
            clock.elapsed()
        tracker.position = 15.0
        with patch("core.visualizer_feed.time.monotonic", return_value=103.0):
            clock.elapsed()
        tracker.position = 20.0
        with patch("core.visualizer_feed.time.monotonic", return_value=106.0):
            clock.elapsed()

        assert tracker.buffer_lag_calls == 1

    def test_no_lag_measured_yet_behaves_exactly_as_before(self):
        """buffer_lag() reads None until the tracker's own `ready` fires —
        see RadioPositionTracker.buffer_lag(). Nothing here should change
        _OffsetTrackerClock's behaviour before that point; this is the same
        scenario TestOffsetTrackerClock's own tests already cover in more
        detail, stated once more explicitly for this class."""
        tracker = _FakeTracker(position=60.0, ready=False)
        clock = _OffsetTrackerClock(_TrackerHolder(tracker))
        clock.mark()

        assert clock.elapsed() == 0.0
        tracker.position = 64.0
        assert clock.elapsed() == pytest.approx(4.0)

    def test_swapping_trackers_measures_the_new_devices_own_lag(self):
        """A device dropping out of a multi-target radio cast
        (routes/devices.py's device-stop) can hand this clock a different
        RadioPositionTracker without tearing the whole analyzer down — see
        _rebase_if_tracker_changed(). The new device's own buffering delay
        must be measured and folded in independently of whatever the old
        one's was, not inherited from it and not skipped."""
        old_tracker = _FakeTracker(position=10.0, ready=True, lag=8.0)
        holder = _TrackerHolder(old_tracker)
        clock = _OffsetTrackerClock(holder)
        clock.mark()
        assert clock.elapsed() == 0.0  # folds old_tracker's 8.0s lag in

        new_tracker = _FakeTracker(position=1.0, ready=True, lag=2.0)
        holder.radio_position_tracker = new_tracker
        # Continuity carries elapsed() on from wherever it left off on the
        # old tracker; the very next call still folds in the *new*
        # tracker's own, smaller lag rather than keeping the old one or
        # applying none at all.
        assert clock.elapsed() == pytest.approx(0.0)
        assert new_tracker.buffer_lag_calls == 1


class TestIsWatchingRadio:
    """VisualizerFeed.is_watching_radio() — read by
    core/radio_position.py's RadioPositionTracker to decide its own poll
    cadence, see that module's _poll_interval()."""

    def test_false_with_no_analyzer_running(self, default_session):
        assert default_session.visualizer.is_watching_radio() is False

    def test_true_with_a_radio_analyzer_running(self, default_session):
        default_session.visualizer.analyzer = MagicMock()
        default_session.state.current_track = None
        assert default_session.visualizer.is_watching_radio() is True

    def test_false_with_a_track_analyzer_running(self, default_session):
        """An analyzer can be running for a *track* instead of radio — that
        one has nothing to do with RadioPositionTracker at all."""
        default_session.visualizer.analyzer = MagicMock()
        default_session.state.current_track = _track()
        assert default_session.visualizer.is_watching_radio() is False


# ── radio, routed through core/radio_relay.py's shared relay ───────────────


class _FakeRelay:
    """VisualizerFeed's radio branch subscribes to the relay's device-audio
    fan-out and feeds those bytes to its own ffmpeg — the same stream the
    device is being sent, which is what makes a moment of audio mean the
    same thing on both sides. Records subscribe/unsubscribe so a run that
    leaks its subscription is visible."""

    def __init__(self, url: str):
        self.url = url
        self.subscribed: list[asyncio.Queue] = []
        self.released: list[asyncio.Queue] = []
        self.lossy: list[bool] = []

    def subscribe_audio(self, *, lossy: bool = False) -> asyncio.Queue:
        self.lossy.append(lossy)
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        self.subscribed.append(q)
        return q

    def unsubscribe_audio(self, q: asyncio.Queue) -> None:
        self.released.append(q)


async def test_analysis_starts_for_relayed_radio(casting_session, fake_analyzer):
    """Since 2026-09-03: decodes the station a second time with its own
    independent ffmpeg (source_url), the same path a track uses — not a
    tap of the relay's own device-audio output. See core/radio_relay.py's
    own docstring for why that tap was removed: a bug in this analyzer's
    decode/pacing used to be one step away from stalling device audio too,
    since both shared one ffmpeg process."""
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    casting_session.radio_relay = _FakeRelay("http://radio/stream")
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert len(fake_analyzer) == 1
        # Fed from the relay's fan-out, not fetched a second time: a second
        # fetch gets the station's own client-priming burst of already-
        # elapsed audio and lands an unknown distance behind the device.
        relay = casting_session.radio_relay
        assert fake_analyzer[0].kwargs["source_queue"] is relay.subscribed[0]
        assert not fake_analyzer[0].kwargs.get("source_url")
        # Lossy: analysis takes the live edge over a backlog. Working
        # through one decodes at full CPU speed (the lookahead cap only
        # throttles running ahead) and starves the loop device audio is
        # paced on — heard live 2026-09-03 as dropouts on the speaker.
        assert relay.lossy == [True]
        # No content position to seek a fresh decoder to — a station has
        # no track-relative timeline.
        assert fake_analyzer[0].kwargs.get("start_offset", 0.0) == 0.0
    finally:
        await feed.shutdown()


async def test_relayed_radio_falls_back_to_first_byte_clock_with_no_tracker(
    casting_session, fake_analyzer
):
    """No RadioPositionTracker (a target type core/radio_position.py
    doesn't cover) falls back to _FirstByteClock, wired through
    AudioAnalyzer's on_first_byte hook rather than a wrapped PCM source —
    see _FirstByteClock's own docstring for why it has to zero on the
    first decoded byte, not on construction."""
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    casting_session.radio_relay = _FakeRelay("http://radio/stream")
    casting_session.radio_position_tracker = None
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        elapsed_fn = fake_analyzer[0].kwargs["elapsed_fn"]
        on_first_byte = fake_analyzer[0].kwargs["on_first_byte"]
        assert elapsed_fn() == 0.0  # no byte marked yet
        on_first_byte()
        assert elapsed_fn() == pytest.approx(0.0, abs=0.05)
    finally:
        await feed.shutdown()


async def test_relayed_radio_passes_the_general_clock_as_the_debug_cast_elapsed_fn(
    casting_session, fake_analyzer
):
    """GET /visualizer's debug overlay (core/audio_analysis.py's
    AudioAnalyzer.last_release_debug) — radio's own elapsed_fn (whichever
    clock above actually paces this analyzer's delivery) is never itself
    the general session clock, unlike the track case, so there's always a
    second, independent one worth comparing it against here."""
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    casting_session.radio_relay = _FakeRelay("http://radio/stream")
    casting_session.state.clock.start(0.0)
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        debug_cast_elapsed_fn = fake_analyzer[0].kwargs["debug_cast_elapsed_fn"]
        assert debug_cast_elapsed_fn() == pytest.approx(
            casting_session.state.clock.elapsed(), abs=0.05
        )
    finally:
        await feed.shutdown()


async def test_relayed_radio_with_no_tracker_passes_a_debug_lead_fn(casting_session, fake_analyzer):
    """The _FirstByteClock fallback (no RadioPositionTracker — a relayed
    Sonos, since 2026-09-04) is the only clock with a fixed/measured lead
    worth reporting — see AudioAnalyzer.last_release_lead's own comment."""
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    casting_session.radio_relay = _FakeRelay("http://radio/stream")
    casting_session.radio_position_tracker = None
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        debug_lead_fn = fake_analyzer[0].kwargs["debug_lead_fn"]
        assert debug_lead_fn() == (ASSUMED_DEVICE_LEAD_SECONDS, False)
    finally:
        await feed.shutdown()


async def test_relayed_radio_with_a_real_tracker_passes_no_debug_lead_fn(
    casting_session, fake_analyzer
):
    """Chromecast/DLNA/direct-Sonos — a real, live-polled device position
    has no fixed/measured lead concept at all (see _OffsetTrackerClock's
    own docstring)."""
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    casting_session.radio_relay = _FakeRelay("http://radio/stream")
    tracker = MagicMock()
    tracker.elapsed_fn.return_value = 0.0
    tracker.buffer_lag.return_value = None
    casting_session.radio_position_tracker = tracker
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert fake_analyzer[0].kwargs["debug_lead_fn"] is None
    finally:
        await feed.shutdown()


async def test_relayed_radio_offsets_tracker_elapsed_fn_to_subscription_start(
    casting_session, fake_analyzer
):
    """Regression test, reported live 2026-09-02: RadioPositionTracker.
    elapsed_fn() (core/radio_position.py) is the device's *absolute*
    position since its own dispatch, but content_position
    (core/audio_analysis.py's own, computed from this analyzer's own fresh
    decode) is relative to *this run's* own start instead — every attach
    starts decoding "now" regardless of how long the station has already
    been playing. Without subtracting the device's position at the moment
    this analyzer actually starts, opening the visualizer any time after
    the device already had a real position (every reload of an
    already-playing radio session included, not just "joined late" in the
    everyday sense) permanently offsets elapsed_fn ahead of
    content_position by that whole amount — every frame computed forever
    after reads as impossibly late and never gets released, which live
    also manifested as stuttering device audio (see
    core/audio_analysis.py's _release_frames() and its own comment on the
    tight drop loop this produces)."""
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    casting_session.radio_relay = _FakeRelay("http://radio/stream")
    tracker = MagicMock()
    tracker.elapsed_fn.return_value = 60.0  # already 60s in when this analyzer starts
    # Not what this test is about — see TestOffsetTrackerClockBufferLag for
    # buffer_lag() coverage. Without this, a bare MagicMock's `ready` and
    # `buffer_lag()` are both truthy/non-None by default, so
    # _apply_measured_lag() would fold a MagicMock into a float baseline.
    tracker.buffer_lag.return_value = None
    casting_session.radio_position_tracker = tracker
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        elapsed_fn = fake_analyzer[0].kwargs["elapsed_fn"]
        on_first_byte = fake_analyzer[0].kwargs["on_first_byte"]

        # Nothing decoded yet, so no frame can be due — and crucially the
        # baseline is not taken here: the tracker keeps climbing through
        # ffmpeg's spawn and the relay's first hand-off, and charging that
        # gap to content time put every frame of the run that far ahead.
        assert elapsed_fn() == pytest.approx(0.0)
        tracker.elapsed_fn.return_value = 62.0  # 2s of startup latency
        assert elapsed_fn() == pytest.approx(0.0)

        on_first_byte()  # content_position 0 exists as of *this* moment
        assert elapsed_fn() == pytest.approx(0.0)
        tracker.elapsed_fn.return_value = 67.0  # 5s later, same rate as content_position
        assert elapsed_fn() == pytest.approx(5.0)
    finally:
        await feed.shutdown()


async def test_relayed_radio_hands_its_fan_out_subscription_back(casting_session, fake_analyzer):
    """A queue left subscribed keeps being filled with audio nobody
    decodes, for as long as the station plays."""
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    casting_session.radio_relay = _FakeRelay("http://radio/stream")
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    relay = casting_session.radio_relay
    assert relay.subscribed and not relay.released

    await feed.shutdown()
    assert relay.released == relay.subscribed


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


async def test_a_replaced_position_tracker_is_followed_without_a_restart(
    casting_session, fake_analyzer
):
    """/play-url puts a fresh RadioPositionTracker on the session for every
    dispatch, and a Sonos re-dispatches the same station at the same
    play_generation as a routine part of its own flow. A clock pinned to
    the tracker it started with reads that one's frozen last value forever
    — a flat 0.00s after the baseline — and no frame is ever released
    again. Reported live 2026-09-03, named exactly by the stalled-clock
    warning in core/audio_analysis.py.

    Followed rather than restarted: tearing the analyzer down would respawn
    ffmpeg and drop everything decoded so far, on an event that happens
    every station start. Identity is not usable as a restart key either —
    CPython reuses id() of a freed object, so the replacement can land on
    the address the previous one just vacated."""
    casting_session.state.current_track = None
    casting_session.state.radio_info = {"title": "FIP", "url": "http://radio/stream"}
    casting_session.radio_relay = _FakeRelay("http://radio/stream")
    first = _FakeTracker(position=30.0, ready=True)
    casting_session.radio_position_tracker = first
    feed = casting_session.visualizer
    feed.subscribe()
    await _settle(feed)
    try:
        assert len(fake_analyzer) == 1
        elapsed_fn = fake_analyzer[0].kwargs["elapsed_fn"]
        fake_analyzer[0].kwargs["on_first_byte"]()
        first.position = 34.0
        assert elapsed_fn() == pytest.approx(4.0, abs=0.2)

        # Same station, same generation — only the tracker is new, and it
        # starts from zero the way a fresh dispatch does.
        casting_session.radio_position_tracker = _FakeTracker(position=0.0, ready=True)
        feed.notify()
        await _settle(feed)

        assert len(fake_analyzer) == 1  # no respawn
        # Continuous across the swap: content position keeps counting, so a
        # reset to zero here would strand every decoded frame in the future.
        assert elapsed_fn() == pytest.approx(4.0, abs=0.2)
        casting_session.radio_position_tracker.position = 3.0
        assert elapsed_fn() == pytest.approx(7.0, abs=0.2)
    finally:
        await feed.shutdown()
