"""core/http_protocol.py — the HTTP protocol Beacon serves with: uvicorn's
own (with core/http_diagnostics.py's logging), plus a body framing uvicorn
lacks.

uvicorn sends every response without a Content-Length chunked. Old Sonos
models stop reading a chunked stream after about 40 seconds and take what
they have for the whole track (#56), yet read an internet radio station to
the end, which arrives with an HTTP/1.0 status line, no length and no
chunking: the body ends where the connection closes. A response that sets
CLOSE_DELIMITED goes out like that (see
docs/investigations/old-sonos-models-stop-reading-the-stream.md).
"""

import re
from http import HTTPStatus

from uvicorn.protocols.utils import get_client_addr, get_path_with_query_string

from .http_diagnostics import DiagnosticHTTPProtocol

# The header a response sets to be sent close-delimited. It never leaves
# this machine: CloseDelimitedFraming strips it with the framing headers.
CLOSE_DELIMITED_HEADER = "x-beacon-framing"
CLOSE_DELIMITED = {CLOSE_DELIMITED_HEADER: "close"}

_MARKER_NAME = CLOSE_DELIMITED_HEADER.encode()
# Dropped from uvicorn's headers and the app's alike: they would contradict it.
_FRAMING_HEADERS = frozenset({_MARKER_NAME, b"content-length", b"transfer-encoding", b"connection"})
# The same characters uvicorn refuses in a header, so nothing can be
# smuggled into the response through one.
_INVALID_NAME = re.compile(b'[\x00-\x1f\x7f()<>@,;:\\[\\]={} \t\\\\"]')
_INVALID_VALUE = re.compile(b"[\x00-\x08\x0a-\x1f\x7f]")
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")


def header_value(text: str) -> str:
    """`text` as a header can carry it, for a name out of a tag or a radio
    directory. A control character could fail the whole response (uvicorn
    and the framing below refuse all but the tab); anything outside
    latin-1, which Starlette cannot encode, answered a Sonos with a 500 for
    every Cyrillic or CJK station name. Both become placeholders instead."""
    return _CONTROL_CHARACTERS.sub(" ", text).encode("latin-1", "replace").decode("latin-1")


def _asks_for_close_delimited(message) -> bool:
    return message["type"] == "http.response.start" and any(
        name.lower() == _MARKER_NAME and value == b"close"
        for name, value in message.get("headers", [])
    )


def _status_line(status: int) -> bytes:
    try:
        phrase = HTTPStatus(status).phrase.encode()
    except ValueError:
        phrase = b""
    return b"HTTP/1.0 %d %s\r\n" % (status, phrase)


class _CloseDelimitedCycle:
    """Mixed into uvicorn's RequestResponseCycle, of either implementation.
    A response without the marker is left entirely to uvicorn."""

    _close_delimited = False

    async def send(self, message) -> None:
        if not self.response_started:
            if _asks_for_close_delimited(message):
                await self._start_close_delimited(message)
                return
        elif self._close_delimited:
            await self._send_close_delimited_body(message)
            return
        await super().send(message)

    async def _start_close_delimited(self, message) -> None:
        if self.flow.write_paused and not self.disconnected:
            await self.flow.drain()
        if self.disconnected:
            return
        self.response_started = True
        self.waiting_for_100_continue = False
        self._close_delimited = True
        self.keep_alive = False

        status = message["status"]
        if self.access_log:
            self.access_logger.info(
                '%s - "%s %s HTTP/%s" %d',
                get_client_addr(self.scope),
                self.scope["method"],
                get_path_with_query_string(self.scope),
                self.scope["http_version"],
                status,
            )
        lines = [_status_line(status)]
        for name, value in [*self.default_headers, *message.get("headers", [])]:
            name = name.lower()
            if name in _FRAMING_HEADERS:
                continue
            if _INVALID_NAME.search(name) or _INVALID_VALUE.search(value):
                raise RuntimeError("Invalid HTTP header.")
            lines.append(name + b": " + value + b"\r\n")
        lines.append(b"connection: close\r\n\r\n")
        self.transport.write(b"".join(lines))

    async def _send_close_delimited_body(self, message) -> None:
        if message["type"] != "http.response.body":
            raise RuntimeError(
                f"Expected ASGI message 'http.response.body', but got '{message['type']}'."
            )
        if self.response_complete:
            raise RuntimeError(
                f"Unexpected ASGI message '{message['type']}' sent, after response already "
                "completed."
            )
        if self.flow.write_paused and not self.disconnected:
            await self.flow.drain()
        if self.disconnected:
            return
        body = message.get("body", b"")
        if body and self.scope["method"] != "HEAD":
            self.transport.write(body)
        if not message.get("more_body", False):
            self.response_complete = True
            self.message_event.set()
            # Closing is what ends the body. uvicorn's own completion then
            # sees a closing transport and only counts the request.
            self.transport.close()
            self.on_response()


_cycle_classes: dict[type, type] = {}


def _close_delimited_cycle(cycle_class: type) -> type:
    if issubclass(cycle_class, _CloseDelimitedCycle):
        return cycle_class
    if cycle_class not in _cycle_classes:
        _cycle_classes[cycle_class] = type(
            f"CloseDelimited{cycle_class.__name__}", (_CloseDelimitedCycle, cycle_class), {}
        )
    return _cycle_classes[cycle_class]


class CloseDelimitedFraming:
    """Mixed into a uvicorn HTTP protocol class. Both implementations hand
    every request's cycle to `self.cycle` before its ASGI task first runs,
    so that assignment is where it learns the framing."""

    @property
    def cycle(self):
        return self.__dict__.get("_cycle")

    @cycle.setter
    def cycle(self, cycle) -> None:
        if cycle is not None:
            cycle.__class__ = _close_delimited_cycle(type(cycle))
        self.__dict__["_cycle"] = cycle


class BeaconHTTPProtocol(CloseDelimitedFraming, DiagnosticHTTPProtocol):  # type: ignore[misc]
    """What main.py serves with."""
