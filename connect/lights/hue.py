"""lights/hue.py — a Hue bridge: finding it, pairing, its entertainment
areas, and the DTLS stream that drives them.

Everything over HTTPS is verified against Signify's own CA (below) with the
bridge id as the hostname, so a pairing key never goes to a box that merely
answers on the bridge's address.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import socket
import ssl
import struct
import time
from dataclasses import dataclass

import httpx

logger = logging.getLogger("connect.lights")

STREAM_PORT = 2100
# Hue's only stream cipher: TLS_PSK_WITH_AES_128_GCM_SHA256 over DTLS 1.2.
_CIPHER = b"PSK-AES128-GCM-SHA256"
_HTTP_TIMEOUT = 5.0
# The bridge answers "link button not pressed" with this error type.
_LINK_BUTTON_NOT_PRESSED = 101

# The CA that signs every Hue bridge's certificate: "root-bridge" for the
# bridges sold until 2025, "Hue Root CA 01" for those since (Bridge Pro).
# Signify publishes both on its developer site; checked against a real
# BSB002 on 2026-11-01. Kept inline rather than as a file so the packaged
# backend cannot ship without it.
_HUE_CA = """\
-----BEGIN CERTIFICATE-----
MIICMjCCAdigAwIBAgIUO7FSLbaxikuXAljzVaurLXWmFw4wCgYIKoZIzj0EAwIw
OTELMAkGA1UEBhMCTkwxFDASBgNVBAoMC1BoaWxpcHMgSHVlMRQwEgYDVQQDDAty
b290LWJyaWRnZTAiGA8yMDE3MDEwMTAwMDAwMFoYDzIwMzgwMTE5MDMxNDA3WjA5
MQswCQYDVQQGEwJOTDEUMBIGA1UECgwLUGhpbGlwcyBIdWUxFDASBgNVBAMMC3Jv
b3QtYnJpZGdlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjNw2tx2AplOf9x86
aTdvEcL1FU65QDxziKvBpW9XXSIcibAeQiKxegpq8Exbr9v6LBnYbna2VcaK0G22
jOKkTqOBuTCBtjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNV
HQ4EFgQUZ2ONTFrDT6o8ItRnKfqWKnHFGmQwdAYDVR0jBG0wa4AUZ2ONTFrDT6o8
ItRnKfqWKnHFGmShPaQ7MDkxCzAJBgNVBAYTAk5MMRQwEgYDVQQKDAtQaGlsaXBz
IEh1ZTEUMBIGA1UEAwwLcm9vdC1icmlkZ2WCFDuxUi22sYpLlwJY81Wrqy11phcO
MAoGCCqGSM49BAMCA0gAMEUCIEBYYEOsa07TH7E5MJnGw557lVkORgit2Rm1h3B2
sFgDAiEA1Fj/C3AN5psFMjo0//mrQebo0eKd3aWRx+pQY08mk48=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIBzDCCAXOgAwIBAgICEAAwCgYIKoZIzj0EAwIwPDELMAkGA1UEBhMCTkwxFDAS
BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTAgFw0y
NTAyMjUwMDAwMDBaGA8yMDUwMTIzMTIzNTk1OVowPDELMAkGA1UEBhMCTkwxFDAS
BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABFfOO0jfSAUXGQ9kjEDzyBrcMQ3ItyA5krE+
cyvb1Y3xFti7KlAad8UOnAx0FBLn7HZrlmIwm1QnX0fK3LPM13mjYzBhMB0GA1Ud
DgQWBBTF1pSpsCASX/z0VHLigxU2CAaqoTAfBgNVHSMEGDAWgBTF1pSpsCASX/z0
VHLigxU2CAaqoTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggq
hkjOPQQDAgNHADBEAiAk7duT+IHbOGO4UUuGLAEpyYejGZK9Z7V9oSfnvuQ5BQIg
IYSgwwxHXm73/JgcU9lAM6c8Bmu3UE3kBIUwBs1qXFw=
-----END CERTIFICATE-----
"""


class HueError(Exception):
    """The bridge could not be reached or refused what was asked."""


class LinkButtonNotPressedError(HueError):
    pass


@dataclass(frozen=True)
class Bridge:
    host: str
    # Lower case, as the certificate's CN is compared case-insensitively.
    bridge_id: str


@dataclass(frozen=True)
class Pairing:
    username: str
    clientkey: str
    app_id: str


@dataclass(frozen=True)
class Channel:
    channel_id: int
    x: float
    y: float
    z: float


@dataclass(frozen=True)
class Area:
    area_id: str
    name: str
    channels: tuple[Channel, ...]
    # Another app (the Hue Sync app, a TV box) is streaming to it.
    active: bool


def _tls_context(check_hostname: bool = True) -> ssl.SSLContext:
    ctx = ssl.create_default_context(cadata=_HUE_CA)
    ctx.check_hostname = check_hostname
    return ctx


def _client(bridge: Bridge) -> httpx.AsyncClient:
    return httpx.AsyncClient(verify=_tls_context(), timeout=_HTTP_TIMEOUT)


def _ext(bridge: Bridge) -> dict:
    # Connects to the address but checks the certificate against the id.
    return {"sni_hostname": bridge.bridge_id}


async def identify(host: str) -> Bridge:
    """The bridge at `host`. The id is read over a connection already
    verified against Signify's CA - a forged answer would need a
    Signify-signed certificate."""
    try:
        async with httpx.AsyncClient(
            verify=_tls_context(check_hostname=False), timeout=_HTTP_TIMEOUT
        ) as http:
            reply = await http.get(f"https://{host}/api/0/config")
            reply.raise_for_status()
            bridge_id = reply.json()["bridgeid"]
    except Exception as e:
        raise HueError(f"No Hue bridge at {host}: {e}") from e
    return Bridge(host=host, bridge_id=bridge_id.lower())


async def discover(timeout: float = 4.0) -> list[Bridge]:
    """Every bridge announcing itself over mDNS within `timeout`."""
    from zeroconf import ServiceStateChange
    from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

    names: list[str] = []

    def on_change(zeroconf, service_type, name, state_change):
        if state_change is ServiceStateChange.Added:
            names.append(name)

    azc = AsyncZeroconf()
    browser = AsyncServiceBrowser(azc.zeroconf, "_hue._tcp.local.", handlers=[on_change])
    try:
        await asyncio.sleep(timeout)
        hosts: list[str] = []
        for name in names:
            info = AsyncServiceInfo("_hue._tcp.local.", name)
            if await info.async_request(azc.zeroconf, 1500):
                hosts.extend(a for a in info.parsed_addresses() if "." in a)
    finally:
        await browser.async_cancel()
        await azc.async_close()
    bridges: list[Bridge] = []
    for host in dict.fromkeys(hosts):
        with contextlib.suppress(HueError):
            bridges.append(await identify(host))
    return bridges


async def pair(bridge: Bridge, device_name: str) -> Pairing:
    """One attempt; raises LinkButtonNotPressedError until somebody has
    pressed the bridge's button."""
    body = {"devicetype": f"beacon#{device_name}"[:40], "generateclientkey": True}
    try:
        async with _client(bridge) as http:
            reply = await http.post(
                f"https://{bridge.host}/api", json=body, extensions=_ext(bridge)
            )
            result = reply.json()[0]
            if "error" in result:
                if result["error"].get("type") == _LINK_BUTTON_NOT_PRESSED:
                    raise LinkButtonNotPressedError()
                raise HueError(result["error"].get("description", "pairing refused"))
            username = result["success"]["username"]
            clientkey = result["success"]["clientkey"]
            # The stream authenticates as the application id, which only
            # this endpoint hands out.
            auth = await http.get(
                f"https://{bridge.host}/auth/v1",
                headers={"hue-application-key": username},
                extensions=_ext(bridge),
            )
            app_id = auth.headers["hue-application-id"]
    except HueError:
        raise
    except Exception as e:
        raise HueError(f"Pairing failed: {e}") from e
    return Pairing(username=username, clientkey=clientkey, app_id=app_id)


