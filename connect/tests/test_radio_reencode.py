"""Tests for the radio re-encode fallback — routes/playback.py's
retry_radio_via_proxy(), routes/upnp.py's transport-problem handling and
routes/stream.py's /stream/radio.

Beacon hands a station's own bytes straight to a device by default. Two
different refusals were seen in practice, and both are fixed by the same
fallback without having to tell them apart: a format the speaker won't
decode (ERROR_UNSUPPORTED_FORMAT for an `audio/aacp` station) and a
transport it won't use (ERROR_ACCESS_DENIED for an https URL on someone
else's host — reported for a plain MP3, so not a format problem at all).
"""

import asyncio
import time
from unittest.mock import AsyncMock, patch

import pytest

from core.claims import claims
from core.icy_metadata import ICY_ROUND_TRIP_ENV, IcyDemuxer, strip_pulse
from core.session import radio_is_buffering
from core.stream_format import ProbedStream
from core.streamer import REASON_DEVICE_REJECTED_STREAM
from delivery import ChromecastDelivery, SonosDelivery
from routes import upnp
from routes.playback import retry_radio_via_proxy

STATION = "https://playerservices.streamtheworld.com/OWR.aac"


@pytest.fixture
def radio_playing(default_session):
    default_session.state.radio_info = {
        "title": "OWR International",
        "url": STATION,
        "content_type": "audio/aacp",
    }
    default_session.state.is_streaming = True
    return default_session


class TestRetryViaProxy:
    async def test_points_the_device_at_beacons_own_re_encoded_copy(self, radio_playing):
        target = ChromecastDelivery("TV")
        with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
            assert await retry_radio_via_proxy(radio_playing, target) is True

        url, title = play.await_args.args
        assert url.endswith(f"/stream/radio/{radio_playing.session_id}")
        # Plain http from this machine, which is the other half of what
        # this fixes — an https URL on a stranger's host is refused by
        # some devices regardless of format.
        assert url.startswith("http://")
        assert title == "OWR International"
        assert play.await_args.kwargs["content_type"] == "audio/mpeg"

    async def test_reports_the_re_encode_in_the_stream_info_panel(self, radio_playing):
        with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
            await retry_radio_via_proxy(radio_playing, ChromecastDelivery("TV"))

        fmt = radio_playing.state.current_output_format
        assert fmt.transcode_reason == REASON_DEVICE_REJECTED_STREAM
        # Without this the listener hears a station that sounds different
        # from the one they picked, with nothing saying why.
        assert fmt.content_type == "audio/mpeg"

    async def test_records_the_switch_so_a_reconnect_stays_on_the_proxy(self, radio_playing):
        with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
            await retry_radio_via_proxy(radio_playing, ChromecastDelivery("TV"))

        assert radio_playing.state.radio_info["proxied"] is True
        assert radio_playing.state.radio_info["content_type"] == "audio/mpeg"

    async def test_never_retries_twice_for_the_same_station(self, radio_playing):
        """A device that refuses even the re-encoded stream must not loop."""
        with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
            await retry_radio_via_proxy(radio_playing, ChromecastDelivery("TV"))
            assert await retry_radio_via_proxy(radio_playing, ChromecastDelivery("TV")) is False
        play.assert_awaited_once()

    async def test_does_nothing_when_no_station_is_loaded(self, default_session):
        with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
            assert await retry_radio_via_proxy(default_session, ChromecastDelivery("TV")) is False
        play.assert_not_awaited()

    async def test_reports_failure_when_the_re_encoded_stream_is_refused_too(self, radio_playing):
        with patch.object(
            ChromecastDelivery, "play", new=AsyncMock(side_effect=RuntimeError("nope"))
        ):
            assert await retry_radio_via_proxy(radio_playing, ChromecastDelivery("TV")) is False
        # Nothing claimed to have started: the panel must not show a
        # transcode that never happened.
        assert radio_playing.state.radio_info.get("proxied") is not True


