"""Which reverse proxies connect believes about the client behind them.

TRUSTED_PROXIES (comma-separated addresses or networks) lists them. The
default is loopback, which in the Docker image is the nginx in front of
connect. Behind a proxy of your own (Traefik, Nginx Proxy Manager, Caddy),
add the address it reaches Beacon from, or every client counts as that
proxy. Only party mode acts on a client's address today: its guests have no
login, so their address is what tells them apart.
"""

import ipaddress
import os

DEFAULT_TRUSTED_PROXIES = "127.0.0.1/32,::1/128"


def _parse(raw: str) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    networks = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            networks.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            continue
    return networks


TRUSTED_PROXIES = _parse(os.getenv("TRUSTED_PROXIES", DEFAULT_TRUSTED_PROXIES))


def is_trusted_proxy(ip: str) -> bool:
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(address in network for network in TRUSTED_PROXIES)


def client_ip(peer: str, forwarded_for: str | None) -> str:
    """The client's address. X-Forwarded-For is only believed from a proxy
    we trust, and read from the right: the rightmost entry no trusted proxy
    added is the one a client can't have forged."""
    if not forwarded_for or not is_trusted_proxy(peer):
        return peer
    for hop in reversed([h.strip() for h in forwarded_for.split(",") if h.strip()]):
        if not is_trusted_proxy(hop):
            return hop
    return peer
