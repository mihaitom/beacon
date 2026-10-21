"""Tests for core/http_protocol.py — a response framed the way an internet
radio server frames a stream, which old Sonos models read to the end where
they stopped reading a chunked one (#56).

Run against both of uvicorn's HTTP implementations: the server uses
httptools where it is installed and h11 where it is not, and the packaged
app's bundle decides that at build time."""

import asyncio

import pytest
from uvicorn.config import Config
from uvicorn.protocols.http.h11_impl import H11Protocol
from uvicorn.protocols.http.httptools_impl import HttpToolsProtocol
from uvicorn.server import ServerState

from core.http_diagnostics import DiagnosticHTTPProtocol
from core.http_protocol import (
    CLOSE_DELIMITED,
    CLOSE_DELIMITED_HEADER,
    BeaconHTTPProtocol,
    CloseDelimitedFraming,
    header_value,
)

_IMPLEMENTATIONS = {
    "httptools": type("HttpTools", (CloseDelimitedFraming, HttpToolsProtocol), {}),
    "h11": type("H11", (CloseDelimitedFraming, H11Protocol), {}),
}

_MARKED = [(name.encode(), value.encode()) for name, value in CLOSE_DELIMITED.items()]


class _FakeTransport:
    def __init__(self) -> None:
        self.written = b""
        self.closed = False

    def get_extra_info(self, name: str):
        return {"peername": ("192.168.42.50", 51234), "sockname": ("127.0.0.1", 7071)}.get(name)

    def write(self, data: bytes) -> None:
        assert not self.closed, "written after close"
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


def _app(headers, chunks=(b"\xff\xfb\x90\x00", b"\xff\xfb\x90\x01")):
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": headers})
        for chunk in chunks:
            await send({"type": "http.response.body", "body": chunk, "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    return app


async def _serve(implementation: str, app, request: bytes) -> _FakeTransport:
    config = Config(app=app, log_config=None, access_log=False)
    config.load()
    protocol = _IMPLEMENTATIONS[implementation](
        config=config, server_state=ServerState(), app_state={}
    )
    transport = _FakeTransport()
    protocol.connection_made(transport)
    protocol.data_received(request)
    for _ in range(20):
        await asyncio.sleep(0)
    return transport


def _head_and_body(written: bytes) -> tuple[list[bytes], bytes]:
    head, _, body = written.partition(b"\r\n\r\n")
    return head.split(b"\r\n"), body


_GET = (
    b"GET /stream/abc.mp3 HTTP/1.1\r\nHost: beacon\r\n"
    b"User-Agent: Linux UPnP/1.0 Sonos/86.10-81100 (ZPS3)\r\n\r\n"
)


@pytest.mark.parametrize("implementation", _IMPLEMENTATIONS)
async def test_a_marked_response_has_no_length_and_ends_with_the_connection(implementation):
    transport = await _serve(
        implementation, _app([(b"content-type", b"audio/mpeg"), *_MARKED]), _GET
    )

    lines, body = _head_and_body(transport.written)
    names = [line.split(b":")[0].lower() for line in lines[1:]]
    assert lines[0] == b"HTTP/1.0 200 OK"
    assert b"transfer-encoding" not in names
    assert b"content-length" not in names
    assert CLOSE_DELIMITED_HEADER.encode() not in names
    assert b"connection: close" in [line.lower() for line in lines]
    assert b"content-type: audio/mpeg" in lines
    # The body exactly as the app sent it, no chunk sizes in between.
    assert body == b"\xff\xfb\x90\x00\xff\xfb\x90\x01"
    assert transport.closed


@pytest.mark.parametrize("implementation", _IMPLEMENTATIONS)
async def test_an_unmarked_response_keeps_uvicorns_framing(implementation):
    transport = await _serve(implementation, _app([(b"content-type", b"audio/mpeg")]), _GET)

    lines, body = _head_and_body(transport.written)
    assert lines[0] == b"HTTP/1.1 200 OK"
    assert b"transfer-encoding: chunked" in [line.lower() for line in lines]
    assert body.startswith(b"4\r\n\xff\xfb\x90\x00\r\n")


@pytest.mark.parametrize("implementation", _IMPLEMENTATIONS)
async def test_a_marked_head_drops_the_length_a_body_of_nothing_would_claim(implementation):
    """Starlette answers a HEAD with Content-Length: 0, which to a speaker
    asking about a stream reads as an empty one."""
    request = _GET.replace(b"GET", b"HEAD", 1)
    # A body the app produces anyway, as a streaming response would.
    app = _app([(b"content-length", b"0"), (b"content-type", b"audio/mpeg"), *_MARKED])

    transport = await _serve(implementation, app, request)

    lines, body = _head_and_body(transport.written)
    assert lines[0] == b"HTTP/1.0 200 OK"
    assert not any(line.lower().startswith(b"content-length") for line in lines)
    assert body == b""
    assert transport.closed


@pytest.mark.parametrize("implementation", _IMPLEMENTATIONS)
async def test_a_header_that_would_split_the_response_never_reaches_the_wire(implementation):
    app = _app([(b"icy-name", b"Station\r\nX-Injected: 1"), *_MARKED])

    transport = await _serve(implementation, app, _GET)

    assert b"X-Injected" not in transport.written
    assert transport.closed


def test_the_server_serves_with_the_framing_and_the_invalid_request_logging():
    assert issubclass(BeaconHTTPProtocol, CloseDelimitedFraming)
    assert issubclass(BeaconHTTPProtocol, DiagnosticHTTPProtocol)


def test_header_value_leaves_a_plain_name_alone():
    assert header_value("Café del Mar - Song") == "Café del Mar - Song"


def test_header_value_replaces_what_a_header_cannot_carry():
    assert header_value("Ночь – Song\r\nX-Injected: 1") == "???? ? Song  X-Injected: 1"


@pytest.mark.parametrize("implementation", _IMPLEMENTATIONS)
async def test_every_control_character_a_name_can_hold_gets_through_the_framing(implementation):
    """Whatever a tag holds, the framing's own header check must accept the
    cleaned name: one it refuses ends the stream before it starts."""
    name = "".join(chr(c) for c in [*range(0x20), 0x7F])
    app = _app([(b"icy-name", header_value(name).encode("latin-1")), *_MARKED])

    transport = await _serve(implementation, app, _GET)

    assert transport.written.startswith(b"HTTP/1.0 200 OK")
    assert transport.written.endswith(b"\xff\xfb\x90\x00\xff\xfb\x90\x01")