class TestPlayUrlRetries:
    def test_a_station_the_device_refuses_outright_falls_back_to_the_proxy(
        self, client, default_session
    ):
        with (
            patch.object(
                ChromecastDelivery,
                "play",
                new=AsyncMock(side_effect=[RuntimeError("UPnP Error 800"), None]),
            ) as play,
            patch(
                "routes.playback.probe_stream",
                new=AsyncMock(return_value=ProbedStream("audio/aacp")),
            ),
        ):
            r = client.post(
                "/play-url",
                json={
                    "target_name": "TV",
                    "target_type": "chromecast",
                    "title": "OWR International",
                    "url": STATION,
                    "cast_directly": True,
                },
            )

        assert r.json()["status"] == "playing"
        assert play.await_count == 2
        assert (
            play.await_args_list[1].args[0].endswith(f"/stream/radio/{default_session.session_id}")
        )
        assert default_session.state.radio_info["proxied"] is True

    def test_a_failure_the_proxy_cannot_fix_still_reports_the_error(self, client, default_session):
        with (
            patch.object(
                ChromecastDelivery, "play", new=AsyncMock(side_effect=RuntimeError("unreachable"))
            ),
            patch(
                "routes.playback.probe_stream",
                new=AsyncMock(return_value=ProbedStream("audio/mpeg")),
            ),
        ):
            r = client.post(
                "/play-url",
                json={
                    "target_name": "TV",
                    "target_type": "chromecast",
                    "title": "OWR International",
                    "url": STATION,
                },
            )

        assert r.json()["error"] == "delivery_failed"
        # Rolled back — nothing is playing, so nothing must look like it is.
        assert default_session.state.radio_info is None
        assert claims.owner_of("chromecast", "TV") is None


class TestStationRefusesTheConnection:
    """Seen live: a stored station answering 403 to everything. The speaker
    reported ERROR_ACCESS_DENIED, the re-encode fallback fetched the same
    403 and produced nothing, and the speaker then reported
    ERROR_CORRUPT_FILE — two messages about the speaker for a problem that
    was never the speaker's."""

    @pytest.mark.parametrize("status", [401, 403, 404, 410])
    def test_says_so_instead_of_letting_the_device_and_the_re_encode_fail(
        self, client, default_session, status
    ):
        with (
            patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
            patch(
                "routes.playback.probe_stream",
                new=AsyncMock(
                    return_value=ProbedStream("audio/mpeg", refused=True, detail=f"HTTP {status}")
                ),
            ),
        ):
            r = client.post(
                "/play-url",
                json={
                    "target_name": "TV",
                    "target_type": "chromecast",
                    "title": "OWR",
                    "url": STATION,
                },
            )

        body = r.json()
        assert body["error"] == "delivery_failed"
        assert body["reason"] == "station_refused"
        assert body["detail"] == f"HTTP {status}"
        # The device is never even asked, and nothing is left looking like
        # it is playing.
        play.assert_not_awaited()
        assert default_session.state.radio_info is None
        assert claims.owner_of("chromecast", "TV") is None

    def test_still_dispatches_a_station_that_is_merely_slow_or_briefly_broken(
        self, client, default_session
    ):
        with (
            patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
            patch(
                "routes.playback.probe_stream",
                new=AsyncMock(return_value=ProbedStream("audio/mpeg", refused=False)),
            ),
        ):
            r = client.post(
                "/play-url",
                json={
                    "target_name": "TV",
                    "target_type": "chromecast",
                    "title": "OWR",
                    "url": STATION,
                },
            )

        assert r.json()["status"] == "playing"
        play.assert_awaited_once()


