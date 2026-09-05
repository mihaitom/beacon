"""Tests for routes/radio.py — GET /radio-favicon, POST /radio-favicon/batch,
POST /radio-metadata/start, POST /radio-metadata/stop, GET /radio-metadata."""

import asyncio
import io
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from PIL import Image

import core.session as session_module
import routes.radio as radio_mod
from core import radio_history


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
def _clear_favicon_caches():
    """Both of routes/radio.py's process-wide caches, before and after every
    test. Leaving either populated makes the *next* test silently pass (or
    fail) on an answer this one resolved — the result cache especially, since
    it short-circuits the mocked fetches entirely."""
    _reset()
    yield
    _reset()


def _reset():
    radio_mod._candidate_cache.clear()
    radio_mod._result_cache.clear()
    radio_mod._result_cache_bytes = 0
    radio_mod._inflight.clear()


def _fake_get_response(status_code=200, content=b"icon-bytes", content_type="image/x-icon"):
    resp = MagicMock()
    resp.status_code = status_code
    resp.content = content
    resp.headers = {"content-type": content_type}
    return resp


def _mock_stream(html: bytes, content_type="text/html", final_url=None):
    """Mocks _client.stream("GET", url) — an async context manager yielding
    a response whose .aiter_bytes() streams `html` in one chunk.

    `.url` is the *final* URL httpx would report, i.e. the requested one
    unless `final_url` says a redirect landed somewhere else — icon hrefs
    resolve against it, so a mock without it would resolve them against
    nothing."""
    stream_resp = MagicMock()
    stream_resp.headers = {"content-type": content_type}

    async def aiter_bytes():
        yield html

    stream_resp.aiter_bytes = aiter_bytes

    @asynccontextmanager
    async def stream(method, url):
        stream_resp.url = final_url or url
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
        stream_resp.url = url
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


def test_discover_candidates_reads_to_the_end_of_head_and_stops_there(client):
    """hitradion1.de inlines a ~300KB stylesheet ahead of its icon
    declarations, putting them past what used to be a flat 256KB read
    limit — the station came out with no findable logo at all. The read now
    runs to </head> however far in that is, and stops there rather than
    carrying on through the page body."""
    head = (
        b"<html><head><style>"
        + b" " * (300 * 1024)
        + b"</style>"
        + b'<link rel="icon" sizes="48x48" href="/late.png">'
        + b"</head>"
    )
    body_chunks_read = 0

    stream_resp = MagicMock()
    stream_resp.headers = {"content-type": "text/html"}

    async def aiter_bytes():
        nonlocal body_chunks_read
        for i in range(0, len(head), 64 * 1024):
            yield head[i : i + 64 * 1024]
        # Past </head>, and far more of it than _MAX_HTML_BYTES would ever
        # allow — so a read that fails to stop here still ends, as a failed
        # assertion rather than a hung test.
        for _ in range(200):
            body_chunks_read += 1
            yield b"<body>" + b"x" * (64 * 1024)

    stream_resp.aiter_bytes = aiter_bytes

    @asynccontextmanager
    async def stream(method, url):
        stream_resp.url = url
        yield stream_resp

    mock_get = AsyncMock(return_value=_fake_get_response(content_type="image/png"))
    with (
        patch.object(radio_mod._client, "stream", stream),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com/", "min_size": "48"})

    assert r.status_code == 200
    assert mock_get.await_args_list[0].args[0] == "https://example.com/late.png"
    assert body_chunks_read == 0


def test_discover_candidates_resolves_hrefs_against_the_redirected_url(client):
    """A homepage that redirects elsewhere (einslive.de -> www1.wdr.de/radio/
    1live/) declares its icons relative to where it *landed*. Resolving them
    against the requested URL instead aimed every candidate, the implicit
    /favicon.ico included, at a host that never had them."""
    html = (
        b"<html><head>"
        b'<link rel="icon" sizes="48x48" href="img/favicon/icon.png">'
        b"</head><body></body></html>"
    )
    mock_get = AsyncMock(return_value=_fake_get_response(content_type="image/png"))
    stream = _mock_stream(html, final_url="https://www1.example.com/radio/one/index.html")

    with (
        patch.object(radio_mod._client, "stream", stream),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com/", "min_size": "48"})

    assert r.status_code == 200
    assert mock_get.await_args_list[0].args[0] == (
        "https://www1.example.com/radio/one/img/favicon/icon.png"
    )

    candidates = radio_mod._candidate_cache["https://example.com/"][1]
    assert candidates[-1].url == "https://www1.example.com/favicon.ico"


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
    # 16px is skipped outright (it declares less than the 32px already in
    # hand), but the implicit /favicon.ico fallback is still tried after —
    # its own declared size is a sort-order sentinel, not a real claim, so
    # it's never skipped that way.
    assert [call.args[0] for call in mock_get.await_args_list] == [
        "https://example.com/32.png",
        "https://example.com/favicon.ico",
    ]


# ── Measuring what was actually fetched ──────────────────────────────────────


def _sized_png(edge: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (edge, edge), (10, 20, 30)).save(buf, format="PNG")
    return buf.getvalue()


def test_radio_favicon_scrapes_the_homepage_when_the_hint_is_too_small(client):
    """Radio Browser's favicon field carries no size, and is very often a
    16/32px browser favicon — taking it on trust was what put a visibly
    soft logo behind NowPlayingView's artwork."""
    html = b'<html><head><link rel="icon" href="/256.png" sizes="256x256"></head></html>'
    responses = {
        "https://cdn.example/tiny.png": _fake_get_response(
            content=_sized_png(32), content_type="image/png"
        ),
        "https://example.com/256.png": _fake_get_response(
            content=_sized_png(256), content_type="image/png"
        ),
    }
    mock_get = AsyncMock(side_effect=lambda url: responses[url])
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get(
            "/radio-favicon",
            params={
                "url": "https://example.com",
                "hint": "https://cdn.example/tiny.png",
                "min_size": 96,
            },
        )
    assert r.status_code == 200
    assert r.content == _sized_png(256)


def test_radio_favicon_keeps_the_hint_when_the_homepage_has_nothing_larger(client):
    """Searching on is only worth it if it finds something better — when it
    doesn't, the too-small hint is still the best answer available, not a
    404 and not whichever candidate happened to be tried last."""
    html = b'<html><head><link rel="icon" href="/16.png" sizes="16x16"></head></html>'
    responses = {
        "https://cdn.example/tiny.png": _fake_get_response(
            content=_sized_png(48), content_type="image/png"
        ),
        "https://example.com/16.png": _fake_get_response(
            content=_sized_png(16), content_type="image/png"
        ),
        "https://example.com/favicon.ico": _fake_get_response(
            content=_sized_png(16), content_type="image/png"
        ),
    }
    mock_get = AsyncMock(side_effect=lambda url: responses[url])
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get(
            "/radio-favicon",
            params={
                "url": "https://example.com",
                "hint": "https://cdn.example/tiny.png",
                "min_size": 512,
            },
        )
    assert r.status_code == 200
    assert r.content == _sized_png(48)


def test_radio_favicon_measures_past_an_overstated_declaration(client):
    """A <link sizes="512x512"> pointing at a 32px file used to end the
    search on the strength of the claim alone."""
    # 128 is the smallest declaration that clears min_size=96, so _select()
    # tries the liar first — which is the whole point: the file behind it
    # is 32px, and only measuring it reveals that.
    html = (
        b"<html><head>"
        b'<link rel="icon" href="/liar.png" sizes="128x128">'
        b'<link rel="icon" href="/real.png" sizes="256x256">'
        b"</head></html>"
    )
    responses = {
        "https://example.com/liar.png": _fake_get_response(
            content=_sized_png(32), content_type="image/png"
        ),
        "https://example.com/real.png": _fake_get_response(
            content=_sized_png(256), content_type="image/png"
        ),
    }
    mock_get = AsyncMock(side_effect=lambda url: responses[url])
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 96})
    assert r.status_code == 200
    assert r.content == _sized_png(256)


