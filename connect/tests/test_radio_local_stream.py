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
        start.assert_awaited_once_with(STATION, "audio/mpeg")
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
        start.assert_awaited_once_with(STATION, "audio/mpeg")

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
