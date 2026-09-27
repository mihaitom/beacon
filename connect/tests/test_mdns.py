"""core/mdns.py: announced exactly while an integration key exists. The
fake_zeroconf fixture (conftest.py) stands in for the network."""

import pytest

from core import integration_key, mdns
from core.state import PORT


@pytest.fixture(autouse=True)
def _fixed_address(monkeypatch):
    monkeypatch.setattr(mdns, "get_local_ip", lambda: "192.0.2.10")


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
