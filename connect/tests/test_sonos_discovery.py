"""delivery/sonos_discovery.py — every Sonos household, not just the first to answer."""

from unittest.mock import MagicMock, patch

import pytest

from delivery import sonos_discovery


def _response(household: str | None) -> bytes:
    lines = [
        "HTTP/1.1 200 OK",
        "SERVER: Linux UPnP/1.0 Sonos/80.1-55014 (ZPS27)",
        "ST: urn:schemas-upnp-org:device:ZonePlayer:1",
    ]
    if household:
        lines.append(f"X-RINCON-HOUSEHOLD: {household}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode()


# Captured at import, before conftest's autouse fixture blocks it per test.
_real_collect_responders = sonos_discovery._collect_responders


class _FakeSocket:
    def __init__(self):
        self.inbox: list = []
        self.closed = False

    def sendto(self, data, addr):
        pass

    def recvfrom(self, size):
        return self.inbox.pop(0)

    def close(self):
        self.closed = True


@pytest.fixture
def network(monkeypatch):
    """A fake network on a fake clock: `answers` are (seconds after the
    search, data, ip)."""
    monkeypatch.setattr(sonos_discovery, "_collect_responders", _real_collect_responders)
    clock = {"now": 0.0}
    monkeypatch.setattr(sonos_discovery.time, "monotonic", lambda: clock["now"])

    def install(answers):
        pending = sorted(answers)
        sock = _FakeSocket()

        def fake_select(rlist, wlist, xlist, timeout):
            clock["now"] += timeout
            while pending and pending[0][0] <= clock["now"]:
                _at, data, ip = pending.pop(0)
                sock.inbox.append((data, (ip, 1900)))
            return ([sock] if sock.inbox else []), [], []

        monkeypatch.setattr(sonos_discovery, "_open_sockets", lambda: [sock])
        monkeypatch.setattr(sonos_discovery.select, "select", fake_select)
        return sock

    return install


def test_keeps_listening_after_the_first_household_answers(network):
    """The bug: SoCo's discover() returned at the first answer, so an S1
    system and an S2 system took turns being the whole device list."""
    sock = network(
        [
            (0.1, _response("Sonos_S1"), "10.0.0.5"),
            (0.6, _response("Sonos_S2"), "10.0.0.7"),
            (0.8, _response("Sonos_S2"), "10.0.0.8"),
        ]
    )

    assert sonos_discovery._collect_responders() == {
        "Sonos_S1": ["10.0.0.5"],
        "Sonos_S2": ["10.0.0.7", "10.0.0.8"],
    }
    assert sock.closed


def test_ignores_non_sonos_answers(network):
    network([(0.1, b"HTTP/1.1 200 OK\r\nSERVER: SomeRouter\r\n\r\n", "10.0.0.1")])

    assert sonos_discovery._collect_responders() == {}


def test_waits_for_a_slow_first_answer(network):
    network([(3.0, _response("Sonos_S2"), "10.0.0.7")])

    assert sonos_discovery._collect_responders() == {"Sonos_S2": ["10.0.0.7"]}


def test_a_speaker_without_household_header_counts_as_its_own(network):
    network([(0.1, _response(None), "10.0.0.9")])

    assert sonos_discovery._collect_responders() == {"10.0.0.9": ["10.0.0.9"]}


def _zone(name):
    zone = MagicMock()
    zone.player_name = name
    return zone


def test_discover_zones_merges_every_household(monkeypatch):
    s1 = {_zone("Garage")}
    s2 = {_zone("Kitchen"), _zone("Living Room")}
    speakers = {"10.0.0.5": s1, "10.0.0.7": s2}
    asked = []

    def soco_class(ip):
        asked.append(ip)
        return MagicMock(visible_zones=speakers[ip])

    monkeypatch.setattr(
        sonos_discovery,
        "_collect_responders",
        lambda: {"Sonos_S1": ["10.0.0.5"], "Sonos_S2": ["10.0.0.7", "10.0.0.8"]},
    )
    with patch("soco.config.SOCO_CLASS", new=soco_class):
        zones = sonos_discovery.discover_zones()

    assert sorted(z.player_name for z in zones) == ["Garage", "Kitchen", "Living Room"]
    # One speaker per household is enough - it knows the others.
    assert asked == ["10.0.0.5", "10.0.0.7"]


def test_discover_zones_asks_the_next_speaker_when_one_does_not_answer(monkeypatch):
    class _Unreachable:
        @property
        def visible_zones(self):
            raise OSError("timed out")

    kitchen = _zone("Kitchen")

    def soco_class(ip):
        return _Unreachable() if ip == "10.0.0.7" else MagicMock(visible_zones={kitchen})

    monkeypatch.setattr(
        sonos_discovery, "_collect_responders", lambda: {"Sonos_S2": ["10.0.0.7", "10.0.0.8"]}
    )
    with patch("soco.config.SOCO_CLASS", new=soco_class):
        assert sonos_discovery.discover_zones() == [kitchen]
