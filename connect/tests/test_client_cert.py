"""Tests for core/client_cert.py — the client certificate for a media server
behind a reverse proxy that requires one (mTLS).

The handshake tests run against a real local https server that refuses any
client without a certificate from its own CA, because the failure this
guards against is a client that quietly goes out without it: every request
to the media server then fails at the TLS layer, nowhere near the cause.
"""

import asyncio
import datetime
import http.server
import io
import ipaddress
import shutil
import ssl
import subprocess
import threading
import wave
from pathlib import Path

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from core import audio_analysis, client_cert, party_broadcast, streamer, waveform
from delivery import airplay
from media import http_client, jellyfin_bridge, plex_bridge
from routes import proxy


def _short_wav() -> bytes:
    """A tenth of a second of silence — real audio, because the bundled
    ffmpeg only opens formats Beacon actually plays."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\0\0" * 800)
    return buf.getvalue()


_BODY = _short_wav()


# ── A small PKI and a server that demands a client certificate ──────────────


def _write_key(key, path: Path) -> None:
    path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )


def _issue(ca_cert, ca_key, name: str, usage, san=None):
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.UTC)
    builder = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.ExtendedKeyUsage([usage]), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
    )
    if san:
        builder = builder.add_extension(x509.SubjectAlternativeName(san), critical=False)
    return builder.sign(ca_key, hashes.SHA256()), key


@pytest.fixture(scope="module")
def pki(tmp_path_factory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("pki")
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test-ca")])
    now = datetime.datetime.now(datetime.UTC)
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), False)
        .sign(ca_key, hashes.SHA256())
    )
    server_cert, server_key = _issue(
        ca_cert,
        ca_key,
        "localhost",
        ExtendedKeyUsageOID.SERVER_AUTH,
        [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))],
    )
    client_crt, client_key = _issue(ca_cert, ca_key, "beacon", ExtendedKeyUsageOID.CLIENT_AUTH)

    paths = {name: d / f"{name}.pem" for name in ("ca", "server", "server_key", "cert", "key")}
    paths["ca"].write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    paths["server"].write_bytes(server_cert.public_bytes(serialization.Encoding.PEM))
    _write_key(server_key, paths["server_key"])
    paths["cert"].write_bytes(client_crt.public_bytes(serialization.Encoding.PEM))
    _write_key(client_key, paths["key"])
    paths["combined"] = d / "combined.pem"
    paths["combined"].write_bytes(paths["cert"].read_bytes() + paths["key"].read_bytes())
    return paths


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(_BODY)))
        self.end_headers()
        self.wfile.write(_BODY)

    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def mtls_url(pki):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(pki["server"], pki["server_key"])
    ctx.load_verify_locations(pki["ca"])
    ctx.verify_mode = ssl.CERT_REQUIRED
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"https://127.0.0.1:{server.server_address[1]}/track"
    server.shutdown()


@pytest.fixture
def trusts_test_ca(pki, monkeypatch):
    """The proxy's server certificate comes from a private CA — the shape
    most mTLS setups have — which SSL_CERT_FILE is the way to trust."""
    monkeypatch.setenv("SSL_CERT_FILE", str(pki["ca"]))


@pytest.fixture
def with_cert(pki, monkeypatch, trusts_test_ca):
    monkeypatch.setattr(client_cert, "CERT_FILE", str(pki["cert"]))
    monkeypatch.setattr(client_cert, "KEY_FILE", str(pki["key"]))


@pytest.fixture
def without_cert(monkeypatch, trusts_test_ca):
    monkeypatch.setattr(client_cert, "CERT_FILE", "")
    monkeypatch.setattr(client_cert, "KEY_FILE", "")


@pytest.fixture(autouse=True)
def _fresh_clients():
    """Every shared client is created on first use, so one built by an
    earlier test (with or without a certificate) must not leak into this
    one."""

    def reset():
        http_client.close()
        for module in (proxy, jellyfin_bridge, plex_bridge):
            module._client = None

    reset()
    yield
    reset()


# ── Every httpx client that talks to the media server ───────────────────────


async def _via_shared_sync_client(url: str) -> bytes:
    return (await asyncio.to_thread(http_client.get, url)).content


async def _via_proxy(url: str) -> bytes:
    return (await proxy._get_client().get(url)).content


async def _via_jellyfin_bridge(url: str) -> bytes:
    return (await jellyfin_bridge._get_client().get(url)).content


async def _via_plex_bridge(url: str) -> bytes:
    return (await plex_bridge._get_client().get(url)).content


async def _via_airplay_artwork(url: str) -> bytes:
    async with airplay._media_server_client(5) as http:
        return (await http.get(url)).content


_MEDIA_SERVER_CLIENTS = pytest.mark.parametrize(
    "fetch",
    [
        _via_shared_sync_client,
        _via_proxy,
        _via_jellyfin_bridge,
        _via_plex_bridge,
        _via_airplay_artwork,
    ],
    ids=lambda f: f.__name__.removeprefix("_via_"),
)


@_MEDIA_SERVER_CLIENTS
async def test_every_media_server_client_presents_the_certificate(fetch, mtls_url, with_cert):
    assert await fetch(mtls_url) == _BODY


@_MEDIA_SERVER_CLIENTS
async def test_the_test_server_really_refuses_a_client_without_one(fetch, mtls_url, without_cert):
    """Control for the test above: without it, a server that accepted
    anyone would make every client look like it presented a certificate.
    The refusal reaches some clients as a bare ssl.SSLError rather than
    wrapped by httpx; routes/proxy.py's catch-all covers that."""
    with pytest.raises((httpx.HTTPError, ssl.SSLError)):
        await fetch(mtls_url)


