"""core/mdns.py: announced exactly while an integration key exists. The
fake_zeroconf fixture (conftest.py) stands in for the network."""

import pytest

from core import device_keys, integration_key, mdns, play_history, server_link
from core.play_history import Account
from core.state import PORT

ALICE = Account("subsonic", "srv-id", "alice")


@pytest.fixture(autouse=True)
def _fixed_address(monkeypatch, tmp_path):
    monkeypatch.setattr(mdns, "get_local_ip", lambda: "192.0.2.10")
    # Device keys decide too; none may be left over from another test.
    monkeypatch.setattr(play_history, "_DIR", str(tmp_path / "history"))


async def test_nothing_is_announced_without_a_key(fake_zeroconf):
    await mdns.sync()
    assert fake_zeroconf.registered == []


async def test_announced_with_port_address_and_properties_once_a_key_exists(fake_zeroconf):
    integration_key.generate()
    await mdns.sync()
    [info] = fake_zeroconf.registered
    assert info.type == mdns.SERVICE_TYPE
    assert info.port == PORT
    assert info.parsed_addresses() == ["192.0.2.10"]
    assert info.properties[b"id"] == mdns.instance_id().encode()
    assert info.properties[b"path"] == b"/remote/"
    assert info.properties[b"api"] == b"/device-link/v1/"


async def test_withdrawn_when_the_key_is_revoked(fake_zeroconf):
    integration_key.generate()
    await mdns.sync()
    integration_key.revoke()
    await mdns.sync()
    assert fake_zeroconf.registered == []


async def test_not_announced_twice_for_the_same_address(fake_zeroconf):
    integration_key.generate()
    await mdns.sync()
    first = fake_zeroconf.registered[0]
    await mdns.sync()
    assert fake_zeroconf.registered == [first]


async def test_follows_a_changed_address(fake_zeroconf, monkeypatch):
    integration_key.generate()
    await mdns.sync()
    monkeypatch.setattr(mdns, "get_local_ip", lambda: "192.0.2.20")
    await mdns.sync()
    [info] = fake_zeroconf.registered
    assert info.parsed_addresses() == ["192.0.2.20"]


async def test_instance_id_is_stable():
    assert mdns.instance_id() == mdns.instance_id()


async def test_a_failing_network_does_not_raise(fake_zeroconf, monkeypatch):
    integration_key.generate()

    def no_network():
        raise OSError("network unreachable")

    monkeypatch.setattr(mdns, "get_local_ip", no_network)
    await mdns.sync()  # must not raise
    assert fake_zeroconf.registered == []


def test_generating_and_revoking_the_key_updates_the_announcement(client, fake_zeroconf):
    client.post("/remote/integration-key")
    assert len(fake_zeroconf.registered) == 1
    client.delete("/remote/integration-key")
    assert fake_zeroconf.registered == []


@pytest.fixture
def as_server(monkeypatch):
    monkeypatch.setattr(server_link, "AVAILABLE", False)
    monkeypatch.setenv("WEB_PORT", "7070")


def make_key(*scopes):
    return device_keys.create(ALICE, "Home Assistant", None, scopes=scopes)


async def test_a_server_announces_its_web_port_once_a_key_may_steer(fake_zeroconf, as_server):
    make_key("control")
    await mdns.sync()
    [info] = fake_zeroconf.registered
    assert info.port == 7070
    assert info.properties[b"api"] == b"/device-link/v1/"


async def test_a_server_stays_quiet_for_a_key_that_may_not_steer(fake_zeroconf, as_server):
    make_key("history")
    await mdns.sync()
    assert fake_zeroconf.registered == []


async def test_a_desktop_announces_its_own_port(fake_zeroconf, monkeypatch):
    monkeypatch.setattr(server_link, "AVAILABLE", True)
    monkeypatch.setenv("WEB_PORT", "7070")
    make_key("control")
    await mdns.sync()
    [info] = fake_zeroconf.registered
    assert info.port == PORT


async def test_a_server_key_keeps_no_window_relay_running(as_server):
    make_key("control")
    assert mdns.steered_from_outside() is False
