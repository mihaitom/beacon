"""media/login_errors.py — why a sign-in against a media server failed.

Every failed check used to reach the login screen as "Media server rejected
the supplied credential", whatever the cause. A server too busy to answer
inside the timeout read exactly like a wrong password, which sent people
retyping a password that was fine.

The reason strings are a contract with the frontend (see
services/connect/errorMessage.ts's loginErrorMessage() and the
`auth.loginFailed.*` i18n keys), matched exactly there, so they are stable
identifiers, not prose. The English `message` is what a caller without the
frontend's translations sees, and the raw cause still goes to the log."""

import json
import socket
import ssl

import httpx

#: The server answered and refused the username, password or token.
REASON_REJECTED = "rejected"
#: The account exists but is not allowed to use the API.
REASON_FORBIDDEN = "forbidden"
#: Connected, but no answer arrived in time - an overloaded or hung server.
REASON_TIMEOUT = "timeout"
#: Nothing accepted the connection: wrong port, server down, no route.
REASON_UNREACHABLE = "unreachable"
#: The host name does not resolve.
REASON_DNS = "dns"
#: The TLS handshake failed, usually an untrusted or expired certificate.
REASON_TLS = "tls"
#: Not something that can be requested at all, e.g. no http(s):// scheme.
REASON_INVALID_URL = "invalid_url"
#: Something answered, but has no API at that path - a wrong address, or a
#: server of a different type than the one picked.
REASON_NOT_FOUND = "not_found"
#: Something answered with what is not this server's API: a web page, most
#: often a reverse proxy's own login page in front of the server.
REASON_UNEXPECTED_RESPONSE = "unexpected_response"
#: 502/503/504 - the server, or the proxy in front of it, says it is not
#: available right now.
REASON_SERVER_UNAVAILABLE = "server_unavailable"
#: Any other 5xx: the server failed on its own side.
REASON_SERVER_ERROR = "server_error"
#: 429, from the server or from a rate limiter in front of it.
REASON_RATE_LIMITED = "rate_limited"
#: The server's API is older than the one Beacon speaks.
REASON_INCOMPATIBLE = "incompatible"
#: The server does not support the way Beacon signs in (Subsonic's token
#: authentication, which e.g. Navidrome refuses for LDAP accounts).
REASON_AUTH_UNSUPPORTED = "auth_unsupported"
#: Jellyfin has Quick Connect switched off.
REASON_QUICK_CONNECT_DISABLED = "quick_connect_disabled"
#: Anything this can't place.
REASON_UNKNOWN = "unknown"

_MESSAGES = {
    REASON_REJECTED: "Media server rejected the supplied credential",
    REASON_FORBIDDEN: "Media server does not allow this account to sign in",
    REASON_TIMEOUT: "Media server did not respond in time",
    REASON_UNREACHABLE: "Media server could not be reached",
    REASON_DNS: "Media server address could not be resolved",
    REASON_TLS: "Media server's certificate could not be verified",
    REASON_INVALID_URL: "Media server URL is not valid",
    REASON_NOT_FOUND: "No media server API found at this address",
    REASON_UNEXPECTED_RESPONSE: "Address answered, but not like a media server",
    REASON_SERVER_UNAVAILABLE: "Media server is currently unavailable",
    REASON_SERVER_ERROR: "Media server reported an internal error",
    REASON_RATE_LIMITED: "Media server is rate limiting requests",
    REASON_INCOMPATIBLE: "Media server's API version is not compatible",
    REASON_AUTH_UNSUPPORTED: "Media server does not support this sign-in method",
    REASON_QUICK_CONNECT_DISABLED: "Quick Connect is not enabled on this Jellyfin server",
    REASON_UNKNOWN: "Sign-in failed",
}

# Only the first of these is the caller's own fault; the rest are 502/504 as
# a gateway reports a failure of the server behind it.
_STATUS = {
    REASON_REJECTED: 401,
    REASON_FORBIDDEN: 403,
    REASON_INVALID_URL: 400,
    REASON_TIMEOUT: 504,
}

