"""Tests for core/local_address.py — handing each device the address this
machine has in the device's own network (#56)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import delivery.sonos as sonos_module
from core import local_address, upnp_events
from core.local_address import for_device, on_default_address
from core.local_address import local_ip_towards as real_local_ip_towards
from core.session import SessionState, is_this_sessions_stream
from core.state import PORT, stream_url
from delivery import ChromecastDelivery, DlnaDelivery, SonosDelivery
from routes.upnp import callback_url_for

# This machine sits in two networks: the default route goes out through
# 10.0.1.0/24, and it has a leg of its own in 10.0.2.0/24, the speakers'.
DEFAULT = "10.0.1.5"
LEG = "10.0.2.5"
SPEAKER = "10.0.2.20"
BEHIND_THE_ROUTER = "10.0.3.7"


@pytest.fixture
def two_networks(monkeypatch):
    looked_up: list[str] = []

    def route(host: str) -> str:
        looked_up.append(host)
        return LEG if host.startswith("10.0.2.") else DEFAULT

    monkeypatch.setattr(local_address, "local_ip_towards", route)
    monkeypatch.setattr(local_address, "_is_own_address", lambda host: host in (DEFAULT, LEG))
    return looked_up


# ── for_device() ──────────────────────────────────────────────────────────────


def test_a_stream_moves_to_the_address_in_the_devices_network(two_networks):
    url = f"http://{DEFAULT}:{PORT}/stream/abc.mp3"
    assert for_device(url, SPEAKER) == f"http://{LEG}:{PORT}/stream/abc.mp3"


def test_a_device_behind_the_router_keeps_the_default_address(two_networks):
    url = f"http://{DEFAULT}:{PORT}/stream/abc.mp3"
    assert for_device(url, BEHIND_THE_ROUTER) == url


def test_a_stations_own_url_is_left_alone(two_networks):
    url = "http://stream.example.com:8000/live.mp3"
    assert for_device(url, SPEAKER) == url


def test_a_device_known_only_by_name_is_not_looked_up(two_networks):
    """A name would need a DNS lookup, which blocks the event loop."""
    url = f"http://{DEFAULT}:{PORT}/stream/abc"
    assert for_device(url, "speaker.local") == url
    assert for_device(url, None) == url
    assert "speaker.local" not in two_networks


def test_a_route_that_cannot_be_looked_up_leaves_the_url(monkeypatch):
    def unreachable(host: str) -> str:
        if host == SPEAKER:
            raise OSError("Network is unreachable")
        return DEFAULT

    monkeypatch.setattr(local_address, "local_ip_towards", unreachable)
    url = f"http://{DEFAULT}:{PORT}/stream/abc"
    assert for_device(url, SPEAKER) == url


# ── on_default_address() and the "still ours?" check ──────────────────────────


def test_a_reported_url_on_the_leg_compares_as_built(two_networks):
    reported = f"x-rincon-mp3radio://{LEG}:{PORT}/stream/radio/abc"
    assert on_default_address(reported) == f"x-rincon-mp3radio://{DEFAULT}:{PORT}/stream/radio/abc"


def test_a_device_playing_from_the_leg_still_plays_this_sessions_stream(two_networks):
    session = SessionState("abc")
    assert stream_url("abc") == f"http://{DEFAULT}:{PORT}/stream/abc"
    assert is_this_sessions_stream(session, f"http://{LEG}:{PORT}/stream/abc.flac")


def test_the_same_stream_from_another_machine_is_not_ours(two_networks):
    """Two Beacons signed in to one account share session ids, so only the
    address tells their streams apart."""
    session = SessionState("abc")
    assert not is_this_sessions_stream(session, f"http://10.0.2.99:{PORT}/stream/abc.flac")


def test_only_an_address_of_this_machine_counts_as_its_own():
    assert local_address._is_own_address("127.0.0.1")
    assert not local_address._is_own_address("192.0.2.1")  # TEST-NET-1, never assigned


def test_the_route_lookup_answers_with_this_machines_own_address():
    assert real_local_ip_towards("127.0.0.1") == "127.0.0.1"


# ── What each device is handed ────────────────────────────────────────────────


def test_an_event_callback_goes_to_the_address_in_the_devices_network(two_networks):
    assert callback_url_for("Room A", "renderingcontrol", "sonos", SPEAKER).startswith(
        f"http://{LEG}:{PORT}/"
    )
    assert callback_url_for("Room A").startswith(f"http://{DEFAULT}:{PORT}/")


async def test_a_sonos_fetches_its_stream_and_sends_its_events_on_its_own_network(
    two_networks, monkeypatch
):
    device = MagicMock()
    device.ip_address = SPEAKER
    device.is_coordinator = True
    device.get_current_transport_info.return_value = {"current_transport_state": "STOPPED"}
    callbacks: list[str] = []

    async def fake_subscribe(label, service, event_url, callback_url):
        callbacks.append(callback_url)

    monkeypatch.setattr(sonos_module, "subscribe", fake_subscribe)

    with patch.object(SonosDelivery, "_get_device", return_value=device):
        await SonosDelivery("Room A").play(f"http://{DEFAULT}:{PORT}/stream/abc.mp3", "Title")

    sent = dict(device.avTransport.SetAVTransportURI.call_args.args[0])
    assert sent["CurrentURI"] == f"http://{LEG}:{PORT}/stream/abc.mp3"
    assert f"http://{LEG}:{PORT}/stream/abc.mp3" in sent["CurrentURIMetaData"]
    assert len(callbacks) == 2
    assert all(c.startswith(f"http://{LEG}:{PORT}/") for c in callbacks)


async def test_a_dlna_renderer_fetches_its_stream_and_sends_its_events_on_its_own_network(
    two_networks, monkeypatch
):
    device = MagicMock()
    device.profile_device.device_url = f"http://{SPEAKER}:49152/description.xml"
    device.async_set_transport_uri = AsyncMock()
    device.async_wait_for_can_play = AsyncMock()
    service = MagicMock()
    service.event_sub_url = f"http://{SPEAKER}:49152/evt/RenderingControl"
    service.action.return_value.async_call = AsyncMock()
    device.profile_device.service_id.return_value = service
    callbacks: list[str] = []

    async def fake_subscribe(label, service_name, event_url, callback_url):
        callbacks.append(callback_url)

    monkeypatch.setattr(upnp_events, "subscribe", fake_subscribe)

    with patch.object(DlnaDelivery, "_get_device", new=AsyncMock(return_value=device)):
        await DlnaDelivery("Receiver").play(f"http://{DEFAULT}:{PORT}/stream/abc.mp3", "Title")

    uri, _title, metadata = device.async_set_transport_uri.call_args.args
    assert uri == f"http://{LEG}:{PORT}/stream/abc.mp3"
    assert uri in metadata
    assert callbacks == [callback_url_for("Receiver", "renderingcontrol", "dlna", SPEAKER)]
    assert callbacks[0].startswith(f"http://{LEG}:{PORT}/")


async def test_a_chromecast_fetches_its_stream_on_its_own_network(two_networks):
    cast = MagicMock()
    cast.cast_info.host = SPEAKER

    def play_media(*args, callback_function, **kwargs):
        callback_function(True, {"type": "MEDIA_STATUS"})

    cast.media_controller.play_media.side_effect = play_media

    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        await ChromecastDelivery("TV").play(f"http://{DEFAULT}:{PORT}/stream/abc.mp3", "Title")

    assert cast.media_controller.play_media.call_args.args[0] == (
        f"http://{LEG}:{PORT}/stream/abc.mp3"
    )
