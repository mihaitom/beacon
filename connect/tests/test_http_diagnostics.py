"""Tests for core/http_diagnostics.py — naming the sender of a request
uvicorn rejects as invalid (#56)."""

import logging

from uvicorn.config import Config
from uvicorn.server import ServerState

from core.http_diagnostics import DiagnosticHTTPProtocol, describe_invalid_request

# The start of a real TLS 1.2 ClientHello.
_TLS_CLIENT_HELLO = bytes.fromhex("16030102000100011c0303")


class _FakeTransport:
    def __init__(self) -> None:
        self.written = b""
        self.closed = False

    def get_extra_info(self, name: str):
        return {"peername": ("192.168.42.61", 51234), "sockname": ("127.0.0.1", 7071)}.get(name)

    def write(self, data: bytes) -> None:
        self.written += data

    def close(self) -> None:
        self.closed = True

    def is_closing(self) -> bool:
        return self.closed

    def pause_reading(self) -> None:
        pass

    def resume_reading(self) -> None:
        pass

    def set_protocol(self, protocol) -> None:
        pass


async def _app(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


def _protocol() -> tuple[DiagnosticHTTPProtocol, _FakeTransport]:
    config = Config(app=_app, log_config=None)
    config.load()
    protocol = DiagnosticHTTPProtocol(config=config, server_state=ServerState(), app_state={})
    transport = _FakeTransport()
    protocol.connection_made(transport)
    return protocol, transport


async def test_a_tls_handshake_is_logged_with_its_sender(caplog):
    protocol, transport = _protocol()

    with caplog.at_level(logging.WARNING, logger="connect.http"):
        protocol.data_received(_TLS_CLIENT_HELLO)

    assert "192.168.42.61:51234" in caplog.text
    assert "TLS handshake" in caplog.text
    # uvicorn still answers it the way it always did.
    assert transport.written.startswith(b"HTTP/1.1 400")


async def test_a_valid_request_logs_nothing(caplog):
    protocol, _ = _protocol()

    with caplog.at_level(logging.WARNING, logger="connect.http"):
        protocol.data_received(b"GET /health HTTP/1.1\r\nHost: beacon\r\n\r\n")

    assert caplog.text == ""


def test_garbage_that_is_not_tls_shows_its_bytes_without_the_tls_note():
    line = describe_invalid_request(("10.0.0.9", 1400), b"\x00\x01hello")

    assert "10.0.0.9:1400" in line
    assert "00 01 68 65 6c 6c 6f" in line
    assert "TLS" not in line
