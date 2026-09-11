"""Tests for /play-url's default radio-relay dispatch (routes/playback.py).

core/radio_relay.py's own internals (ICY demux, ffmpeg fan-out, reconnect
backoff) have their own tests in test_radio_relay.py — these only check
that the route wires a relay in correctly: starts one, points the device at
it, tears it down on failure/station-change/stop, and skips the
independent ICY watch that would otherwise duplicate what the relay
already reports.
"""

from unittest.mock import AsyncMock, patch

from core.stream_format import ProbedStream
from delivery import AirPlayDelivery, ChromecastDelivery


class FakeRelay:
    """Stands in for core.session.RadioRelay — real fetch/ffmpeg behavior
    is exactly what test_radio_relay.py already covers; this only needs to
    look like a relay to whatever wires it in."""

    def __init__(
        self,
        url,
        content_type,
        on_title_change,
        on_stream_info=None,
        on_orphaned=None,
        max_bitrate_kbps=None,
        preferred_format=None,
    ):
        self.url = url
        # What the listener's cast-quality ceiling was when this relay was
        # started, so a test can check the route passes it through.
        self.max_bitrate_kbps = max_bitrate_kbps
        self.preferred_format = preferred_format
        # Mirrors RadioRelay's own two: why the station is being re-encoded
        # (None where it is passed through) and what it is being handed to
        # the device at.
        self.reencode_reason = None
        self.output_bitrate_kbps = None
        self.device_content_type = "audio/mpeg"
        # Mirrors RadioRelay.source_content_type: the caller's guess until
        # the relay's own connection to the station replaces it with what
        # the station announces. /play-url reads it back for radio_info.
        self.source_content_type = content_type
        # Mirrors RadioRelay.refused_status — set only when the station
        # answered with a 4xx meaning it refuses this listener.
        self.refused_status = None
        self._on_title_change = on_title_change
        # Mirrors RadioRelay's own: what it calls once nothing has been
        # listening for long enough — see SessionState._radio_relay_orphaned.
        self._on_orphaned = on_orphaned
        self.started = False
        self.stopped = False
        # Mirrors RadioRelay.connected — /play-url only dispatches a device
        # at the relay once its first connection attempt actually produced
        # something. Overridden per-test for the "never connected" case.
        self.connected = True

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True


def _play_url(client, **overrides):
    body = {
        "target_name": "TV",
        "target_type": "chromecast",
        "title": "Test",
        "url": "http://example.com/stream.mp3",
    }
    body.update(overrides)
    return client.post("/play-url", json=body)


def test_does_not_probe_a_station_it_is_about_to_relay(client, default_session):
    """The relay fetches the station itself and reads the same headers a
    probe would (see core/radio_relay.py) — probing on top of that is a
    second connection to the station for an answer already in hand, and
    some stations allow exactly one at a time."""
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch("routes.playback.probe_stream", new=AsyncMock()) as probe,
        patch("core.session.RadioRelay", FakeRelay),
    ):
        r = _play_url(client)

    assert r.json()["status"] == "playing"
    probe.assert_not_awaited()


def test_records_the_type_the_relay_read_off_the_station(client, default_session):
    """What the station itself announced, for anything that later
    re-dispatches it straight to a device — retry_radio_via_proxy(), a
    device joining mid-station (see core/stream_format.py's
    radio_content_type)."""

    class AacStation(FakeRelay):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.source_content_type = "audio/aac"
            self.device_content_type = "audio/aac"

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
        patch("core.session.RadioRelay", AacStation),
    ):
        r = _play_url(client)

    assert r.json()["status"] == "playing"
    assert default_session.state.radio_info["content_type"] == "audio/aac"
    # And what the device was told, which for a relayed station is the
    # relay's output rather than the station's own type — here both, since
    # this relay hands AAC through untouched.
    assert play.await_args.kwargs["content_type"] == "audio/aac"
    assert default_session.state.radio_info["device_content_type"] == "audio/aac"