def _parse_area(data: dict) -> Area:
    return Area(
        area_id=data["id"],
        name=data.get("metadata", {}).get("name", ""),
        channels=tuple(
            Channel(
                channel_id=ch["channel_id"],
                x=ch["position"]["x"],
                y=ch["position"]["y"],
                z=ch["position"]["z"],
            )
            for ch in data.get("channels", [])
        ),
        active=data.get("status") == "active",
    )


async def _request(bridge: Bridge, pairing: Pairing, method: str, path: str, **kwargs) -> dict:
    try:
        async with _client(bridge) as http:
            reply = await http.request(
                method,
                f"https://{bridge.host}/clip/v2/resource/{path}",
                headers={"hue-application-key": pairing.username},
                extensions=_ext(bridge),
                **kwargs,
            )
            reply.raise_for_status()
            return reply.json()
    except Exception as e:
        raise HueError(f"{method} {path}: {e}") from e


async def list_areas(bridge: Bridge, pairing: Pairing) -> list[Area]:
    data = await _request(bridge, pairing, "GET", "entertainment_configuration")
    return [_parse_area(a) for a in data.get("data", [])]


async def get_area(bridge: Bridge, pairing: Pairing, area_id: str) -> Area:
    data = await _request(bridge, pairing, "GET", f"entertainment_configuration/{area_id}")
    if not data.get("data"):
        raise HueError(f"No entertainment area {area_id}")
    return _parse_area(data["data"][0])


