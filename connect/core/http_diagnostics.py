"""core/http_diagnostics.py — who sends the requests uvicorn rejects.

uvicorn answers bytes it cannot parse as HTTP with a 400 and a bare
"Invalid HTTP request received.", naming neither the sender nor what
arrived. In #56 those came in pairs every 32s from somewhere on the
network, starting with the first dispatch to one Sonos group, and nothing
in the log could say which device it was.
"""

import logging

from uvicorn.protocols.http.auto import AutoHTTPProtocol

logger = logging.getLogger("connect.http")

# uvicorn's own line for the same event, dropped by main.py's log filter
# since the one below says the same and more.
UVICORN_INVALID_REQUEST_MESSAGE = "Invalid HTTP request received."

# Enough to tell a TLS handshake or a different protocol from a garbled
# HTTP request line.
_SAMPLE_BYTES = 24

# Every TLS record starts with content type 0x16 (handshake) and major
# version 3, whatever the minor version.
_TLS_HANDSHAKE_PREFIX = b"\x16\x03"


def describe_invalid_request(client: tuple[str, int] | None, data: bytes) -> str:
    sender = f"{client[0]}:{client[1]}" if client else "an unknown address"
    sample = data[:_SAMPLE_BYTES]
    what = (
        " — a TLS handshake: something tried https:// on this plain-http port"
        if sample.startswith(_TLS_HANDSHAKE_PREFIX)
        else ""
    )
    return (
        f"[http] Invalid HTTP request from {sender}{what}: "
        f"starts with {sample.hex(' ')} ({sample!r})"
    )


class DiagnosticHTTPProtocol(AutoHTTPProtocol):  # type: ignore[misc, valid-type]
    """uvicorn's own HTTP protocol, logging the sender and the first bytes
    of a request it rejects as invalid."""

    _last_data: bytes = b""

    def data_received(self, data: bytes) -> None:
        # The chunk being parsed when the parser gives up is the offending one.
        self._last_data = data
        super().data_received(data)

    def send_400_response(self, msg: str) -> None:
        logger.warning(describe_invalid_request(self.client, self._last_data))
        super().send_400_response(msg)
