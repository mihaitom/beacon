"""Tests for state helpers: compute_position, resolve_target, find_sonos."""

import asyncio
import time

from core.session import SessionState, compute_position
from core.state import EventBus, audio_capability_limits, find_sonos, resolve_target
from media import Track

# ── EventBus ──────────────────────────────────────────────────────────────────


async def test_event_bus_broadcast_delivers_to_every_subscriber():
    bus = EventBus()
    q1, q2 = bus.subscribe(), bus.subscribe()

    await bus.broadcast({"hello": "world"})

    assert q1.get_nowait() == {"hello": "world"}
    assert q2.get_nowait() == {"hello": "world"}


async def test_event_bus_broadcast_is_a_noop_with_no_subscribers():
    bus = EventBus()
    await bus.broadcast({"hello": "world"})  # must not raise


async def test_event_bus_broadcast_drops_updates_for_a_slow_consumer():
    """A subscriber that never drains its queue must not block every other
    (or future) broadcast — a slow/dead consumer just misses updates."""
    bus = EventBus()
    q = bus.subscribe()
    for i in range(q.maxsize + 5):
        await bus.broadcast({"i": i})

    assert q.full()
    assert q.qsize() == q.maxsize  # extra broadcasts past maxsize were dropped


def test_event_bus_unsubscribe_removes_the_queue():
    bus = EventBus()
    q = bus.subscribe()
    bus.unsubscribe(q)
    asyncio.run(bus.broadcast({"hello": "world"}))
    assert q.empty()


def test_event_bus_unsubscribe_unknown_queue_is_a_noop():
    bus = EventBus()
    bus.unsubscribe(asyncio.Queue())  # never subscribed — must not raise


# ── compute_position ──────────────────────────────────────────────────────────


def _session() -> SessionState:
    return SessionState("test")


def test_compute_position_no_track():
    assert compute_position(_session()) == 0.0


def test_compute_position_not_streaming():
    session = _session()
    session.state.current_track = Track("1", "T", "A", 180, "")
    session.state.is_streaming = False
    assert compute_position(session) == 0.0


def test_compute_position_no_start_time():
    session = _session()
    session.state.current_track = Track("1", "T", "A", 180, "")
    session.state.is_streaming = True
    session.state.clock.play_start_time = 0.0
    assert compute_position(session) == 0.0


def test_compute_position_paused():
    session = _session()
    session.state.current_track = Track("1", "T", "A", 180, "")
    session.state.is_streaming = True
    session.state.clock.play_start_time = time.time() - 9999
    session.state.clock.is_paused = True
    session.state.clock.paused_elapsed = 45.0

    assert abs(compute_position(session) - 45.0) < 0.1


def test_compute_position_playing():
    session = _session()
    session.state.current_track = Track("1", "T", "A", 180, "")
    session.state.is_streaming = True
    session.state.clock.play_start_time = time.time() - 30
    session.state.clock.is_paused = False

    assert abs(compute_position(session) - 30.0) < 1.0


def test_compute_position_clamps_to_duration():
    session = _session()
    session.state.current_track = Track("1", "T", "A", 60, "")
    session.state.is_streaming = True
    session.state.clock.play_start_time = time.time() - 9999
    session.state.clock.is_paused = False

    assert compute_position(session) == 60.0


def test_compute_position_applies_position_offset():
    """A device lagging behind the wall clock yields a negative offset,
    which compute_position subtracts back out."""
    session = _session()
    session.state.current_track = Track("1", "T", "A", 180, "")
    session.state.is_streaming = True
    session.state.clock.play_start_time = time.time() - 30
    session.state.clock.is_paused = False
    session.state.clock.position_offset = -4.0

    assert abs(compute_position(session) - 26.0) < 1.0


def test_compute_position_offset_clamps_to_zero():
    session = _session()
    session.state.current_track = Track("1", "T", "A", 180, "")
    session.state.is_streaming = True
    session.state.clock.play_start_time = time.time() - 1
    session.state.clock.is_paused = False
    session.state.clock.position_offset = -10.0

    assert compute_position(session) == 0.0


