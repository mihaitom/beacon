"""Tests for core/stream_diagnostics.py and GET /stream-diagnostics — what
Now Playing's overlay shows about a cast stream while the log level is
DEBUG (#56): per target, what was sent, where the device is, how far ahead
of it the sent audio runs, and what the device asked for."""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core import upnp_events
from core.state import StreamConnection
from core.stream_diagnostics import describe_stream
from delivery import (
    AirPlayDelivery,
    ChromecastDelivery,
    DeliveryManager,
    DlnaDelivery,
    SonosDelivery,
)
from delivery.chromecast import _MediaReportListener
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


def _playing(default_session, at: float = 100.0, delivery=None):
    st = default_session.state
    st.current_track = Track("1", "Song", "Artist", 400, "")
    st.is_streaming = True
    st.clock.start(at)
    if delivery is None:
        delivery = SonosDelivery("Study")
        delivery.stream_peer = "10.0.0.5"
    st.active_delivery = delivery
    return st


def _connection(st, peer="10.0.0.5", sender=None, *, start=0.0, sent=60.0):
    """An open connection that has handed its device `sent` seconds of
    audio from `start` on."""
    conn = StreamConnection(
        generation=st.clock.play_generation, start=start, peer=peer, sender=sender
    )
    conn.on_progress(audio_seconds=sent, total_bytes=2_400_000)
    conn.bytes_delivered = 2_400_000
    st.recent_streams.append(conn)
    return conn


def _target(described, name):
    return next(t for t in described["targets"] if t["name"] == name)


def test_a_connection_shows_what_it_sent_in_seconds_of_audio(default_session):
    """ffmpeg's ratio of seconds to bytes turns what the device has taken
    into audio: half of what was written is half its seconds."""
    st = _playing(default_session)
    conn = StreamConnection(
        generation=st.clock.play_generation, start=100.0, model="S3", peer="10.0.0.5"
    )
    conn.on_progress(audio_seconds=300.0, total_bytes=12_000_000)
    conn.bytes_delivered = 6_000_000
    st.open_streams.append(conn)
    st.recent_streams.append(conn)

    described = describe_stream(default_session)["targets"][0]["connection"]

    assert described["open"] is True
    assert described["current"] is True
    assert described["model"] == "S3"
    assert described["audio_end"] == pytest.approx(250.0)


def test_the_buffer_ahead_is_the_audio_sent_beyond_where_the_device_is(default_session):
    st = _playing(default_session)
    _connection(st, start=100.0)
    # The device said 30s into its stream 2s ago: at 132s of the track now.
    st.device_reading = (st.clock.play_generation, time.time() - 2.0, 30.0, "Study")

    described = describe_stream(default_session)["targets"][0]

    assert described["device"]["position"] == pytest.approx(130.0)
    assert described["ahead"] == pytest.approx(160.0 - 132.0, abs=0.2)


def test_no_buffer_is_claimed_for_a_device_that_stopped(default_session):
    st = _playing(default_session)
    _connection(st, start=100.0)
    st.device_reading = (st.clock.play_generation, time.time(), 0.0, "Study")
    upnp_events.handle_event("Study", _EVENT.format(state="STOPPED", status="ERROR_BUFFERING"))

    described = describe_stream(default_session)["targets"][0]

    assert described["ahead"] is None
    assert described["state"] == "STOPPED"
    assert described["problem"] == "ERROR_BUFFERING"


def _dlna_reporting(**state_variables):
    """A renderer whose last poll left these AVTransport variables."""
    service = MagicMock()
    service.has_state_variable.side_effect = lambda name: name in state_variables
    service.state_variable.side_effect = lambda name: MagicMock(value=state_variables[name])
    device = MagicMock()
    device.async_update = AsyncMock()
    device.media_position = 30
    device.profile_device.service_id.return_value = service
    return device


def test_a_dlna_renderer_reports_its_state_on_the_poll_it_already_gets(default_session):
    """No eventing of its own, unlike a Sonos: the position poll's
    GetTransportInfo is what says it stopped, and why."""
    st = _playing(default_session)
    st.active_delivery = DlnaDelivery("Receiver")
    device = _dlna_reporting(TransportState="STOPPED", TransportStatus="ERROR_OCCURRED")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        asyncio.run(st.active_delivery.get_position())

    target = describe_stream(default_session)["targets"][0]

    assert target["state"] == "STOPPED"
    assert target["problem"] == "ERROR_OCCURRED"


