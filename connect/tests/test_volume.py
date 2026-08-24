"""Tests for routes/volume.py — /volume and /device-volume."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from core.claims import claims
from delivery import ChromecastDelivery, DlnaDelivery, SonosDelivery

# ── /volume (session-level, active Sonos target) ───────────────────────────────


def test_volume_get_returns_error_without_active_sonos_target(client, default_session):
    r = client.get("/volume")
    assert "error" in r.json()


def test_volume_get_reads_active_sonos_target(client, default_session):
    default_session.state.active_delivery = SonosDelivery("Küche")
    dev = MagicMock()
    dev.volume = 42
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        r = client.get("/volume")
    assert r.json() == {"volume": 42}


def test_volume_get_returns_error_when_device_unreachable(client, default_session):
    default_session.state.active_delivery = SonosDelivery("Küche")
    with patch.object(SonosDelivery, "_get_device", side_effect=RuntimeError("unreachable")):
        r = client.get("/volume")
    assert r.json() == {"error": "unreachable"}


def test_volume_post_sets_active_sonos_target(client, default_session):
    default_session.state.active_delivery = SonosDelivery("Küche")
    dev = MagicMock()
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        r = client.post("/volume", json={"volume": 55})
    assert r.json() == {"volume": 55}
    assert dev.volume == 55


def test_volume_post_clamps_and_applies_to_every_grouped_target(client, default_session):
    from delivery import DeliveryManager

    default_session.state.active_delivery = DeliveryManager.from_deliveries(
        [SonosDelivery("Küche"), SonosDelivery("Wohnzimmer")]
    )
    devices = [MagicMock(), MagicMock()]
    with patch.object(SonosDelivery, "_get_device", side_effect=devices):
        r = client.post("/volume", json={"volume": 250})
    assert r.json() == {"volume": 100}
    assert all(d.volume == 100 for d in devices)


def test_volume_post_without_active_sonos_target_is_a_noop(client, default_session):
    r = client.post("/volume", json={"volume": 50})
    assert "error" in r.json()

# ── /device-volume GET ────────────────────────────────────────────────────────


def test_device_volume_get_sonos(client, default_session):
    dev = MagicMock()
    dev.volume = 42
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        r = client.get("/device-volume?device_type=sonos&name=Küche")
    assert r.json() == {"volume": 42}


def test_device_volume_get_chromecast_maps_0_to_1_to_percent(client, default_session):
    cast = MagicMock()
    cast.status.volume_level = 0.37
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        r = client.get("/device-volume?device_type=chromecast&name=TV")
    assert r.json() == {"volume": 37}


def test_device_volume_get_returns_error_for_airplay(client, default_session):
    r = client.get("/device-volume?device_type=airplay&name=HomePod")
    assert "error" in r.json()


def test_device_volume_get_dlna(client, default_session):
    with patch.object(DlnaDelivery, "get_volume", new=AsyncMock(return_value=64)):
        r = client.get("/device-volume?device_type=dlna&name=Receiver")
    assert r.json() == {"volume": 64}


def test_device_volume_get_dlna_returns_error_when_unsupported(client, default_session):
    with patch.object(DlnaDelivery, "get_volume", new=AsyncMock(return_value=None)):
        r = client.get("/device-volume?device_type=dlna&name=Receiver")
    assert "error" in r.json()


def test_device_volume_get_swallows_device_errors(client, default_session):
    with patch.object(
        SonosDelivery, "_get_device", side_effect=RuntimeError("offline")
    ):
        r = client.get("/device-volume?device_type=sonos&name=Küche")
    assert "error" in r.json()


# ── /device-volume POST ───────────────────────────────────────────────────────


def test_device_volume_set_sonos_assigns_volume(client, default_session):
    dev = MagicMock()
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        r = client.post(
            "/device-volume?device_type=sonos&name=Küche", json={"volume": 55}
        )
    assert r.json() == {"volume": 55}
    assert dev.volume == 55


def test_device_volume_set_chromecast_scales_to_0_to_1(client, default_session):
    cast = MagicMock()
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        r = client.post(
            "/device-volume?device_type=chromecast&name=TV", json={"volume": 50}
        )
    assert r.json() == {"volume": 50}
    cast.set_volume.assert_called_once_with(0.5)


def test_device_volume_set_clamps_above_100(client, default_session):
    dev = MagicMock()
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        r = client.post(
            "/device-volume?device_type=sonos&name=Küche", json={"volume": 250}
        )
    assert r.json() == {"volume": 100}
    assert dev.volume == 100


def test_device_volume_set_clamps_below_zero(client, default_session):
    cast = MagicMock()
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        r = client.post(
            "/device-volume?device_type=chromecast&name=TV", json={"volume": -10}
        )
    assert r.json() == {"volume": 0}
    cast.set_volume.assert_called_once_with(0.0)


def test_device_volume_set_rejects_unsupported_type(client, default_session):
    r = client.post(
        "/device-volume?device_type=airplay&name=HomePod", json={"volume": 50}
    )
    assert "error" in r.json()


def test_device_volume_set_dlna(client, default_session):
    with patch.object(DlnaDelivery, "set_volume", new=AsyncMock()) as set_volume:
        r = client.post(
            "/device-volume?device_type=dlna&name=Receiver", json={"volume": 70}
        )
    assert r.json() == {"volume": 70}
    set_volume.assert_called_once_with(70)


def test_device_volume_set_swallows_device_errors(client, default_session):
    with patch.object(
        SonosDelivery, "_get_device", side_effect=RuntimeError("unreachable")
    ):
        r = client.post(
            "/device-volume?device_type=sonos&name=Küche", json={"volume": 50}
        )
    assert r.json() == {"error": "unreachable"}


# ── /device-volume claim enforcement ────────────────────────────────────────────
# Only the session that claimed a device (via /play, /join, /claim) may read or
# change its volume — a device claimed by someone else must be rejected, and an
# unclaimed device (nobody playing yet) must be allowed through unchanged.


def test_device_volume_get_rejected_when_claimed_by_another_session(client, default_session):
    asyncio.run(claims.claim("sonos", "Küche", "some-other-session"))

    with patch.object(SonosDelivery, "_get_device") as get_device:
        r = client.get("/device-volume?device_type=sonos&name=Küche")

    body = r.json()
    assert body["error"] == "device_in_use"
    assert body["device"] == {"name": "Küche", "type": "sonos"}
    get_device.assert_not_called()


def test_device_volume_set_rejected_when_claimed_by_another_session(client, default_session):
    asyncio.run(claims.claim("chromecast", "TV", "some-other-session"))

    with patch.object(ChromecastDelivery, "_get_device") as get_device:
        r = client.post(
            "/device-volume?device_type=chromecast&name=TV", json={"volume": 50}
        )

    body = r.json()
    assert body["error"] == "device_in_use"
    assert body["device"] == {"name": "TV", "type": "chromecast"}
    get_device.assert_not_called()


def test_device_volume_get_allowed_when_claimed_by_own_session(client, default_session):
    asyncio.run(claims.claim("sonos", "Küche", default_session.session_id))
    dev = MagicMock()
    dev.volume = 42
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        r = client.get("/device-volume?device_type=sonos&name=Küche")
    assert r.json() == {"volume": 42}


def test_device_volume_get_allowed_when_unclaimed(client, default_session):
    dev = MagicMock()
    dev.volume = 42
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        r = client.get("/device-volume?device_type=sonos&name=Küche")
    assert r.json() == {"volume": 42}


# ── device_volumes / push (Sonos only) ──────────────────────────────────────
# Everything a Sonos volume call learns is written into session.state.
# device_volumes and broadcast — the same reactive path a RenderingControl
# push (routes/upnp.py) uses, so DeviceListItem.vue's slider reads all three
# sources the same way instead of needing a special case for whichever one
# happened to answer first. chromecast/dlna deliberately don't participate
# (still poll-only in the frontend), see routes/volume.py's own comments.


def test_volume_get_records_and_broadcasts_the_active_targets_volume(client, default_session):
    default_session.state.active_delivery = SonosDelivery("Küche")
    q = default_session.event_bus.subscribe()
    dev = MagicMock()
    dev.volume = 42
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        client.get("/volume")
    assert default_session.state.device_volumes["sonos:Küche"] == (42, None)
    assert q.get_nowait()["targets"] == [
        {"name": "Küche", "type": "sonos", "volume": 42, "muted": None}
    ]


def test_volume_post_records_and_broadcasts_for_every_grouped_target(client, default_session):
    from delivery import DeliveryManager

    default_session.state.active_delivery = DeliveryManager.from_deliveries(
        [SonosDelivery("Küche"), SonosDelivery("Wohnzimmer")]
    )
    q = default_session.event_bus.subscribe()
    devices = [MagicMock(), MagicMock()]
    with patch.object(SonosDelivery, "_get_device", side_effect=devices):
        client.post("/volume", json={"volume": 60})
    assert default_session.state.device_volumes["sonos:Küche"] == (60, None)
    assert default_session.state.device_volumes["sonos:Wohnzimmer"] == (60, None)
    names = {t["name"] for t in q.get_nowait()["targets"]}
    assert names == {"Küche", "Wohnzimmer"}


def test_device_volume_get_records_and_broadcasts_for_sonos(client, default_session):
    default_session.state.active_delivery = SonosDelivery("Küche")
    q = default_session.event_bus.subscribe()
    dev = MagicMock()
    dev.volume = 42
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        client.get("/device-volume?device_type=sonos&name=Küche")
    assert default_session.state.device_volumes["sonos:Küche"] == (42, None)
    assert q.get_nowait()["targets"] == [
        {"name": "Küche", "type": "sonos", "volume": 42, "muted": None}
    ]


def test_device_volume_get_does_not_record_chromecast_or_dlna(client, default_session):
    """Those stay on DeviceListItem.vue's own poll — nothing here should
    fabricate a device_volumes entry (or a broadcast) for a type that has
    no push path to read it back from."""
    cast = MagicMock()
    cast.status.volume_level = 0.5
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        client.get("/device-volume?device_type=chromecast&name=TV")
    assert default_session.state.device_volumes == {}


def test_device_volume_set_records_and_broadcasts_for_sonos(client, default_session):
    default_session.state.active_delivery = SonosDelivery("Küche")
    q = default_session.event_bus.subscribe()
    dev = MagicMock()
    with patch.object(SonosDelivery, "_get_device", return_value=dev):
        client.post("/device-volume?device_type=sonos&name=Küche", json={"volume": 77})
    assert default_session.state.device_volumes["sonos:Küche"] == (77, None)
    assert q.get_nowait()["targets"] == [
        {"name": "Küche", "type": "sonos", "volume": 77, "muted": None}
    ]


def test_device_volume_set_does_not_record_chromecast_or_dlna(client, default_session):
    cast = MagicMock()
    with patch.object(ChromecastDelivery, "_get_device", return_value=cast):
        client.post("/device-volume?device_type=chromecast&name=TV", json={"volume": 50})
    assert default_session.state.device_volumes == {}