async def test_a_combined_pem_needs_no_separate_key(pki, mtls_url, monkeypatch, trusts_test_ca):
    monkeypatch.setattr(client_cert, "CERT_FILE", str(pki["combined"]))
    monkeypatch.setattr(client_cert, "KEY_FILE", "")
    assert await _via_proxy(mtls_url) == _BODY


def test_without_a_certificate_httpx_keeps_its_own_default(without_cert):
    assert client_cert.ssl_context() is True


# ── ffmpeg, which fetches tracks from the media server itself ───────────────

_HTTPS = "https://media.example/rest/stream.view?id=1"


def _cert_args_before_input(cmd: list[str], url: str) -> bool:
    """The certificate options, ahead of the -i that opens `url` — after
    it they would be output options and apply to nothing."""
    i_pos = cmd.index(url) - 1
    assert cmd[i_pos] == "-i"
    head = cmd[:i_pos]
    if "-cert_file" not in head or "-key_file" not in head:
        return False
    return head[head.index("-cert_file") + 1] == client_cert.CERT_FILE


def test_ffmpeg_gets_cert_and_key(with_cert, pki):
    assert client_cert.ffmpeg_args(_HTTPS) == [
        "-cert_file",
        str(pki["cert"]),
        "-key_file",
        str(pki["key"]),
    ]


def test_ffmpeg_reads_the_key_from_a_combined_pem(pki, monkeypatch):
    monkeypatch.setattr(client_cert, "CERT_FILE", str(pki["combined"]))
    monkeypatch.setattr(client_cert, "KEY_FILE", "")
    args = client_cert.ffmpeg_args(_HTTPS)
    assert args[args.index("-key_file") + 1] == str(pki["combined"])


@pytest.mark.parametrize("url", ["http://media.example/rest/stream.view", "pipe:0", "/tmp/a.flac"])
def test_ffmpeg_gets_nothing_where_there_is_no_tls(with_cert, url):
    assert client_cert.ffmpeg_args(url) == []


def test_ffmpeg_gets_nothing_without_a_certificate(without_cert):
    assert client_cert.ffmpeg_args(_HTTPS) == []
    assert "-cert_file" not in streamer.http_input_args(_HTTPS)