def test_radio_favicon_still_tries_favicon_ico_after_a_smaller_declared_icon(client):
    """The implicit /favicon.ico fallback declares size=1 purely to sort
    after every real declaration (see _Candidate.is_declared_size) — that
    sentinel must never be mistaken for a genuine "this is smaller" claim,
    or the one candidate meant to catch exactly this case (a station with
    only a small declared icon, but a much bigger real favicon.ico) never
    gets tried at all."""
    html = b'<html><head><link rel="icon" href="/16.png" sizes="16x16"></head></html>'
    responses = {
        "https://example.com/16.png": _fake_get_response(
            content=_sized_png(16), content_type="image/png"
        ),
        "https://example.com/favicon.ico": _fake_get_response(
            content=_sized_png(256), content_type="image/png"
        ),
    }
    mock_get = AsyncMock(side_effect=lambda url: responses[url])
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 96})
    assert r.status_code == 200
    assert r.content == _sized_png(256)


def test_radio_favicon_stops_fetching_once_nothing_declared_can_beat_what_it_has(client):
    """The size a candidate declares is still a usable upper bound: one that
    promises less than what is already in hand is not worth downloading to
    find that out."""
    html = (
        b"<html><head>"
        b'<link rel="icon" href="/64.png" sizes="64x64">'
        b'<link rel="icon" href="/16.png" sizes="16x16">'
        b"</head></html>"
    )
    mock_get = AsyncMock(
        return_value=_fake_get_response(content=_sized_png(64), content_type="image/png")
    )
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 512})
    assert r.status_code == 200
    # 16px is skipped outright (it declares less than the 64px already in
    # hand), but the implicit /favicon.ico fallback is still tried after —
    # its own declared size is a sort-order sentinel, not a real claim, so
    # it's never skipped that way.
    assert [call.args[0] for call in mock_get.await_args_list] == [
        "https://example.com/64.png",
        "https://example.com/favicon.ico",
    ]


def test_radio_favicon_gives_up_after_the_fetch_budget(client):
    """A page declaring a long list of icons that all turn out too small
    must not turn one request into a dozen outbound fetches."""
    links = b"".join(
        b'<link rel="icon" href="/i%d.png" sizes="%dx%d">' % (i, 300 - i, 300 - i)
        for i in range(12)
    )
    html = b"<html><head>" + links + b"</head></html>"
    mock_get = AsyncMock(
        return_value=_fake_get_response(content=_sized_png(8), content_type="image/png")
    )
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 512})
    assert r.status_code == 200
    assert mock_get.await_count == radio_mod._MAX_FETCHES


def test_radio_favicon_treats_svg_as_meeting_any_size(client):
    """An SVG scales losslessly, so it satisfies min_size without PIL ever
    being able to measure it."""
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"></svg>'
    mock_get = AsyncMock(return_value=_fake_get_response(content=svg, content_type="image/svg+xml"))
    mock_stream = MagicMock(side_effect=AssertionError("should not scrape the homepage"))
    with (
        patch.object(radio_mod._client, "stream", mock_stream),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get(
            "/radio-favicon",
            params={
                "url": "https://example.com",
                "hint": "https://cdn.example/logo.svg",
                "min_size": 512,
            },
        )
    assert r.status_code == 200
    assert r.content == svg


def test_radio_favicon_does_not_let_a_mask_icon_svg_win_on_scalability_alone(client):
    """A <link rel="mask-icon"> is a monochrome silhouette meant for
    Safari's own CSS masking, not a real likeness of the station's logo —
    see _ICON_RELS' own comment. Treating it as satisfying any min_size the
    way a genuine logo SVG does (both being vector) let it short-circuit
    the search and win over an actual full-color icon already in hand,
    which looked exactly like the station's colorful logo had lost all its
    color. Reported live 2026-09-03."""
    html = (
        b"<html><head>"
        b'<link rel="apple-touch-icon" href="/logo.png" sizes="180x180">'
        b'<link rel="mask-icon" href="/mask.svg" color="#5bbad5">'
        b"</head></html>"
    )
    responses = {
        "https://example.com/logo.png": _fake_get_response(
            content=_sized_png(180), content_type="image/png"
        ),
        "https://example.com/mask.svg": _fake_get_response(
            content=b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"></svg>',
            content_type="image/svg+xml",
        ),
        # The implicit /favicon.ico fallback is always in the candidate
        # list too (see _discover_candidates()) and sorts ahead of the
        # mask-icon here (declared size 1 vs 0) — undecodable, so it falls
        # back to that declared size and never threatens the 180px best.
        "https://example.com/favicon.ico": _fake_get_response(),
    }
    mock_get = AsyncMock(side_effect=lambda url: responses[url])
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 512})
    assert r.status_code == 200
    # Neither meets min_size=512 — the real, full-color 180px icon is still
    # the best available answer, not the mask-icon SVG that would have
    # "met" it purely by being vector.
    assert r.content == _sized_png(180)


