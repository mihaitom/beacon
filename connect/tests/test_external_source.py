"""The external source: its settings, its songs, the /rest rules for them and
the passthrough of its page (core/external_source.py, media/external_bridge.py,
routes/external_source.py)."""

import hashlib
import json

import httpx
import pytest

from core import external_source
from media import JellyfinClient, PlexClient, SubsonicClient
from routes import external_source as external_routes
from routes import party as party_routes
from routes import proxy as proxy_routes

BASE = "http://10.9.9.9:8800"


@pytest.fixture(autouse=True)
def _isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(external_source, "_CONFIG_PATH", str(tmp_path / "external_sources.json"))
    monkeypatch.setattr(external_source, "_OLD_CONFIG_PATH", str(tmp_path / "external_source.json"))
    monkeypatch.setattr(external_source, "_ITEMS_PATH", str(tmp_path / "external_items.sqlite"))


@pytest.fixture
def configured():
    return external_source.save_source(None, "Wishlist", "mdi-gift", BASE, "s3cret")


class _AppRequests(list):
    """The requests connect sent to the user's app, and how it answers."""

    def __init__(self):
        super().__init__()
        self.respond = lambda request: httpx.Response(404)


@pytest.fixture
def app_requests(monkeypatch):
    """Every request connect sends to the user's app, answered by
    `respond` (replaceable per test) instead of the network."""
    seen = _AppRequests()

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return seen.respond(request)

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        external_routes, "_client", httpx.AsyncClient(transport=transport, follow_redirects=False)
    )
    monkeypatch.setattr(proxy_routes, "_client", httpx.AsyncClient(transport=transport))
    return seen


def _respond(app_requests, fn):
    app_requests.respond = fn


# --- configuration -------------------------------------------------------------


def test_the_address_is_normalized_and_must_be_http():
    assert external_source.normalize_base_url(" http://host:1/ ") == "http://host:1"
    for bad in ("ftp://host", "host:8800", "http://", "http://host/?x=1"):
        with pytest.raises(external_source.ExternalSourceError):
            external_source.normalize_base_url(bad)


def test_a_source_needs_a_name_and_a_known_kind_of_icon():
    with pytest.raises(external_source.ExternalSourceError):
        external_source.save_source(None, "  ", "", BASE, "")
    for icon in ("<b>", "fa-music", "mdi-" + "x" * 50):
        with pytest.raises(external_source.ExternalSourceError):
            external_source.save_source(None, "X", icon, BASE, "")


def test_nothing_set_up_reads_back_as_no_sources():
    assert external_source.load_sources() == []


def test_saved_settings_read_back(configured):
    assert external_source.load_sources() == [
        {
            "id": configured["id"],
            "name": "Wishlist",
            "icon": "mdi-gift",
            "base_url": BASE,
            "token": "s3cret",
        }
    ]


def test_several_sources_keep_their_order_and_ids(configured):
    second = external_source.save_source(None, "Folder", "", "http://10.9.9.8:8800", "")
    assert second["icon"] == external_source.DEFAULT_ICON
    assert [s["name"] for s in external_source.load_sources()] == ["Wishlist", "Folder"]
    external_source.save_source(configured["id"], "Wishes", "mdi-gift", BASE, "s3cret")
    assert [s["name"] for s in external_source.load_sources()] == ["Wishes", "Folder"]
    assert external_source.remove_source(configured["id"]) is True
    assert [s["id"] for s in external_source.load_sources()] == [second["id"]]
    assert external_source.remove_source(configured["id"]) is False


def test_changing_a_source_that_is_gone_is_refused():
    with pytest.raises(KeyError):
        external_source.save_source("nothere", "X", "", BASE, "")


def test_there_is_a_limit(monkeypatch):
    monkeypatch.setattr(external_source, "MAX_SOURCES", 2)
    external_source.save_source(None, "A", "", BASE, "")
    external_source.save_source(None, "B", "", BASE, "")
    with pytest.raises(external_source.ExternalSourceError):
        external_source.save_source(None, "C", "", BASE, "")


def test_the_single_source_of_before_becomes_the_first_of_the_list(tmp_path):
    old = tmp_path / "external_source.json"
    old.write_text(json.dumps({"name": "Imports", "base_url": BASE, "token": "t"}))
    [source] = external_source.load_sources()
    assert (source["name"], source["icon"], source["base_url"], source["token"]) == (
        "Imports",
        external_source.DEFAULT_ICON,
        BASE,
        "t",
    )
    assert not old.exists()
    assert external_source.load_sources() == [source]


