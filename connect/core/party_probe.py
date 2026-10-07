"""core/party_probe.py - "Test setup" for the online party: can a guest from
outside reach this Beacon's party under the address the party was started
from?

Nothing outside the network can be asked to look, so connect looks itself:
it opens the party's own public URL (/party/api/probe) the way a guest's
browser would - DNS, the reverse proxy, the certificate, the login in front
of Beacon, the route to /party/ - with a one-time nonce only this instance
knows, so an answer is known to come from here and not from a login page or
another service.

The name is looked up twice: here, and in public DNS (Cloudflare's
resolver), since the local DNS the server and the host use may know a name,
or an address for it, that guests on mobile data never see. Where public
DNS has another address, the party is also tried through that one - the
way guests come in.

One answer it cannot give for certain, and says so rather than guessing: a
router that cannot loop back to its own public address makes a working
setup look unreachable from inside. A failure through a *public* address is
therefore "unclear", not "broken".

Either way the last word is a phone on mobile data, which the dialog says.
"""

import asyncio
import ipaddress
import logging
import secrets
import socket
import ssl
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger("connect.party_probe")

# How long a nonce stays valid: one probe, start to answer.
NONCE_SECONDS = 30.0
_TIMEOUT = httpx.Timeout(8.0)
_LOCAL_SUFFIXES = (".local", ".lan", ".home", ".internal", ".localdomain", ".home.arpa")

_nonces: dict[str, float] = {}


def issue_nonce() -> str:
    now = time.monotonic()
    for nonce, expires in list(_nonces.items()):
        if expires < now:
            del _nonces[nonce]
    nonce = secrets.token_urlsafe(18)
    _nonces[nonce] = now + NONCE_SECONDS
    return nonce


def nonce_valid(nonce: str) -> bool:
    expires = _nonces.get(nonce)
    return expires is not None and expires >= time.monotonic()


def forwarded_untrusted(forwarded_for: str | None, is_trusted) -> bool:
    """Whether a proxy in front of Beacon added itself to X-Forwarded-For
    without being in TRUSTED_PROXIES: then every guest counts as that proxy
    and they all share the join limits. More than one hop means a proxy
    stands between the client and the one that reached connect."""
    hops = [h.strip() for h in (forwarded_for or "").split(",") if h.strip()]
    return len(hops) >= 2 and not is_trusted(hops[-1])


@dataclass
class Step:
    id: str
    status: str  # "ok", "warn", "fail", "unclear", "skipped"
    code: str = ""
    detail: str = ""


@dataclass
class Result:
    steps: list[Step] = field(default_factory=list)
    addresses: list[str] = field(default_factory=list)
    public_addresses: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "steps": [vars(step) for step in self.steps],
            "addresses": self.addresses,
            "public_addresses": self.public_addresses,
        }


def _is_private(address: str) -> bool:
    """Not an address the internet routes to: a private network, loopback,
    and carrier-grade NAT too (100.64.0.0/10), where a provider shares one
    public address among many customers and nobody outside can get in."""
    return not ipaddress.ip_address(address).is_global


def _local_host(host: str) -> bool:
    """An address only the local network has: an IP of its own, localhost or
    a local-only name."""
    try:
        return _is_private(host)
    except ValueError:
        pass
    lowered = host.lower().rstrip(".")
    return lowered == "localhost" or "." not in lowered or lowered.endswith(_LOCAL_SUFFIXES)


async def _resolve(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(info[4][0] for info in infos))


# Cloudflare's public resolver, asked over HTTPS for the one name - what a
# guest's phone on mobile data would find, as opposed to the local DNS the
# Beacon server (and the host) may well be using.
DOH_URL = "https://cloudflare-dns.com/dns-query"
_DNS_TYPES = (("A", 1), ("AAAA", 28))


async def public_lookup(client: httpx.AsyncClient, host: str) -> list[str] | None:
    """`host`'s addresses in public DNS: an empty list for a name it does not
    know, None when it could not be asked."""

    async def one(record: str, code: int) -> list[str]:
        response = await client.get(
            DOH_URL,
            params={"name": host, "type": record},
            headers={"accept": "application/dns-json"},
        )
        response.raise_for_status()
        data = response.json()
        # 0 is an answer, 3 is "no such name"; anything else is the
        # resolver failing, which says nothing about the name.
        if data.get("Status") not in (0, 3):
            raise ValueError(f"DNS status {data.get('Status')}")
        return [a["data"] for a in data.get("Answer") or [] if a.get("type") == code]

    try:
        answers = await asyncio.gather(*(one(record, code) for record, code in _DNS_TYPES))
    except (httpx.HTTPError, ValueError, KeyError) as e:
        logger.info(f"[party-probe] Public DNS lookup for {host} failed: {e}")
        return None
    return list(dict.fromkeys(address for found in answers for address in found))


