import datetime
from urllib.parse import urljoin

from conftest import AUDIO, TINY_PNG, queries

BASE = "http://testserver"


def _resolve(relative: str) -> str:
    """An address from the page as Beacon resolves it: against /ui/."""
    return urljoin(f"{BASE}/ui/", relative).removeprefix(BASE)


def _show(client, show_id="band1977-05-08.aud"):
    return client.get(f"/ui/api/shows/{show_id}").json()


def test_v1_says_who_it_is(client):
    assert client.get("/v1").json() == {
        "name": "Test archive",
        "version": "1.0.0",
        "capabilities": [],
    }


def test_the_page_and_its_files_are_served(client):
    page = client.get("/ui/")
    assert page.status_code == 200
    assert 'src="app.js"' in page.text
    assert client.get("/ui/app.js").status_code == 200
    assert client.get("/ui/style.css").status_code == 200


def test_with_a_token_the_page_needs_it_but_audio_does_not(make_client):
    c = make_client(token="t0ken")
    assert c.get("/v1").status_code == 401
    assert c.get("/ui/api/home", headers={"authorization": "Bearer wrong"}).status_code == 401
    authed = {"authorization": "Bearer t0ken"}
    show = c.get("/ui/api/shows/band1977-05-08.aud", headers=authed).json()
    # Beacon and the speakers fetch these without a header.
    assert c.get(_resolve(show["tracks"][0]["item"]["audioUrl"])).status_code == 200
    assert c.get("/health").status_code == 200


def test_a_show_plays_the_mp3s_in_order(client):
    show = _show(client)
    assert [t["title"] for t in show["tracks"]] == ["Opener", "Long Jam", "Encore"]
    assert [t["duration"] for t in show["tracks"]] == [301.2, 3723, 300]
    item = show["tracks"][0]["item"]
    assert (item["title"], item["artist"], item["album"]) == (
        "Opener",
        "The Band",
        "1977-05-08 - Barton Hall",
    )
    assert item["audioUrl"].startswith("../audio/") and item["audioUrl"].endswith(
        "/band1977-05-08.aud/band77d1t01.mp3"
    )
    assert show["artistId"] == "TheBand"


def test_a_show_with_only_flac_open_plays_the_flac(client):
    show = _show(client, "band1979-02-02.flac")
    assert [t["title"] for t in show["tracks"]] == ["Only Song"]
    url = _resolve(show["tracks"][0]["item"]["audioUrl"])
    assert url.endswith("/sub%20dir/one%20two.flac")
    response = client.get(url)
    assert response.status_code == 200
    assert "flac" in response.headers["content-type"]


def test_a_stream_only_show_is_never_offered(client, fake):
    response = client.get("/ui/api/shows/band1978-01-01.sbd")
    assert response.status_code == 404
    assert "cannot be played" in response.json()["error"]
    # Every search leaves them out.
    client.get("/ui/api/home")
    client.get("/ui/api/search", params={"q": "band"})
    client.get("/ui/api/artists/TheBand")
    show_queries = [q for q in queries(fake) if "mediatype:etree" in q]
    assert len(show_queries) == 5  # three for the shows tab, the search, the artist
    assert all("-collection:stream_only" in q for q in show_queries)


def test_a_stream_only_show_gets_no_audio_even_with_a_signature(client, config):
    from live_music_archive.signing import sign

    name = "band78t01.mp3"
    sig = sign(config.secret, "audio", f"band1978-01-01.sbd/{name}")
    assert client.get(f"/audio/{sig}/band1978-01-01.sbd/{name}").status_code == 404


def test_something_outside_the_live_music_archive_is_refused(client):
    assert client.get("/ui/api/shows/some-audiobook").status_code == 404


def test_audio_follows_archive_org_and_passes_ranges_on(client, fake):
    url = _resolve(_show(client)["tracks"][0]["item"]["audioUrl"])
    whole = client.get(url)
    assert whole.status_code == 200
    assert whole.content == AUDIO
    assert whole.headers["content-length"] == str(len(AUDIO))
    assert whole.headers["accept-ranges"] == "bytes"
    part = client.get(url, headers={"range": "bytes=100-199"})
    assert part.status_code == 206
    assert part.content == AUDIO[100:200]
    assert part.headers["content-range"] == f"bytes 100-199/{len(AUDIO)}"
    downloads = [r for r in fake.requests if r.url.path.startswith("/download/")]
    assert downloads[-1].headers["user-agent"].startswith("beacon-live-music-archive/")


def test_audio_answers_head(client):
    url = _resolve(_show(client)["tracks"][0]["item"]["audioUrl"])
    response = client.head(url)
    assert response.status_code == 200
    assert response.headers["content-length"] == str(len(AUDIO))
    assert response.content == b""


def test_a_wrong_signature_gets_nothing(client, fake):
    url = _resolve(_show(client)["tracks"][0]["item"]["audioUrl"])
    rest = url.split("/", 3)[3]
    before = len(fake.requests)
    assert client.get(f"/audio/forged/{rest}").status_code == 404
    assert client.get("/covers/forged/band1977-05-08.aud").status_code == 404
    assert len(fake.requests) == before