class TestRadioStreamRoute:
    def test_serves_the_loaded_station_re_encoded_as_mp3(self, client, radio_playing):
        async def fake_stream(urls, *args, **kwargs):
            assert urls == [STATION]
            yield b"audio"

        with patch("routes.stream.stream_tracks", fake_stream):
            r = client.get(f"/stream/radio/{radio_playing.session_id}")

        assert r.status_code == 200
        assert r.headers["content-type"].startswith("audio/mpeg")
        assert r.content == b"audio"

    def test_answers_a_head_probe_without_starting_ffmpeg(self, client, radio_playing):
        """A Sonos probes the URL with HEAD before it will play it. A route
        that only answers GET returns 405 to that probe, and the speaker
        then reports ERROR_CORRUPT_FILE / ERROR_NO_PLAYABLE_CONTENT for a
        stream it never opened."""

        def must_not_run(*args, **kwargs):  # pragma: no cover
            raise AssertionError("HEAD must not start ffmpeg")

        with patch("routes.stream.stream_tracks", must_not_run):
            r = client.head(f"/stream/radio/{radio_playing.session_id}")

        assert r.status_code == 200
        assert r.headers["content-type"].startswith("audio/mpeg")

    def test_answers_204_when_radio_already_stopped(self, client, default_session):
        """A device reconnecting after the station stopped gets a clean end,
        not a stalled connection — same shape /stream's own no-track answer
        has."""
        r = client.get(f"/stream/radio/{default_session.session_id}")
        assert r.status_code == 204

    def test_subscribes_to_the_relay_instead_of_re_fetching_when_one_is_running(
        self, client, radio_playing
    ):
        """The default (relayed) case — routes/playback.py's /play-url
        already started core/radio_relay.py's RadioRelay for this station;
        this connection must be one more subscriber to it, not a second,
        independent fetch (see stream_tracks not being touched at all
        here, unlike the fallback test above)."""

        class FakeRelay:
            device_content_type = "audio/mpeg"

            def subscribe_audio(self):
                q = asyncio.Queue()
                q.put_nowait(b"relayed-audio")
                q.put_nowait(None)
                return q

            def unsubscribe_audio(self, q):
                self.unsubscribed = q

        relay = FakeRelay()
        radio_playing.radio_relay = relay

        def must_not_run(*args, **kwargs):  # pragma: no cover
            raise AssertionError("must subscribe to the relay, not fetch the station again")

        with patch("routes.stream.stream_tracks", must_not_run):
            r = client.get(f"/stream/radio/{radio_playing.session_id}")

        assert r.status_code == 200
        assert r.headers["content-type"].startswith("audio/mpeg")
        assert r.content == b"relayed-audio"
        assert relay.unsubscribed is not None