def test_the_renderer_never_gets_a_token_back(client, default_session, configured):
    body = client.get("/external-source").json()
    assert body["may_configure"] is True
    [source] = body["sources"]
    assert source["has_token"] is True
    assert source["icon"] == "mdi-gift"
    assert "s3cret" not in str(body)
    assert source["ui_path"] == f"/external-ui/{external_source.ui_secret()}/{configured['id']}/"


def test_adding_a_source_answers_with_the_list_and_a_probe(client, default_session, app_requests):
    _respond(app_requests, lambda r: httpx.Response(200, json={"name": "Wish", "capabilities": []}))
    response = client.post(
        "/external-source", json={"name": "New", "icon": "mdi-folder-music", "base_url": BASE}
    )
    assert response.status_code == 200
    body = response.json()
    assert [s["name"] for s in body["sources"]] == ["New"]
    assert body["source"]["id"] == body["sources"][0]["id"]
    assert body["probe"]["ok"] is True


def test_saving_without_a_token_keeps_the_stored_one(
    client, default_session, configured, app_requests
):
    _respond(app_requests, lambda r: httpx.Response(200, json={"name": "Wish", "capabilities": []}))
    response = client.put(
        f"/external-source/{configured['id']}", json={"name": "Renamed", "base_url": BASE}
    )
    assert response.status_code == 200
    assert external_source.get_source(configured["id"])["token"] == "s3cret"
    assert response.json()["probe"] == {
        "ok": True,
        "name": "Wish",
        "version": "",
        "capabilities": [],
    }
    assert app_requests[-1].headers["authorization"] == "Bearer s3cret"


def test_an_unknown_source_is_a_404(client, default_session):
    assert (
        client.put("/external-source/nope", json={"name": "X", "base_url": BASE}).status_code == 404
    )
    assert client.delete("/external-source/nope").status_code == 404
    assert client.get("/external-source/nope/probe").status_code == 404
    assert (
        client.post("/external-source/nope/items", json={"items": [{"audioUrl": "a"}]}).status_code
        == 422
    )


def test_removing_a_source_answers_with_the_rest(client, default_session, configured):
    response = client.delete(f"/external-source/{configured['id']}")
    assert response.status_code == 200
    assert response.json()["sources"] == []


def test_the_probe_says_why_the_app_did_not_answer(
    client, default_session, configured, app_requests
):
    _respond(app_requests, lambda r: httpx.Response(401))
    assert client.get(f"/external-source/{configured['id']}/probe").json() == {
        "ok": False,
        "error": "The app refused the token",
    }


@pytest.mark.parametrize(
    "error, said",
    [
        (httpx.ConnectError("All connection attempts failed"), "All connection attempts failed"),
        (httpx.ConnectTimeout(""), "ConnectTimeout"),
    ],
)
def test_an_app_that_cannot_be_reached_says_only_why(
    client, default_session, configured, app_requests, error, said
):
    def fail(request):
        raise error

    _respond(app_requests, fail)
    assert client.get(f"/external-source/{configured['id']}/probe").json() == {
        "ok": False,
        "error": said,
    }


def test_on_a_shared_server_only_an_admin_may_set_it_up(
    client, default_session, configured, monkeypatch
):
    monkeypatch.setattr(external_routes, "_HOSTED", True)
    default_session.account_is_admin = False
    assert client.get("/external-source").json()["may_configure"] is False
    assert client.post("/external-source", json={"name": "X", "base_url": BASE}).status_code == 403
    path = f"/external-source/{configured['id']}"
    assert client.put(path, json={"name": "X", "base_url": BASE}).status_code == 403
    assert client.delete(path).status_code == 403
    assert client.get(f"{path}/probe").status_code == 403
    assert [s["name"] for s in external_source.load_sources()] == ["Wishlist"]


def test_a_listener_sees_the_tab_but_not_the_address(
    client, default_session, configured, monkeypatch
):
    monkeypatch.setattr(external_routes, "_HOSTED", True)
    default_session.account_is_admin = False
    [source] = client.get("/external-source").json()["sources"]
    assert source["name"] == "Wishlist"
    assert "base_url" not in source
    assert "has_token" not in source


def test_on_the_desktop_the_signed_in_person_may_set_it_up(
    client, default_session, monkeypatch, app_requests
):
    monkeypatch.setattr(external_routes, "_HOSTED", False)
    default_session.account_is_admin = False
    response = client.post("/external-source", json={"name": "X", "base_url": BASE})
    assert response.status_code == 200
    assert external_source.load_sources()[0]["name"] == "X"


def test_an_unauthenticated_session_gets_nothing(client, reset_state):
    assert client.get("/external-source").status_code == 401


