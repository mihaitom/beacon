"""Tests for routes/coverart.py — batched cover-art fetch."""

import base64
from unittest.mock import AsyncMock, MagicMock

import routes.coverart as coverart_module
from media import JellyfinClient, PlexClient, SubsonicClient, jellyfin_bridge, plex_bridge


def _fake_client(*, content=b"img-bytes", content_type="image/jpeg", status_ok=True):
    """A stand-in for the shared httpx.AsyncClient each backend's real fetch
    goes through — captures the request it was given and answers with a
    canned image (or a failure, if status_ok is False)."""
    captured: dict = {}
    response = MagicMock()
    response.headers = {"content-type": content_type}
    response.content = content
    if status_ok:
        response.raise_for_status = MagicMock()
    else:
        import httpx

        def _raise():
            raise httpx.HTTPStatusError("nope", request=MagicMock(), response=MagicMock())

        response.raise_for_status = _raise

    async def get(url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs.get("headers")
        return response

    client = MagicMock()
    client.get = AsyncMock(side_effect=get)
    return client, captured


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


def test_batch_reports_null_for_a_ref_that_fails(client, default_session, monkeypatch):
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
