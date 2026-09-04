"""Tests for routes/coverart.py — batched cover-art fetch."""

import base64
from unittest.mock import AsyncMock, MagicMock

import pytest

import routes.coverart as coverart_module
from media import JellyfinClient, PlexClient, SubsonicClient, jellyfin_bridge, plex_bridge


@pytest.fixture(autouse=True)
def _empty_cache():
    """The route's cache is module-level and outlives one request, so
    without this a test asking for an id an earlier test already fetched is
    answered by that test's fixture instead of by its own."""
    coverart_module._reset_cache()
    yield
    coverart_module._reset_cache()


@pytest.fixture(autouse=True)
def _public_dns(monkeypatch):
    """Every hostname resolves to a public address unless a test says
    otherwise. Artist photos go through _points_somewhere_internal(), which
    resolves the host — nothing here may depend on real DNS (or reach for
    it)."""
    monkeypatch.setattr(coverart_module, "_resolve_addresses", AsyncMock(return_value=["93.0.0.1"]))


def _fake_client(*, content=b"img-bytes", content_type="image/jpeg", status_ok=True, status=None):
    """A stand-in for the shared httpx.AsyncClient each backend's real fetch
    goes through — captures the request it was given and answers with a
    canned image (or a failure, if status_ok is False; 404 by default, i.e.
    a genuinely missing image rather than a server that failed us)."""
    captured: dict = {}
    response = MagicMock()
    response.headers = {"content-type": content_type}
    response.content = content
    response.status_code = status if status is not None else (200 if status_ok else 404)
    # Explicit: an unset MagicMock attribute is truthy, which would read as
    # "this is a redirect" in _fetch_image_url().
    response.is_redirect = False

    async def get(url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs.get("headers")
        return response

    client = MagicMock()
    client.get = AsyncMock(side_effect=get)
    return client, captured


def _redirecting_client(location: str, *, content=b"img-bytes"):
    """Answers the first request with a 302 to `location` and the next one
    with an image — the shape _fetch_image_url() has to check hop by hop."""
    import httpx

    seen: list[str] = []
    image = MagicMock()
    image.headers = {"content-type": "image/jpeg"}
    image.content = content
    image.status_code = 200
    image.is_redirect = False

    async def get(url, **kwargs):
        seen.append(url)
        if len(seen) == 1:
            redirect = MagicMock()
            redirect.is_redirect = True
            redirect.status_code = 302
            redirect.headers = {"location": location}
            redirect.url = httpx.URL(url)
            return redirect
        return image

    client = MagicMock()
    client.get = AsyncMock(side_effect=get)
    return client, seen


def _decode(data_url: str) -> tuple[str, bytes]:
    header, encoded = data_url.split(",", 1)
    content_type = header.split(";")[0].removeprefix("data:")
    return content_type, base64.b64decode(encoded)


def test_batch_returns_data_url_per_id_for_subsonic(client, default_session, monkeypatch):
    default_session.media = SubsonicClient(
        "http://navidrome.internal", credential="u=t&t=abc&s=def"
    )
    fake_client, captured = _fake_client(content=b"cover-bytes")
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)

    response = client.post("/cover-art/batch", json={"ids": ["song-1"], "size": 160})

    assert response.status_code == 200
    results = response.json()["results"]
    content_type, decoded = _decode(results["song-1"])
    assert content_type == "image/jpeg"
    assert decoded == b"cover-bytes"
    assert "getCoverArt.view" in captured["url"]
    assert "size=160" in captured["url"]


def test_batch_fetches_every_id_concurrently(client, default_session, monkeypatch):
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client()
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)

    ids = [f"song-{i}" for i in range(5)]
    response = client.post("/cover-art/batch", json={"ids": ids})

    results = response.json()["results"]
    assert set(results.keys()) == set(ids)
    assert fake_client.get.await_count == 5


