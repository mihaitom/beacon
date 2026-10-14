"""delivery/sonos_discovery.py — finding Sonos speakers across every household

SoCo's own discover() stops at the first speaker that answers and returns
that speaker's household. A network with two households - an S1 system next
to an S2 one is the common case, since the two firmwares cannot share one -
then shows whichever household happened to answer first, and the device list
flips between them from one scan to the next. This listens for the whole
response window instead and asks one speaker per household for its zones.
"""

import logging
import select
import socket
import struct
import time

logger = logging.getLogger("delivery")

_MCAST_GROUP = "239.255.255.250"
_MCAST_PORT = 1900
# MX 1: every speaker answers within one second of hearing the search.
_PLAYER_SEARCH = (
    b"M-SEARCH * HTTP/1.1\r\n"
    b"HOST: 239.255.255.250:1900\r\n"
    b'MAN: "ssdp:discover"\r\n'
    b"MX: 1\r\n"
    b"ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n"
    b"\r\n"
)
# The MX second plus slack for a busy Wi-Fi. Listening this long once anything
# has answered is what catches the second household.
RESPONSE_WINDOW = 1.5
# SoCo's own default, for a network where nothing has answered yet.
TIMEOUT = 5.0


def _household_of(data: bytes) -> str | None:
    """The X-RINCON-HOUSEHOLD header of an SSDP response, if it has one."""
    for line in data.decode("utf-8", "replace").splitlines():
        name, _, value = line.partition(":")
        if name.strip().lower() == "x-rincon-household":
            return value.strip() or None
    return None


def _open_sockets() -> list[socket.socket]:
    from soco.discovery import _find_ipv4_addresses

    sockets = []
    for address in _find_ipv4_addresses():
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            # UPnP 1.0 requires a TTL of 4.
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, struct.pack("B", 4))
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(address))
            sockets.append(sock)
        except OSError as e:
            logger.debug(f"[Sonos] no discovery socket for {address}: {e}")
    return sockets


def _collect_responders() -> dict[str, list[str]]:
    """Speaker IPs that answered the search, grouped by household."""
    sockets = _open_sockets()
    # Sent three times, UDP being unreliable - as SoCo does.
    for _ in range(3):
        for sock in sockets[:]:
            try:
                sock.sendto(_PLAYER_SEARCH, (_MCAST_GROUP, _MCAST_PORT))
            except OSError as e:
                logger.debug(f"[Sonos] discovery send failed: {e}")
                sockets.remove(sock)
                sock.close()

    households: dict[str, list[str]] = {}
    started = time.monotonic()
    try:
        while sockets:
            elapsed = time.monotonic() - started
            if elapsed > TIMEOUT or (households and elapsed > RESPONSE_WINDOW):
                break
            readable, _, _ = select.select(sockets, [], [], 0.1)
            for sock in readable:
                data, (ip, _port) = sock.recvfrom(1024)
                # Anything else on the network answering the multicast.
                if b"Sonos" not in data:
                    continue
                household = _household_of(data) or ip
                ips = households.setdefault(household, [])
                if ip not in ips:
                    ips.append(ip)
    finally:
        for sock in sockets:
            sock.close()
    return households


def discover_zones() -> list:
    """Every visible Sonos zone on the network, from every household."""
    from soco import config

    zones: set = set()
    for household, ips in _collect_responders().items():
        # One speaker knows its whole household; the next one is only asked
        # if the first does not answer the topology query.
        for ip in ips:
            try:
                zones |= config.SOCO_CLASS(ip).visible_zones
                break
            except Exception as e:
                logger.debug(f"[Sonos] {ip} ({household}) did not list its zones: {e}")
    return list(zones)
