"""Tests for media/login_errors.py — why a sign-in failed."""

import socket
import ssl

import httpx
import pytest

from media import SubsonicClient, http_client
from media.login_errors import (
    LoginFailed,
    SubsonicError,
    classify_login_error,
    login_failed,
)

_REQUEST = httpx.Request("GET", "https://music.example.com/rest/ping.view")


def _status_error(status: int) -> httpx.HTTPStatusError:
    return httpx.HTTPStatusError(
        str(status), request=_REQUEST, response=httpx.Response(status, request=_REQUEST)
    )


def _raised_from(outer: Exception, cause: BaseException) -> Exception:
    try:
        try:
            raise cause
        except BaseException as inner:
            raise outer from inner
    except Exception as e:
        return e


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (httpx.ReadTimeout("The read operation timed out"), "timeout"),
        (httpx.ConnectTimeout("timed out"), "timeout"),
        (httpx.ConnectError("[Errno 111] Connection refused"), "unreachable"),
        (httpx.RemoteProtocolError("Server disconnected"), "unreachable"),
        (httpx.UnsupportedProtocol("Request URL is missing a protocol"), "invalid_url"),
        (httpx.InvalidURL("Invalid non-printable ASCII character in URL"), "invalid_url"),
        (httpx.TooManyRedirects("Exceeded maximum allowed redirects."), "unexpected_response"),
        (_status_error(401), "rejected"),
        (_status_error(403), "forbidden"),
        (_status_error(404), "not_found"),
        (_status_error(429), "rate_limited"),
        (_status_error(502), "server_unavailable"),
        (_status_error(503), "server_unavailable"),
        (_status_error(504), "server_unavailable"),
        (_status_error(500), "server_error"),
        (_status_error(418), "unknown"),
        (SubsonicError(40, "Wrong username or password"), "rejected"),
        (
            SubsonicError(41, "Token authentication not supported for LDAP users"),
            "auth_unsupported",
        ),
        (SubsonicError(44, "Invalid API key"), "rejected"),
        (SubsonicError(50, "User is not authorized"), "forbidden"),
        (SubsonicError(30, "Incompatible Subsonic REST protocol version"), "incompatible"),
        (SubsonicError(None, "not a Subsonic response"), "unexpected_response"),
        (SubsonicError(0, "A generic error"), "unknown"),
        (KeyError("AccessToken"), "unexpected_response"),
        (ValueError("something else entirely"), "unknown"),
    ],
)
def test_classifies(error, reason):
    assert classify_login_error(error) == reason


def test_a_connect_error_caused_by_a_certificate_is_a_tls_problem():
    error = _raised_from(
        httpx.ConnectError("handshake failed"),
        ssl.SSLCertVerificationError("certificate verify failed: self-signed certificate"),
    )
    assert classify_login_error(error) == "tls"


def test_a_connect_error_caused_by_name_resolution_is_a_dns_problem():
    error = _raised_from(
        httpx.ConnectError("lookup failed"),
        socket.gaierror(-2, "Name or service not known"),
    )
    assert classify_login_error(error) == "dns"


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed", "tls"),
        ("[Errno -2] Name or service not known", "dns"),
        ("[Errno 8] nodename nor servname provided, or not known", "dns"),
        ("[Errno 11001] getaddrinfo failed", "dns"),
        ("[Errno -3] Temporary failure in name resolution", "dns"),
    ],
)
def test_a_connect_error_known_only_by_its_text(text, reason):
    assert classify_login_error(httpx.ConnectError(text)) == reason


@pytest.mark.parametrize(
    ("reason", "status"),
    [
        ("rejected", 401),
        ("forbidden", 403),
        ("invalid_url", 400),
        ("timeout", 504),
        ("unreachable", 502),
        ("server_error", 502),
        ("unknown", 502),
    ],
)
def test_status_codes(reason, status):
    assert LoginFailed(reason).status_code == status


def test_body_carries_the_reason_and_a_readable_detail():
    body = LoginFailed("timeout", "The read operation timed out").body()
    assert body == {
        "detail": "Media server did not respond in time",
        "error": "login_failed",
        "reason": "timeout",
    }


def test_login_failed_keeps_an_already_classified_failure():
    original = LoginFailed("quick_connect_disabled")
    assert login_failed(original) is original


def test_login_failed_keeps_the_raw_cause_as_detail():
    failed = login_failed(httpx.ReadTimeout("The read operation timed out"))
    assert failed.reason == "timeout"
    assert failed.detail == "The read operation timed out"


# ── what SubsonicClient.ping() makes of real responses ──────────────────────


def _ping_answering(monkeypatch, response_for):
    monkeypatch.setattr(SubsonicClient, "ping", _REAL_SUBSONIC_PING)
    monkeypatch.setattr(
        http_client, "get", lambda url, **kwargs: response_for(httpx.Request("GET", url))
    )
    with pytest.raises(LoginFailed) as failed:
        SubsonicClient("https://music.example.com", credential="u=a&t=b&s=c").ping()
    return failed.value.reason


# Captured before conftest's autouse stub replaces it for every test.
_REAL_SUBSONIC_PING = SubsonicClient.ping


def test_a_proxy_login_page_is_an_unexpected_response(monkeypatch):
    # What a reverse proxy with its own sign-in (Authentik, Authelia) hands
    # back once its redirect has been followed.
    reason = _ping_answering(
        monkeypatch,
        lambda request: httpx.Response(
            200, html="<!doctype html><title>Sign in</title>", request=request
        ),
    )
    assert reason == "unexpected_response"


def test_json_from_a_different_kind_of_server_is_an_unexpected_response(monkeypatch):
    reason = _ping_answering(
        monkeypatch,
        lambda request: httpx.Response(200, json={"Name": "Jellyfin"}, request=request),
    )
    assert reason == "unexpected_response"


def test_a_server_too_busy_to_answer_is_a_timeout_not_a_wrong_password(monkeypatch):
    def time_out(request):
        raise httpx.ReadTimeout("The read operation timed out", request=request)

    assert _ping_answering(monkeypatch, time_out) == "timeout"


def test_a_proxy_whose_backend_is_down_is_unavailable(monkeypatch):
    reason = _ping_answering(
        monkeypatch, lambda request: httpx.Response(502, text="Bad Gateway", request=request)
    )
    assert reason == "server_unavailable"