def test_batch_reports_null_for_a_cover_the_server_does_not_have(
    client, default_session, monkeypatch
):
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client(status_ok=False)
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)

    response = client.post("/cover-art/batch", json={"ids": ["missing-cover"]})

    assert response.json()["results"] == {"missing-cover": None}


def test_batch_reports_null_for_a_non_image_response(client, default_session, monkeypatch):
    # A media server answering with an HTML error page (e.g. an auth
    # redirect) rather than a real image — must not be handed to the
    # frontend as if it were valid cover art.
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client(content_type="text/html")
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)

    response = client.post("/cover-art/batch", json={"ids": ["song-1"]})

    assert response.json()["results"] == {"song-1": None}


def test_batch_reports_null_for_an_id_with_no_cover(client, default_session, monkeypatch):
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client()
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)

    # Empty id -> get_cover_art_url() itself returns None, never reaching
    # fake_client.get at all.
    response = client.post("/cover-art/batch", json={"ids": [""]})

    assert response.json()["results"] == {"": None}
    fake_client.get.assert_not_awaited()


def test_batch_caps_the_id_list(client, default_session, monkeypatch):
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client()
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)

    ids = [f"song-{i}" for i in range(coverart_module._MAX_IDS + 20)]
    response = client.post("/cover-art/batch", json={"ids": ids})

    assert len(response.json()["results"]) == coverart_module._MAX_IDS


def test_batch_uses_jellyfin_client_and_auth_header(client, default_session, monkeypatch):
    default_session.media = JellyfinClient("http://jellyfin.internal", token="tok", user_id="u1")
    fake_client, captured = _fake_client()
    monkeypatch.setattr(jellyfin_bridge, "_get_client", lambda: fake_client)

    response = client.post("/cover-art/batch", json={"ids": ["item-1"], "size": 96})

    assert "results" in response.json()
    assert "Items/item-1/Images/Primary" in captured["url"]
    assert "maxHeight=96" in captured["url"]
    assert captured["headers"] == {"X-Emby-Token": "tok"}


def test_batch_uses_plex_client_ignoring_requested_size(client, default_session, monkeypatch):
    default_session.media = PlexClient("http://plex.internal", token="tok")
    fake_client, captured = _fake_client()
    monkeypatch.setattr(plex_bridge, "_get_client", lambda: fake_client)

    response = client.post("/cover-art/batch", json={"ids": ["rk-1"], "size": 640})

    assert "results" in response.json()
    assert "/library/metadata/rk-1/thumb" in captured["url"]
    # No size parameter at all — Plex's own get_cover_art_url() ignores it
    # (see media/plex.py), same as its existing single-cover browser path.
    assert "640" not in captured["url"]


def test_batch_requires_an_authenticated_session(client):
    response = client.post("/cover-art/batch", json={"ids": ["song-1"]})

    assert response.status_code == 401


def test_batch_serves_a_repeat_request_from_the_cache(client, default_session, monkeypatch):
    # The point of the whole cache: a view revisited (or a second browser
    # reloading the page) must not send the media server through the same
    # fetch again.
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client(content=b"cover-bytes")
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)

    first = client.post("/cover-art/batch", json={"ids": ["song-1"]})
    second = client.post("/cover-art/batch", json={"ids": ["song-1"]})

    assert first.json()["results"] == second.json()["results"]
    assert fake_client.get.await_count == 1


def test_batch_caches_each_size_separately(client, default_session, monkeypatch):
    # A 160px thumbnail is not an answer for a 640px request — the size is
    # part of what was asked for, not just of how it was asked.
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client()
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)

    client.post("/cover-art/batch", json={"ids": ["song-1"], "size": 160})
    client.post("/cover-art/batch", json={"ids": ["song-1"], "size": 640})

    assert fake_client.get.await_count == 2