def test_only_files_of_the_show_can_be_fetched(client, config):
    from live_music_archive.signing import sign

    show_id = "band1977-05-08.aud"
    for name in ("band77d1t01.flac", "band1977-05-08.aud_archive.torrent", "../other/x.mp3"):
        sig = sign(config.secret, "audio", f"{show_id}/{name}")
        assert client.get(f"/audio/{sig}/{show_id}/{name}").status_code == 404, name


def test_identifiers_are_checked_before_anything_is_asked(client, fake):
    for path in ("/ui/api/shows/x%3Ay", "/ui/api/artists/a%20b", "/ui/images/%2E%2E"):
        assert client.get(path).status_code == 404, path
    assert fake.requests == []


def test_covers_come_from_archive_org(client):
    item = _show(client)["tracks"][0]["item"]
    response = client.get(_resolve(item["coverUrl"]))
    assert response.status_code == 200
    assert response.content == TINY_PNG
    assert client.get("/ui/images/TheBand").headers["content-type"] == "image/png"
    assert client.get("/ui/images/NoPicture").status_code == 404


def test_answers_are_kept_instead_of_asked_again(client, fake):
    _show(client)
    _show(client)
    client.get("/ui/images/TheBand")
    client.get("/ui/images/TheBand")
    client.get("/ui/api/home")
    client.get("/ui/api/home")
    paths = [r.url.path for r in fake.requests]
    assert paths.count("/metadata/band1977-05-08.aud") == 1
    assert paths.count("/services/img/TheBand") == 1
    assert paths.count("/advancedsearch.php") == 3  # the three lists of the shows tab


def test_a_slow_down_from_archive_org_is_obeyed(client, fake):
    fake.busy = True
    response = client.get("/ui/api/home")
    assert response.status_code == 503
    assert "slow down" in response.json()["error"]
    fake.busy = False
    asked = len(fake.requests)
    assert client.get("/ui/api/artists").status_code == 503
    assert len(fake.requests) == asked


def test_search_finds_artists_and_shows(client, fake):
    result = client.get("/ui/api/search", params={"q": "barton (hall"}).json()
    assert [a["name"] for a in result["artists"]] == ["The Band"]
    assert result["shows"][0] == {
        "id": "band1977-05-08.aud",
        "title": "The Band Live at Barton Hall on 1977-05-08",
        "artist": "The Band",
        "artistId": "TheBand",
        "coverId": "TheBand",
        "date": "1977-05-08",
        "venue": "Barton Hall",
        "location": "Ithaca, NY",
        "recording": "Audience",
        "rating": None,
        "reviews": 0,
    }
    assert any(r"venue:barton OR" in q and r"venue:\(hall OR" in q for q in queries(fake))


def test_an_artist_lists_their_shows(client, fake):
    result = client.get("/ui/api/artists/TheBand", params={"sort": "oldest", "page": "2"}).json()
    assert (result["name"], result["page"]) == ("The Band", 2)
    assert result["shows"][0]["id"] == "band1977-05-08.aud"
    listing = next(r for r in fake.requests if 'collection:"TheBand"' in r.url.params["q"])
    assert listing.url.params["sort[]"] == "date asc"
    assert listing.url.params["page"] == "2"


def test_the_shows_tab_has_this_day_in_other_years(make_client, fake):
    client = make_client(today=lambda: datetime.date(2026, 5, 8))
    home = client.get("/ui/api/home").json()
    assert home["today"] == "2026-05-08"
    # One recording per night, two shows per artist, and only this day.
    assert [s["id"] for s in home["onThisDay"]] == [
        "band1977-05-08.aud",
        "other1990-05-08",
        "band1980-05-08",
    ]
    assert any('title:"05-08"' in q for q in queries(fake))


def test_the_shows_tab_has_the_best_rated_shows(client, fake):
    assert client.get("/ui/api/home").json()["favourites"]
    favourites = next(r for r in fake.requests if "num_reviews" in r.url.params.get("q", ""))
    assert favourites.url.params.get_list("sort[]") == ["avg_rating desc", "num_reviews desc"]


def test_a_show_wears_its_artists_picture(client):
    item = _show(client)["tracks"][0]["item"]
    assert item["coverUrl"].endswith("/TheBand")
    assert client.get(_resolve(item["coverUrl"])).content == TINY_PNG


def test_the_featured_show_is_a_real_concert(client, monkeypatch):
    import conftest

    # Other nights, or they would count as recordings of the same one.
    junk = {
        **conftest.SEARCH_DOCS["shows"][0],
        "identifier": "some-audiobook",
        "date": "2001-01-01T00:00:00Z",
    }
    flac_only = {
        **conftest.SEARCH_DOCS["shows"][0],
        "identifier": "band1979-02-02.flac",
        "date": "1979-02-02T00:00:00Z",
    }
    real = conftest.SEARCH_DOCS["shows"][0]
    monkeypatch.setitem(conftest.SEARCH_DOCS, "shows", [junk, flac_only, real])
    home = client.get("/ui/api/home").json()
    assert home["featured"]["id"] == "band1977-05-08.aud"
    assert [s["id"] for s in home["week"]] == ["some-audiobook", "band1979-02-02.flac"]
