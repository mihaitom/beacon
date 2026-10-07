"""Tests for core/party_probe.py - the online party's "Test setup"."""

import ssl

import httpx
import pytest

import core.party_probe as probe_mod
from core.party import party
from core.party_probe import forwarded_untrusted, probe
from main import app


@pytest.fixture
def resolves(monkeypatch):
    """What the name resolves to here."""
    answer = {"addresses": [PUBLIC]}

    async def fake_resolve(host, port):
        if isinstance(answer["addresses"], Exception):
            raise answer["addresses"]
        return answer["addresses"]

    monkeypatch.setattr(probe_mod, "_resolve", fake_resolve)
    return answer


PUBLIC = "93.184.215.14"


def _client(handler, public: list[str] | None = None, dns_down=False) -> httpx.AsyncClient:
    """`handler` answers the party; public DNS (Cloudflare) answers `public`
    - the same address the name has here unless the test says otherwise."""
    public = [PUBLIC] if public is None else public

    def route(request: httpx.Request) -> httpx.Response:
        if request.url.host == "cloudflare-dns.com":
            if dns_down:
                return httpx.Response(503)
            wanted = 1 if request.url.params["type"] == "A" else 28
            answer = [
                {"type": 1 if "." in a else 28, "data": a}
                for a in public
                if (1 if "." in a else 28) == wanted
            ]
            return httpx.Response(200, json={"Status": 0 if public else 3, "Answer": answer})
        return handler(request)

    return httpx.AsyncClient(transport=httpx.MockTransport(route), follow_redirects=False)


def _steps(result) -> dict[str, tuple[str, str]]:
    return {step.id: (step.status, step.code) for step in result.steps}


def _beacon(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"nonce": request.url.params["n"]})


async def test_a_party_reachable_under_its_public_address_passes(resolves):
    result = await probe("https://beacon.example.com", _client(_beacon))
    assert _steps(result) == {
        "address": ("ok", ""),
        "dns": ("ok", "public"),
        "public-dns": ("ok", "public"),
        "reach": ("ok", ""),
    }


async def test_a_local_address_is_no_address_for_guests_outside():
    for origin in ("http://192.168.1.10:7070", "http://localhost:7070", "http://beacon.local"):
        result = await probe(origin, _client(_beacon))
        assert _steps(result) == {"address": ("fail", "local-address")}, origin


async def test_a_name_that_does_not_resolve_points_at_dns(resolves):
    resolves["addresses"] = OSError("Name or service not known")
    result = await probe("https://beacon.example.com", _client(_beacon))
    assert _steps(result)["dns"] == ("fail", "unresolvable")


async def test_a_shared_provider_address_is_no_public_one(resolves):
    """Carrier-grade NAT: the provider shares one public address among many
    customers, and nobody outside can get in through it."""
    resolves["addresses"] = ["100.72.4.9"]
    result = await probe("https://beacon.example.com", _client(_beacon))
    assert _steps(result)["dns"] == ("ok", "private")


async def test_a_success_through_a_local_address_proves_the_home_network_only(resolves):
    """Here the name points at the LAN, and public DNS could not be asked
    where it points out there: a success says nothing about guests yet."""
    resolves["addresses"] = ["192.168.1.10"]
    result = await probe("https://beacon.example.com", _client(_beacon, dns_down=True))
    assert _steps(result)["dns"] == ("ok", "private")
    assert _steps(result)["reach"] == ("warn", "local-only")


async def test_a_login_in_front_of_the_party_is_named_as_such(resolves):
    def login(request):
        return httpx.Response(302, headers={"location": "https://auth.example.com/"})

    result = await probe("https://beacon.example.com", _client(login))
    assert _steps(result)["reach"] == ("fail", "login")


async def test_something_that_is_not_this_beacon_does_not_count(resolves):
    """A login page answering 200, another service, a different Beacon."""

    def other(request):
        return httpx.Response(200, json={"nonce": "someone-elses"})

    result = await probe("https://beacon.example.com", _client(other))
    assert _steps(result)["reach"] == ("fail", "not-beacon")


async def test_no_way_in_from_here_is_unclear_through_a_public_address(resolves):
    """A router that cannot loop back to its own public address looks just
    like a broken setup from inside."""

    def refuse(request):
        raise httpx.ConnectError("connection refused", request=request)

    result = await probe("https://beacon.example.com", _client(refuse))
    assert _steps(result)["reach"] == ("unclear", "unreachable")
    resolves["addresses"] = ["192.168.1.10"]
    result = await probe("https://beacon.example.com", _client(refuse))
    assert _steps(result)["reach"] == ("fail", "unreachable")


async def test_a_certificate_problem_is_named_as_such(resolves):
    def bad_certificate(request):
        error = httpx.ConnectError("certificate verify failed", request=request)
        error.__cause__ = ssl.SSLCertVerificationError("certificate verify failed")
        raise error

    result = await probe("https://beacon.example.com", _client(bad_certificate))
    assert _steps(result)["reach"] == ("fail", "certificate")