def test_batch_does_not_serve_another_server_s_cover(client, default_session, monkeypatch):
    # Cover ids are only unique within one media server, so the same id on a
    # different server has to be fetched rather than answered from the first
    # server's entry.
    fake_client, _ = _fake_client()
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)

    default_session.media = SubsonicClient("http://navidrome.a", credential="u=t&t=a&s=b")
    client.post("/cover-art/batch", json={"ids": ["song-1"]})
    default_session.media = SubsonicClient("http://navidrome.b", credential="u=t&t=a&s=b")
    client.post("/cover-art/batch", json={"ids": ["song-1"]})

    assert fake_client.get.await_count == 2


def test_batch_remembers_a_miss_but_only_briefly(client, default_session, monkeypatch):
    # A missing cover is remembered too — a view full of art-less songs
    # would otherwise re-ask the media server on every render, which is the
    # request shape that got a real user banned (see the module docstring).
    # It expires far sooner than a hit, since a library scan that hasn't
    # produced the artwork *yet* is the common reason for one.
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client(status_ok=False)
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)

    client.post("/cover-art/batch", json={"ids": ["song-1"]})
    client.post("/cover-art/batch", json={"ids": ["song-1"]})
    assert fake_client.get.await_count == 1

    # Moved through the route's own clock seam rather than by patching
    # time.monotonic itself — that one is also the event loop's clock, and
    # pinning it under the running loop this request goes through is a hang
    # waiting to happen (see coverart.py's _now()).
    now = [0.0]
    monkeypatch.setattr(coverart_module, "_now", lambda: now[0])
    coverart_module._reset_cache()
    client.post("/cover-art/batch", json={"ids": ["song-1"]})
    now[0] = coverart_module._NEGATIVE_CACHE_TTL + 1
    client.post("/cover-art/batch", json={"ids": ["song-1"]})

    assert fake_client.get.await_count == 3


def test_batch_evicts_its_least_recently_used_entry(client, default_session, monkeypatch):
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client(content=b"x" * 1024)
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)
    monkeypatch.setattr(coverart_module, "_CACHE_MAX_BYTES", 2048)

    for cover_id in ["a", "b", "c", "d"]:
        client.post("/cover-art/batch", json={"ids": [cover_id]})
    assert fake_client.get.await_count == 4

    # "a" is long gone, "d" is the most recent thing there is.
    client.post("/cover-art/batch", json={"ids": ["d"]})
    assert fake_client.get.await_count == 4
    client.post("/cover-art/batch", json={"ids": ["a"]})
    assert fake_client.get.await_count == 5


def test_batch_fetches_and_caches_an_artist_photo_url(client, default_session, monkeypatch):
    # Artist photos arrive from the media server as ready-made URLs, often
    # on a third-party CDN — resolved here so they get the same batching and
    # the same cache as everything else.
    fake_client, captured = _fake_client(content=b"photo-bytes")
    monkeypatch.setattr(coverart_module, "_image_client", fake_client)

    url = "https://cdn.example/artist.jpg"
    response = client.post("/cover-art/batch", json={"ids": [], "image_urls": [url]})

    assert response.status_code == 200
    content_type, decoded = _decode(response.json()["image_results"][url])
    assert content_type == "image/jpeg"
    assert decoded == b"photo-bytes"
    assert captured["url"] == url

    client.post("/cover-art/batch", json={"image_urls": [url]})
    assert fake_client.get.await_count == 1


def test_batch_reports_null_for_an_artist_photo_that_404s(client, default_session, monkeypatch):
    # Plenty of artists have no photo — the frontend falls back to the album
    # cover behind it, so this has to be a clean "no", not an error.
    fake_client, _ = _fake_client(status_ok=False)
    monkeypatch.setattr(coverart_module, "_image_client", fake_client)

    response = client.post("/cover-art/batch", json={"image_urls": ["https://cdn.example/a.jpg"]})

    assert response.json()["image_results"] == {"https://cdn.example/a.jpg": None}