def test_reports_a_station_that_refuses_the_relay(client, default_session):
    """The relay is what asks the station, so it is what finds a 403 — and
    the listener is told, rather than the speaker being dispatched into the
    same answer. Covered end-to-end in test_radio_reencode.py; this is the
    relay-shaped half of it."""

    class RefusedStation(FakeRelay):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.connected = False
            self.refused_status = 403

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
        patch("core.session.RadioRelay", RefusedStation),
    ):
        r = _play_url(client)

    body = r.json()
    assert body["reason"] == "station_refused"
    assert body["detail"] == "HTTP 403"
    play.assert_not_awaited()
    assert default_session.state.radio_info is None


def test_dispatches_the_device_to_beacons_own_relay_by_default(client, default_session):
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/aacp"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        r = _play_url(client)

    assert r.json()["status"] == "playing"
    url, title = play.await_args.args
    assert url.endswith(f"/stream/radio/{default_session.session_id}")
    assert title == "Test"
    assert play.await_args.kwargs["content_type"] == "audio/mpeg"
    assert default_session.state.radio_info["relayed"] is True
    # The station's own identity, not the relay endpoint — see
    # core/state.py's radio_dispatch_url() for where the distinction matters.
    assert default_session.state.radio_info["url"] == "http://example.com/stream.mp3"
    assert isinstance(default_session.radio_relay, FakeRelay)
    assert default_session.radio_relay.started is True


def test_passes_the_cast_quality_ceiling_to_the_relay(client, default_session):
    """The setting only ever reached songs: /play sent it, /play-url did
    not, and the relay had no way to know about it."""
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client, max_lossy_format="mp3", max_lossy_bitrate_kbps=96)

    assert default_session.radio_relay.max_bitrate_kbps == 96


def test_casting_restarts_a_relay_local_playback_started_under_another_ceiling(
    client, default_session
):
    """Listening on this device and then sending the station to a speaker is
    the ordinary way round. The relay is already running under the local
    ceiling; reusing it would ignore the cast setting for the whole
    station."""
    running = FakeRelay("http://example.com/stream.mp3", "audio/mpeg", lambda _t: None)
    running.max_bitrate_kbps = 320
    running.preferred_format = "mp3"
    default_session.radio_relay = running

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client, max_lossy_format="mp3", max_lossy_bitrate_kbps=96)

    assert running.stopped is True
    assert default_session.radio_relay is not running
    assert default_session.radio_relay.max_bitrate_kbps == 96


def test_casting_restarts_a_relay_running_in_another_format(client, default_session):
    """Switching the setting to AAC has to reach a station already playing
    through the relay, the same way a changed ceiling does."""
    running = FakeRelay("http://example.com/stream.mp3", "audio/mpeg", lambda _t: None)
    running.max_bitrate_kbps = 96
    running.preferred_format = "mp3"
    default_session.radio_relay = running

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client, max_lossy_format="aac", max_lossy_bitrate_kbps=96)

    assert running.stopped is True
    assert default_session.radio_relay.preferred_format == "aac"


def test_opus_reaches_the_relay_as_aac(client, default_session):
    """The relay has no Opus encoder, and a Chromecast takes AAC just as
    happily as it takes Opus — so the setting lands on the best thing the
    relay can actually produce rather than falling all the way to MP3."""
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client, max_lossy_format="opus", max_lossy_bitrate_kbps=128)

    assert default_session.radio_relay.preferred_format == "aac"


def test_a_device_that_plays_no_aac_gets_mp3_whatever_was_asked_for(client, default_session):
    """An AirPlay device decodes neither AAC nor Opus (see
    AirPlayDelivery.PLAYABLE_CODECS) — handing it either is how a station
    reached a speaker as silence."""
    with (
        patch.object(AirPlayDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(
            client,
            target_name="HomePod",
            target_type="airplay",
            max_lossy_format="aac",
            max_lossy_bitrate_kbps=128,
        )

    assert default_session.radio_relay.preferred_format == "mp3"


def test_a_second_dispatch_at_another_quality_is_not_a_duplicate(client, default_session):
    """Two clients share a session and each has its own quality setting. The
    second arriving inside the duplicate-dispatch cooldown used to be
    dropped — after its relay teardown had already silenced the speaker."""
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client, max_lossy_format="mp3", max_lossy_bitrate_kbps=320)
        _play_url(client, max_lossy_format="mp3", max_lossy_bitrate_kbps=96)

    assert play.await_count == 2


def test_the_very_same_dispatch_is_still_a_duplicate(client, default_session):
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client, max_lossy_format="mp3", max_lossy_bitrate_kbps=96)
        _play_url(client, max_lossy_format="mp3", max_lossy_bitrate_kbps=96)

    assert play.await_count == 1


