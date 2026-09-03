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
from delivery import ChromecastDelivery


class FakeRelay:
    """Stands in for core.session.RadioRelay — real fetch/ffmpeg behavior
    is exactly what test_radio_relay.py already covers; this only needs to
    look like a relay to whatever wires it in."""

    def __init__(self, url, content_type, on_title_change):
        self.url = url
        self.device_content_type = "audio/mpeg"
        self._on_title_change = on_title_change
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

    def __init__(self, url, content_type, on_title_change):
        super().__init__(url, content_type, on_title_change)
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