def test_batch_refuses_a_non_http_image_url(client, default_session, monkeypatch):
    # This endpoint fetches whatever URL it is handed, so it stays on the
    # two schemes a media server ever hands out for a photo.
    fake_client, _ = _fake_client()
    monkeypatch.setattr(coverart_module, "_image_client", fake_client)

    response = client.post("/cover-art/batch", json={"image_urls": ["file:///etc/passwd"]})

    assert response.json()["image_results"] == {"file:///etc/passwd": None}
    fake_client.get.assert_not_awaited()


def test_batch_caps_the_image_url_list(client, default_session, monkeypatch):
    fake_client, _ = _fake_client()
    monkeypatch.setattr(coverart_module, "_image_client", fake_client)

    urls = [f"https://cdn.example/{i}.jpg" for i in range(coverart_module._MAX_IDS + 20)]
    response = client.post("/cover-art/batch", json={"image_urls": urls})

    assert len(response.json()["image_results"]) == coverart_module._MAX_IDS


def test_batch_leaves_out_an_id_it_could_not_fetch(client, default_session, monkeypatch):
    # A media server that was briefly unreachable says nothing about
    # whether the cover exists. Reported by leaving the id out of the
    # answer entirely — a `null` would be remembered as "no artwork" by
    # every cache in the path, including the browser's own for the rest of
    # the session, over one bad moment.
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    client_mock = MagicMock()
    client_mock.get = AsyncMock(side_effect=OSError("connection refused"))
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: client_mock)

    response = client.post("/cover-art/batch", json={"ids": ["song-1"]})

    assert response.status_code == 200
    assert response.json()["results"] == {}


@pytest.mark.parametrize("status", [401, 403, 429, 500, 503])
def test_batch_does_not_remember_a_server_failure_as_a_missing_cover(
    client, default_session, monkeypatch, status
):
    # Only a 404/410 means "there is no such image". Everything else is
    # about the server or the moment, so it is neither cached nor reported
    # as a settled answer — the next request tries again.
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client(status=status)
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)

    first = client.post("/cover-art/batch", json={"ids": ["song-1"]})
    second = client.post("/cover-art/batch", json={"ids": ["song-1"]})

    assert first.json()["results"] == {}
    assert second.json()["results"] == {}
    assert fake_client.get.await_count == 2


def test_batch_counts_misses_against_the_cache_budget(client, default_session, monkeypatch):
    # A cached miss holds no image, so counting it by length would make it
    # free — and a library whose items have no artwork yet would then grow
    # the cache without bound, since the byte total the eviction loop
    # watches would never move.
    default_session.media = SubsonicClient("http://navidrome.internal", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client(status_ok=False)
    monkeypatch.setattr(coverart_module, "_get_subsonic_client", lambda: fake_client)
    monkeypatch.setattr(coverart_module, "_CACHE_MAX_BYTES", coverart_module._NEGATIVE_ENTRY_BYTES)

    for cover_id in ["a", "b", "c"]:
        client.post("/cover-art/batch", json={"ids": [cover_id]})

    assert len(coverart_module._cache) == 1
    assert coverart_module._cache_bytes == coverart_module._NEGATIVE_ENTRY_BYTES


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8080/x.jpg",
        "http://[::1]/x.jpg",
        "http://10.0.0.5/x.jpg",
        "http://169.254.169.254/latest/meta-data/",
    ],
)
def test_batch_refuses_an_image_url_pointing_at_our_own_network(
    client, default_session, monkeypatch, url
):
    # image_urls is the one list this endpoint fetches from a host it was
    # handed rather than one it configured, so an authenticated client must
    # not be able to use the backend to reach a loopback port, a
    # Docker-internal service or a cloud metadata endpoint and read the
    # answer back base64-encoded.
    default_session.media = SubsonicClient("http://navidrome.example", credential="u=t&t=a&s=b")
    fake_client, _ = _fake_client()
    monkeypatch.setattr(coverart_module, "_image_client", fake_client)

    response = client.post("/cover-art/batch", json={"image_urls": [url]})

    assert response.json()["image_results"] == {url: None}
    fake_client.get.assert_not_awaited()