async def test_plain_http_and_an_untrusted_proxy_are_warned_about(resolves):
    def behind_untrusted_proxy(request):
        return httpx.Response(
            200,
            json={
                "nonce": request.url.params["n"],
                "forwarded_untrusted": True,
                "proxy": "172.18.0.5",
            },
        )

    result = await probe("http://beacon.example.com", _client(behind_untrusted_proxy))
    steps = _steps(result)
    assert steps["https"] == ("warn", "no-https")
    assert steps["proxies"] == ("warn", "untrusted-proxy")


def test_a_proxy_counts_as_untrusted_only_when_one_stands_in_between():
    def trusted(ip):
        return ip == "127.0.0.1"

    assert forwarded_untrusted("198.51.100.4, 172.18.0.5", trusted)
    assert not forwarded_untrusted("198.51.100.4, 127.0.0.1", trusted)
    # Straight to Beacon: the client is the only hop.
    assert not forwarded_untrusted("198.51.100.4", trusted)
    assert not forwarded_untrusted(None, trusted)


async def test_the_probe_reaches_the_real_guest_endpoint(resolves, monkeypatch):
    async def same_as_here(client, host):
        return [PUBLIC]

    monkeypatch.setattr(probe_mod, "public_lookup", same_as_here)
    party.enable()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), follow_redirects=False
    ) as client:
        result = await probe("https://beacon.example.com", client)
    assert _steps(result)["reach"] == ("ok", "")


async def test_the_guest_endpoint_answers_only_a_nonce_it_handed_out(client):
    party.enable()
    assert client.get("/party/api/probe?n=guessed").status_code == 404
    nonce = probe_mod.issue_nonce()
    assert client.get(f"/party/api/probe?n={nonce}").json()["nonce"] == nonce
    party.disable()
    assert client.get(f"/party/api/probe?n={nonce}").status_code == 404


def test_the_host_runs_it_for_an_origin_only(client):
    party.enable()
    assert client.post("/party-host/probe", json={"origin": "file:///etc"}).status_code == 422
    assert (
        client.post("/party-host/probe", json={"origin": "https://x.example/party"}).status_code
        == 422
    )


# ── Public DNS ──────────────────────────────────────────────────────────────


async def test_a_name_only_the_local_dns_knows_fails_for_guests(resolves):
    """The usual stumbling block: at home the name works, out there it does
    not exist."""
    resolves["addresses"] = ["10.2.2.7"]
    result = await probe("https://beacon.example.com", _client(_beacon, public=[]))
    assert _steps(result)["public-dns"] == ("fail", "missing")
    assert _steps(result)["reach"] == ("warn", "local-only")
    assert "reach-public" not in _steps(result)


async def test_a_private_address_in_public_dns_fails_for_guests(resolves):
    result = await probe("https://beacon.example.com", _client(_beacon, public=["192.168.1.10"]))
    assert _steps(result)["public-dns"] == ("fail", "private")


async def test_split_dns_is_tried_the_way_guests_come_in(resolves):
    """Here the LAN address, out there the public one: the party is also
    reached through the public address, by address, with the name for the
    certificate and the proxy."""
    resolves["addresses"] = ["10.2.2.7"]
    seen = []

    def party(request):
        seen.append(
            (request.url.host, request.headers["host"], request.extensions.get("sni_hostname"))
        )
        return _beacon(request)

    result = await probe("https://beacon.example.com", _client(party))
    steps = _steps(result)
    assert steps["public-dns"] == ("ok", "public")
    assert steps["reach-public"] == ("ok", "")
    # Inside the network it is reached directly, which is fine now.
    assert steps["reach"] == ("ok", "home")
    assert (PUBLIC, "beacon.example.com", "beacon.example.com") in seen
    assert result.public_addresses == [PUBLIC]


async def test_no_way_in_through_the_public_address_is_unclear(resolves):
    """From inside, a router may not loop back to its own public address."""
    resolves["addresses"] = ["10.2.2.7"]

    def lan_only(request):
        if request.url.host == PUBLIC:
            raise httpx.ConnectError("timed out", request=request)
        return _beacon(request)

    result = await probe("https://beacon.example.com", _client(lan_only))
    assert _steps(result)["reach-public"] == ("unclear", "unreachable")
    assert _steps(result)["reach"] == ("warn", "local-only")


async def test_public_dns_out_of_reach_leaves_it_open(resolves):
    result = await probe("https://beacon.example.com", _client(_beacon, dns_down=True))
    assert _steps(result)["public-dns"] == ("unclear", "unavailable")
    assert _steps(result)["reach"] == ("ok", "")


async def test_a_name_unknown_here_is_still_tried_through_public_dns(resolves):
    resolves["addresses"] = OSError("Name or service not known")
    result = await probe("https://beacon.example.com", _client(_beacon))
    steps = _steps(result)
    assert steps["dns"] == ("fail", "unresolvable")
    assert steps["reach-public"] == ("ok", "")
    assert "reach" not in steps