class TestRadioStreamIcy:
    """routes/stream.py's own Icy-MetaData: 1 handling — see
    core/icy_metadata.py's IcyMuxer docstring for the live symptom this
    responds to (Sonos dropping out only when relayed through Beacon,
    theorised to be picking a smaller, file-like buffer for a URL that
    carries none of the ICY signalling the station's own does)."""

    def test_no_icy_metaint_header_without_the_request_header(self, client, radio_playing):
        """The overwhelming majority of requests here — a plain player, or
        a device that never asked — must see byte-for-byte the same stream
        as before this existed."""

        async def fake_stream(urls, *args, **kwargs):
            yield b"audio"

        with patch("routes.stream.stream_tracks", fake_stream):
            r = client.get(f"/stream/radio/{radio_playing.session_id}")

        assert "icy-metaint" not in r.headers
        assert "icy-name" not in r.headers
        assert r.content == b"audio"

    def test_icy_metaint_and_name_headers_when_requested(self, client, radio_playing):
        async def fake_stream(urls, *args, **kwargs):
            yield b"audio"

        with (
            patch("routes.stream.stream_tracks", fake_stream),
            patch("routes.stream.DEVICE_METAINT", 4),
        ):
            r = client.get(
                f"/stream/radio/{radio_playing.session_id}", headers={"Icy-MetaData": "1"}
            )

        assert r.headers["icy-metaint"] == "4"
        # radio_playing's own fixture sets radio_info["title"] — the
        # station's name, not the now-playing tag (see radio_stream()'s
        # own comment on that distinction).
        assert r.headers["icy-name"] == "OWR International"

    def test_muxed_body_demuxes_back_to_the_original_audio_and_title(self, client, radio_playing):
        radio_playing.radio_title = "Artist - Track"

        async def fake_stream(urls, *args, **kwargs):
            # Two chunks, neither aligned to metaint=4 on its own — only
            # their 12-byte total is, so the round-trip below recovers
            # everything instead of a real stream's last partial window
            # legitimately staying buffered with nothing to complete it.
            yield b"012"
            yield b"3456789ab"

        with (
            patch("routes.stream.stream_tracks", fake_stream),
            patch("routes.stream.DEVICE_METAINT", 4),
        ):
            r = client.get(
                f"/stream/radio/{radio_playing.session_id}", headers={"Icy-MetaData": "1"}
            )

        demuxer = IcyDemuxer(4, (titles := []).append)
        assert demuxer.feed(r.content) == b"0123456789ab"
        # strip_pulse: what goes out carries core/icy_metadata.py's invisible
        # pulse mark on alternating windows (pulsed_title(), which has its own
        # tests). Which window a given request lands in is wall-clock luck, so
        # asserting the raw title here would pass or fail by the second. What
        # this test is about is the station's real title surviving the
        # mux/demux round trip, which holds either way.
        assert [strip_pulse(t) for t in titles] == ["Artist - Track"]

    def test_relayed_stream_is_muxed_too(self, client, radio_playing):
        """The relayed path (core/radio_relay.py) is a separate code path
        from the direct re-encode fallback above — both must answer
        Icy-MetaData: 1, since a real Sonos radio dispatch goes through
        this one by default."""

        class FakeRelay:
            device_content_type = "audio/mpeg"

            def subscribe_audio(self):
                q = asyncio.Queue()
                q.put_nowait(b"relayed-data")  # 12 bytes — a clean multiple of metaint=4
                q.put_nowait(None)
                return q

            def unsubscribe_audio(self, q):
                pass

        radio_playing.radio_relay = FakeRelay()

        with patch("routes.stream.DEVICE_METAINT", 4):
            r = client.get(
                f"/stream/radio/{radio_playing.session_id}", headers={"Icy-MetaData": "1"}
            )

        assert r.headers["icy-metaint"] == "4"
        demuxer = IcyDemuxer(4, lambda _: None)
        assert demuxer.feed(r.content) == b"relayed-data"

    def test_does_not_record_an_injection_by_default(self, client, radio_playing, monkeypatch):
        """Off by default since ICY_ROUND_TRIP_ENV — nothing functional is
        left reading the result (see that constant's own comment), so an
        ordinary title change no longer arms a measurement, pulsed or not."""
        monkeypatch.delenv(ICY_ROUND_TRIP_ENV, raising=False)
        radio_playing.radio_title = "Artist - Track"

        async def fake_stream(urls, *args, **kwargs):
            yield b"0123"  # exactly one metaint=4 block

        with (
            patch("routes.stream.stream_tracks", fake_stream),
            patch("routes.stream.DEVICE_METAINT", 4),
        ):
            client.get(f"/stream/radio/{radio_playing.session_id}", headers={"Icy-MetaData": "1"})

        assert radio_playing.radio_icy_pending_injection is None

    def test_records_the_injection_for_the_upnp_round_trip_measurement(
        self, client, radio_playing, monkeypatch
    ):
        """See core/session.py's radio_icy_pending_injection and
        routes/upnp.py's _handle_stream_title_echo() — the other end of
        this, matching the title back up once the device echoes it. Only
        with ICY_ROUND_TRIP_ENV switched back on — see the test right above
        for the now-default off case."""
        monkeypatch.setenv(ICY_ROUND_TRIP_ENV, "1")
        radio_playing.radio_title = "Artist - Track"

        async def fake_stream(urls, *args, **kwargs):
            yield b"0123"  # exactly one metaint=4 block

        before = time.monotonic()
        with (
            patch("routes.stream.stream_tracks", fake_stream),
            patch("routes.stream.DEVICE_METAINT", 4),
        ):
            client.get(f"/stream/radio/{radio_playing.session_id}", headers={"Icy-MetaData": "1"})
        after = time.monotonic()

        pending = radio_playing.radio_icy_pending_injection
        assert pending is not None
        title, injected_at = pending
        assert strip_pulse(title) == "Artist - Track"  # see the pulse note above
        assert before <= injected_at <= after

    def test_does_not_record_an_injection_when_icy_was_not_requested(self, client, radio_playing):
        radio_playing.radio_title = "Artist - Track"

        async def fake_stream(urls, *args, **kwargs):
            yield b"0123"

        with (
            patch("routes.stream.stream_tracks", fake_stream),
            patch("routes.stream.DEVICE_METAINT", 4),
        ):
            client.get(f"/stream/radio/{radio_playing.session_id}")

        assert radio_playing.radio_icy_pending_injection is None


