from dataclasses import replace
from urllib.parse import urljoin

from starlette.testclient import TestClient

from folder_source.app import create_app

BASE = "http://testserver"


def _resolve(relative: str) -> str:
    """An address from the page as Beacon resolves it: against /ui/."""
    return urljoin(f"{BASE}/ui/", relative).removeprefix(BASE)


def _album(client, title):
    album_id = next(a["id"] for a in client.get("/ui/api/albums").json() if a["title"] == title)
    return client.get(f"/ui/api/albums/{album_id}").json()


def test_v1_says_who_it_is(client):
    assert client.get("/v1").json() == {
        "name": "Test folder",
        "version": "1.0.0",
        "capabilities": [],
    }


def test_the_page_and_its_files_are_served(client):
    page = client.get("/ui/")
    assert page.status_code == 200
    assert 'src="app.js"' in page.text
    assert client.get("/ui/app.js").status_code == 200
    assert client.get("/ui/style.css").status_code == 200


def test_a_play_item_plays(client):
    track = _album(client, "Polarnacht")["tracks"][0]
    item = track["item"]
    assert (item["title"], item["artist"], item["album"]) == (
        "Erster Schnee",
        "Nordlicht",
        "Polarnacht",
    )
    assert item["duration"] > 1.5
    audio = client.get(_resolve(item["audioUrl"]))
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/mpeg"
    assert client.get(_resolve(item["coverUrl"])).headers["content-type"] == "image/jpeg"


def test_audio_answers_range_requests(client):
    item = _album(client, "Polarnacht")["tracks"][0]["item"]
    response = client.get(_resolve(item["audioUrl"]), headers={"range": "bytes=0-99"})
    assert response.status_code == 206
    assert len(response.content) == 100
    assert response.headers["content-range"].startswith("bytes 0-99/")


def test_a_wrong_signature_gets_nothing(client):
    item = _album(client, "Polarnacht")["tracks"][0]["item"]
    url = _resolve(item["audioUrl"])
    track_id = url.split("/")[2]
    assert client.get(f"/audio/{track_id}/forged.mp3").status_code == 404
    album_id = _resolve(item["coverUrl"]).split("/")[2]
    assert client.get(f"/covers/{album_id}/forged").status_code == 404


def test_paths_cannot_be_named_at_all(client):
    for path in ("/audio/../../etc/passwd", "/audio/%2e%2e/x/y", "/covers/..%2f..%2fetc/x"):
        assert client.get(path).status_code == 404


def test_an_embedded_cover_is_served(client):
    album = _album(client, "Sommer")
    assert album["cover"] is True
    assert client.get(f"/ui/covers/{album['id']}").content.startswith(b"\xff\xd8")


def test_an_album_without_a_cover_says_so(client):
    album = _album(client, "Best Of")
    assert album["cover"] is False
    assert "coverUrl" not in album["tracks"][0]["item"]
    assert client.get(f"/ui/covers/{album['id']}").status_code == 404


def test_search_returns_playable_songs(client):
    result = client.get("/ui/api/search", params={"q": "schrei"}).json()
    assert [t["title"] for t in result["tracks"]] == ["Schrei nach Liebe"]
    assert result["tracks"][0]["item"]["audioUrl"].startswith("../audio/")


def test_artists_count_their_albums(client):
    artists = {a["name"]: a["albums"] for a in client.get("/ui/api/artists").json()}
    assert artists["Nordlicht"] == 1
    assert artists["Various Artists"] == 1


def test_with_a_token_the_page_needs_it_but_audio_does_not(config, library):
    app = create_app(replace(config, token="t0ken"), library, scan_on_start=False)
    with TestClient(app) as c:
        assert c.get("/v1").status_code == 401
        assert c.get("/ui/").status_code == 401
        assert c.get("/ui/api/albums", headers={"authorization": "Bearer wrong"}).status_code == 401
        authed = {"authorization": "Bearer t0ken"}
        albums = c.get("/ui/api/albums", headers=authed).json()
        album = c.get(f"/ui/api/albums/{albums[0]['id']}", headers=authed).json()
        # Beacon and the speakers fetch these without a header.
        assert c.get(_resolve(album["tracks"][0]["item"]["audioUrl"])).status_code == 200
        assert c.get("/health").status_code == 200


def test_signatures_depend_on_the_secret(config, library):
    other = create_app(replace(config, secret=b"another"), library, scan_on_start=False)
    with TestClient(create_app(config, library, scan_on_start=False)) as c, TestClient(other) as o:
        url = _resolve(_album(c, "Polarnacht")["tracks"][0]["item"]["audioUrl"])
        assert c.get(url).status_code == 200
        assert o.get(url).status_code == 404


def test_odd_characters_are_refused_not_crashed_on(config, library):
    app = create_app(replace(config, token="t0ken"), library, scan_on_start=False)
    with TestClient(app, raise_server_exceptions=False) as c:
        assert c.get("/audio/abc/%C3%A4.mp3").status_code == 404
        assert c.get("/covers/abc/%C3%A4").status_code == 404
        assert (
            c.get("/v1", headers={"authorization": "Bearer t\xf6ken".encode("latin-1")}).status_code
            == 401
        )


def test_the_status_tells_how_far_a_scan_is(client):
    progress = client.get("/ui/api/status").json()["progress"]
    assert progress == {"phase": "", "found": 9, "toRead": 9, "read": 9}