def test_radio_favicon_default_min_size_still_costs_one_fetch(client):
    """Nothing is ever "too small" at min_size=0, so a caller that doesn't
    care must not pay for the extra searching this added."""
    hint = _fake_get_response(content=_sized_png(16), content_type="image/png")
    mock_get = AsyncMock(return_value=hint)
    mock_stream = MagicMock(side_effect=AssertionError("should not scrape the homepage"))
    with (
        patch.object(radio_mod._client, "stream", mock_stream),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get(
            "/radio-favicon",
            params={"url": "https://example.com", "hint": "https://cdn.example/tiny.png"},
        )
    assert r.status_code == 200
    mock_get.assert_awaited_once()


# ── Malformed candidates must never reach the caller as a 500 ────────────────


def test_radio_favicon_skips_an_href_that_cannot_be_resolved(client):
    """urljoin() itself raises on a stray "//[" — one broken <link> in a
    station's HTML used to escape the route as an unhandled exception,
    which the browser then reports as a CORS error rather than a 500."""
    html = (
        b"<html><head>"
        b'<link rel="icon" href="//[">'
        b'<link rel="icon" href="/good.png" sizes="128x128">'
        b"</head></html>"
    )
    good = _fake_get_response(content=_sized_png(128), content_type="image/png")
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", AsyncMock(return_value=good)),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 96})
    assert r.status_code == 200
    assert r.content == _sized_png(128)


def test_radio_favicon_skips_a_candidate_httpx_refuses_to_request(client):
    """httpx.InvalidURL is deliberately not an httpx.HTTPError, so it used
    to escape the per-candidate except clause."""
    html = b'<html><head><link rel="icon" href="/icon.png" sizes="128x128"></head></html>'
    good = _fake_get_response(content=_sized_png(128), content_type="image/png")
    calls = []

    async def _get(url):
        calls.append(url)
        if len(calls) == 1:
            raise httpx.InvalidURL("no host")
        return good

    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", AsyncMock(side_effect=_get)),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 96})
    assert r.status_code == 200
    assert r.content == _sized_png(128)


def test_has_transparency_survives_a_decompression_bomb():
    """PIL raises DecompressionBombError, which subclasses Exception
    directly — a hostile favicon must not be able to 500 the route."""
    png = _png_bytes("RGBA", transparent_ratio=1.0)
    with patch.object(radio_mod.Image, "open", side_effect=Image.DecompressionBombError("boom")):
        assert radio_mod._has_transparency(png) is False


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


# ── Surviving a restart (the on-disk cache) ─────────────────────────────────


_ICON_HTML = (
    b'<html><head><link rel="icon" sizes="48x48" href="/icon.png"></head><body></body></html>'
)


def _restart():
    """Everything the process loses when it exits, and nothing else — the
    directory _disk_store() wrote stays exactly where the next process
    would find it."""
    radio_mod._result_cache.clear()
    radio_mod._result_cache_bytes = 0
    radio_mod._inflight.clear()
    radio_mod._candidate_cache.clear()
    radio_mod._disk_loaded = False
    radio_mod._disk_bytes = 0


def _resolve_once(client, content=b"real-icon-bytes"):
    """One cold lookup that leaves a cached icon behind, in memory and on
    disk. Returns the response."""
    mock_get = AsyncMock(return_value=_fake_get_response(content=content, content_type="image/png"))
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(_ICON_HTML)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        return client.get(
            "/radio-favicon", params={"url": "https://example.com/", "min_size": "48"}
        )


def test_resolved_icon_is_restored_after_a_restart_without_refetching(client):
    """The packaged desktop app spawns its own connect, so every launch
    starts with an empty _result_cache. Without this, each one re-scraped
    every saved station's homepage against a third-party host."""
    first = _resolve_once(client)
    assert first.status_code == 200

    _restart()

    # Answering these at all would mean the icon came off the network
    # again; the differing bytes are what says so if it did.
    cold_stream = MagicMock(side_effect=_mock_stream(_ICON_HTML))
    cold_get = AsyncMock(
        return_value=_fake_get_response(content=b"refetched-bytes", content_type="image/png")
    )
    with (
        patch.object(radio_mod._client, "stream", cold_stream),
        patch.object(radio_mod._client, "get", cold_get),
    ):
        second = client.get(
            "/radio-favicon", params={"url": "https://example.com/", "min_size": "48"}
        )

    assert second.status_code == 200
    assert second.content == b"real-icon-bytes"
    assert second.headers["X-Has-Transparency"] == first.headers["X-Has-Transparency"]
    assert cold_stream.call_count == 0
    assert cold_get.await_count == 0


def test_a_stored_svg_is_re_judged_for_transparency_on_restart(client):
    """A cached entry carries the answer the rule of the day produced. For
    an SVG that answer used to be "opaque", and re-serving it unchanged
    would keep the logo framed for the whole week the entry stays good —
    so the one verdict that costs nothing to redo is redone."""
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M1 1z"/></svg>'
    html = b'<html><head><link rel="icon" href="/icon.svg"></head><body></body></html>'
    mock_get = AsyncMock(return_value=_fake_get_response(content=svg, content_type="image/svg+xml"))
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        assert (
            client.get("/radio-favicon", params={"url": "https://example.com/"}).status_code == 200
        )

    # Rewrite the stored verdict the way a version of this app that did not
    # know about SVGs would have left it.
    stored = next(Path(radio_mod._DISK_DIR).iterdir())
    entry = json.loads(stored.read_text())
    entry["transparent"] = False
    stored.write_text(json.dumps(entry))

    _restart()

    with (
        patch.object(radio_mod._client, "stream", MagicMock(side_effect=AssertionError)),
        patch.object(radio_mod._client, "get", AsyncMock(side_effect=AssertionError)),
    ):
        again = client.get("/radio-favicon", params={"url": "https://example.com/"})

    assert again.content == svg  # served from disk, not refetched
    assert again.headers["X-Has-Transparency"] == "true"


def test_a_station_with_no_icon_is_remembered_across_a_restart(client):
    """A miss is the answer worth keeping most: a station whose homepage
    declares nothing and has no /favicon.ico costs a full scrape to find
    that out, every launch, for as long as it stays in the list."""
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(b"<html><head></head></html>")),
        patch.object(radio_mod._client, "get", AsyncMock(return_value=_fake_get_response(404))),
    ):
        assert (
            client.get("/radio-favicon", params={"url": "https://example.com/"}).status_code == 404
        )

    _restart()

    cold_get = AsyncMock(return_value=_fake_get_response())
    with (
        patch.object(radio_mod._client, "stream", MagicMock(side_effect=AssertionError)),
        patch.object(radio_mod._client, "get", cold_get),
    ):
        again = client.get("/radio-favicon", params={"url": "https://example.com/"})

    assert again.status_code == 404
    assert cold_get.await_count == 0


