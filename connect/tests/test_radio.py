"""Tests for routes/radio.py — GET /radio-favicon, POST /radio-metadata/start,
POST /radio-metadata/stop, GET /radio-metadata."""

import io
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from PIL import Image

import routes.radio as radio_mod


def _png_bytes(mode: str, transparent_ratio: float = 0.0) -> bytes:
    """A synthetic 32x32 PNG — `transparent_ratio` of its pixels (from the
    top) fully transparent, the rest opaque, when mode is RGBA. Ignored for
    RGB (no alpha channel at all)."""
    size = 32
    img = Image.new(mode, (size, size), (200, 40, 40, 255) if mode == "RGBA" else (200, 40, 40))
    if mode == "RGBA":
        transparent_rows = int(size * transparent_ratio)
        for y in range(transparent_rows):
            for x in range(size):
                img.putpixel((x, y), (200, 40, 40, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _clear_candidate_cache():
    radio_mod._candidate_cache.clear()
    yield
    radio_mod._candidate_cache.clear()


def _fake_get_response(status_code=200, content=b"icon-bytes", content_type="image/x-icon"):
    resp = MagicMock()
    resp.status_code = status_code
    resp.content = content
    resp.headers = {"content-type": content_type}
    return resp


def _mock_stream(html: bytes, content_type="text/html"):
    """Mocks _client.stream("GET", url) — an async context manager yielding
    a response whose .aiter_bytes() streams `html` in one chunk."""
    stream_resp = MagicMock()
    stream_resp.headers = {"content-type": content_type}

    async def aiter_bytes():
        yield html

    stream_resp.aiter_bytes = aiter_bytes

    @asynccontextmanager
    async def stream(method, url):
        yield stream_resp

    return stream


# ── Input validation ─────────────────────────────────────────────────────────


def test_radio_favicon_rejects_non_http_scheme(client):
    r = client.get("/radio-favicon", params={"url": "file:///etc/passwd"})
    assert r.status_code == 400


def test_radio_favicon_rejects_url_without_host(client):
    r = client.get("/radio-favicon", params={"url": "http://"})
    assert r.status_code == 400


def test_radio_favicon_404s_when_neither_url_nor_hint_is_given(client):
    r = client.get("/radio-favicon")
    assert r.status_code == 404


def test_radio_favicon_404s_when_url_is_missing_and_the_hint_is_broken(client):
    with patch.object(radio_mod._client, "get", AsyncMock(side_effect=httpx.ConnectError("x"))):
        r = client.get("/radio-favicon", params={"hint": "https://cdn.example/dead.png"})
    assert r.status_code == 404


# ── Radio Browser's own favicon hint ─────────────────────────────────────────


def test_radio_favicon_uses_the_hint_with_no_homepage_at_all(client):
    """A station played straight out of the discover dialog without being
    added can have a Radio Browser favicon hint but no homepage (see
    RadioStation.favicon in types/library.ts) — the hint alone must still
    resolve, with no homepage ever scraped and no 400 for the missing url."""
    hint_response = _fake_get_response(content=b"hinted-icon-bytes", content_type="image/png")
    mock_stream = MagicMock(side_effect=AssertionError("should not scrape a homepage"))
    with (
        patch.object(radio_mod._client, "stream", mock_stream),
        patch.object(radio_mod._client, "get", AsyncMock(return_value=hint_response)),
    ):
        r = client.get("/radio-favicon", params={"hint": "https://cdn.example/icon.png"})
    assert r.status_code == 200
    assert r.content == b"hinted-icon-bytes"
    mock_stream.assert_not_called()


def test_radio_favicon_uses_the_hint_without_scraping_the_homepage(client):
    hint_response = _fake_get_response(content=b"hinted-icon-bytes", content_type="image/png")
    mock_stream = MagicMock(side_effect=AssertionError("should not scrape the homepage"))
    with (
        patch.object(radio_mod._client, "stream", mock_stream),
        patch.object(radio_mod._client, "get", AsyncMock(return_value=hint_response)),
    ):
        r = client.get(
            "/radio-favicon",
            params={"url": "https://example.com", "hint": "https://cdn.example/icon.png"},
        )
    assert r.status_code == 200
    assert r.content == b"hinted-icon-bytes"
    mock_stream.assert_not_called()


def test_radio_favicon_falls_back_to_the_homepage_when_the_hint_is_broken(client):
    good_response = _fake_get_response(content=b"scraped-icon-bytes", content_type="image/png")
    mock_get = AsyncMock(side_effect=[httpx.ConnectError("dead hint"), good_response])
    with (
        patch.object(radio_mod._client, "stream", side_effect=httpx.ConnectError("x")),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get(
            "/radio-favicon",
            params={"url": "https://example.com", "hint": "https://cdn.example/dead.png"},
        )
    assert r.status_code == 200
    assert r.content == b"scraped-icon-bytes"


def test_radio_favicon_ignores_a_non_http_hint(client):
    mock_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", side_effect=httpx.ConnectError("x")),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get(
            "/radio-favicon",
            params={"url": "https://example.com", "hint": "javascript:alert(1)"},
        )
    assert r.status_code == 200
    # Only the favicon.ico fallback was ever requested — the hint itself
    # was never handed to httpx.
    for call in mock_get.call_args_list:
        assert call.args[0] != "javascript:alert(1)"


# ── No declared icon → implicit /favicon.ico fallback ───────────────────────


# ── _parse_sizes ─────────────────────────────────────────────────────────────


def test_parse_sizes_picks_the_largest_declared():
    assert radio_mod._parse_sizes("16x16 32x32 48x48") == 48


def test_parse_sizes_any_outranks_every_raster_size():
    # "any" (SVG, scales losslessly) counts as larger than any raster size
    # actually likely to be declared alongside it.
    assert radio_mod._parse_sizes("48x48 any") == 100_000


def test_parse_sizes_empty_string_is_zero():
    assert radio_mod._parse_sizes("") == 0


# ── homepage HTML discovery ───────────────────────────────────────────────────


def test_discover_candidates_stops_reading_past_the_html_byte_cap(client):
    """A homepage response must not be buffered without limit — a huge (or
    infinite, e.g. misconfigured streaming) body stops being read once
    _MAX_HTML_BYTES is reached, rather than the response ever finishing."""
    chunk = b"<html>" + b" " * 1024  # 1KB-ish chunks
    n_chunks = (radio_mod._MAX_HTML_BYTES // len(chunk)) + 5  # well past the cap

    stream_resp = MagicMock()
    stream_resp.headers = {"content-type": "text/html"}

    async def aiter_bytes():
        for _ in range(n_chunks):
            yield chunk

    stream_resp.aiter_bytes = aiter_bytes

    @asynccontextmanager
    async def stream(method, url):
        yield stream_resp

    mock_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", stream),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})

    # No <link> tags in the (junk) HTML either way — just confirms this
    # returned promptly instead of consuming every one of n_chunks first.
    assert r.status_code == 200


def test_radio_favicon_skips_an_unreachable_candidate_and_tries_the_next(client):
    html = (
        b"<html><head>"
        b'<link rel="icon" sizes="16x16" href="/broken.png">'
        b'<link rel="icon" sizes="48x48" href="/good.png">'
        b"</head><body></body></html>"
    )
    good_response = _fake_get_response(content=b"real-icon-bytes", content_type="image/png")
    mock_get = AsyncMock(side_effect=[httpx.ConnectError("unreachable"), good_response])

    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})

    assert r.status_code == 200
    assert r.content == b"real-icon-bytes"
    assert mock_get.await_count == 2


def test_radio_favicon_falls_back_to_favicon_ico_when_homepage_unreachable(client):
    with (
        patch.object(radio_mod._client, "stream", side_effect=httpx.ConnectError("x")),
        patch.object(radio_mod._client, "get", AsyncMock(return_value=_fake_get_response())),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200


def test_radio_favicon_falls_back_to_favicon_ico_when_no_link_tags(client):
    html = b"<html><head><title>No icons here</title></head><body></body></html>"
    mock_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200
    mock_get.assert_awaited_once_with("https://example.com/favicon.ico")


def test_radio_favicon_skips_html_parsing_for_non_html_content_type(client):
    # The "homepage_url" itself resolves straight to an image or something
    # else entirely — treated the same as "found nothing", not an error.
    mock_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(b"", content_type="image/png")),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200
    mock_get.assert_awaited_once_with("https://example.com/favicon.ico")


# ── Declared <link rel="icon"> discovery ─────────────────────────────────────


def test_radio_favicon_prefers_declared_icon_over_favicon_ico(client):
    html = b'<html><head><link rel="icon" href="/static/logo.png"></head></html>'
    mock_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200
    mock_get.assert_awaited_once_with("https://example.com/static/logo.png")


def test_radio_favicon_resolves_relative_href_against_homepage_url(client):
    html = b'<html><head><link rel="icon" href="icons/favicon.png"></head></html>'
    mock_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        client.get("/radio-favicon", params={"url": "https://example.com/station/"})
    mock_get.assert_awaited_once_with("https://example.com/station/icons/favicon.png")


def test_radio_favicon_picks_smallest_candidate_meeting_min_size(client):
    html = (
        b"<html><head>"
        b'<link rel="icon" href="/16.png" sizes="16x16">'
        b'<link rel="apple-touch-icon" href="/180.png" sizes="180x180">'
        b'<link rel="icon" href="/512.png" sizes="512x512">'
        b"</head></html>"
    )
    mock_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 128})
    # 180x180 is the smallest of the three that still meets min_size=128 —
    # no reason to fetch the 512px one when this list row only needs ~128px.
    mock_get.assert_awaited_once_with("https://example.com/180.png")


