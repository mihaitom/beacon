import time
from dataclasses import replace
from urllib.parse import urljoin

import pytest
from conftest import make_mp3
from starlette.testclient import TestClient

from folder_source.app import create_app
from folder_source.config import music_folders

BASE = "http://testserver"
# The music fixture's folder, "Music", named after itself.
KEY = "music"
API = f"/ui/api/{KEY}"


def _resolve(relative: str) -> str:
    """An address from the page as Beacon resolves it: against /ui/."""
    return urljoin(f"{BASE}/ui/", relative).removeprefix(BASE)


def _album(client, title):
    album_id = next(a["id"] for a in client.get(f"{API}/albums").json() if a["title"] == title)
    return client.get(f"{API}/albums/{album_id}").json()


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
    for name in ("app.js", "style.css"):
        response = client.get(f"/ui/{name}")
        assert response.status_code == 200
        # An update must reach a browser that has the old file.
        assert response.headers["cache-control"] == "no-cache"


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
    track_id = url.split("/")[3]
    assert client.get(f"/audio/{KEY}/{track_id}/forged.mp3").status_code == 404
    album_id = _resolve(item["coverUrl"]).split("/")[3]
    assert client.get(f"/covers/{KEY}/{album_id}/forged").status_code == 404


def test_paths_cannot_be_named_at_all(client):
    for path in (
        "/audio/../../etc/passwd",
        f"/audio/{KEY}/%2e%2e/x/y",
        f"/covers/{KEY}/..%2f..%2fetc/x",
    ):
        assert client.get(path).status_code == 404


def test_an_embedded_cover_is_served(client):
    album = _album(client, "Sommer")
    assert album["cover"] is True
    assert client.get(f"/ui/covers/{KEY}/{album['id']}").content.startswith(b"\xff\xd8")


def test_the_page_can_ask_for_a_small_cover(client):
    album = _album(client, "Sommer")
    response = client.get(f"/ui/covers/{KEY}/{album['id']}?size=thumb")
    assert response.headers["content-type"] == "image/jpeg"
    assert response.content.startswith(b"\xff\xd8")


def test_an_album_without_a_cover_says_so(client):
    album = _album(client, "Best Of")
    assert album["cover"] is False
    assert "coverUrl" not in album["tracks"][0]["item"]
    assert client.get(f"/ui/covers/{KEY}/{album['id']}").status_code == 404


def test_search_returns_playable_songs(client):
    result = client.get(f"{API}/search", params={"q": "schrei"}).json()
    assert [t["title"] for t in result["tracks"]] == ["Schrei nach Liebe"]
    assert result["tracks"][0]["item"]["audioUrl"].startswith("../audio/")


def test_artists_count_their_albums(client):
    artists = {a["name"]: a["albums"] for a in client.get(f"{API}/artists").json()}
    assert artists["Nordlicht"] == 1
    assert artists["Various Artists"] == 1


def test_with_a_token_the_page_needs_it_but_audio_does_not(config, library):
    app = create_app(replace(config, token="t0ken"), {KEY: library}, scan_on_start=False)
    with TestClient(app) as c:
        assert c.get("/v1").status_code == 401
        assert c.get("/ui/").status_code == 401
        assert c.get(f"{API}/albums", headers={"authorization": "Bearer wrong"}).status_code == 401
        authed = {"authorization": "Bearer t0ken"}
        albums = c.get(f"{API}/albums", headers=authed).json()
        album = c.get(f"{API}/albums/{albums[0]['id']}", headers=authed).json()
        # Beacon and the speakers fetch these without a header.
        assert c.get(_resolve(album["tracks"][0]["item"]["audioUrl"])).status_code == 200
        assert c.get("/health").status_code == 200


def test_signatures_depend_on_the_secret(config, library):
    other = create_app(replace(config, secret=b"another"), {KEY: library}, scan_on_start=False)
    with (
        TestClient(create_app(config, {KEY: library}, scan_on_start=False)) as c,
        TestClient(other) as o,
    ):
        url = _resolve(_album(c, "Polarnacht")["tracks"][0]["item"]["audioUrl"])
        assert c.get(url).status_code == 200
        assert o.get(url).status_code == 404


def test_odd_characters_are_refused_not_crashed_on(config, library):
    app = create_app(replace(config, token="t0ken"), {KEY: library}, scan_on_start=False)
    with TestClient(app, raise_server_exceptions=False) as c:
        assert c.get(f"/audio/{KEY}/abc/%C3%A4.mp3").status_code == 404
        assert c.get(f"/covers/{KEY}/abc/%C3%A4").status_code == 404
        assert (
            c.get("/v1", headers={"authorization": "Bearer t\xf6ken".encode("latin-1")}).status_code
            == 401
        )