def test_casting_keeps_a_relay_already_running_under_the_same_ceiling(client, default_session):
    """Nothing to gain from a reconnect — and it would cost the station one
    for no reason."""
    running = FakeRelay("http://example.com/stream.mp3", "audio/mpeg", lambda _t: None)
    running.max_bitrate_kbps = 96
    running.preferred_format = "mp3"
    default_session.radio_relay = running

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client, max_lossy_format="mp3", max_lossy_bitrate_kbps=96)

    assert running.stopped is False
    assert default_session.radio_relay is running


def test_a_station_cast_without_a_ceiling_gets_none(client, default_session):
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client)

    assert default_session.radio_relay.max_bitrate_kbps is None


def test_reports_a_re_encoded_station_to_the_stream_info_panel(client, default_session):
    """So the overlay says "MP3 96k" instead of only naming the source —
    the same row it already shows for a song over the ceiling."""

    class ReencodingRelay(FakeRelay):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.reencode_reason = "quality_limit"
            self.output_bitrate_kbps = 96

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", ReencodingRelay),
    ):
        _play_url(client, max_lossy_format="mp3", max_lossy_bitrate_kbps=96)

    fmt = default_session.state.current_output_format
    assert fmt.target_bitrate_kbps == 96
    assert fmt.transcode_reason == "quality_limit"
    assert "96k" in fmt.label


def test_reports_a_compatibility_conversion_as_one(client, default_session):
    """An AAC station is re-encoded because the device gets MP3 either way.
    Reporting the quality ceiling for that (as this did at first) tells the
    listener their setting is doing something it is not — it says so even
    with the setting on "original"."""

    class CompatRelay(FakeRelay):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.reencode_reason = "codec_not_castable"
            self.output_bitrate_kbps = 192

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/aacp"))
        ),
        patch("core.session.RadioRelay", CompatRelay),
    ):
        _play_url(client)

    fmt = default_session.state.current_output_format
    assert fmt.transcode_reason == "codec_not_castable"
    assert fmt.target_bitrate_kbps == 192


def test_says_nothing_about_transcoding_for_a_station_it_passes_through(client, default_session):
    """A station under the ceiling is copied, and claiming a conversion
    that never happened is exactly what the panel used to do."""
    before = default_session.state.current_output_format

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client, max_lossy_format="mp3", max_lossy_bitrate_kbps=96)

    assert default_session.state.current_output_format is before


def test_does_not_start_a_second_independent_icy_watch_when_relayed(client, default_session):
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
        patch.object(default_session, "start_radio_metadata_watch") as start_watch,
    ):
        _play_url(client)

    start_watch.assert_not_called()


def test_stops_a_metadata_watch_already_running_from_a_local_playback_pre_call(
    client, default_session
):
    """stores/playback.ts's playRadioStation() always calls
    /radio-metadata/start once before deciding whether to cast — local
    playback needs it and the frontend doesn't know in advance it's about
    to cast instead. A relayed dispatch must tear that down rather than
    run it alongside the relay's own ICY parsing."""
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
        patch.object(default_session, "stop_radio_metadata_watch") as stop_watch,
    ):
        _play_url(client)

    stop_watch.assert_called_once()


