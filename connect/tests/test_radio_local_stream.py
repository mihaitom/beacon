"""Tests for routes/stream.py's /stream/radio-local — the relayed station
served to the app's own `<audio>` element rather than to a cast device,
and the teardown that goes with it.

The reason this route exists is timing: a station that stops sending
without closing the connection is invisible to a browser (no error is ever
reported, the element simply goes quiet), while the relay sees the same
silence directly and reconnects behind a response it never closes. See
that route's own docstring, and core/radio_relay.py's
_STALL_TIMEOUT_SECONDS for the other half.
"""

import asyncio
import logging
from unittest.mock import AsyncMock, patch

import pytest

from core.stream_format import ProbedStream

STATION = "http://mp3channels.webradio.rockantenne.de/rockantenne"


class FakeRelay:
    """Only what the route touches. `connected` is deliberately settable:
    the route must serve a relay that has not reached the station yet just
    the same, since subscribing to one that is still retrying is the whole
    point of it holding the connection."""

    def __init__(self, url=STATION, chunks=(b"relayed-audio",), connected=True):
        self.url = url
        self.device_content_type = "audio/mpeg"
        self.connected = connected
        self._chunks = list(chunks)
        self.unsubscribed = None
        self.burst_requested = None

    def subscribe_audio(self, *, burst=False):
        self.burst_requested = burst
        q = asyncio.Queue()
        for chunk in self._chunks:
            q.put_nowait(chunk)
        q.put_nowait(None)
        return q

    def unsubscribe_audio(self, q):
        self.unsubscribed = q


@pytest.fixture
def probed():
    with patch(
        "routes.stream.probe_stream",
        new=AsyncMock(return_value=ProbedStream(content_type="audio/mpeg")),
    ) as probe:
        yield probe