def test_the_status_tells_how_far_a_scan_is(client):
    progress = client.get("/ui/api/status").json()["folders"][0]["progress"]
    assert progress == {"phase": "", "found": 9, "toRead": 9, "read": 9}


def test_the_songs_list_comes_a_page_at_a_time(client):
    everything = client.get(f"{API}/songs?sort=title").json()
    assert everything["total"] == len(everything["rows"]) == 9
    page = client.get(f"{API}/songs?sort=title&offset=3&limit=2").json()
    assert page["total"] == 9
    assert [r["id"] for r in page["rows"]] == [r["id"] for r in everything["rows"][3:5]]
    # Each row can be played as it is.
    assert page["rows"][0]["item"]["audioUrl"].startswith("../audio/")


def test_a_songs_page_out_of_range_is_empty_not_an_error(client):
    assert client.get(f"{API}/songs?offset=999").json()["rows"] == []
    assert len(client.get(f"{API}/songs?limit=abc").json()["rows"]) == 9
    assert len(client.get(f"{API}/songs?limit=-5").json()["rows"]) == 1


def test_the_first_songs_page_carries_the_index(client):
    first = client.get(f"{API}/songs?sort=artist").json()
    rows, letters = first["rows"], first["letters"]
    assert letters["#"] == 0  # the loose song, which names no artist
    assert rows[letters["A"]]["artist"] == "Anna"
    assert rows[letters["N"]]["artist"] == "Nordlicht"
    assert client.get(f"{API}/songs?sort=artist&offset=2").json()["letters"] is None


def test_songs_say_whether_their_album_has_a_cover(client):
    rows = client.get(f"{API}/songs").json()["rows"]
    by_album = {r["album"]: r["cover"] for r in rows}
    assert by_album["Polarnacht"] is True
    assert by_album["Best Of"] is False


# --- several folders -------------------------------------------------------------


@pytest.fixture(scope="module")
def two_folders(tmp_path_factory):
    """The same file in both, tagged differently: ids alone cannot tell them apart."""
    root = tmp_path_factory.mktemp("two")
    for name in ("Imports", "DJ Sets"):
        make_mp3(root / name / "Artist/Album/01 Song.mp3", title=f"From {name}", album="Album")
    return [root / "Imports", root / "DJ Sets"]


@pytest.fixture
def two(config, two_folders):
    """A client over both folders, scanned on start as in real life."""
    app = create_app(replace(config, folders=music_folders(list(map(str, two_folders)))))
    with TestClient(app) as c:
        for _ in range(200):
            if not c.get("/ui/api/status").json()["scanning"]:
                break
            time.sleep(0.02)
        yield c


def _only_track(client, key):
    album = client.get(f"/ui/api/{key}/albums").json()[0]
    return client.get(f"/ui/api/{key}/albums/{album['id']}").json()["tracks"][0]


def test_each_folder_is_listed_by_its_name(two):
    folders = two.get("/ui/api/status").json()["folders"]
    assert [(f["key"], f["name"], f["songs"]) for f in folders] == [
        ("imports", "Imports", 1),
        ("dj-sets", "DJ Sets", 1),
    ]


def test_each_folder_plays_its_own_file(two):
    imports, sets = _only_track(two, "imports"), _only_track(two, "dj-sets")
    assert (imports["title"], sets["title"]) == ("From Imports", "From DJ Sets")
    assert imports["item"]["audioUrl"] != sets["item"]["audioUrl"]
    assert (
        two.get(_resolve(imports["item"]["audioUrl"])).content
        != two.get(_resolve(sets["item"]["audioUrl"])).content
    )


def test_a_signature_holds_only_for_its_own_folder(two):
    url = _resolve(_only_track(two, "imports")["item"]["audioUrl"])
    assert two.get(url).status_code == 200
    assert two.get(url.replace("/imports/", "/dj-sets/")).status_code == 404


def test_search_stays_in_its_folder(two):
    found = two.get("/ui/api/imports/search", params={"q": "from"}).json()["tracks"]
    assert [t["title"] for t in found] == ["From Imports"]


def test_an_unknown_folder_is_not_found(two):
    assert two.get("/ui/api/elsewhere/albums").status_code == 404
    assert two.get("/audio/elsewhere/x/y.mp3").status_code == 404