# --- songs ---------------------------------------------------------------------


def _one(source_id, item):
    return external_source.register(source_id, [item])[0]


def test_a_whole_album_registers_in_its_order(configured):
    tracks = external_source.register(
        configured["id"], [{"audioUrl": f"{n}.mp3", "title": f"Song {n}"} for n in (3, 1, 2)]
    )
    assert [t.title for t in tracks] == ["Song 3", "Song 1", "Song 2"]
    assert len({t.id for t in tracks}) == 3
    assert external_source.get_track(tracks[2].id).title == "Song 2"


def test_one_refused_song_stores_none_of_the_album(configured):
    with pytest.raises(external_source.ExternalSourceError):
        external_source.register(
            configured["id"], [{"audioUrl": "1.mp3"}, {"audioUrl": "http://elsewhere/2.mp3"}]
        )
    first = external_source.ID_PREFIX + hashlib.sha256(f"{BASE}/ui/1.mp3".encode()).hexdigest()[:24]
    with pytest.raises(KeyError):
        external_source.get_track(first)
    assert _one(configured["id"], {"audioUrl": "1.mp3"}).id == first


@pytest.mark.parametrize(
    "url",
    [
        "http://10.9.9.9:9999/audio.mp3",  # another port
        "https://10.9.9.9:8800/audio.mp3",  # another scheme
        "http://127.0.0.1/admin",
        "//evil.example/audio.mp3",
        "file:///etc/passwd",
    ],
)
def test_audio_from_anywhere_but_the_app_is_refused(configured, url):
    with pytest.raises(external_source.ExternalSourceError):
        _one(configured["id"], {"audioUrl": url})


def test_a_cover_from_elsewhere_is_refused_too(configured):
    with pytest.raises(external_source.ExternalSourceError):
        _one(configured["id"], {"audioUrl": "a.mp3", "coverUrl": "http://elsewhere/c.jpg"})


def test_nothing_registers_for_a_source_that_is_not_there(configured):
    with pytest.raises(external_source.ExternalSourceError):
        _one("nope", {"audioUrl": "a.mp3"})


def test_the_same_audio_keeps_its_id_and_takes_the_newest_metadata(configured):
    first = _one(configured["id"], {"audioUrl": "a.mp3", "title": "Old"})
    second = _one(configured["id"], {"audioUrl": "a.mp3", "title": "New", "duration": "201.6"})
    assert first.id == second.id
    track = external_source.get_track(first.id)
    assert (track.title, track.duration) == ("New", 201)


def test_missing_metadata_gets_harmless_defaults(configured):
    track = _one(configured["id"], {"audioUrl": "a.mp3", "duration": "soon"})
    assert (track.title, track.artist, track.duration, track.cover_art_id) == (
        "Unknown",
        "Unknown",
        0,
        "",
    )


def test_an_unknown_id_raises_like_a_missing_library_song(configured):
    with pytest.raises(KeyError):
        external_source.get_track("ext:nothing")


@pytest.mark.parametrize(
    "media",
    [
        SubsonicClient("http://navidrome"),
        JellyfinClient("http://jellyfin"),
        PlexClient("http://plex"),
    ],
)
def test_every_media_client_hands_external_ids_to_the_source(configured, media):
    track = _one(
        configured["id"], {"audioUrl": "a.mp3", "coverUrl": "c.jpg", "title": "T", "artist": "A"}
    )
    assert media.get_stream_url(track.id) == f"{BASE}/ui/a.mp3"
    assert media.get_track(track.id).title == "T"
    assert media.get_cover_art_url(track.id, internal=True) == f"{BASE}/ui/c.jpg"


def test_library_ids_still_go_to_the_media_server():
    media = SubsonicClient("http://navidrome")
    assert media.get_stream_url("123").startswith("http://navidrome/rest/stream.view?id=123")


def test_the_items_route_returns_subsonic_songs(client, default_session, configured):
    response = client.post(
        f"/external-source/{configured['id']}/items",
        json={
            "items": [
                {"audioUrl": "a.mp3", "title": "T", "artist": "A", "coverUrl": "c.jpg"},
                {"audioUrl": "b.mp3", "title": "U"},
            ]
        },
    )
    assert response.status_code == 200
    first, second = response.json()["songs"]
    assert first["id"].startswith("ext:")
    assert (first["title"], first["artist"], first["coverArt"]) == ("T", "A", first["id"])
    assert second["title"] == "U"


def test_the_items_route_refuses_a_foreign_address(client, default_session, configured):
    response = client.post(
        f"/external-source/{configured['id']}/items",
        json={"items": [{"audioUrl": "http://elsewhere/a.mp3"}]},
    )
    assert response.status_code == 422