async def _reach(
    client: httpx.AsyncClient,
    url: str,
    nonce: str,
    through_private: bool,
    **request: object,
) -> tuple[Step, dict]:
    """One attempt at the party's probe endpoint, as a step (its id set by
    the caller) and the answer's body."""
    try:
        response = await client.get(url, params={"n": nonce}, **request)  # type: ignore[arg-type]
    except httpx.ConnectError as e:
        cause = e.__cause__ or e.__context__
        if isinstance(cause, ssl.SSLError) or "certificate" in str(e).lower():
            return Step("", "fail", "certificate", str(e)), {}
        # Through a public address, a router that cannot loop back to
        # itself looks exactly like this - see the module docstring.
        return Step("", "fail" if through_private else "unclear", "unreachable", str(e)), {}
    except httpx.TimeoutException as e:
        return Step("", "fail" if through_private else "unclear", "timeout", str(e)), {}
    except httpx.HTTPError as e:
        return Step("", "fail", "unreachable", str(e)), {}

    status = response.status_code
    if status in (301, 302, 303, 307, 308, 401, 403):
        return Step("", "fail", "login", f"HTTP {status}"), {}
    body: dict = {}
    if status == 200:
        try:
            body = response.json()
        except ValueError:
            body = {}
    if body.get("nonce") != nonce:
        return Step("", "fail", "not-beacon", f"HTTP {status}"), {}
    return Step("", "ok"), body


def _as(step: Step, step_id: str) -> Step:
    step.id = step_id
    return step


async def probe(origin: str, client: httpx.AsyncClient | None = None) -> Result:
    """Checks `origin` (scheme://host[:port]) the way a guest's browser reaches
    it: the address, the name here and in public DNS, the party through the
    address the name has here, and - where public DNS has a different one -
    through that address too, which is the way guests come in."""
    result = Result()
    parts = urlsplit(origin)
    host = parts.hostname or ""
    https = parts.scheme == "https"
    port = parts.port or (443 if https else 80)

    if _local_host(host):
        result.steps.append(Step("address", "fail", "local-address", host))
        return result
    result.steps.append(Step("address", "ok", "", host))

    own = client is None
    client = client or httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False, trust_env=False)
    try:
        return await _probe(result, client, origin, host, port, https)
    finally:
        if own:
            await client.aclose()


async def _probe(
    result: Result, client: httpx.AsyncClient, origin: str, host: str, port: int, https: bool
) -> Result:
    try:
        result.addresses = await _resolve(host, port)
    except OSError as e:
        result.steps.append(Step("dns", "fail", "unresolvable", str(e)))
    private = bool(result.addresses) and all(_is_private(a) for a in result.addresses)
    if result.addresses:
        dns_code = "private" if private else "public"
        result.steps.append(Step("dns", "ok", dns_code, ", ".join(result.addresses)))

    public = await public_lookup(client, host)
    if public is None:
        result.steps.append(Step("public-dns", "unclear", "unavailable"))
    elif not public:
        result.steps.append(Step("public-dns", "fail", "missing"))
    elif all(_is_private(a) for a in public):
        result.public_addresses = public
        result.steps.append(Step("public-dns", "fail", "private", ", ".join(public)))
    else:
        result.public_addresses = public
        result.steps.append(Step("public-dns", "ok", "public", ", ".join(public)))

    nonce = issue_nonce()
    body: dict = {}
    reached_here = None
    if result.addresses:
        reached_here, body = await _reach(client, f"{origin}/party/api/probe", nonce, private)
        result.steps.append(_as(reached_here, "reach"))

    # The way guests come in: the address public DNS has, where that is not
    # simply the one the name has here (then the step above was that way
    # already). Connected to by address, with the name for the certificate
    # and the proxy's routing.
    outside = [a for a in result.public_addresses if not _is_private(a)]
    if outside and set(outside) != set(result.addresses):
        address = outside[0]
        netloc = f"[{address}]" if ":" in address else address
        default_port = 443 if https else 80
        host_header = host if port == default_port else f"{host}:{port}"
        reached, outside_body = await _reach(
            client,
            f"{'https' if https else 'http'}://{netloc}:{port}/party/api/probe",
            nonce,
            False,
            headers={"host": host_header},
            extensions={"sni_hostname": host} if https else {},
        )
        result.steps.append(_as(reached, "reach-public"))
        body = body or outside_body
        if reached.status == "ok" and reached_here is not None and reached_here.status == "ok":
            # Inside the network the party is reached directly; that is fine
            # once the way from outside is known to work too.
            reached_here.code = "home"
    if (
        reached_here is not None
        and reached_here.status == "ok"
        and private
        and not reached_here.code
    ):
        # Reached this very Beacon, but through a local address: that says
        # nothing yet about guests out on the internet.
        reached_here.status, reached_here.code = "warn", "local-only"

    if body:
        if not https:
            result.steps.append(Step("https", "warn", "no-https"))
        if body.get("forwarded_untrusted"):
            result.steps.append(Step("proxies", "warn", "untrusted-proxy", body.get("proxy", "")))
    return result