def test_an_expired_disk_entry_is_not_restored(client):
    """Expiries are stored as wall-clock time precisely so that an entry
    that ran out while nothing was running is gone by the next launch, and
    the file with it."""
    assert _resolve_once(client).status_code == 200
    files = list(Path(radio_mod._DISK_DIR).iterdir())
    assert len(files) == 1
    entry = json.loads(files[0].read_text())
    entry["expires"] = time.time() - 1
    files[0].write_text(json.dumps(entry))

    _restart()
    radio_mod._disk_load()

    # Dropped on the way in rather than kept around as a hit nobody may
    # use, so the directory doesn't accumulate what it can never answer.
    assert not files[0].exists()
    assert not radio_mod._result_cache
    assert _resolve_once(client, content=b"refetched-bytes").content == b"refetched-bytes"


def test_an_unreadable_disk_entry_costs_only_its_own_station(client):
    """A half-written or hand-mangled file is one station's logo, not a
    reason to come up with nothing at all."""
    assert _resolve_once(client).status_code == 200
    (Path(radio_mod._DISK_DIR) / "garbage.json").write_text("{not json")

    _restart()

    cold_get = AsyncMock(
        return_value=_fake_get_response(content=b"refetched-bytes", content_type="image/png")
    )
    with (
        patch.object(radio_mod._client, "stream", MagicMock(side_effect=AssertionError)),
        patch.object(radio_mod._client, "get", cold_get),
    ):
        second = client.get(
            "/radio-favicon", params={"url": "https://example.com/", "min_size": "48"}
        )

    assert second.content == b"real-icon-bytes"
    assert cold_get.await_count == 0
    assert not (Path(radio_mod._DISK_DIR) / "garbage.json").exists()


def test_disk_cache_evicts_oldest_entries_past_its_budget(monkeypatch):
    """Bounded by what it holds, oldest first — the budget has to cover
    what a *previous* run left behind as much as this one's own writes."""
    icon = radio_mod._Fetched(b"x" * 4096, "image/png", 48, transparent=False)
    monkeypatch.setattr(radio_mod, "_DISK_CACHE_MAX_BYTES", 8 * 1024)

    paths = []
    for i in range(4):
        key = (f"https://example.com/{i}", "", 48)
        radio_mod._disk_store(key, icon)
        path = radio_mod._disk_path(key)
        # Written within the same instant otherwise, which leaves "oldest"
        # up to whatever order the filesystem reports.
        os.utime(path, (1_700_000_000 + i, 1_700_000_000 + i))
        paths.append(path)

    surviving = [p for p in paths if os.path.exists(p)]
    assert surviving == paths[-len(surviving) :]
    assert sum(os.path.getsize(p) for p in surviving) <= radio_mod._DISK_CACHE_MAX_BYTES


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


def test_has_transparency_true_for_svg():
    """A vector image is transparent wherever it does not paint, and PIL
    cannot open one to be asked — left to the generic "couldn't tell"
    fallback, every SVG logo came back opaque and got framed like a square
    cover. tomorrowland.com's, four <path> elements and no background at
    all, is exactly that shape."""
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 260"><path d="M1 1z"/></svg>'

    assert radio_mod._has_transparency(svg, "image/svg+xml") is True
    # Without the content type there is nothing to recognise it by, and the
    # decode below is what answers — the old behaviour, kept for anything
    # that genuinely cannot be identified.
    assert radio_mod._has_transparency(svg) is False


def test_transparency_header_is_true_for_a_resolved_svg(client):
    """The end-to-end version of the above: what NowPlayingView.vue reads
    off the response to decide whether to frame the logo."""
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M1 1z"/></svg>'
    html = b'<html><head><link rel="icon" href="/icon.svg"></head><body></body></html>'
    mock_get = AsyncMock(return_value=_fake_get_response(content=svg, content_type="image/svg+xml"))

    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", mock_get),
    ):
        r = client.get("/radio-favicon", params={"url": "https://example.com/"})

    assert r.status_code == 200
    assert r.headers["X-Has-Transparency"] == "true"


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
    # No history: setting the field directly is not a title *arriving*, and
    # nothing is playing for one to belong to.
    assert r.json() == {"title": "Artist - Track", "history": [], "bitrate": None, "codec": None}


def test_radio_metadata_reports_what_the_station_broadcasts(client, default_session):
    """Read once per connection out of the ICY response headers by whichever
    reader is running — see SessionState._set_radio_stream_info(). The
    stream-info panel is the one consumer."""
    default_session._set_radio_stream_info(320, "MP3")
    r = client.get("/radio-metadata")
    assert r.status_code == 200
    assert r.json()["bitrate"] == 320
    assert r.json()["codec"] == "MP3"


