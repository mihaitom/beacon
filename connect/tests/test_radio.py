"""Tests for routes/radio.py — GET /radio-favicon."""

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
    img = Image.new(
        mode, (size, size), (200, 40, 40, 255) if mode == "RGBA" else (200, 40, 40)
    )
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


def _fake_get_response(
    status_code=200, content=b"icon-bytes", content_type="image/x-icon"
):
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


# ── No declared icon → implicit /favicon.ico fallback ───────────────────────


def test_radio_favicon_falls_back_to_favicon_ico_when_homepage_unreachable(client):
    with (
        patch.object(radio_mod._client, "stream", side_effect=httpx.ConnectError("x")),
        patch.object(
            radio_mod._client, "get", AsyncMock(return_value=_fake_get_response())
        ),
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
        patch.object(
            radio_mod._client, "stream", _mock_stream(b"", content_type="image/png")
        ),
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
        client.get(
            "/radio-favicon", params={"url": "https://example.com", "min_size": 128}
        )
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
        client.get(
            "/radio-favicon", params={"url": "https://example.com", "min_size": 512}
        )
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
        client.get(
            "/radio-favicon", params={"url": "https://example.com", "min_size": 16}
        )
        client.get(
            "/radio-favicon", params={"url": "https://example.com", "min_size": 512}
        )
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