class TestLocalRadioStream:
    def test_starts_a_relay_for_the_station_and_serves_it(self, client, default_session, probed):
        relay = FakeRelay()
        with patch.object(
            type(default_session), "start_radio_relay", new=AsyncMock(return_value=relay)
        ) as start:
            r = client.get(f"/stream/radio-local?url={STATION}")

        assert r.status_code == 200
        assert r.headers["content-type"].startswith("audio/mpeg")
        assert r.content == b"relayed-audio"
        # "aac" rather than None even though nothing was asked for: see
        # relay_format_for_target(), where "original" aims at AAC wherever
        # the target takes it - which is what keeps an AAC station from
        # being re-encoded to MP3 on its way to a listener who never asked
        # for a conversion at all.
        start.assert_awaited_once_with(
            STATION, "audio/mpeg", max_bitrate_kbps=None, preferred_format="aac"
        )
        # Released again on the way out, exactly like a cast device's own
        # connection to /stream/radio — a relay outlives any one connection
        # to it, and a subscriber never removed is a queue filled forever.
        assert relay.unsubscribed is not None
        # Everything the relay emits is paced to real time, so a player fed
        # from it holds no buffer of its own — the burst is what replaces
        # the few seconds an Icecast server hands a client up front, and
        # without it every brief loss of connection is audible. The whole
        # reason this matters more here than for casting: this is the path
        # someone listens on away from home.
        assert relay.burst_requested is True

    def test_logs_how_long_the_connection_stood(self, client, default_session, probed, caplog):
        """Opening one of these was the only half that got recorded, which
        made a player reconnecting mid-stream look exactly like a player
        that had been listening all along — several short connections and
        one long one read the same in the log."""
        relay = FakeRelay()

        with (
            patch.object(
                type(default_session), "start_radio_relay", new=AsyncMock(return_value=relay)
            ),
            caplog.at_level(logging.INFO, logger="connect.stream"),
        ):
            r = client.get(f"/stream/radio-local?url={STATION}")

        assert r.status_code == 200
        assert "Serving relayed radio to a local player" in caplog.text
        assert "Relayed radio to a local player ended after" in caplog.text

    def test_reuses_a_relay_already_running_for_the_same_station(
        self, client, default_session, probed
    ):
        """The element re-requests this URL on every reconnect of its own,
        which is exactly when the station is least able to answer a second
        connection — so a running relay must be joined, not re-probed and
        restarted."""
        default_session.radio_relay = FakeRelay()

        with patch.object(type(default_session), "start_radio_relay", new=AsyncMock()) as start:
            r = client.get(f"/stream/radio-local?url={STATION}")

        assert r.status_code == 200
        start.assert_not_awaited()
        probed.assert_not_awaited()

    def test_starts_a_fresh_relay_for_a_different_station(self, client, default_session, probed):
        default_session.radio_relay = FakeRelay(url="http://some-other-station")
        relay = FakeRelay()

        with patch.object(
            type(default_session), "start_radio_relay", new=AsyncMock(return_value=relay)
        ) as start:
            r = client.get(f"/stream/radio-local?url={STATION}")

        assert r.status_code == 200
        start.assert_awaited_once_with(
            STATION, "audio/mpeg", max_bitrate_kbps=None, preferred_format="aac"
        )

    def test_passes_this_devices_own_quality_ceiling_to_the_relay(
        self, client, default_session, probed
    ):
        """Local radio comes through the relay too, so the setting for this
        device applies to a station the same way it applies to a song."""
        relay = FakeRelay()

        with patch.object(
            type(default_session), "start_radio_relay", new=AsyncMock(return_value=relay)
        ) as start:
            r = client.get(f"/stream/radio-local?url={STATION}&max_bitrate_kbps=96")

        assert r.status_code == 200
        start.assert_awaited_once_with(
            STATION, "audio/mpeg", max_bitrate_kbps=96, preferred_format="aac"
        )

    def test_passes_the_chosen_format_on_as_well(self, client, default_session, probed):
        relay = FakeRelay()

        with patch.object(
            type(default_session), "start_radio_relay", new=AsyncMock(return_value=relay)
        ) as start:
            r = client.get(f"/stream/radio-local?url={STATION}&max_bitrate_kbps=96&format=aac")

        assert r.status_code == 200
        start.assert_awaited_once_with(
            STATION, "audio/mpeg", max_bitrate_kbps=96, preferred_format="aac"
        )

    def test_opus_asks_the_relay_for_aac_rather_than_dropping_to_mp3(
        self, client, default_session, probed
    ):
        """There is no Opus encoder in the relay. AAC is the closest thing
        it can produce, and every browser that plays Opus plays AAC — so
        the listener keeps the better of the two rather than landing on the
        format they went out of their way not to pick."""
        relay = FakeRelay()

        with patch.object(
            type(default_session), "start_radio_relay", new=AsyncMock(return_value=relay)
        ) as start:
            r = client.get(f"/stream/radio-local?url={STATION}&format=opus")

        assert r.status_code == 200
        start.assert_awaited_once_with(
            STATION, "audio/mpeg", max_bitrate_kbps=None, preferred_format="aac"
        )

    def test_a_reconnect_never_restarts_a_running_relay_over_a_ceiling(
        self, client, default_session, probed
    ):
        """The element re-requests this URL on every reconnect. Restarting
        the relay because the ceiling in the URL differs from the one it is
        running under would mean local playback and a cast device taking
        turns tearing down the same station — see /play-url, which is the
        one side allowed to win that argument."""
        default_session.radio_relay = FakeRelay()

        with patch.object(type(default_session), "start_radio_relay", new=AsyncMock()) as start:
            r = client.get(f"/stream/radio-local?url={STATION}&max_bitrate_kbps=96")

        assert r.status_code == 200
        start.assert_not_awaited()

    def test_answers_200_while_the_relay_is_still_trying_to_reach_the_station(
        self, client, default_session, probed
    ):
        """Not an error status, deliberately. A non-2xx is reported by an
        `<audio>` element as an unsupported source — the one MediaError
        code its own reconnect logic correctly refuses to retry (see
        audioEngine.ts's MEDIA_ERR_NETWORK) — so answering one here would
        turn a station that is briefly unreachable into a station this
        device gives up on outright."""
        relay = FakeRelay(chunks=(), connected=False)

        with patch.object(
            type(default_session), "start_radio_relay", new=AsyncMock(return_value=relay)
        ):
            r = client.get(f"/stream/radio-local?url={STATION}")

        assert r.status_code == 200


class TestLocalRelayTeardown:
    """/radio-metadata/stop is the client's own "radio has stopped" signal
    and now speaks for the relay as well — see its docstring."""

    def test_stops_a_relay_local_playback_started(self, client, default_session):
        default_session.radio_relay = FakeRelay()

        with patch.object(type(default_session), "stop_radio_relay", new=AsyncMock()) as stop:
            r = client.post("/radio-metadata/stop")

        assert r.status_code == 200
        stop.assert_awaited_once()

    def test_leaves_a_casting_sessions_relay_alone(self, client, default_session):
        """The client calls this on its way through every radio stop,
        including the ones where casting carries on (leaveRadio() in
        stores/playback.ts). radio_info is set by /play-url and nothing
        else, so it is exactly the question "is a device being fed from
        this?" — without the guard, stopping radio here would cut a
        speaker off mid-song."""
        default_session.radio_relay = FakeRelay()
        default_session.state.radio_info = {"title": "Rock Antenne", "url": STATION}

        with patch.object(type(default_session), "stop_radio_relay", new=AsyncMock()) as stop:
            r = client.post("/radio-metadata/stop")

        assert r.status_code == 200
        stop.assert_not_awaited()