def test_radio_metadata_returns_null_before_anything_has_been_seen(client, default_session):
    r = client.get("/radio-metadata")
    assert r.status_code == 200
    assert r.json() == {"title": None, "history": [], "bitrate": None, "codec": None}


# ── The per-station title log ────────────────────────────────────────────────


def test_radio_metadata_returns_the_current_stations_log_newest_first(client, default_session):
    default_session._radio_metadata_url = "http://station-a"
    for title in ("First", "Second", "Third"):
        default_session._set_radio_title(title)

    body = client.get("/radio-metadata").json()

    assert body["title"] == "Third"
    assert [e["title"] for e in body["history"]] == ["Third", "Second", "First"]
    assert all(isinstance(e["at"], float) for e in body["history"])


def test_radio_title_log_is_kept_per_station(default_session):
    """Switching away and back finds the first station's own log intact,
    rather than one merged list with another station's titles in it."""
    default_session._radio_metadata_url = "http://station-a"
    default_session._set_radio_title("A1")
    default_session._radio_metadata_url = "http://station-b"
    default_session._set_radio_title("B1")
    default_session._radio_metadata_url = "http://station-a"
    default_session._set_radio_title("A2")

    assert [e["title"] for e in default_session.radio_title_log()] == ["A2", "A1"]
    default_session._radio_metadata_url = "http://station-b"
    assert [e["title"] for e in default_session.radio_title_log()] == ["B1"]


def test_radio_title_log_survives_stopping_the_watch(default_session):
    """A station's history is not what stopping means — coming back to it
    later is exactly when the log is worth having."""
    default_session._radio_metadata_url = "http://station-a"
    default_session._set_radio_title("A1")
    default_session.stop_radio_metadata_watch()

    assert default_session.radio_title_log() == []  # nothing playing
    default_session._radio_metadata_url = "http://station-a"
    assert [e["title"] for e in default_session.radio_title_log()] == ["A1"]


def test_radio_title_log_ignores_a_station_cycling_the_same_strings(default_session):
    """Deutschlandfunk rotates its programme name, its slogan and the
    current item on a roughly one-minute loop (sampled live 2026-09-05).
    Logged as they arrive, three strings would fill the whole buffer."""
    default_session._radio_metadata_url = "http://station-a"
    for _ in range(20):
        for title in ("Informationen am Morgen", "DLF - Alles von Relevanz", "Ein Beitrag"):
            default_session._set_radio_title(title)

    assert [e["title"] for e in default_session.radio_title_log()] == [
        "Ein Beitrag",
        "DLF - Alles von Relevanz",
        "Informationen am Morgen",
    ]


def test_radio_title_log_records_a_repeat_once_the_window_has_passed(default_session):
    """The same track really played again hours later is a new entry, not
    the same broadcast coming round — that is the whole reason the repeat
    guard is a time window rather than a plain "seen before"."""
    default_session._radio_metadata_url = "http://station-a"
    default_session._set_radio_title("Artist - Track")
    history = default_session.radio_title_history["http://station-a"]
    history[0]["at"] -= session_module._RADIO_HISTORY_REPEAT_WINDOW + 1

    default_session._set_radio_title("Artist - Track")

    assert [e["title"] for e in default_session.radio_title_log()] == [
        "Artist - Track",
        "Artist - Track",
    ]


def test_radio_title_log_keeps_the_newest_entries_per_station(default_session):
    default_session._radio_metadata_url = "http://station-a"
    for i in range(session_module._RADIO_HISTORY_PER_STATION + 25):
        default_session._set_radio_title(f"Track {i}")

    log = default_session.radio_title_log()
    assert len(log) == session_module._RADIO_HISTORY_PER_STATION
    assert log[0]["title"] == f"Track {session_module._RADIO_HISTORY_PER_STATION + 24}"
    assert log[-1]["title"] == "Track 25"


def test_radio_title_log_drops_the_least_recently_heard_station(default_session):
    """A session outlives any single station; the histories are the one
    part of it that would otherwise only ever grow."""
    for i in range(session_module._RADIO_HISTORY_STATIONS + 3):
        default_session._radio_metadata_url = f"http://station-{i}"
        default_session._set_radio_title(f"Title {i}")

    assert len(default_session.radio_title_history) == session_module._RADIO_HISTORY_STATIONS
    assert "http://station-0" not in default_session.radio_title_history
    assert "http://station-3" in default_session.radio_title_history


def test_radio_title_log_follows_a_relayed_station(default_session):
    """A relayed station reports its titles through the same callback but
    has no _radio_metadata_url — its own URL is the station identity."""
    default_session.radio_relay = SimpleNamespace(url="http://relayed-station")
    default_session._set_radio_title("Relayed title")

    assert [e["title"] for e in default_session.radio_title_log()] == ["Relayed title"]
    assert "http://relayed-station" in default_session.radio_title_history


def test_radio_title_log_comes_back_after_the_session_is_gone(default_session):
    """The whole point of storing it: the session is reaped after half an
    hour of not listening, and the packaged desktop app spawns a fresh
    connect on every launch. Starting the station again has to find what it
    played yesterday."""
    default_session._radio_metadata_url = "http://station-a"
    default_session._set_radio_title("Yesterday's track")

    # A new process, a new SessionState under the same login — nothing in
    # memory, only what is on disk.
    revived = session_module.SessionState(default_session.session_id)
    revived._radio_metadata_url = "http://station-a"

    assert [e["title"] for e in revived.radio_title_log()] == ["Yesterday's track"]


def test_a_revived_log_keeps_growing_where_it_left_off(default_session):
    default_session._radio_metadata_url = "http://station-a"
    default_session._set_radio_title("Yesterday's track")

    revived = session_module.SessionState(default_session.session_id)
    revived._radio_metadata_url = "http://station-a"
    revived._set_radio_title("Today's track")

    assert [e["title"] for e in revived.radio_title_log()] == [
        "Today's track",
        "Yesterday's track",
    ]
    # And the addition is itself stored, rather than the file staying at
    # whatever the previous run left.
    again = session_module.SessionState(default_session.session_id)
    again._radio_metadata_url = "http://station-a"
    assert len(again.radio_title_log()) == 2