def test_batch_refuses_a_redirect_into_our_own_network(client, default_session, monkeypatch):
    # Checking the URL that was asked for is worth nothing if the answer is
    # a 302 to somewhere else, so every hop goes through the same guard.
    default_session.media = SubsonicClient("http://navidrome.example", credential="u=t&t=a&s=b")
    fake_client, seen = _redirecting_client("http://127.0.0.1:9200/x.jpg")
    monkeypatch.setattr(coverart_module, "_image_client", fake_client)

    url = "https://cdn.example/artist.jpg"
    response = client.post("/cover-art/batch", json={"image_urls": [url]})

    assert response.json()["image_results"] == {url: None}
    assert seen == [url]  # the redirect target itself was never fetched


def test_batch_follows_a_redirect_to_another_public_host(client, default_session, monkeypatch):
    # The legitimate shape this has to keep working: a media server
    # redirecting to fanart/last.fm, and that host redirecting on to its
    # own edge.
    default_session.media = SubsonicClient("http://navidrome.example", credential="u=t&t=a&s=b")
    fake_client, seen = _redirecting_client("https://edge.example/real.jpg", content=b"photo")
    monkeypatch.setattr(coverart_module, "_image_client", fake_client)

    url = "https://cdn.example/artist.jpg"
    response = client.post("/cover-art/batch", json={"image_urls": [url]})

    assert _decode(response.json()["image_results"][url])[1] == b"photo"
    assert seen == [url, "https://edge.example/real.jpg"]


def test_batch_allows_an_image_url_on_the_media_server_itself(client, default_session, monkeypatch):
    # A self-hosted server on the LAN handing out artist photos on its own
    # address, not through our proxy, is both real and legitimate — and it
    # is a host this backend already talks to on every other request.
    default_session.media = SubsonicClient("http://192.168.1.10:4533", credential="u=t&t=a&s=b")
    fake_client, captured = _fake_client(content=b"lan-photo")
    monkeypatch.setattr(coverart_module, "_image_client", fake_client)

    url = "http://192.168.1.10:4533/artist.jpg"
    response = client.post("/cover-art/batch", json={"image_urls": [url]})

    assert _decode(response.json()["image_results"][url])[1] == b"lan-photo"
    assert captured["url"] == url


def test_batch_retries_an_unresolvable_image_host_rather_than_remembering_it(
    client, default_session, monkeypatch
):
    # DNS failing is a fetch that could not happen, not a settled "this
    # artist has no photo" — remembering it would blank the photo for the
    # whole negative TTL over a hiccup.
    fake_client, _ = _fake_client()
    monkeypatch.setattr(coverart_module, "_image_client", fake_client)
    monkeypatch.setattr(
        coverart_module, "_resolve_addresses", AsyncMock(side_effect=OSError("no such host"))
    )

    url = "https://cdn.example/artist.jpg"
    response = client.post("/cover-art/batch", json={"image_urls": [url]})

    assert response.json()["image_results"] == {}
    assert coverart_module._cache == {}


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, coverart_module._DEFAULT_CACHE_MB),
        ("", coverart_module._DEFAULT_CACHE_MB),
        ("   ", coverart_module._DEFAULT_CACHE_MB),
        ("not-a-number", coverart_module._DEFAULT_CACHE_MB),
        ("0", coverart_module._MIN_CACHE_MB),
        ("-5", coverart_module._MIN_CACHE_MB),
        ("256", 256),
    ],
)
def test_cover_cache_budget_survives_whatever_is_in_the_environment(monkeypatch, raw, expected):
    # A documented, user-facing env var: a typo (or `COVER_CACHE_MB=` with
    # no value, which a Compose file produces for a variable left blank)
    # must not take the backend down at import time.
    if raw is None:
        monkeypatch.delenv("COVER_CACHE_MB", raising=False)
    else:
        monkeypatch.setenv("COVER_CACHE_MB", raw)

    assert coverart_module._cache_budget_mb() == expected
