"""Tests for core/stream_diagnostics.py and GET /stream-diagnostics — what
Now Playing's overlay shows about a cast stream while the log level is
DEBUG (#56): what was sent, where the device is, how far ahead of it the
sent audio runs, and what the device asked for."""

import time

import pytest

from core import upnp_events
from core.state import StreamConnection
from core.stream_diagnostics import describe_stream
from delivery import SonosDelivery
from media import Track

# A LastChange shaped like a Sonos's (see test_upnp_events.py).
_EVENT = (
    '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>'
    "&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;"
    "&lt;TransportState val=&quot;{state}&quot;/&gt;"
    "&lt;TransportStatus val=&quot;{status}&quot;/&gt;"
    "&lt;/InstanceID&gt;&lt;/Event&gt;"
    "</LastChange></e:property></e:propertyset>"
)


def _playing(default_session, at: float = 100.0):
    st = default_session.state
    st.current_track = Track("1", "Song", "Artist", 400, "")
    st.is_streaming = True
    st.clock.start(at)
    st.active_delivery = SonosDelivery("Study")
    return st


def test_a_connection_shows_what_it_sent_in_seconds_of_audio(default_session):
    """ffmpeg's ratio of seconds to bytes turns what the device has taken
    into audio: half of what was written is half its seconds."""
    st = _playing(default_session)
    conn = StreamConnection(generation=st.clock.play_generation, start=100.0, model="S3")
    conn.on_progress(audio_seconds=300.0, total_bytes=12_000_000)
    conn.bytes_delivered = 6_000_000
    st.open_streams.append(conn)
    st.recent_streams.append(conn)

    described = describe_stream(default_session)["connections"][0]

    assert described["open"] is True
    assert described["current"] is True
    assert described["model"] == "S3"
    assert described["audio_end"] == pytest.approx(250.0)


def test_the_buffer_ahead_is_the_audio_sent_beyond_where_the_device_is(default_session):
    st = _playing(default_session)
    conn = StreamConnection(generation=st.clock.play_generation, start=100.0)
    conn.on_progress(audio_seconds=60.0, total_bytes=2_400_000)
    conn.bytes_delivered = 2_400_000
    st.recent_streams.append(conn)
    # The device said 30s into its stream 2s ago: at 132s of the track now.
    st.device_reading = (st.clock.play_generation, time.time() - 2.0, 30.0)

    described = describe_stream(default_session)

    assert described["device"]["position"] == pytest.approx(130.0)
    assert described["ahead"] == pytest.approx(160.0 - 132.0, abs=0.2)


def test_no_buffer_is_claimed_for_a_device_that_stopped(default_session):
    st = _playing(default_session)
    conn = StreamConnection(generation=st.clock.play_generation, start=100.0)
    conn.on_progress(audio_seconds=60.0, total_bytes=2_400_000)
    st.recent_streams.append(conn)
    st.device_reading = (st.clock.play_generation, time.time(), 0.0)
    upnp_events.handle_event("Study", _EVENT.format(state="STOPPED", status="ERROR_BUFFERING"))

    described = describe_stream(default_session)

    assert described["ahead"] is None
    assert described["targets"][0]["state"] == "STOPPED"
    assert described["targets"][0]["problem"] == "ERROR_BUFFERING"


def test_a_reading_from_an_earlier_stream_is_not_shown(default_session):
    st = _playing(default_session)
    st.device_reading = (st.clock.play_generation - 1, time.time(), 30.0)

    assert describe_stream(default_session)["device"] is None


def test_the_route_lists_what_the_device_asked_for(client, default_session):
    """Newest first: the HEAD a Sonos sends shortly before it runs dry, a
    byte range, ICY metadata."""
    _playing(default_session)
    client.head(
        f"/stream/{default_session.session_id}",
        headers={"User-Agent": "Linux UPnP/1.0 Sonos/86.10-81100 (ZPS3)", "Icy-MetaData": "1"},
    )

    requests = client.get("/stream-diagnostics").json()["requests"]

    assert requests[0]["method"] == "HEAD"
    assert requests[0]["model"] == "S3"
    assert requests[0]["icy"] == "1"


def test_a_request_turned_away_says_so(client, default_session):
    """A speaker resumed from its own app after Beacon took the stream for
    stopped is answered 204 - the request most worth seeing."""
    st = _playing(default_session)
    st.is_streaming = False
    st.streamed_generation = st.clock.play_generation

    client.get(f"/stream/{default_session.session_id}", headers={"User-Agent": "Sonos (ZPS57)"})

    request = client.get("/stream-diagnostics").json()["requests"][0]
    assert request["method"] == "GET"
    assert request["answer"] == "204, stopped"