# The NOTIFY body a Sonos actually posts back — the interesting values live
# in a LastChange document that is XML-escaped inside the outer XML.
_NOTIFY_BODY = (
    '<?xml version="1.0"?>'
    '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>'
    "&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;"
    "&lt;TransportState val=&quot;STOPPED&quot;/&gt;"
    "&lt;TransportStatus val=&quot;{status}&quot;/&gt;"
    "&lt;/InstanceID&gt;&lt;/Event&gt;"
    "</LastChange></e:property></e:propertyset>"
)


class TestTransportProblemTriggersTheRetry:
    """The failure that never reaches a request's own response: the speaker
    accepts the URI, /play-url answers "playing", and only then does the
    device report on its own event channel that nothing is coming out."""

    @pytest.fixture
    def claimed(self, radio_playing):
        # The route finds the session through the claim, exactly the way
        # _handle_rendering_control_event() does — an unclaimed device is a
        # no-op there and here alike.
        asyncio.run(claims.claim("sonos", "Arbeitszimmer", radio_playing.session_id))
        radio_playing.state.active_delivery = SonosDelivery("Arbeitszimmer")
        yield radio_playing
        # Cleared before the app shuts down: its lifespan stops whatever is
        # still streaming, and a SonosDelivery that was never a real speaker
        # raises from _get_device() there rather than in the test.
        radio_playing.state.active_delivery = None
        radio_playing.state.is_streaming = False
        asyncio.run(claims.release("sonos", "Arbeitszimmer", radio_playing.session_id))

    @pytest.mark.parametrize("status", ["ERROR_UNSUPPORTED_FORMAT", "ERROR_ACCESS_DENIED"])
    def test_re_encodes_the_station_the_speaker_refused(self, client, claimed, status):
        with patch.object(SonosDelivery, "play", new=AsyncMock()) as play:
            r = client.request(
                "NOTIFY",
                "/upnp/events/avtransport/Arbeitszimmer",
                content=_NOTIFY_BODY.format(status=status),
            )

        assert r.status_code == 200
        play.assert_awaited_once()
        assert play.await_args.args[0].endswith(f"/stream/radio/{claimed.session_id}")
        assert claimed.state.radio_info["proxied"] is True

    def test_leaves_a_healthy_report_alone(self, client, claimed):
        with patch.object(SonosDelivery, "play", new=AsyncMock()) as play:
            client.request(
                "NOTIFY",
                "/upnp/events/avtransport/Arbeitszimmer",
                content=_NOTIFY_BODY.format(status="OK"),
            )
        play.assert_not_awaited()

    def test_does_not_retry_a_station_already_being_re_encoded(self, client, claimed):
        claimed.state.radio_info = {**claimed.state.radio_info, "proxied": True}
        with patch.object(SonosDelivery, "play", new=AsyncMock()) as play:
            client.request(
                "NOTIFY",
                "/upnp/events/avtransport/Arbeitszimmer",
                content=_NOTIFY_BODY.format(status="ERROR_ACCESS_DENIED"),
            )
        play.assert_not_awaited()

    def _report_problem(self, client, status="ERROR_LOST_CONNECTION"):
        return client.request(
            "NOTIFY",
            "/upnp/events/avtransport/Arbeitszimmer",
            content=_NOTIFY_BODY.format(status=status),
        )

    def test_redispatches_a_relayed_station_without_marking_it_proxied(self, client, claimed):
        """retry_radio_via_proxy() has nothing to switch a relayed station
        *to* — the device is already on Beacon's own relay URL — and
        marking radio_info "proxied" would block recovery from ever running
        again for this station (see routes/upnp.py's
        _handle_transport_problem() docstring for the real incident that
        guards against). The relay outlives the device's connection though,
        so pointing the device back at the same URL is a real recovery: it
        reconnects to a relay that is very likely serving audio again."""
        claimed.state.radio_info = {**claimed.state.radio_info, "relayed": True}
        with patch.object(SonosDelivery, "play", new=AsyncMock()) as play:
            self._report_problem(client)
        play.assert_awaited_once()
        assert play.await_args.args[0].endswith(f"/stream/radio/{claimed.session_id}")
        assert claimed.state.radio_info.get("proxied") is not True

    def test_does_not_redispatch_a_relayed_station_again_within_the_cooldown(self, client, claimed):
        """The cooldown is what keeps an unrecoverable relay from turning
        recovery into a redispatch loop — a device reporting failure as
        fast as it can must not be answered at the same rate."""
        claimed.state.radio_info = {**claimed.state.radio_info, "relayed": True}
        with patch.object(SonosDelivery, "play", new=AsyncMock()) as play:
            self._report_problem(client)
            self._report_problem(client)
            self._report_problem(client)
        play.assert_awaited_once()

    def test_redispatches_a_relayed_station_again_once_the_cooldown_has_passed(
        self, client, claimed
    ):
        """A drop half an hour later is a fresh failure, not the same one —
        unlike `proxied`, this guard has to expire."""
        claimed.state.radio_info = {**claimed.state.radio_info, "relayed": True}
        with patch.object(SonosDelivery, "play", new=AsyncMock()) as play:
            self._report_problem(client)
            claimed.last_radio_redispatch -= upnp._RELAY_REDISPATCH_COOLDOWN_SECONDS + 1
            self._report_problem(client)
        assert play.await_count == 2

    def test_leaves_a_queued_track_to_the_stream_connection_watcher(self, client, claimed):
        """A track's own GET /stream closing is what routes/stream.py
        already watches; a second recovery path would fight it."""
        claimed.state.radio_info = None
        with patch.object(SonosDelivery, "play", new=AsyncMock()) as play:
            client.request(
                "NOTIFY",
                "/upnp/events/avtransport/Arbeitszimmer",
                content=_NOTIFY_BODY.format(status="ERROR_ACCESS_DENIED"),
            )
        play.assert_not_awaited()

    def test_shows_buffering_again_once_redispatched(self, client, claimed):
        """Reported live 2026-09-04: a relayed Sonos losing its connection
        and being redispatched re-incurs its own startup-buffering delay
        same as any fresh /play-url — but the seek bar kept showing "Live"
        ticking straight through it rather than "Buffering…", because
        nothing here re-based elapsed_since_stream_start() to reflect that
        the device is starting fresh. See _redispatch_relayed_station()'s
        own comment for why restream_from(), not a generation bump, is the
        fix."""
        claimed.state.radio_info = {**claimed.state.radio_info, "relayed": True}
        claimed.state.clock.start()
        # Long enough since the *original* dispatch that the old,
        # never-re-based elapsed_since_stream_start() would already read
        # well past ASSUMED_DEVICE_LEAD_SECONDS on its own — the bug this
        # guards against wasn't "never buffers", it was "stops buffering
        # immediately regardless of how fresh the redispatch actually is".
        claimed.state.clock.play_start_time -= 120.0
        assert radio_is_buffering(claimed) is False

        with patch.object(SonosDelivery, "play", new=AsyncMock()):
            self._report_problem(client)

        assert radio_is_buffering(claimed) is True

    def test_does_not_move_the_displayed_position_on_redispatch(self, client, claimed):
        """restream_from() re-bases the *stream-start* reference only —
        elapsed() itself, what the seek bar's "Live · {time}" label
        actually shows, must keep reading the same value it did a moment
        ago. A real jump here would be its own, worse bug: the displayed
        time skipping backward for a redispatch nobody but Beacon knows
        happened."""
        claimed.state.radio_info = {**claimed.state.radio_info, "relayed": True}
        claimed.state.clock.start()
        claimed.state.clock.play_start_time -= 120.0
        before = claimed.state.clock.elapsed()

        with patch.object(SonosDelivery, "play", new=AsyncMock()):
            self._report_problem(client)

        assert claimed.state.clock.elapsed() == pytest.approx(before, abs=1.0)

    def test_a_failed_redispatch_leaves_buffering_alone(self, client, claimed):
        """No fresh dispatch actually reached the device, so there is
        nothing for it to buffer — re-basing the clock here would just
        make the seek bar lie about a redispatch that never happened."""
        claimed.state.radio_info = {**claimed.state.radio_info, "relayed": True}
        claimed.state.clock.start()
        claimed.state.clock.play_start_time -= 120.0
        assert radio_is_buffering(claimed) is False

        with patch.object(SonosDelivery, "play", new=AsyncMock(side_effect=RuntimeError("boom"))):
            self._report_problem(client)

        assert radio_is_buffering(claimed) is False
