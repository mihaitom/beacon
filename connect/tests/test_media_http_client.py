"""Tests for media/http_client.py — the shared, pooled HTTP client the media
adapters make every media-server call through.

The point of the module is connection *reuse*: `httpx.get()` per call builds
a client, resolves DNS, does a TLS handshake and throws it all away, which
under a library-browsing burst was enough to overrun the host's DNS stub and
take a cast session down with it (see
docs/playback-bugs/fixed-slow-media-lookup-froze-streaming.md).
"""

import httpx
import pytest

from media import http_client


@pytest.fixture(autouse=True)
def _fresh_client():
    http_client.close()
    yield
    http_client.close()


def test_reuses_one_client_across_calls():
    """The whole reason this module exists — a new client per call is a new
    connection, a new DNS lookup and a new TLS handshake per call."""
    assert http_client.client() is http_client.client()


def test_creates_the_client_lazily():
    """Importing the media package must not open sockets or resolve anything
    on its own — tests import it constantly."""
    assert http_client._client is None
    http_client.client()
    assert http_client._client is not None


def test_keeps_connections_alive_between_requests():
    """Pooling only helps if idle connections survive the gap between one
    request and the next while someone scrolls a library."""
    assert http_client._LIMITS.max_keepalive_connections > 0
    assert http_client._LIMITS.keepalive_expiry >= 30


def test_bounds_the_connection_count():
    """Bounded so a runaway caller cannot exhaust the media server's own
    connection limit."""
    assert http_client._LIMITS.max_connections is not None
    assert http_client._LIMITS.max_connections > 0


def test_builds_the_client_with_those_limits(monkeypatch):
    """Asserting on the constant alone would still pass if the client were
    built without it — check it is actually handed over."""
    captured = {}

    class _FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def close(self):
            pass

    monkeypatch.setattr(http_client.httpx, "Client", _FakeClient)
    http_client.client()

    assert captured["limits"] is http_client._LIMITS


def test_get_and_post_go_through_the_shared_client(monkeypatch):
    calls = []
    shared = http_client.client()

    def _record(method):
        def _inner(url, **kwargs):
            calls.append((method, url, kwargs))
            return httpx.Response(200, request=httpx.Request(method.upper(), url))

        return _inner

    monkeypatch.setattr(shared, "get", _record("get"))
    monkeypatch.setattr(shared, "post", _record("post"))

    assert http_client.get("http://server/a", params={"x": 1}).status_code == 200
    assert http_client.post("http://server/b", json={"y": 2}).status_code == 200

    assert calls[0][:2] == ("get", "http://server/a")
    assert calls[0][2] == {"params": {"x": 1}}
    assert calls[1][:2] == ("post", "http://server/b")
    assert calls[1][2] == {"json": {"y": 2}}


def test_close_drops_the_pool_and_the_next_call_rebuilds_it():
    first = http_client.client()
    http_client.close()

    assert http_client._client is None
    assert first.is_closed
    assert http_client.client() is not first


def test_close_is_safe_when_nothing_was_ever_created():
    http_client.close()
    http_client.close()  # must not raise on an already-empty pool
    assert http_client._client is None