def test_a_healthy_dlna_renderer_reports_no_problem(default_session):
    st = _playing(default_session)
    st.active_delivery = DlnaDelivery("Receiver")
    device = _dlna_reporting(TransportState="PLAYING", TransportStatus="OK")
    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        asyncio.run(st.active_delivery.get_position())

    target = describe_stream(default_session)["targets"][0]

    assert target["state"] == "PLAYING"
    assert target["problem"] is None


def test_a_chromecast_reports_its_player_state_and_a_playback_error(default_session):
    st = _playing(default_session)
    st.active_delivery = ChromecastDelivery("Kitchen")
    listener = _MediaReportListener("Kitchen")

    listener.new_media_status(MagicMock(player_state="PLAYING", idle_reason=None))
    assert describe_stream(default_session)["targets"][0]["state"] == "PLAYING"

    listener.new_media_status(MagicMock(player_state="IDLE", idle_reason="ERROR"))
    target = describe_stream(default_session)["targets"][0]
    assert target["state"] == "IDLE (ERROR)"
    assert target["problem"] is not None


def test_a_chromecast_finishing_a_track_is_not_a_problem(default_session):
    """FINISHED and INTERRUPTED are what every track change leaves behind."""
    st = _playing(default_session)
    st.active_delivery = ChromecastDelivery("Kitchen")
    listener = _MediaReportListener("Kitchen")

    listener.new_media_status(MagicMock(player_state="IDLE", idle_reason="INTERRUPTED"))
    listener.new_media_status(MagicMock(player_state="IDLE", idle_reason="FINISHED"))

    assert describe_stream(default_session)["targets"][0]["problem"] is None


def test_a_chromecast_refusing_to_load_is_a_problem(default_session):
    st = _playing(default_session)
    st.active_delivery = ChromecastDelivery("Kitchen")

    _MediaReportListener("Kitchen").load_media_failed(1, 104)

    assert "104" in describe_stream(default_session)["targets"][0]["problem"]


def test_a_reading_from_an_earlier_stream_is_not_shown(default_session):
    st = _playing(default_session)
    st.device_reading = (st.clock.play_generation - 1, time.time(), 30.0, "Study")

    assert describe_stream(default_session)["targets"][0]["device"] is None


def test_the_route_lists_what_the_device_asked_for(client, default_session):
    """Newest first: the HEAD a Sonos sends shortly before it runs dry, a
    byte range, ICY metadata."""
    st = _playing(default_session)
    st.active_delivery.stream_peer = "testclient"
    client.head(
        f"/stream/{default_session.session_id}",
        headers={"User-Agent": "Linux UPnP/1.0 Sonos/86.10-81100 (ZPS3)", "Icy-MetaData": "1"},
    )

    requests = client.get("/stream-diagnostics").json()["targets"][0]["requests"]

    assert requests[0]["method"] == "HEAD"
    assert requests[0]["model"] == "S3"
    assert requests[0]["icy"] == "1"


def test_a_request_turned_away_says_so(client, default_session):
    """A speaker resumed from its own app after Beacon took the stream for
    stopped is answered 204 - the request most worth seeing."""
    st = _playing(default_session)
    st.active_delivery.stream_peer = "testclient"
    st.is_streaming = False
    st.streamed_generation = st.clock.play_generation

    client.get(f"/stream/{default_session.session_id}", headers={"User-Agent": "Sonos (ZPS57)"})

    request = client.get("/stream-diagnostics").json()["targets"][0]["requests"][0]
    assert request["method"] == "GET"
    assert request["answer"] == "204, stopped"


# --- Several targets at once ------------------------------------------------


def _cast_to_three(default_session):
    kitchen = ChromecastDelivery("Kitchen")
    kitchen.stream_peer = "10.0.0.7"
    receiver = DlnaDelivery("Receiver")
    receiver.stream_peer = "10.0.0.9"
    den = AirPlayDelivery("Den")
    return _playing(
        default_session, delivery=DeliveryManager.from_deliveries([kitchen, receiver, den])
    )


