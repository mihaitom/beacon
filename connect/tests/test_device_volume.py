"""Tests for core/device_volume.py — a device reporting its own volume."""

import asyncio
import threading

import pytest

from core.claims import claims
from core.device_volume import (
    _reset_for_tests,
    capture_main_loop,
    clear_pushes_volume,
    mark_pushes_volume,
    pushes_volume,
    record_pushed_volume,
    report_volume_from_thread,
)


@pytest.fixture(autouse=True)
def _clean_registry():
    _reset_for_tests()
    yield
    _reset_for_tests()


async def test_a_reading_reaches_the_session_that_claimed_the_device(default_session):
    await claims.claim("chromecast", "Kitchen", default_session.session_id)

    assert await record_pushed_volume("chromecast", "Kitchen", volume=40, muted=False) is True
    assert default_session.state.device_volumes["chromecast:Kitchen"] == (40, False)


async def test_a_reading_for_a_device_nobody_claims_is_dropped(default_session):
    # Not an error: the app was closed, the device was released, or this is
    # simply a stray report from a subscription nobody cancelled.
    assert await record_pushed_volume("dlna", "Nobody", volume=40) is False
    assert default_session.state.device_volumes == {}


async def test_one_half_of_a_reading_leaves_the_other_alone(default_session):
    """A RenderingControl event often carries Volume or Mute, not both."""
    await claims.claim("sonos", "Küche", default_session.session_id)

    await record_pushed_volume("sonos", "Küche", volume=30, muted=False)
    await record_pushed_volume("sonos", "Küche", muted=True)

    assert default_session.state.device_volumes["sonos:Küche"] == (30, True)


async def test_a_reading_is_broadcast_so_every_client_sees_it(default_session):
    await claims.claim("sonos", "Küche", default_session.session_id)
    queue = default_session.event_bus.subscribe()

    await record_pushed_volume("sonos", "Küche", volume=30)

    assert queue.get_nowait()["targets"] is not None


def test_which_devices_push_is_tracked_per_device():
    assert pushes_volume("dlna", "Beamer") is False

    mark_pushes_volume("dlna", "Beamer")
    assert pushes_volume("dlna", "Beamer") is True
    # A second renderer of the same type is a separate question: whether a
    # DLNA device accepts a subscription is a fact about that device.
    assert pushes_volume("dlna", "Soundbar") is False

    clear_pushes_volume("dlna", "Beamer")
    assert pushes_volume("dlna", "Beamer") is False


async def test_a_report_from_another_thread_lands_on_the_loop(default_session):
    """pychromecast calls its listeners from its own connection thread —
    the one report here that doesn't already arrive on the event loop."""
    capture_main_loop()
    await claims.claim("chromecast", "Kitchen", default_session.session_id)

    done = threading.Event()

    def from_pychromecast():
        report_volume_from_thread("chromecast", "Kitchen", volume=77, muted=False)
        done.set()

    threading.Thread(target=from_pychromecast).start()
    done.wait(timeout=2)
    # The coroutine was scheduled on this loop, not run on that thread.
    for _ in range(20):
        await asyncio.sleep(0.01)
        if "chromecast:Kitchen" in default_session.state.device_volumes:
            break

    assert default_session.state.device_volumes["chromecast:Kitchen"] == (77, False)


def test_a_report_before_the_app_started_is_dropped_rather_than_raising():
    """On somebody else's thread nothing would catch it, and a volume
    reading is not worth taking that thread down for."""
    import core.device_volume as module

    module._main_loop = None
    report_volume_from_thread("chromecast", "Kitchen", volume=10)


# ── The two devices that had no push at all before ──────────────────────────


async def test_a_dlna_renderer_that_accepts_a_subscription_stops_being_polled(monkeypatch):
    """Its own event URL, from its own device description — unlike Sonos
    there is no fixed path to assume."""
    from delivery.dlna import DlnaDelivery

    service = type("Service", (), {"event_sub_url": "http://10.0.0.9:49152/evt/RenderingControl"})()
    device = type(
        "Device", (), {"profile_device": type("P", (), {"service": lambda self, _: service})()}
    )()
    subscribed: dict = {}

    async def fake_subscribe(label, service_name, event_url, callback_url):
        subscribed.update(
            label=label, service=service_name, event_url=event_url, callback=callback_url
        )
        return object()

    monkeypatch.setattr("core.upnp_events.subscribe", fake_subscribe)

    await DlnaDelivery("Beamer")._subscribe_to_volume_events(device)

    assert subscribed["service"] == "renderingcontrol"
    assert subscribed["event_url"] == "http://10.0.0.9:49152/evt/RenderingControl"
    # The callback names the type, so the reading reaches the session that
    # claimed *this* device rather than a Sonos of the same name.
    assert "/dlna/renderingcontrol/Beamer" in subscribed["callback"]
    assert pushes_volume("dlna", "Beamer") is True


async def test_a_dlna_renderer_that_refuses_one_keeps_being_polled(monkeypatch):
    from delivery.dlna import DlnaDelivery

    service = type("Service", (), {"event_sub_url": "http://10.0.0.9:49152/evt/RenderingControl"})()
    device = type(
        "Device", (), {"profile_device": type("P", (), {"service": lambda self, _: service})()}
    )()

    async def refuses(*_args, **_kwargs):
        return None

    monkeypatch.setattr("core.upnp_events.subscribe", refuses)

    await DlnaDelivery("Soundbar")._subscribe_to_volume_events(device)

    assert pushes_volume("dlna", "Soundbar") is False


async def test_a_renderer_without_a_rendering_control_service_is_left_alone(monkeypatch):
    from delivery.dlna import DlnaDelivery

    device = type(
        "Device", (), {"profile_device": type("P", (), {"service": lambda self, _: None})()}
    )()
    called = False

    async def fake_subscribe(*_args, **_kwargs):
        nonlocal called
        called = True
        return object()

    monkeypatch.setattr("core.upnp_events.subscribe", fake_subscribe)

    await DlnaDelivery("Radio")._subscribe_to_volume_events(device)

    assert called is False
    assert pushes_volume("dlna", "Radio") is False


def test_a_chromecast_listener_reports_what_the_device_says(default_session):
    """pychromecast hands the listener a CastStatus on every change the
    device makes, including ones nothing here asked for (the TV remote, the
    Google Home app)."""
    from delivery.chromecast import _VolumeListener

    reported: dict = {}
    import core.device_volume as module

    monkey = module.report_volume_from_thread
    module.report_volume_from_thread = lambda *a, **kw: reported.update(args=a, kwargs=kw)
    try:
        _VolumeListener("Kitchen").new_cast_status(
            type("CastStatus", (), {"volume_level": 0.42, "volume_muted": True})()
        )
    finally:
        module.report_volume_from_thread = monkey

    assert reported["args"] == ("chromecast", "Kitchen")
    assert reported["kwargs"] == {"volume": 42, "muted": True}


def test_a_chromecast_status_without_a_level_reports_nothing(default_session):
    import core.device_volume as module
    from delivery.chromecast import _VolumeListener

    calls = []
    monkey = module.report_volume_from_thread
    module.report_volume_from_thread = lambda *a, **kw: calls.append(a)
    try:
        _VolumeListener("Kitchen").new_cast_status(type("CastStatus", (), {"volume_level": None})())
    finally:
        module.report_volume_from_thread = monkey

    assert calls == []
