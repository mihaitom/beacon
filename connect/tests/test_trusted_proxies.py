from core import trusted_proxies
from core.trusted_proxies import _parse, client_ip


def test_forwarded_for_is_only_believed_from_a_trusted_proxy():
    assert client_ip("203.0.113.9", "198.51.100.1") == "203.0.113.9"
    assert client_ip("127.0.0.1", "198.51.100.1") == "198.51.100.1"
    # A client prepending its own entry doesn't get to choose: the rightmost
    # untrusted hop is what the proxy itself saw.
    assert client_ip("127.0.0.1", "1.1.1.1, 198.51.100.1") == "198.51.100.1"
    assert client_ip("127.0.0.1", "198.51.100.1, 127.0.0.1") == "198.51.100.1"


def test_a_proxy_network_added_to_the_list_is_believed(monkeypatch):
    monkeypatch.setattr(trusted_proxies, "TRUSTED_PROXIES", _parse("127.0.0.1/32, 172.16.0.0/12"))
    # Inner nginx (loopback) in front, a Docker-network proxy in front of it.
    assert client_ip("127.0.0.1", "198.51.100.1, 172.18.0.5") == "198.51.100.1"


def test_a_malformed_entry_is_skipped_rather_than_trusting_everything():
    assert [str(n) for n in _parse("not-an-ip, 10.0.0.0/8,,")] == ["10.0.0.0/8"]


def test_the_default_trusts_only_loopback():
    assert [str(n) for n in _parse(trusted_proxies.DEFAULT_TRUSTED_PROXIES)] == [
        "127.0.0.1/32",
        "::1/128",
    ]