def test_a_stored_log_stays_with_its_own_session(default_session):
    """A session id comes out of the login it belongs to — one person's
    listening must not surface under another's."""
    default_session._radio_metadata_url = "http://station-a"
    default_session._set_radio_title("Mine")

    other = session_module.SessionState("someone-else")
    other._radio_metadata_url = "http://station-a"

    assert other.radio_title_log() == []


def test_a_stored_log_stays_with_its_own_station(default_session):
    default_session._radio_metadata_url = "http://station-a"
    default_session._set_radio_title("A1")
    default_session._radio_metadata_url = "http://station-b"
    default_session._set_radio_title("B1")

    revived = session_module.SessionState(default_session.session_id)
    revived._radio_metadata_url = "http://station-b"

    assert [e["title"] for e in revived.radio_title_log()] == ["B1"]


def test_a_half_written_line_costs_only_that_one_title(default_session):
    """The log is appended to, so the line that loses a crash is the one
    being written — the thousand before it are still whole, and giving up
    the file over the broken tail would throw away exactly what this
    exists to keep."""
    default_session._radio_metadata_url = "http://station-a"
    default_session._set_radio_title("A1")
    default_session._set_radio_title("A2")
    path = Path(radio_history._station_path(default_session.session_id, "http://station-a"))
    with path.open("a", encoding="utf-8") as f:
        f.write('{"title": "torn off half')

    revived = session_module.SessionState(default_session.session_id)
    revived._radio_metadata_url = "http://station-a"

    assert [e["title"] for e in revived.radio_title_log()] == ["A2", "A1"]


def test_an_unreadable_file_costs_only_its_own_station(default_session):
    default_session._radio_metadata_url = "http://station-a"
    default_session._set_radio_title("A1")
    directory = Path(radio_history._session_dir(default_session.session_id))
    (directory / "garbage.jsonl").write_text("{not json")

    revived = session_module.SessionState(default_session.session_id)
    revived._radio_metadata_url = "http://station-a"

    assert [e["title"] for e in revived.radio_title_log()] == ["A1"]


def test_a_stations_file_is_trimmed_back_once_it_outgrows_the_cap(default_session):
    """Appending means the file grows past the cap between trims — what it
    must never do is grow without bound, or hand back more than the cap."""
    cap = 5
    monkeyed = session_module._RADIO_HISTORY_PER_STATION
    try:
        session_module._RADIO_HISTORY_PER_STATION = cap
        default_session._radio_metadata_url = "http://station-a"
        for i in range(cap * radio_history._TRIM_FACTOR + 3):
            default_session._set_radio_title(f"Track {i}")
        path = Path(radio_history._station_path(default_session.session_id, "http://station-a"))
        # Header plus at most _TRIM_FACTOR caps' worth of titles.
        assert len(path.read_text().splitlines()) <= cap * radio_history._TRIM_FACTOR + 1

        revived = session_module.SessionState(default_session.session_id)
        revived._radio_metadata_url = "http://station-a"
        log = revived.radio_title_log()
    finally:
        session_module._RADIO_HISTORY_PER_STATION = monkeyed

    assert len(log) == cap
    assert log[0]["title"] == f"Track {cap * radio_history._TRIM_FACTOR + 2}"


def test_only_the_station_being_played_is_read_into_memory(default_session):
    """A log this long is worth holding for the station somebody is
    listening to, not for all fifty they have ever tried."""
    for i in range(3):
        default_session._radio_metadata_url = f"http://station-{i}"
        default_session._set_radio_title(f"Title {i}")

    revived = session_module.SessionState(default_session.session_id)
    revived._radio_metadata_url = "http://station-1"
    assert [e["title"] for e in revived.radio_title_log()] == ["Title 1"]
    assert list(revived.radio_title_history) == ["http://station-1"]


def test_a_session_keeps_only_its_most_recent_stations_on_disk(default_session, monkeypatch):
    """A station tried once would otherwise keep a file of its own for as
    long as the session lives — the least recently played go first, so what
    survives is what somebody actually comes back to."""
    monkeypatch.setattr(radio_history, "_MAX_STATIONS", 3)
    directory = Path(radio_history._session_dir(default_session.session_id))
    for i in range(6):
        default_session._radio_metadata_url = f"http://station-{i}"
        default_session._set_radio_title(f"Title {i}")
        path = Path(radio_history._station_path(default_session.session_id, f"http://station-{i}"))
        # Written within the same instant otherwise, which leaves "least
        # recently played" up to whatever order the filesystem reports.
        # Recent on purpose: a directory whose newest file is older than
        # _MAX_AGE_SECONDS is dropped whole, before the per-station cap
        # ever applies.
        stamp = time.time() - 100 + i
        os.utime(path, (stamp, stamp))

    radio_history.prune()

    survivors = sorted(p.name for p in directory.iterdir())
    expected = sorted(
        Path(radio_history._station_path(default_session.session_id, f"http://station-{i}")).name
        for i in (3, 4, 5)
    )
    assert survivors == expected


def test_stored_logs_are_dropped_once_nothing_has_written_to_them_for_a_month(default_session):
    """A session id changes with the login it is derived from, so an old
    one is never revisited — without this the directory grows with every
    session that ever played radio."""
    default_session._radio_metadata_url = "http://station-a"
    default_session._set_radio_title("Ancient")
    directory = Path(radio_history._session_dir(default_session.session_id))
    stale = time.time() - radio_history._MAX_AGE_SECONDS - 1
    for path in directory.iterdir():
        os.utime(path, (stale, stale))

    radio_history.prune()

    assert not directory.exists()


def test_a_log_that_cannot_be_written_still_plays(default_session, monkeypatch):
    """Storage is an improvement on the in-memory log, never a condition
    for it — a read-only or full data directory must not cost a title."""
    monkeypatch.setattr(radio_history, "_DIR", "/proc/definitely-not-writable/radio-history")
    default_session._radio_metadata_url = "http://station-a"

    default_session._set_radio_title("Still recorded")

    assert [e["title"] for e in default_session.radio_title_log()] == ["Still recorded"]