def test_http_input_args_carry_both_reconnect_and_certificate(with_cert):
    args = streamer.http_input_args(_HTTPS)
    assert "-reconnect" in args
    assert "-cert_file" in args


@pytest.mark.parametrize(
    "build",
    [
        lambda url: streamer.pcm_decode_cmd(url, 12.0, None, 2, 44100),
        lambda url: party_broadcast.decoder_cmd(url, 0.0, 1.0),
        lambda url: audio_analysis._decode_cmd(url, 30.0, 1.0),
    ],
    ids=["mix-decode", "party-broadcast", "visualizer-analysis"],
)
def test_ffmpeg_commands_carry_the_certificate(with_cert, build):
    assert _cert_args_before_input(build(_HTTPS), _HTTPS)


class _CapturedProcess:
    returncode = 0

    async def communicate(self):
        return b"", b""


async def _captured_exec(monkeypatch, run) -> list[str]:
    seen: list[str] = []

    async def fake_exec(*cmd, **_kwargs):
        seen.extend(cmd)
        return _CapturedProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    await run()
    return seen


async def test_waveform_decode_carries_the_certificate(with_cert, monkeypatch):
    cmd = await _captured_exec(monkeypatch, lambda: waveform.get_waveform("t", _HTTPS))
    assert _cert_args_before_input(cmd, _HTTPS)


async def test_format_probe_carries_the_certificate(with_cert, monkeypatch):
    cmd = await _captured_exec(monkeypatch, lambda: streamer._probe_source(_HTTPS))
    assert _cert_args_before_input(cmd, _HTTPS)


def _ffmpeg_with_openssl() -> str | None:
    """The bundled build (OpenSSL, what Docker and the desktop app ship), or
    a PATH ffmpeg built the same way. A GnuTLS build ignores SSL_CERT_FILE
    for the server side, which is a different question from this one."""
    bundled = Path(__file__).resolve().parents[2] / "build" / "ffmpeg" / "ffmpeg"
    for candidate in (str(bundled), shutil.which("ffmpeg")):
        if not candidate or not Path(candidate).exists():
            continue
        conf = subprocess.run(
            [candidate, "-hide_banner", "-buildconf"], check=False, capture_output=True
        )
        if b"enable-openssl" in conf.stdout:
            return candidate
    return None


@pytest.mark.parametrize("cert", ["with", "without"])
def test_a_real_ffmpeg_gets_through_with_it_and_only_with_it(
    cert, request, mtls_url, trusts_test_ca
):
    binary = _ffmpeg_with_openssl()
    if not binary:
        pytest.skip("no ffmpeg built against OpenSSL here")
    request.getfixturevalue(f"{cert}_cert")
    cmd = [
        binary,
        "-hide_banner",
        "-loglevel",
        "error",
        *streamer.http_input_args(mtls_url),
        "-i",
        mtls_url,
        "-f",
        "s16le",
        "pipe:1",
    ]
    result = subprocess.run(cmd, check=False, capture_output=True, timeout=30)
    if cert == "with":
        assert result.returncode == 0, result.stderr.decode()
        assert len(result.stdout) == 800 * 2
    else:
        assert result.returncode != 0


# ── Startup ─────────────────────────────────────────────────────────────────


def test_a_certificate_that_does_not_load_is_named_at_startup(monkeypatch, caplog):
    monkeypatch.setattr(client_cert, "CERT_FILE", "/nonexistent/client.pem")
    monkeypatch.setattr(client_cert, "KEY_FILE", "")
    client_cert.check_at_startup()
    assert "MEDIA_SERVER_CLIENT_CERT" in caplog.text


def test_a_certificate_that_loads_is_reported_at_startup(with_cert, caplog):
    caplog.set_level("INFO", logger="connect.client_cert")
    client_cert.check_at_startup()
    assert "Presenting client certificate" in caplog.text