def test_cast_directly_opts_out_of_the_relay(client, default_session):
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
        patch.object(default_session, "start_radio_metadata_watch") as start_watch,
    ):
        _play_url(client, cast_directly=True)

    play.assert_awaited_once_with(
        "http://example.com/stream.mp3", "Test", content_type="audio/mpeg"
    )
    assert default_session.radio_relay is None
    assert default_session.state.radio_info["relayed"] is False
    start_watch.assert_called_once_with("http://example.com/stream.mp3")


def test_tears_down_the_relay_when_the_device_refuses_it(client, default_session):
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock(side_effect=RuntimeError("nope"))),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        r = _play_url(client)

    assert r.json()["error"] == "delivery_failed"
    assert default_session.radio_relay is None
    assert default_session.state.radio_info is None


def test_a_failed_switch_does_not_leave_the_previous_station_claiming_a_relay_that_is_gone(
    client, default_session
):
    """start_radio_relay() for the new station tears down the previous
    one's relay before the new dispatch is even attempted (see that
    method's own docstring) — so when the dispatch then fails and rolls
    radio_info back to the previous station, that station's own relay no
    longer exists either. Reporting it as still "relayed" would claim a
    live relay nothing backs any more, until some unrelated later
    /play-url happened to fix it — see core/state.py's radio_dispatch_url()
    for what actually breaks were a consumer to trust that flag."""
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client, title="First", url="http://example.com/first.mp3")

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock(side_effect=RuntimeError("nope"))),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        r = _play_url(client, title="Second", url="http://example.com/second.mp3")

    assert r.json()["error"] == "delivery_failed"
    assert default_session.state.radio_info["url"] == "http://example.com/first.mp3"
    assert default_session.state.radio_info["relayed"] is False
    assert default_session.radio_relay is None


def test_a_second_station_stops_the_first_relay_and_starts_a_new_one(client, default_session):
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client, title="First", url="http://example.com/first.mp3")
        first_relay = default_session.radio_relay
        _play_url(client, title="Second", url="http://example.com/second.mp3")

    assert first_relay is not None
    assert first_relay.stopped is True
    assert default_session.radio_relay is not first_relay
    assert default_session.radio_relay.url == "http://example.com/second.mp3"


def test_the_same_station_repeated_reuses_the_running_relay(client, default_session):
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client)
        first_relay = default_session.radio_relay
        _play_url(client)

    assert first_relay is not None
    assert default_session.radio_relay is first_relay
    assert first_relay.stopped is False


class UnreachableRelay(FakeRelay):
    """A relay whose first connection attempt never produced anything —
    RadioRelay.start() returns anyway (its own loop keeps retrying in the
    background), leaving `connected` False."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.connected = False


def test_falls_back_to_direct_when_the_relay_never_connected(client, default_session):
    """probe_stream() reached the station on a connection of its own, but
    the relay's own could not be established — some stations allow exactly
    one at a time. Dispatching the device at /stream/radio anyway answers
    200 with a body that stays silent indefinitely, which reads as a broken
    speaker rather than a station problem; the station's own URL at least
    plays, and keeps retry_radio_via_proxy() available behind it."""
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", UnreachableRelay),
    ):
        r = _play_url(client)

    assert r.json()["status"] == "playing"
    play.assert_awaited_once_with(
        "http://example.com/stream.mp3", "Test", content_type="audio/mpeg"
    )
    # Marked direct, so /join, /resume and the device-stop restart all send
    # later devices to the same place this one went (see radio_dispatch_url())
    # and the transport-problem handler still has its re-encode fallback.
    assert default_session.state.radio_info["relayed"] is False
    assert default_session.radio_relay is None


def test_starting_a_relay_clears_the_redispatch_cooldown(client, default_session):
    """routes/upnp.py's _redispatch_relayed_station() rate-limits itself off
    this timestamp — a station switched to right after a recovery must not
    inherit the previous one's cooldown and be denied its own first one."""
    default_session.last_radio_redispatch = 12345.0
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch(
            "routes.playback.probe_stream", new=AsyncMock(return_value=ProbedStream("audio/mpeg"))
        ),
        patch("core.session.RadioRelay", FakeRelay),
    ):
        _play_url(client)

    assert default_session.last_radio_redispatch == 0.0
