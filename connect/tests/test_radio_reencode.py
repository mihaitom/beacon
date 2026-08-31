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
from unittest.mock import AsyncMock, patch

import pytest

from core.claims import claims
from core.stream_format import ProbedStream
from core.streamer import REASON_DEVICE_REJECTED_STREAM
from delivery import ChromecastDelivery, SonosDelivery
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