def test_compute_position_offset_clamps_to_duration():
    session = _session()
    session.state.current_track = Track("1", "T", "A", 30, "")
    session.state.is_streaming = True
    session.state.clock.play_start_time = time.time() - 28
    session.state.clock.is_paused = False
    session.state.clock.position_offset = 4.0

    assert compute_position(session) == 30.0


# ── resolve_target ────────────────────────────────────────────────────────────


def test_resolve_target_from_targets_list():
    from delivery import AirPlayDelivery, DeliveryManager, SonosDelivery

    result = resolve_target(
        targets=[
            {"type": "sonos", "name": "Küche"},
            {"type": "airplay", "name": "HomePod"},
        ]
    )
    assert isinstance(result, DeliveryManager)
    assert len(result.deliveries) == 2
    assert isinstance(result.deliveries[0], SonosDelivery)
    assert isinstance(result.deliveries[1], AirPlayDelivery)


def test_resolve_target_single_sonos():
    from delivery import SonosDelivery

    result = resolve_target(target_type="sonos", target_name="Wohnzimmer")
    assert isinstance(result, SonosDelivery)
    assert result.target == "Wohnzimmer"


def test_resolve_target_single_airplay():
    from delivery import AirPlayDelivery

    result = resolve_target(target_type="airplay", target_name="HomePod")
    assert isinstance(result, AirPlayDelivery)
    assert result.target == "HomePod"


def test_resolve_target_single_chromecast():
    from delivery import ChromecastDelivery

    result = resolve_target(target_type="chromecast", target_name="LivingRoom TV")
    assert isinstance(result, ChromecastDelivery)
    assert result.target == "LivingRoom TV"


def test_resolve_target_single_dlna():
    from delivery import DlnaDelivery

    result = resolve_target(target_type="dlna", target_name="Receiver")
    assert isinstance(result, DlnaDelivery)
    assert result.target == "Receiver"


def test_resolve_target_mixed_targets_list():
    from delivery import (
        AirPlayDelivery,
        ChromecastDelivery,
        DeliveryManager,
        DlnaDelivery,
        SonosDelivery,
    )

    result = resolve_target(
        targets=[
            {"type": "sonos", "name": "Küche"},
            {"type": "airplay", "name": "HomePod"},
            {"type": "chromecast", "name": "LivingRoom TV"},
            {"type": "dlna", "name": "Receiver"},
        ]
    )
    assert isinstance(result, DeliveryManager)
    assert len(result.deliveries) == 4
    assert isinstance(result.deliveries[0], SonosDelivery)
    assert isinstance(result.deliveries[1], AirPlayDelivery)
    assert isinstance(result.deliveries[2], ChromecastDelivery)
    assert isinstance(result.deliveries[3], DlnaDelivery)


def test_resolve_target_returns_none_when_no_config():
    result = resolve_target()
    assert result is None


def test_resolve_target_reuses_matching_previous_instance():
    """Regression test: a fresh instance on every /play left AirPlay's
    previous RAOP stream never explicitly stopped, racing the new connection
    for the device's single audio data port (Connection refused on track
    switch — see CHANGELOG). Switching to the same device must reuse the
    same delivery instance so its own play() can stop itself first."""
    from delivery import AirPlayDelivery

    first = resolve_target(target_type="airplay", target_name="HomePod")
    second = resolve_target(target_type="airplay", target_name="HomePod", previous=first)
    assert second is first
    assert isinstance(second, AirPlayDelivery)


def test_resolve_target_does_not_reuse_different_target():
    first = resolve_target(target_type="airplay", target_name="HomePod")
    second = resolve_target(target_type="airplay", target_name="Apple TV", previous=first)
    assert second is not first
    assert second.target == "Apple TV"


def test_resolve_target_does_not_reuse_different_type():
    from delivery import ChromecastDelivery

    first = resolve_target(target_type="airplay", target_name="Living Room")
    second = resolve_target(
        target_type="chromecast", target_name="Living Room", previous=first
    )
    assert second is not first
    assert isinstance(second, ChromecastDelivery)