@pytest.mark.parametrize("count", [0, 501])
def test_the_items_route_takes_an_album_not_a_library(client, default_session, configured, count):
    response = client.post(
        f"/external-source/{configured['id']}/items",
        json={"items": [{"audioUrl": f"{n}.mp3"} for n in range(count)]},
    )
    assert response.status_code == 422


# --- /rest with an external id -------------------------------------------------


@pytest.fixture
def song(configured):
    return _one(configured["id"], {"audioUrl": "a.mp3", "title": "T", "coverUrl": "c.jpg"})


@pytest.fixture
def media_server_calls(monkeypatch):
    """What reached the media server through the proxy."""
    calls: list = []

    async def fake_proxy(request, target):
        calls.append((target, list(request.query_params.multi_items())))
        return httpx.Response(200)  # never inspected

    monkeypatch.setattr(proxy_routes, "_proxy", fake_proxy)
    return calls


def _subsonic(response):
    return response.json()["subsonic-response"]


def test_get_song_is_answered_without_the_media_server(
    client, default_session, song, media_server_calls
):
    body = _subsonic(client.get("/rest/getSong.view", params={"id": song.id}))
    assert body["status"] == "ok"
    assert body["song"]["title"] == "T"
    assert media_server_calls == []


@pytest.mark.parametrize("endpoint", ["star", "unstar", "setRating"])
def test_changes_on_the_media_server_are_refused(
    client, default_session, song, media_server_calls, endpoint
):
    body = _subsonic(client.get(f"/rest/{endpoint}.view", params={"id": song.id, "rating": 5}))
    assert body["status"] == "failed"
    assert media_server_calls == []


def test_a_scrobble_is_swallowed(client, default_session, song, media_server_calls):
    assert _subsonic(client.get("/rest/scrobble.view", params={"id": song.id}))["status"] == "ok"
    assert media_server_calls == []


def test_embedded_lyrics_and_similar_songs_are_empty(
    client, default_session, song, media_server_calls
):
    lyrics = _subsonic(client.get("/rest/getLyricsBySongId.view", params={"id": song.id}))
    similar = _subsonic(client.get("/rest/getSimilarSongs2.view", params={"id": song.id}))
    assert lyrics["lyricsList"]["structuredLyrics"] == []
    assert similar["similarSongs2"]["song"] == []
    assert media_server_calls == []


def test_a_playlist_gets_only_the_library_songs(client, default_session, song, media_server_calls):
    default_session.media.internal_url = "http://navidrome"
    client.get(
        "/rest/updatePlaylist.view",
        params=[("playlistId", "p1"), ("songIdToAdd", song.id), ("songIdToAdd", "lib1")],
    )
    assert media_server_calls[-1][1] == [("playlistId", "p1"), ("songIdToAdd", "lib1")]


def test_the_saved_queue_drops_an_external_current_song_and_its_position(
    client, default_session, song, media_server_calls
):
    default_session.media.internal_url = "http://navidrome"
    client.get(
        "/rest/savePlayQueue.view",
        params=[("id", "lib1"), ("id", song.id), ("current", song.id), ("position", "5000")],
    )
    assert media_server_calls[-1][1] == [("id", "lib1")]


def test_a_library_only_call_passes_through_untouched(client, default_session, media_server_calls):
    default_session.media.internal_url = "http://navidrome"
    client.get("/rest/getAlbum.view", params={"id": "al-1"})
    assert media_server_calls[-1][1] == [("id", "al-1")]


def test_audio_is_fetched_from_the_app_with_range_and_nothing_else(
    client, default_session, song, app_requests
):
    _respond(
        app_requests,
        lambda r: httpx.Response(
            206,
            content=b"abc",
            headers={
                "content-type": "audio/mp4",
                "content-range": "bytes 0-2/10",
                "set-cookie": "x=1",
            },
        ),
    )
    response = client.get(
        "/rest/stream.view",
        params={"id": song.id, "u": "listener", "p": "pw"},
        headers={"range": "bytes=0-2", "cookie": "beacon=1"},
    )
    assert response.status_code == 206
    assert response.content == b"abc"
    assert "set-cookie" not in response.headers
    upstream = app_requests[-1]
    assert str(upstream.url) == f"{BASE}/ui/a.mp3"
    assert upstream.headers["range"] == "bytes=0-2"
    assert "cookie" not in upstream.headers
    assert "authorization" not in upstream.headers


