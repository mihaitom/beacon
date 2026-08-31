"""Tests for core/playlist_url.py — turning a radio "stream" URL that is
really a playlist file into the audio URL inside it."""

import httpx
import pytest

from core.playlist_url import resolve_stream_url

STREAM = "http://dispatcher.rndfnk.com/br/br24/live/mp3/mid"


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)


def _serving(body: str, status: int = 200, content_type: str = "application/octet-stream"):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body.encode(), headers={"content-type": content_type})

    return handler


class TestLeavesRealStreamsAlone:
    """The overwhelmingly common case, and the one that must cost nothing:
    a URL that isn't a playlist is never even fetched."""

    @pytest.mark.parametrize(
        "url",
        [
            "http://mp3channels.webradio.rockantenne.de/rockantenne",
            "http://example.test/stream.mp3",
            "http://example.test/stream.aac",
            # An HLS playlist is the live format itself, not an indirection
            # to resolve away - picking the first segment out of one would
            # produce a few seconds of audio that then stops.
            "http://example.test/live.m3u8",
            # The extension has to be the path's, not the query string's.
            "http://example.test/stream?playlist=foo.m3u",
        ],
    )
    async def test_returns_the_url_untouched_without_fetching_it(self, url):
        def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
            raise AssertionError(f"should not have fetched {request.url}")

        async with _client(handler) as client:
            assert await resolve_stream_url(url, client) == url


class TestResolvesPlaylists:
    async def test_reads_the_stream_url_out_of_an_m3u(self):
        # Bayerischer Rundfunk's own b5aktuell_2.m3u, verbatim - the exact
        # station that produced a bare `UPnP Error 800` from a Sonos with
        # nothing pointing at the cause.
        async with _client(_serving(f"{STREAM}\n{STREAM}\n")) as client:
            resolved = await resolve_stream_url("http://streams.br.de/b5aktuell_2.m3u", client)
        assert resolved == STREAM

    async def test_skips_an_m3u_comment_that_mentions_a_url_of_its_own(self):
        # #EXTINF lines routinely carry a station homepage, which is
        # emphatically not the stream.
        body = f"#EXTM3U\n#EXTINF:-1,B5 aktuell - http://www.br.de/b5\n{STREAM}\n"
        async with _client(_serving(body)) as client:
            resolved = await resolve_stream_url("http://example.test/station.m3u", client)
        assert resolved == STREAM

    async def test_reads_a_pls_file(self):
        body = f"[playlist]\nNumberOfEntries=1\nFile1={STREAM}\nTitle1=B5\nVersion=2\n"
        async with _client(_serving(body)) as client:
            resolved = await resolve_stream_url("http://example.test/station.pls", client)
        assert resolved == STREAM

    async def test_reads_an_asx_file(self):
        body = f'<ASX version="3.0"><ENTRY><REF HREF="{STREAM}"/></ENTRY></ASX>'
        async with _client(_serving(body)) as client:
            resolved = await resolve_stream_url("http://example.test/station.asx", client)
        assert resolved == STREAM

    async def test_takes_the_first_of_several_entries(self):
        body = f"{STREAM}\nhttp://backup.test/stream\n"
        async with _client(_serving(body)) as client:
            resolved = await resolve_stream_url("http://example.test/station.m3u", client)
        assert resolved == STREAM


class TestFailureLeavesTheCallerWhereItWas:
    """Resolving is an improvement, never a precondition — a playlist that
    can't be read must not turn a station that might somehow still work
    into one that provably can't."""

    async def test_returns_the_original_url_when_the_playlist_is_unreachable(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down")

        url = "http://example.test/station.m3u"
        async with _client(handler) as client:
            assert await resolve_stream_url(url, client) == url

    async def test_returns_the_original_url_on_an_http_error(self):
        url = "http://example.test/station.m3u"
        async with _client(_serving("nope", status=404)) as client:
            assert await resolve_stream_url(url, client) == url

    async def test_returns_the_original_url_when_the_file_holds_no_stream_url(self):
        url = "http://example.test/station.m3u"
        async with _client(_serving("#EXTM3U\n/relative/path/only\n")) as client:
            assert await resolve_stream_url(url, client) == url

    async def test_survives_a_playlist_that_is_not_valid_utf8(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b"\xff\xfe\n" + STREAM.encode())

        async with _client(handler) as client:
            resolved = await resolve_stream_url("http://example.test/station.m3u", client)
        assert resolved == STREAM