def test_radio_favicon_falls_back_to_largest_when_nothing_meets_min_size(client):
    html = (
        b"<html><head>"
        b'<link rel="icon" href="/16.png" sizes="16x16">'
        b'<link rel="icon" href="/32.png" sizes="32x32">'
        b"</head></html>"
    )
    mock_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 512})
    mock_get.assert_awaited_once_with("https://example.com/32.png")


# ── Cascading fallback on a bad candidate ────────────────────────────────────


def test_radio_favicon_falls_through_to_next_candidate_on_404(client):
    html = b'<html><head><link rel="icon" href="/dead.png"></head></html>'
    responses = [_fake_get_response(status_code=404), _fake_get_response()]
    mock_get = AsyncMock(side_effect=responses)
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200
    assert mock_get.await_count == 2
    mock_get.assert_any_await("https://example.com/dead.png")
    mock_get.assert_any_await("https://example.com/favicon.ico")


def test_radio_favicon_returns_404_when_every_candidate_fails(client):
    html = b'<html><head><link rel="icon" href="/dead.png"></head></html>'
    mock_get = AsyncMock(return_value=_fake_get_response(status_code=404))
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 404


# ── Response validation (unchanged from the single-candidate version) ───────


def test_radio_favicon_returns_404_for_non_image_content_type(client):
    fake = _fake_get_response(content_type="text/html")
    with (
        patch.object(radio_mod._client, "stream", side_effect=httpx.ConnectError("x")),
        patch.object(radio_mod._client, "get", AsyncMock(return_value=fake)),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 404


def test_radio_favicon_returns_404_for_oversized_response(client):
    fake = _fake_get_response(content=b"x" * (radio_mod._MAX_BYTES + 1))
    with (
        patch.object(radio_mod._client, "stream", side_effect=httpx.ConnectError("x")),
        patch.object(radio_mod._client, "get", AsyncMock(return_value=fake)),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 404


# ── Inline `data:` URI favicons (RFC 2397) ───────────────────────────────────
# Regression tests: some sites declare a favicon directly as a data: URI
# instead of linking to a separate file — the old code handed that straight
# to httpx.get(), which fails ("missing a protocol") since there's nothing
# to fetch; the bytes are already right there in the URI.


def test_radio_favicon_decodes_percent_encoded_data_uri_svg(client):
    svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'></svg>"
    html = (
        b'<html><head><link rel="icon" href="data:image/svg+xml,'
        + svg.replace("<", "%3C").replace(">", "%3E").encode()
        + b'"></head></html>'
    )
    mock_get = AsyncMock()  # must never be called — nothing to fetch
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/svg+xml"
    assert r.content.decode() == svg
    mock_get.assert_not_called()


def test_radio_favicon_decodes_base64_data_uri_png(client):
    import base64

    png_bytes = _png_bytes("RGB")
    encoded = base64.b64encode(png_bytes).decode()
    html = (
        b'<html><head><link rel="icon" href="data:image/png;base64,'
        + encoded.encode()
        + b'"></head></html>'
    )
    mock_get = AsyncMock()
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content == png_bytes
    mock_get.assert_not_called()


def test_radio_favicon_falls_through_to_favicon_ico_on_malformed_data_uri(client):
    # No comma at all — nothing separates the header from a (nonexistent) payload.
    html = b'<html><head><link rel="icon" href="data:image/png;base64"></head></html>'
    mock_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200
    mock_get.assert_awaited_once_with("https://example.com/favicon.ico")


def test_radio_favicon_skips_a_decoded_data_uri_with_a_non_image_content_type(client):
    # Decodes fine, but declares a content type that isn't actually an
    # image — distinct from the malformed (no comma) case above, which
    # never gets as far as decoding at all.
    html = b'<html><head><link rel="icon" href="data:text/plain;base64,aGVsbG8="></head></html>'
    mock_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200
    mock_get.assert_awaited_once_with("https://example.com/favicon.ico")


def test_decode_data_uri_returns_none_without_comma():
    assert radio_mod._decode_data_uri("data:image/png;base64") is None


def test_decode_data_uri_returns_none_for_invalid_base64():
    assert radio_mod._decode_data_uri("data:image/png;base64,not-valid-base64!!!") is None


def test_decode_data_uri_defaults_content_type_when_missing():
    content, content_type = radio_mod._decode_data_uri("data:,hello")
    assert content == b"hello"
    assert content_type == "application/octet-stream"


def test_radio_favicon_returns_image_bytes_and_cache_header_on_success(client):
    fake = _fake_get_response(content=b"\x00\x01icon", content_type="image/x-icon")
    with (
        patch.object(radio_mod._client, "stream", side_effect=httpx.ConnectError("x")),
        patch.object(radio_mod._client, "get", AsyncMock(return_value=fake)),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200
    assert r.content == b"\x00\x01icon"
    assert r.headers["content-type"] == "image/x-icon"
    assert "max-age" in r.headers["cache-control"]


# ── Candidate-list caching ───────────────────────────────────────────────────


def test_radio_favicon_reuses_cached_candidates_across_different_min_size(client):
    html = b'<html><head><link rel="icon" href="/logo.png" sizes="64x64"></head></html>'
    mock_stream = _mock_stream(html)
    stream_spy = MagicMock(side_effect=mock_stream)
    mock_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", stream_spy),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 16})
        client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 512})
    # Homepage HTML fetched (and parsed) once, reused for the second
    # request's different min_size instead of being fetched again.
    assert stream_spy.call_count == 1


# ── _has_transparency ────────────────────────────────────────────────────────


def test_has_transparency_true_for_mostly_transparent_rgba():
    png = _png_bytes("RGBA", transparent_ratio=0.5)
    assert radio_mod._has_transparency(png) is True


def test_has_transparency_false_for_opaque_rgba():
    png = _png_bytes("RGBA", transparent_ratio=0.0)
    assert radio_mod._has_transparency(png) is False


def test_has_transparency_false_for_rgb_with_no_alpha_channel():
    png = _png_bytes("RGB")
    assert radio_mod._has_transparency(png) is False


def test_has_transparency_false_below_minimum_ratio():
    # A handful of antialiased edge pixels shouldn't count.
    png = _png_bytes("RGBA", transparent_ratio=0.01)
    assert radio_mod._has_transparency(png) is False


def test_has_transparency_false_for_garbage_bytes():
    assert radio_mod._has_transparency(b"not an image") is False


# ── X-Has-Transparency header ────────────────────────────────────────────────


def test_radio_favicon_reports_transparency_header_true(client):
    png = _png_bytes("RGBA", transparent_ratio=0.5)
    fake = _fake_get_response(content=png, content_type="image/png")
    with (
        patch.object(radio_mod._client, "stream", side_effect=httpx.ConnectError("x")),
        patch.object(radio_mod._client, "get", AsyncMock(return_value=fake)),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200
    assert r.headers["x-has-transparency"] == "true"


def test_radio_favicon_reports_transparency_header_false(client):
    png = _png_bytes("RGB")
    fake = _fake_get_response(content=png, content_type="image/png")
    with (
        patch.object(radio_mod._client, "stream", side_effect=httpx.ConnectError("x")),
        patch.object(radio_mod._client, "get", AsyncMock(return_value=fake)),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com"})
    assert r.status_code == 200
    assert r.headers["x-has-transparency"] == "false"


# ── /radio-browser/search, /radio-browser/countries, /radio-browser/click ───


def test_radio_browser_search_browses_with_defaults_when_nothing_is_given(client):
    # No name typed yet — the dialog's initial "top stations" view (see
    # core/radio_browser.py's search_stations() docstring), not something
    # the route short-circuits away the way a local filter field would.
    with patch.object(radio_mod, "search_stations", AsyncMock(return_value=[])) as search:
        r = client.get("/radio-browser/search")
    assert r.status_code == 200
    assert r.json() == {"stations": []}
    search.assert_called_once_with("", limit=30, countrycodes=None, order="votes")


def test_radio_browser_search_returns_what_core_found(client):
    stations = [{"stationuuid": "abc", "name": "Example FM", "url": "http://example.com/stream"}]
    with patch.object(radio_mod, "search_stations", AsyncMock(return_value=stations)) as search:
        r = client.get(
            "/radio-browser/search",
            params={"name": "example", "limit": 5, "countrycode": "DE", "order": "clickcount"},
        )
    assert r.status_code == 200
    assert r.json() == {"stations": stations}
    search.assert_called_once_with("example", limit=5, countrycodes=["DE"], order="clickcount")


def test_radio_browser_search_accepts_more_than_one_country(client):
    with patch.object(radio_mod, "search_stations", AsyncMock(return_value=[])) as search:
        r = client.get(
            "/radio-browser/search",
            params=[("name", "example"), ("countrycode", "DE"), ("countrycode", "FR")],
        )
    assert r.status_code == 200
    search.assert_called_once_with("example", limit=30, countrycodes=["DE", "FR"], order="votes")


def test_radio_browser_search_reports_502_when_every_mirror_is_unreachable(client):
    with patch.object(radio_mod, "search_stations", AsyncMock(return_value=None)):
        r = client.get("/radio-browser/search", params={"name": "example"})
    assert r.status_code == 502


def test_radio_browser_countries_returns_what_core_found(client):
    countries = [{"name": "Germany", "code": "DE"}]
    with patch.object(radio_mod, "list_countries", AsyncMock(return_value=countries)):
        r = client.get("/radio-browser/countries")
    assert r.status_code == 200
    assert r.json() == {"countries": countries}


def test_radio_browser_countries_reports_502_when_every_mirror_is_unreachable(client):
    with patch.object(radio_mod, "list_countries", AsyncMock(return_value=None)):
        r = client.get("/radio-browser/countries")
    assert r.status_code == 502


def test_radio_browser_click_registers_and_never_fails_the_request(client):
    with patch.object(radio_mod, "register_click", AsyncMock()) as register:
        r = client.post("/radio-browser/click/abc-123")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    register.assert_called_once_with("abc-123")


# ── /radio-stream-url ────────────────────────────────────────────────────────
# Local playback never otherwise reaches this backend, so this endpoint is
# the only place it can have a .m3u/.pls station URL resolved - see
# core/playlist_url.py. The casting path does the same inside /play-url.


def test_radio_stream_url_returns_what_the_playlist_points_at(client):
    stream = "http://dispatcher.rndfnk.com/br/br24/live/mp3/mid"
    with patch.object(radio_mod, "resolve_stream_url", new=AsyncMock(return_value=stream)) as r:
        response = client.get("/radio-stream-url?url=http://streams.br.de/b5aktuell_2.m3u")
    assert response.status_code == 200
    assert response.json() == {"url": stream}
    r.assert_awaited_once_with("http://streams.br.de/b5aktuell_2.m3u")


def test_radio_stream_url_hands_back_a_plain_stream_url_unchanged(client):
    url = "http://mp3channels.webradio.rockantenne.de/rockantenne"
    response = client.get(f"/radio-stream-url?url={url}")
    assert response.status_code == 200
    assert response.json() == {"url": url}


# ── /radio-metadata/* ────────────────────────────────────────────────────────


def test_radio_metadata_start_requires_an_authenticated_session(client):
    # No default_session fixture here - the session backing `client`'s
    # requests was never authenticated at all.
    r = client.post("/radio-metadata/start", json={"url": "http://station"})
    assert r.status_code == 401


def test_radio_metadata_start_starts_the_sessions_watch(client, default_session):
    with patch.object(default_session, "start_radio_metadata_watch") as start:
        r = client.post("/radio-metadata/start", json={"url": "http://station"})
    assert r.status_code == 200
    start.assert_called_once_with("http://station")


def test_radio_metadata_stop_stops_the_sessions_watch(client, default_session):
    with patch.object(default_session, "stop_radio_metadata_watch") as stop:
        r = client.post("/radio-metadata/stop")
    assert r.status_code == 200
    stop.assert_called_once()


def test_radio_metadata_returns_the_sessions_current_title(client, default_session):
    default_session.radio_title = "Artist - Track"
    r = client.get("/radio-metadata")
    assert r.status_code == 200
    assert r.json() == {"title": "Artist - Track"}


def test_radio_metadata_returns_null_before_anything_has_been_seen(client, default_session):
    r = client.get("/radio-metadata")
    assert r.status_code == 200
    assert r.json() == {"title": None}