def test_radio_title_is_not_logged_when_nothing_is_playing(default_session):
    """No station, nothing to attribute a title to — dropped rather than
    filed under a made-up key."""
    default_session._set_radio_title("Orphan")

    assert default_session.radio_title == "Orphan"
    assert default_session.radio_title_history == {}


# ── Cache correctness across Origin ──────────────────────────────────────────


def test_radio_favicon_varies_on_origin_even_without_one(client):
    """The response is cacheable for a week, and whether it carries CORS
    headers depends on the request's Origin — so it must vary on Origin
    whether or not this particular request had one. Without that, a fetch
    without an Origin (an <img src>, a non-browser client) leaves a cache
    entry with no Access-Control-Allow-Origin that the browser may then
    serve to the app's own fetch(), failing it as a CORS error with no
    request ever going out — for as long as the entry lives."""
    icon = _fake_get_response(content=_sized_png(64), content_type="image/png")
    with patch.object(radio_mod._client, "get", AsyncMock(return_value=icon)):
        r = client.get("/radio-favicon", params={"hint": "https://cdn.example/icon.png"})

    assert r.status_code == 200
    assert "origin" in r.headers["vary"].lower()
    assert r.headers["cache-control"] == radio_mod._CACHE_CONTROL


# ── Cacheable misses ─────────────────────────────────────────────────────────
#
# A miss that nothing may cache is re-asked on every render, which is what
# turned every station without a findable icon into a permanent stream of
# 4xx from one IP and got that IP banned by the reverse proxy's IPS. See
# routes/radio.py's _NEGATIVE_CACHE_CONTROL.


def test_radio_favicon_404_is_cacheable_and_varies_on_origin(client):
    with patch.object(radio_mod._client, "get", AsyncMock(side_effect=httpx.ConnectError("x"))):
        r = client.get("/radio-favicon", params={"hint": "https://cdn.example/dead.png"})
    assert r.status_code == 404
    assert r.headers["cache-control"] == radio_mod._NEGATIVE_CACHE_CONTROL
    assert "origin" in r.headers["vary"].lower()


def test_radio_favicon_400_is_cacheable_and_varies_on_origin(client):
    r = client.get("/radio-favicon", params={"url": "file:///etc/passwd"})
    assert r.status_code == 400
    assert r.headers["cache-control"] == radio_mod._NEGATIVE_CACHE_CONTROL
    assert "origin" in r.headers["vary"].lower()


def test_radio_favicon_misses_expire_sooner_than_hits():
    """A station with no icon today may put one up tomorrow, and unlike a
    hit there is nothing on screen to show the answer has gone stale."""
    assert radio_mod._RESULT_NEGATIVE_TTL < radio_mod._RESULT_CACHE_TTL


# ── Result cache ─────────────────────────────────────────────────────────────


def test_radio_favicon_resolves_a_station_once_across_requests(client):
    icon = _fake_get_response(content=_sized_png(64), content_type="image/png")
    mock_get = AsyncMock(return_value=icon)
    with patch.object(radio_mod._client, "get", mock_get):
        first = client.get("/radio-favicon", params={"hint": "https://cdn.example/icon.png"})
        second = client.get("/radio-favicon", params={"hint": "https://cdn.example/icon.png"})
    assert first.content == second.content
    # The second request was answered from _result_cache — the station's own
    # host was not asked again.
    assert mock_get.call_count == 1


def test_radio_favicon_caches_a_miss_so_it_is_not_re_resolved(client):
    mock_get = AsyncMock(side_effect=httpx.ConnectError("x"))
    with patch.object(radio_mod._client, "get", mock_get):
        first = client.get("/radio-favicon", params={"hint": "https://cdn.example/dead.png"})
        second = client.get("/radio-favicon", params={"hint": "https://cdn.example/dead.png"})
    assert first.status_code == second.status_code == 404
    assert mock_get.call_count == 1


def test_radio_favicon_keeps_sizes_of_one_station_apart(client):
    """min_size is part of the cache key: a 64px answer must never be handed
    to a caller that asked for something big enough for NowPlayingView."""
    html = b'<html><head><link rel="icon" href="/logo.png" sizes="512x512"></head></html>'
    small = _fake_get_response(content=_sized_png(64), content_type="image/png")
    large = _fake_get_response(content=_sized_png(512), content_type="image/png")
    with (
        patch.object(radio_mod._client, "stream", _mock_stream(html)),
        patch.object(radio_mod._client, "get", AsyncMock(side_effect=[small, large])),
    ):
        first = client.get("/radio-favicon", params={"url": "https://example.com", "min_size": 16})
        second = client.get(
            "/radio-favicon", params={"url": "https://example.com", "min_size": 512}
        )
    assert first.content != second.content


def test_result_cache_evicts_the_least_recently_used_entry_when_over_budget():
    big = radio_mod._RESULT_CACHE_MAX_BYTES // 2 + 1
    first = radio_mod._Fetched(b"x" * big, "image/png", 64)
    second = radio_mod._Fetched(b"y" * big, "image/png", 64)
    radio_mod._cache_put(("a", "", 0), first)
    radio_mod._cache_put(("b", "", 0), second)
    assert radio_mod._cache_get(("a", "", 0)) == (False, None)
    assert radio_mod._cache_get(("b", "", 0)) == (True, second)


def test_result_cache_forgets_an_entry_it_has_outlived():
    fetched = radio_mod._Fetched(b"icon", "image/png", 64)
    radio_mod._cache_put(("a", "", 0), fetched)
    later = radio_mod.time.monotonic() + radio_mod._RESULT_CACHE_TTL + 1
    with patch.object(radio_mod.time, "monotonic", return_value=later):
        assert radio_mod._cache_get(("a", "", 0)) == (False, None)