def test_a_redirect_from_the_app_is_not_followed(client, default_session, song, app_requests):
    _respond(
        app_requests, lambda r: httpx.Response(302, headers={"location": "http://127.0.0.1/x"})
    )
    response = client.get("/rest/stream.view", params={"id": song.id}, follow_redirects=False)
    assert response.status_code == 302
    assert len(app_requests) == 1


def test_the_cover_comes_from_the_app(client, default_session, song, app_requests):
    _respond(
        app_requests,
        lambda r: httpx.Response(200, content=b"img", headers={"content-type": "image/jpeg"}),
    )
    response = client.get("/rest/getCoverArt.view", params={"id": song.id})
    assert response.content == b"img"
    assert str(app_requests[-1].url) == f"{BASE}/ui/c.jpg"


def test_an_unknown_external_song_is_a_404(client, default_session, configured, app_requests):
    assert client.get("/rest/stream.view", params={"id": "ext:gone"}).status_code == 404


# --- the page --------------------------------------------------------------------


def _ui(source: dict, path: str = "") -> str:
    return f"/external-ui/{external_source.ui_secret()}/{source['id']}/{path}"


def test_the_page_needs_the_secret(client, configured, app_requests):
    assert client.get(f"/external-ui/wrong/{configured['id']}/index.html").status_code == 404
    assert app_requests == []


def test_the_page_is_sandboxed_and_stripped(client, configured, app_requests):
    _respond(
        app_requests,
        lambda r: httpx.Response(
            200,
            content=b"<html></html>",
            headers={
                "content-type": "text/html",
                "set-cookie": "a=1",
                "content-security-policy": "default-src *",
                "access-control-allow-origin": "https://elsewhere",
            },
        ),
    )
    response = client.get(_ui(configured), headers={"cookie": "beacon=1", "x-connect-token": "t"})
    assert response.status_code == 200
    csp = response.headers["content-security-policy"]
    assert csp.startswith("sandbox ")
    assert "allow-same-origin" not in csp
    assert "allow-top-navigation" not in csp
    assert response.headers["access-control-allow-origin"] == "*"
    assert "set-cookie" not in response.headers
    upstream = app_requests[-1]
    assert str(upstream.url) == f"{BASE}/ui/"
    assert upstream.headers["authorization"] == "Bearer s3cret"
    assert "cookie" not in upstream.headers
    assert "x-connect-token" not in upstream.headers


def test_the_pages_api_calls_pass_through_with_body_and_query(client, configured, app_requests):
    _respond(app_requests, lambda r: httpx.Response(200, json={"items": []}))
    response = client.post(_ui(configured, "api/search?q=a+b"), json={"x": 1})
    assert response.json() == {"items": []}
    upstream = app_requests[-1]
    assert upstream.method == "POST"
    assert upstream.url.path == "/ui/api/search"
    assert upstream.url.params["q"] == "a b"
    assert upstream.content == b'{"x":1}'


def test_a_preflight_is_answered_by_connect(client, configured, app_requests):
    response = client.options(_ui(configured, "api/search"))
    assert response.status_code == 204
    assert response.headers["access-control-allow-origin"] == "*"
    assert app_requests == []


def test_an_unreachable_app_is_a_502_still_sandboxed(client, configured, app_requests):
    def fail(request):
        raise httpx.ConnectError("refused")

    _respond(app_requests, fail)
    response = client.get(_ui(configured))
    assert response.status_code == 502
    assert response.headers["content-security-policy"].startswith("sandbox ")


def test_no_page_for_a_source_that_is_not_there(client, app_requests):
    assert client.get(_ui({"id": "nope"})).status_code == 404
    assert app_requests == []


def test_each_source_gets_its_own_page(client, configured, app_requests):
    other = external_source.save_source(None, "Folder", "", "http://10.9.9.8:8800", "f")
    _respond(app_requests, lambda r: httpx.Response(200, content=b"x"))
    client.get(_ui(other, "app.js"))
    assert str(app_requests[-1].url) == "http://10.9.9.8:8800/ui/app.js"
    assert app_requests[-1].headers["authorization"] == "Bearer f"


def test_a_removed_sources_songs_are_no_longer_fetched(
    client, default_session, song, configured, app_requests
):
    external_source.remove_source(configured["id"])
    assert client.get("/rest/stream.view", params={"id": song.id}).status_code == 404
    assert external_source.get_cover_art_url(song.id) is None
    assert app_requests == []


# --- party ---------------------------------------------------------------------


def test_party_guests_cannot_name_an_external_song():
    with pytest.raises(party_routes.HTTPException):
        party_routes._check_id("ext:abc")
    assert party_routes._check_id("abc") == "abc"
