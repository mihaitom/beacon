"""Tests for media/bridge.py — what the Jellyfin and Plex bridges share.

Driven through a small Bridge of the test's own and a real httpx client on a
mock transport, so what is checked is the Subsonic side both bridges answer
with, independent of either server's calls.
"""

import threading
from unittest.mock import MagicMock

import httpx
import pytest
from starlette.requests import Request

from media import bridge, jellyfin_bridge, plex_bridge
from media.bridge import PlaylistEditor


def _request(query: str = "", headers: dict[str, str] | None = None) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/rest/x",
            "query_string": query.encode(),
            "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        }
    )


class _ClosingStream(httpx.AsyncByteStream):
    def __init__(self, body: bytes):
        self.body = body
        self.closed = False

    async def __aiter__(self):
        yield self.body
        yield self.body

    async def aclose(self) -> None:
        self.closed = True


class _Upstream:
    """A server answering every request with one canned response, keeping
    what it was asked."""

    def __init__(self, status: int = 200, content_type: str = "image/jpeg"):
        self.status = status
        self.content_type = content_type
        self.stream = _ClosingStream(b"bytes")
        self.requests: list[httpx.Request] = []

    def client(self) -> httpx.AsyncClient:
        def answer(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            return httpx.Response(
                self.status, headers={"content-type": self.content_type}, stream=self.stream
            )

        return httpx.AsyncClient(transport=httpx.MockTransport(answer))


def _media() -> MagicMock:
    media = MagicMock()
    media.auth_headers = lambda: {"Authorization": "Token tok"}
    return media


def _bridge(upstream: _Upstream, cover_url: str | None = "http://server/cover") -> bridge.Bridge:
    client = upstream.client()

    async def cover(_cover_id, _params, _media):
        return cover_url

    async def stream(_track_id, _media):
        return "http://server/stream"

    async def get_song(params, _media):
        return {"song": {"id": params["id"]}}

    return bridge.Bridge(
        label="test-bridge",
        unsupported="is not supported here",
        handlers={"getSong.view": get_song},
        log=MagicMock(),
        client=lambda: client,
        cover_url=cover,
        stream_url=stream,
    )


async def _body(response) -> bytes:
    return b"".join([chunk async for chunk in response.body_iterator])


# ── ids and mapping ──────────────────────────────────────────────────────────


def test_quote_id_keeps_an_id_inside_its_path_segment():
    """Every id comes from the request unvalidated; "../Users" spliced in
    raw would reach server paths outside the handler whitelist."""
    assert "/" not in bridge.quote_id("../Users")


def test_map_all_skips_a_malformed_item_and_keeps_the_rest():
    def mapper(item):
        if item["Id"] == "bad":
            raise ValueError("no name")
        return {"id": item["Id"]}

    items = [{"Id": "a"}, {"Id": "bad"}, {"Id": "b"}]
    mapped = bridge.map_all(mapper, items, id_field="Id", log=MagicMock(), label="t")

    assert mapped == [{"id": "a"}, {"id": "b"}]


# ── playlists ────────────────────────────────────────────────────────────────


class _Playlist:
    """A server-side playlist addressed by per-entry ids, like both
    servers': appending a song hands out an id only the server knows."""

    def __init__(self, song_ids: list[str]):
        self.entries = [(f"e{i}", song) for i, song in enumerate(song_ids)]
        self._next = len(song_ids)

    def songs(self) -> list[str]:
        return [song for _, song in self.entries]

    def editor(self) -> PlaylistEditor:
        async def entries():
            return list(self.entries)

        async def remove(entry_ids):
            self.entries = [e for e in self.entries if e[0] not in entry_ids]

        async def add(song_ids):
            for song in song_ids:
                self.entries.append((f"e{self._next}", song))
                self._next += 1

        async def move(entry_id, index, _after):
            entry = next(e for e in self.entries if e[0] == entry_id)
            self.entries.remove(entry)
            self.entries.insert(index, entry)

        return PlaylistEditor(entries=entries, remove=remove, add=add, move=move)


async def test_set_playlist_songs_puts_a_newly_added_song_where_it_was_asked_for():
    """The added song only gets its entry id from the server, so the order
    has to be worked out from a fresh listing rather than the one before."""
    playlist = _Playlist(["a", "b", "c"])

    await bridge.set_playlist_songs(playlist.editor(), ["new", "a", "c"])

    assert playlist.songs() == ["new", "a", "c"]


# ── binary passthrough ───────────────────────────────────────────────────────


async def test_a_cover_is_fetched_with_the_server_s_credentials_and_cached():
    upstream = _Upstream()

    response = await bridge.handle(
        _bridge(upstream), "getCoverArt.view", _request("id=c1"), _media()
    )
    await _body(response)

    assert upstream.requests[0].headers["authorization"] == "Token tok"
    assert response.headers["cache-control"].startswith("public")


async def test_the_server_s_status_reaches_the_browser():
    """A missing cover stays a 404, not a 200 with an error page as image."""
    upstream = _Upstream(status=404)

    response = await bridge.handle(
        _bridge(upstream), "getCoverArt.view", _request("id=c1"), _media()
    )

    assert response.status_code == 404


async def test_the_upstream_response_is_closed_when_the_browser_stops_reading():
    """A seek or skip drops the <audio> element's connection mid-track; the
    server's response has to go with it rather than stay open."""
    upstream = _Upstream(content_type="audio/flac")

    response = await bridge.handle(_bridge(upstream), "stream.view", _request("id=t1"), _media())
    body = response.body_iterator
    assert await anext(body) == b"bytes"
    await body.aclose()

    assert upstream.stream.closed is True


@pytest.mark.parametrize(
    "path, query, message",
    [
        ("getCoverArt.view", "", "No cover art id supplied"),
        ("stream.view", "", "No track id supplied"),
    ],
)
async def test_a_binary_request_without_an_id_is_answered_without_asking_the_server(
    path, query, message
):
    upstream = _Upstream()

    response = await bridge.handle(_bridge(upstream), path, _request(query), _media())

    assert message.encode() in response.body
    assert upstream.requests == []


async def test_an_item_without_a_cover_is_answered_without_asking_the_server():
    upstream = _Upstream()

    response = await bridge.handle(
        _bridge(upstream, cover_url=None), "getCoverArt.view", _request("id=c1"), _media()
    )

    assert b"No cover art available" in response.body
    assert upstream.requests == []


# ── dispatch ─────────────────────────────────────────────────────────────────


async def test_call_refuses_an_endpoint_that_is_not_bridged():
    """core/party_library.py would otherwise read an empty answer as an
    empty library."""
    with pytest.raises(ValueError):
        await bridge.call(_bridge(_Upstream()), "getNothing.view", {}, _media())


async def test_call_answers_a_bridged_endpoint():
    result = await bridge.call(_bridge(_Upstream()), "getSong.view", {"id": "s1"}, _media())
    assert result == {"song": {"id": "s1"}}


# ── per server ───────────────────────────────────────────────────────────────


async def test_jellyfin_removes_every_stale_entry_in_one_call(monkeypatch):
    sent = []

    async def entries(_playlist_id, _media):
        return [("e1", "a"), ("e2", "b"), ("e3", "c")]

    async def request(method, _media, path, params=None, json_body=None):
        sent.append((method, path, params))

    monkeypatch.setattr(jellyfin_bridge, "_playlist_entries", entries)
    monkeypatch.setattr(jellyfin_bridge, "_jf_request", request)

    await jellyfin_bridge._set_playlist_songs("p1", ["b"], MagicMock())

    deletes = [params for method, _, params in sent if method == "DELETE"]
    assert deletes == [{"EntryIds": "e1,e3"}]


async def test_jellyfin_asks_for_the_cover_version_it_was_handed():
    """The version is what makes a changed cover a new URL, past every cache."""
    media = MagicMock(internal_url="http://jf:8096")

    url = await jellyfin_bridge._cover_url("item1_v2", {}, media)

    assert "/Items/item1/Images/Primary" in url
    assert "tag=v2" in url


async def test_plex_looks_the_stream_url_up_off_the_event_loop():
    """Plex resolves a stream URL over the network; on the loop, that
    request would stall every other request for its whole length."""
    lookup_thread = {}

    def get_stream_url(_track_id):
        lookup_thread["id"] = threading.get_ident()
        return "http://plex/stream"

    media = MagicMock(get_stream_url=get_stream_url)

    assert await plex_bridge._stream_url("t1", media) == "http://plex/stream"
    assert lookup_thread["id"] != threading.get_ident()