# Subsonic API error codes (subsonic.org/pages/api.jsp, plus OpenSubsonic's
# 41-44).
_SUBSONIC_REASONS = {
    20: REASON_INCOMPATIBLE,  # client must upgrade
    30: REASON_INCOMPATIBLE,  # server must upgrade
    40: REASON_REJECTED,  # wrong username or password
    41: REASON_AUTH_UNSUPPORTED,  # token authentication not supported
    42: REASON_AUTH_UNSUPPORTED,  # authentication mechanism not supported
    44: REASON_REJECTED,  # invalid API key
    50: REASON_FORBIDDEN,  # user not authorized
}


class SubsonicError(RuntimeError):
    """A Subsonic response with status "failed". `code` is None when the
    body was not a Subsonic response at all."""

    def __init__(self, code: int | None, message: str):
        super().__init__(f"Subsonic Error {code}: {message}")
        self.code = code


class LoginFailed(Exception):
    """Raised by the login checks; main.py turns it into the response the
    login screen reads."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail

    @property
    def status_code(self) -> int:
        return _STATUS.get(self.reason, 502)

    @property
    def message(self) -> str:
        return _MESSAGES[self.reason]

    def body(self) -> dict:
        return {"detail": self.message, "error": "login_failed", "reason": self.reason}


def _causes(error: BaseException):
    """The error and everything it was raised from - httpx wraps httpcore,
    which wraps the socket or ssl error that actually says what happened."""
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        yield error
        error = error.__cause__ or error.__context__


def _connect_reason(error: BaseException) -> str:
    for cause in _causes(error):
        if isinstance(cause, ssl.SSLError):
            return REASON_TLS
        if isinstance(cause, socket.gaierror):
            return REASON_DNS
    # httpcore re-raises some of these with only the text of the original.
    text = str(error)
    if "CERTIFICATE_VERIFY_FAILED" in text or "SSL" in text:
        return REASON_TLS
    if any(
        marker in text
        for marker in (
            "Name or service not known",
            "nodename nor servname",
            "getaddrinfo failed",
            "Temporary failure in name resolution",
            "No address associated with hostname",
        )
    ):
        return REASON_DNS
    return REASON_UNREACHABLE


def _status_reason(status: int) -> str:
    if status == 401:
        return REASON_REJECTED
    if status == 403:
        return REASON_FORBIDDEN
    if status in (404, 405):
        return REASON_NOT_FOUND
    if status == 429:
        return REASON_RATE_LIMITED
    if status in (502, 503, 504):
        return REASON_SERVER_UNAVAILABLE
    if status >= 500:
        return REASON_SERVER_ERROR
    return REASON_UNKNOWN


def classify_login_error(error: BaseException) -> str:
    """One of the REASON_* constants for anything a login check can raise."""
    if isinstance(error, LoginFailed):
        return error.reason
    if isinstance(error, SubsonicError):
        if error.code is None:
            return REASON_UNEXPECTED_RESPONSE
        return _SUBSONIC_REASONS.get(error.code, REASON_UNKNOWN)
    if isinstance(error, httpx.HTTPStatusError):
        return _status_reason(error.response.status_code)
    # Before ConnectError's parent: a timeout is a TransportError too.
    if isinstance(error, httpx.TimeoutException):
        return REASON_TIMEOUT
    if isinstance(error, (httpx.InvalidURL, httpx.UnsupportedProtocol)):
        return REASON_INVALID_URL
    if isinstance(error, httpx.ConnectError):
        return _connect_reason(error)
    if isinstance(error, httpx.TooManyRedirects):
        return REASON_UNEXPECTED_RESPONSE
    if isinstance(error, httpx.TransportError):
        return REASON_UNREACHABLE
    # A body that isn't JSON, or JSON without the fields the API promises.
    if isinstance(error, (json.JSONDecodeError, KeyError, TypeError)):
        return REASON_UNEXPECTED_RESPONSE
    return REASON_UNKNOWN


def login_failed(error: BaseException) -> LoginFailed:
    if isinstance(error, LoginFailed):
        return error
    return LoginFailed(classify_login_error(error), str(error))