async def test_one_lookup_is_shared_by_everyone_asking_for_it_at_once():
    """Two screens (or two clients) opening on the same station must scrape
    that station's homepage once between them, not once each."""
    started = 0

    async def slow_resolve(url, hint, min_size):
        nonlocal started
        started += 1
        await asyncio.sleep(0.01)
        return radio_mod._Fetched(b"icon", "image/png", 64)

    with patch.object(radio_mod, "_resolve_favicon", slow_resolve):
        both = await asyncio.gather(
            radio_mod._resolve_cached(("https://example.com", "", 0)),
            radio_mod._resolve_cached(("https://example.com", "", 0)),
        )
    assert started == 1
    assert both[0] is both[1]


async def test_a_failed_lookup_is_not_cached_as_a_missing_icon():
    """An unexpected error says nothing about whether the station has an
    icon — caching it as "no" would blank the logo for the whole negative
    TTL over one bad moment."""
    with patch.object(radio_mod, "_resolve_favicon", AsyncMock(side_effect=RuntimeError("boom"))):
        assert await radio_mod._resolve_cached(("https://example.com", "", 0)) is None
    assert radio_mod._cache_get(("https://example.com", "", 0)) == (False, None)


# ── POST /radio-favicon/batch ────────────────────────────────────────────────


def test_favicon_batch_returns_the_icon_and_its_transparency(client):
    icon = _fake_get_response(content=_png_bytes("RGBA", 0.5), content_type="image/png")
    with patch.object(radio_mod._client, "get", AsyncMock(return_value=icon)):
        r = client.post(
            "/radio-favicon/batch",
            json={"stations": [{"key": "s1", "hint": "https://cdn.example/icon.png"}]},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["pending"] == []
    entry = body["results"]["s1"]
    assert entry["data_url"].startswith("data:image/png;base64,")
    # Carried in the payload so NowPlayingView doesn't need a second request
    # against the same URL just to read one response header.
    assert entry["transparent"] is True


def test_favicon_batch_returns_null_for_a_station_with_nothing_to_go_on(client):
    r = client.post("/radio-favicon/batch", json={"stations": [{"key": "s1"}]})
    assert r.json() == {"results": {"s1": None}, "pending": []}


def test_favicon_batch_returns_null_for_a_station_whose_icon_cannot_be_found(client):
    with patch.object(radio_mod._client, "get", AsyncMock(side_effect=httpx.ConnectError("x"))):
        r = client.post(
            "/radio-favicon/batch",
            json={"stations": [{"key": "s1", "hint": "https://cdn.example/dead.png"}]},
        )
    assert r.json() == {"results": {"s1": None}, "pending": []}


def test_favicon_batch_ignores_a_non_http_homepage_but_still_uses_the_hint(client):
    """Same http(s)-only restriction as the single-icon route, but a bad
    homepage must not throw away a perfectly good hint alongside it."""
    icon = _fake_get_response(content=_sized_png(64), content_type="image/png")
    with patch.object(radio_mod._client, "get", AsyncMock(return_value=icon)):
        r = client.post(
            "/radio-favicon/batch",
            json={
                "stations": [
                    {"key": "s1", "url": "file:///etc/passwd", "hint": "https://cdn.example/i.png"}
                ]
            },
        )
    assert r.json()["results"]["s1"] is not None


def test_favicon_batch_answers_a_repeated_key_once(client):
    icon = _fake_get_response(content=_sized_png(64), content_type="image/png")
    mock_get = AsyncMock(return_value=icon)
    with patch.object(radio_mod._client, "get", mock_get):
        r = client.post(
            "/radio-favicon/batch",
            json={
                "stations": [
                    {"key": "s1", "hint": "https://cdn.example/icon.png"},
                    {"key": "s1", "hint": "https://cdn.example/icon.png"},
                ]
            },
        )
    assert list(r.json()["results"]) == ["s1"]
    assert mock_get.call_count == 1


def test_favicon_batch_caps_how_many_stations_it_answers(client):
    over = radio_mod._MAX_BATCH_STATIONS + 5
    r = client.post(
        "/radio-favicon/batch",
        json={"stations": [{"key": f"s{i}"} for i in range(over)]},
    )
    assert len(r.json()["results"]) == radio_mod._MAX_BATCH_STATIONS


async def test_favicon_batch_reports_a_slow_lookup_as_pending_and_finishes_it_anyway():
    """One dead host costs the full client timeout, several times over — it
    must not hold up the rest of the list. What misses the deadline keeps
    running, so the caller's follow-up batch is a cache hit rather than a
    repeat of the work."""
    release = asyncio.Event()

    async def slow_resolve(url, hint, min_size):
        await release.wait()
        return radio_mod._Fetched(b"late-icon", "image/png", 64)

    request = radio_mod.FaviconBatchRequest(
        stations=[radio_mod.FaviconBatchStation(key="s1", hint="https://cdn.example/icon.png")]
    )
    with (
        patch.object(radio_mod, "_resolve_favicon", slow_resolve),
        patch.object(radio_mod, "_BATCH_DEADLINE", 0.01),
    ):
        first = await radio_mod.radio_favicon_batch(request)
        assert json.loads(first.body) == {"results": {}, "pending": ["s1"]}

        release.set()
        second = await radio_mod.radio_favicon_batch(request)

    assert json.loads(second.body)["pending"] == []
    assert json.loads(second.body)["results"]["s1"]["data_url"].startswith("data:image/png;base64,")


async def test_favicon_batch_and_the_single_icon_route_share_one_lookup():
    """Whether a screen asks one at a time or a list at once must change
    only how many HTTP requests cross the network, never how much work a
    station's own server is put to."""
    calls = 0

    async def counting_resolve(url, hint, min_size):
        nonlocal calls
        calls += 1
        return radio_mod._Fetched(_sized_png(64), "image/png", 64)

    with patch.object(radio_mod, "_resolve_favicon", counting_resolve):
        await radio_mod.radio_favicon_batch(
            radio_mod.FaviconBatchRequest(
                stations=[radio_mod.FaviconBatchStation(key="s1", hint="https://cdn.example/i.png")]
            )
        )
        response = await radio_mod.radio_favicon(
            url="", min_size=0, hint="https://cdn.example/i.png"
        )

    assert response.status_code == 200
    assert calls == 1