async def set_streaming(bridge: Bridge, pairing: Pairing, area_id: str, on: bool) -> None:
    await _request(
        bridge,
        pairing,
        "PUT",
        f"entertainment_configuration/{area_id}",
        json={"action": "start" if on else "stop"},
    )


def stream_message(seq: int, area_id: str, colours: dict[int, tuple[float, float, float]]) -> bytes:
    """One HueStream v2 frame: the header, the area's id, then 7 bytes a
    channel - its id and 16-bit RGB."""
    head = b"HueStream" + bytes([2, 0, seq & 0xFF, 0, 0, 0, 0]) + area_id.encode()
    body = b"".join(
        struct.pack(">BHHH", ch, *(round(max(0.0, min(1.0, c)) * 0xFFFF) for c in rgb))
        for ch, rgb in colours.items()
    )
    return head + body


class DtlsStream:
    """A DTLS 1.2 PSK client over a plain UDP socket.

    pyOpenSSL has DTLS but no PSK API; the OpenSSL that cryptography ships
    has both, so the PSK callback is set on pyOpenSSL's context directly.
    Memory BIOs rather than the socket itself: OpenSSL only retransmits a
    lost handshake flight when told to, which a socket BIO under pyOpenSSL
    never is - and the bridge does drop the first one now and then, right
    after the area was started."""

    def __init__(self, host: str, identity: str, key: bytes, port: int = STREAM_PORT) -> None:
        from cryptography.hazmat.bindings.openssl.binding import Binding
        from OpenSSL import SSL

        self._ssl = SSL
        ffi, lib = Binding.ffi, Binding.lib
        ctx = SSL.Context(SSL.DTLS_CLIENT_METHOD)
        ctx.set_cipher_list(_CIPHER)
        ident = identity.encode()

        @ffi.callback(
            "unsigned int(SSL *, const char *, char *, unsigned int, unsigned char *, unsigned int)"
        )
        def psk(_ssl, _hint, out_identity, max_identity, out_key, max_key):
            if len(ident) + 1 > max_identity or len(key) > max_key:
                return 0
            ffi.memmove(out_identity, ident + b"\0", len(ident) + 1)
            ffi.memmove(out_key, key, len(key))
            return len(key)

        self._psk = psk  # cffi frees the callback once nothing holds it
        lib.SSL_CTX_set_psk_client_callback(ctx._context, psk)

        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.connect((host, port))
        self._conn = SSL.Connection(ctx, None)
        self._conn.set_connect_state()

    def _flush(self) -> None:
        while True:
            try:
                data = self._conn.bio_read(65535)
            except self._ssl.WantReadError:
                return
            self._sock.send(data)

    def handshake(self, timeout: float = 5.0) -> None:
        """Blocking - run it off the event loop."""
        started = time.monotonic()
        while True:
            try:
                self._conn.do_handshake()
                self._flush()
                self._sock.setblocking(False)
                return
            except self._ssl.WantReadError:
                self._flush()
            except self._ssl.Error as e:
                raise HueError(f"DTLS handshake failed: {e}") from e
            if time.monotonic() - started > timeout:
                raise HueError("DTLS handshake timed out")
            self._sock.settimeout(self._conn.DTLSv1_get_timeout() or 0.5)
            try:
                self._conn.bio_write(self._sock.recv(65535))
            except TimeoutError:
                self._conn.DTLSv1_handle_timeout()

    def send(self, payload: bytes) -> None:
        """One datagram; never blocks, a full socket buffer drops it."""
        self._conn.send(payload)
        with contextlib.suppress(BlockingIOError):
            self._flush()

    def close(self) -> None:
        # A close_notify the bridge never gets is harmless: it ends the
        # session by itself once the stream stops.
        with contextlib.suppress(Exception):
            self._conn.shutdown()
            self._flush()
        self._sock.close()
