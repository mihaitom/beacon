"""core/local_address.py — the address a device reaches Beacon at.

A machine in more than one network has an address in each, and a device
has to be handed the one in its own network. The default route's address
is only right for a device behind that route: a speaker in another network
this machine also sits in reaches it through the router, while the replies
leave directly through this machine's own leg in the speaker's network. A
router that sees only one half of a connection drops it, and a Sonos then
stopped reading every stream 30-45 s in (#56, see
docs/investigations/old-sonos-models-stop-reading-the-stream.md).
"""

import ipaddress
import socket
from urllib.parse import SplitResult, urlsplit

# Stands for "no device in particular": the route to it is the default
# route. Nothing is ever sent there (see local_ip_towards()).
_ANYWHERE = "8.8.8.8"


def local_ip_towards(host: str) -> str:
    """The address this machine sends from when talking to `host`. A UDP
    connect() only looks the route up; no packet leaves."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect((host, 80))
        return s.getsockname()[0]


def get_local_ip() -> str:
    """The default route's address, the one every URL Beacon builds for
    itself carries until for_device() moves it."""
    return local_ip_towards(_ANYWHERE)


def _is_ipv4_literal(host: object) -> bool:
    # Anything else would need a DNS lookup, which blocks the event loop.
    try:
        ipaddress.IPv4Address(host)
    except ValueError:
        return False
    return True


def _is_own_address(host: str) -> bool:
    # Only an address of this machine's own can be bound to.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.bind((host, 0))
        except OSError:
            return False
    return True


def _with_host(parts: SplitResult, host: str) -> str:
    netloc = host if parts.port is None else f"{host}:{parts.port}"
    return parts._replace(netloc=netloc).geturl()


def for_device(url: str, device_host: str | None) -> str:
    """`url` as the device at `device_host` is to be handed it: one on the
    default address moves to this machine's address in that device's
    network. A station's own URL stays as it is, and so does any URL when
    the route to the device can't be looked up."""
    if not _is_ipv4_literal(device_host):
        return url
    parts = urlsplit(url)
    try:
        if parts.hostname != get_local_ip():
            return url
        return _with_host(parts, local_ip_towards(device_host))
    except (OSError, ValueError):
        return url


def on_default_address(url: str) -> str:
    """`url` with an address of this machine's own put back to the default
    one, undoing for_device(), so the URL a device reports it plays
    compares equal to the one Beacon built."""
    parts = urlsplit(url)
    host = parts.hostname
    if not _is_ipv4_literal(host) or not _is_own_address(host):
        return url
    try:
        return _with_host(parts, get_local_ip())
    except (OSError, ValueError):
        return url