def test_each_target_shows_its_own_connection(default_session):
    """The point of telling them apart: one speaker that stopped reading is
    seen as that speaker, not hidden behind another one reading fine."""
    st = _cast_to_three(default_session)
    _connection(st, peer="10.0.0.7", sent=300.0)
    stalled = _connection(st, peer="10.0.0.9", sent=40.0)
    stalled.last_handoff -= 120
    _connection(st, peer="10.0.0.2", sender="Den", sent=200.0)

    described = describe_stream(default_session)

    assert [t["name"] for t in described["targets"]] == ["Kitchen", "Receiver", "Den"]
    assert _target(described, "Kitchen")["connection"]["audio_end"] == pytest.approx(300.0)
    assert _target(described, "Receiver")["connection"]["last_read"] > 100
    assert _target(described, "Den")["connection"]["audio_end"] == pytest.approx(200.0)


def test_the_buffer_ahead_is_only_claimed_for_the_target_that_reported_a_position(
    default_session,
):
    """Only one target is asked for its position; another's buffer would be
    measured against a device it is not."""
    st = _cast_to_three(default_session)
    _connection(st, peer="10.0.0.7", sent=300.0)
    _connection(st, peer="10.0.0.9", sent=40.0)
    st.device_reading = (st.clock.play_generation, time.time(), 30.0, "Receiver")

    described = describe_stream(default_session)

    assert _target(described, "Kitchen")["ahead"] is None
    assert _target(described, "Kitchen")["device"] is None
    assert _target(described, "Receiver")["ahead"] == pytest.approx(40.0 - 130.0, abs=0.2)


def test_a_target_whose_device_stopped_claims_no_buffer_while_another_plays(default_session):
    st = _cast_to_three(default_session)
    _connection(st, peer="10.0.0.9", sent=300.0)
    st.device_reading = (st.clock.play_generation, time.time(), 30.0, "Receiver")
    _MediaReportListener("Kitchen").new_media_status(
        MagicMock(player_state="IDLE", idle_reason="ERROR")
    )

    described = describe_stream(default_session)

    assert _target(described, "Kitchen")["problem"] is not None
    assert _target(described, "Receiver")["ahead"] is not None


def test_a_sonos_follower_names_its_coordinator_instead_of_a_connection(default_session):
    study = SonosDelivery("Study")
    study.stream_peer = "10.0.0.5"
    st = _playing(
        default_session,
        delivery=DeliveryManager.from_deliveries([study, SonosDelivery("Lounge")]),
    )
    _connection(st, peer="10.0.0.5")

    described = describe_stream(default_session)

    assert _target(described, "Study")["follows"] is None
    assert _target(described, "Study")["connection"] is not None
    assert _target(described, "Lounge")["follows"] == "Study"
    assert _target(described, "Lounge")["connection"] is None


def test_a_request_from_an_address_no_target_has_is_listed_on_its_own(client, default_session):
    """A speaker playing on from its own app after it was dropped, turned
    away with a 204 - the request most worth seeing, so it is not hidden
    for having no target to go under."""
    st = _cast_to_three(default_session)
    st.is_streaming = False
    st.streamed_generation = st.clock.play_generation

    client.get(f"/stream/{default_session.session_id}", headers={"User-Agent": "Sonos (ZPS57)"})

    stranger = client.get("/stream-diagnostics").json()["targets"][-1]
    assert stranger["type"] is None
    assert stranger["name"] == "testclient"
    assert stranger["requests"][0]["answer"] == "204, stopped"


def test_the_route_puts_connect_s_own_fetch_under_the_airplay_target_it_names(
    client, default_session
):
    """Every AirPlay fetch comes from connect's own address; the name on the
    URL is what tells two AirPlay targets apart."""
    _cast_to_three(default_session)
    client.head(f"/stream/{default_session.session_id}.mp3?sender=Den")

    described = client.get("/stream-diagnostics").json()

    assert _target(described, "Den")["requests"][0]["method"] == "HEAD"
    assert all(t["type"] is not None for t in described["targets"])