def test_resolve_target_reuses_matching_member_of_previous_manager():
    from delivery import AirPlayDelivery, DeliveryManager

    first = resolve_target(
        targets=[
            {"type": "sonos", "name": "Küche"},
            {"type": "airplay", "name": "HomePod"},
        ]
    )
    assert isinstance(first, DeliveryManager)
    airplay_member = first.deliveries[1]

    second = resolve_target(target_type="airplay", target_name="HomePod", previous=first)
    assert second is airplay_member
    assert isinstance(second, AirPlayDelivery)


# ── find_sonos ────────────────────────────────────────────────────────────────


def test_find_sonos_from_sonos_delivery():
    from delivery import SonosDelivery

    d = SonosDelivery("Küche")
    result = find_sonos(d)
    assert result == [d]


def test_find_sonos_from_manager():
    from delivery import AirPlayDelivery, DeliveryManager, SonosDelivery

    s = SonosDelivery("Küche")
    a = AirPlayDelivery("HomePod")
    manager = DeliveryManager.from_deliveries([s, a])
    result = find_sonos(manager)
    assert result == [s]


def test_find_sonos_returns_empty_for_airplay_only():
    from delivery import AirPlayDelivery

    result = find_sonos(AirPlayDelivery("HomePod"))
    assert result == []


def test_find_sonos_returns_empty_for_chromecast_only():
    from delivery import ChromecastDelivery

    result = find_sonos(ChromecastDelivery("LivingRoom TV"))
    assert result == []


def test_find_sonos_returns_empty_for_dlna_only():
    from delivery import DlnaDelivery

    result = find_sonos(DlnaDelivery("Receiver"))
    assert result == []


def test_find_sonos_picks_sonos_from_mixed_manager():
    from delivery import (
        AirPlayDelivery,
        ChromecastDelivery,
        DeliveryManager,
        SonosDelivery,
    )

    s = SonosDelivery("Küche")
    manager = DeliveryManager.from_deliveries(
        [AirPlayDelivery("HomePod"), s, ChromecastDelivery("TV")]
    )
    assert find_sonos(manager) == [s]


def test_find_sonos_returns_none_from_empty():
    result = find_sonos(None)
    assert result == []


# ── audio_capability_limits ─────────────────────────────────────────────────


def test_audio_capability_limits_from_none():
    assert audio_capability_limits(None) == (None, None)


def test_audio_capability_limits_single_delivery():
    from delivery import SonosDelivery

    result = audio_capability_limits(SonosDelivery("Küche"))
    assert result == (48000, 24)


def test_audio_capability_limits_delivery_with_no_declared_limit():
    from delivery import AirPlayDelivery

    d = AirPlayDelivery("HomePod")
    d.MAX_SAMPLE_RATE_HZ = None
    d.MAX_BIT_DEPTH = None
    assert audio_capability_limits(d) == (None, None)


def test_audio_capability_limits_manager_picks_the_most_restrictive():
    from delivery import ChromecastDelivery, DeliveryManager, SonosDelivery

    s = SonosDelivery("Küche")  # 48000 Hz / 24 bit
    c = ChromecastDelivery("TV")  # 96000 Hz / 24 bit
    manager = DeliveryManager.from_deliveries([s, c])
    assert audio_capability_limits(manager) == (48000, 24)


def test_audio_capability_limits_manager_ignores_members_with_no_limit():
    from delivery import AirPlayDelivery, ChromecastDelivery, DeliveryManager

    a = AirPlayDelivery("HomePod")
    a.MAX_SAMPLE_RATE_HZ = None
    a.MAX_BIT_DEPTH = None
    c = ChromecastDelivery("TV")  # 96000 Hz / 24 bit
    manager = DeliveryManager.from_deliveries([a, c])
    assert audio_capability_limits(manager) == (96000, 24)


def test_audio_capability_limits_manager_all_members_without_a_limit():
    from delivery import AirPlayDelivery, DeliveryManager

    a = AirPlayDelivery("HomePod")
    a.MAX_SAMPLE_RATE_HZ = None
    a.MAX_BIT_DEPTH = None
    manager = DeliveryManager.from_deliveries([a])
    assert audio_capability_limits(manager) == (None, None)
