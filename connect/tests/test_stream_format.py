"""Tests for core/stream_format.py — what content type to announce to a
device for a radio stream."""

import httpx
import pytest

from core.stream_format import (
    FALLBACK_CONTENT_TYPE,
    content_type_from_extension,
    probe_stream,
    radio_content_type,
    resolve_content_type,
)

AAC_URL = "https://playerservices.streamtheworld.com/api/livestream-redirect/OWR_ADP.aac"


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)


def _serving(content_type: str, status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        headers = {"content-type": content_type} if content_type else {}
        return httpx.Response(status, content=b"\x00" * 32, headers=headers)

    return handler


class TestFromExtension:
    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("https://x.example/stream.aac", "audio/aac"),
            ("https://x.example/stream.mp3", "audio/mpeg"),
            ("https://x.example/stream.ogg", "audio/ogg"),
            ("https://x.example/stream.opus", "audio/ogg"),
            ("https://x.example/stream.flac", "audio/flac"),
            ("https://x.example/stream.m4a", "audio/mp4"),
            # The common case — most Icecast mounts carry no extension at all.
            ("https://x.example/live", FALLBACK_CONTENT_TYPE),
            ("https://x.example/stream.weird", FALLBACK_CONTENT_TYPE),
            # The path's extension, never the query string's.
            ("https://x.example/stream.aac?token=abc&t=1", "audio/aac"),
        ],
    )
    def test_reads_the_paths_own_extension(self, url, expected):
        assert content_type_from_extension(url) == expected


class TestProbing:
    async def test_believes_the_station_over_its_own_file_extension(self):
        # A `.ogg` URL that is really FLAC: the extension says one thing and
        # the server another, and the server is right.
        async with _client(_serving("audio/flac")) as client:
            result = await resolve_content_type("https://x.example/stream.ogg", client)
        assert result == "audio/flac"

    async def test_drops_parameters_the_server_tacks_on(self):
        async with _client(_serving("audio/mpeg;charset=UTF-8")) as client:
            assert await resolve_content_type("https://x.example/live", client) == "audio/mpeg"

    async def test_normalises_case(self):
        async with _client(_serving("Audio/FLAC")) as client:
            assert await resolve_content_type("https://x.example/live", client) == "audio/flac"

    @pytest.mark.parametrize(
        ("declared", "announced"),
        [
            # The regression that made this necessary: probing alone turned
            # a station a Sonos had refused with ERROR_UNSUPPORTED_FORMAT
            # into one it refused with `UPnP Error 714: Illegal MIME-Type`
            # instead — it does not recognise `audio/aacp` in a DIDL
            # protocolInfo, only `audio/aac`.
            ("audio/aacp", "audio/aac"),
            ("audio/x-aac", "audio/aac"),
            ("audio/mp3", "audio/mpeg"),
            ("audio/x-mpeg", "audio/mpeg"),
            ("audio/vorbis", "audio/ogg"),
            ("audio/x-flac", "audio/flac"),
            ("audio/x-wav", "audio/wav"),
        ],
    )
    async def test_announces_the_spelling_devices_accept(self, declared, announced):
        async with _client(_serving(declared)) as client:
            assert await resolve_content_type(AAC_URL, client) == announced

    async def test_passes_through_an_audio_type_it_has_no_alias_for(self):
        # Refusing an accurate name a device happens not to know is no
        # worse than handing it a guess, and the re-encode fallback covers
        # either outcome — so an unknown audio/* type is not second-guessed.
        async with _client(_serving("audio/basic")) as client:
            assert await resolve_content_type("https://x.example/live", client) == "audio/basic"

    async def test_follows_a_redirect_to_the_node_actually_serving_the_stream(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "balancer":
                return httpx.Response(302, headers={"location": "https://node/stream.aac"})
            return httpx.Response(200, headers={"content-type": "audio/aacp"})

        async with _client(handler) as client:
            result = await resolve_content_type("https://balancer/stream.aac", client)
        assert result == "audio/aac"


class TestFallsBackToTheGuess:
    """Never worse than the extension guess it replaces — a station that
    can't be reached or won't say still gets announced as something."""

    async def test_when_the_station_is_unreachable(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down")

        async with _client(handler) as client:
            assert await resolve_content_type(AAC_URL, client) == "audio/aac"

    async def test_when_the_station_answers_an_http_error(self):
        async with _client(_serving("audio/aacp", status=404)) as client:
            assert await resolve_content_type(AAC_URL, client) == "audio/aac"

    async def test_when_the_station_declares_nothing_at_all(self):
        async with _client(_serving("")) as client:
            assert await resolve_content_type(AAC_URL, client) == "audio/aac"

    async def test_when_the_station_declares_something_that_is_not_audio(self):
        # An unconfigured Icecast mount answers application/octet-stream;
        # announcing that to a device is strictly worse than the guess.
        async with _client(_serving("application/octet-stream")) as client:
            assert await resolve_content_type(AAC_URL, client) == "audio/aac"

    async def test_and_all_the_way_down_to_the_blanket_default(self):
        async with _client(_serving("text/html")) as client:
            result = await resolve_content_type("https://x.example/live", client)
        assert result == FALLBACK_CONTENT_TYPE


class TestRadioContentType:
    def test_reuses_what_the_station_was_probed_as(self):
        info = {"url": AAC_URL, "content_type": "audio/flac"}
        assert radio_content_type(info) == "audio/flac"

    def test_falls_back_to_the_extension_for_state_written_before_this_existed(self):
        # A session that started casting on an older build has no recorded
        # type; a reconnect must still announce something sensible.
        assert radio_content_type({"url": AAC_URL}) == "audio/aac"


class TestRefusedByTheStation:
    """A station answering 4xx is not a device problem, and nothing
    downstream can fix it — ffmpeg would fetch the very same URL. Told
    apart here so /play-url can say so instead of letting the speaker fail
    on it and the re-encode fail behind that (which reached a listener as
    ERROR_ACCESS_DENIED followed by ERROR_CORRUPT_FILE, two messages about
    a speaker that was working fine)."""

    @pytest.mark.parametrize("status", [401, 403, 404, 410])
    async def test_flags_the_codes_that_mean_the_station_said_no(self, status):
        async with _client(_serving("audio/mpeg", status=status)) as client:
            probed = await probe_stream(AAC_URL, client)
        assert probed.refused is True
        assert probed.detail == f"HTTP {status}"

    @pytest.mark.parametrize("status", [500, 502, 503])
    async def test_leaves_a_server_side_wobble_alone(self, status):
        # A station can be briefly broken and play fine anyway; refusing to
        # try would be worse than trying and failing.
        async with _client(_serving("audio/mpeg", status=status)) as client:
            assert (await probe_stream(AAC_URL, client)).refused is False

    async def test_a_station_that_never_answered_is_not_a_refusal(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down")

        async with _client(handler) as client:
            assert (await probe_stream(AAC_URL, client)).refused is False

    async def test_a_working_station_is_never_flagged(self):
        async with _client(_serving("audio/mpeg")) as client:
            probed = await probe_stream("https://x.example/live", client)
        assert probed.refused is False
        assert probed.content_type == "audio/mpeg"
