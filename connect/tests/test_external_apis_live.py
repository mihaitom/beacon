"""Live smoke tests for every third-party service Beacon talks to, apart
from the lyrics providers (test_lyrics_live.py) and the media servers
(test_bridges_live.py).

Each test goes through the real function in core/ rather than a bare HTTP
check, so a service that still answers but has changed the shape the code
reads fails here too - most of these functions swallow an upstream failure
into None or an empty list, which is what the assertions catch.

Excluded from the default run and from CI like every `live` test. Run all
of them, lyrics and media servers included, with:

    uv run pytest -m live

or only these:

    uv run pytest -m live tests/test_external_apis_live.py

Last.fm is skipped unless a key is set (Settings, or LASTFM_API_KEY in
connect/.env). Nothing is written to connect's real caches: they are
pointed at a temporary directory for the run.
"""

import asyncio

import httpx
import pytest

from core import deezer, fanart, lastfm, listenbrainz, party_probe, radio_browser, recommendations
from media import plex

pytestmark = pytest.mark.live

# Well known, and on every one of these services.
ARTIST = "Daft Punk"
ALBUM = "Discovery"
TRACK = "One More Time"
GITHUB_REPO = "mihaitom/beacon"


@pytest.fixture(autouse=True)
async def _isolated(monkeypatch, tmp_path):
    """A fresh HTTP client per module for this test's event loop (the shared
    ones are bound to the loop of their first request, and every test gets a
    new loop), and the on-disk and in-memory caches emptied, so every call
    really reaches the service."""
    clients = []
    for module in (deezer, fanart, lastfm, listenbrainz, radio_browser, recommendations):
        old = module._client
        fresh = httpx.AsyncClient(timeout=old.timeout, headers=old.headers)
        clients.append(fresh)
        monkeypatch.setattr(module, "_client", fresh)

    monkeypatch.setattr(recommendations, "_PATH", str(tmp_path / "recommendations.json"))
    monkeypatch.setattr(recommendations, "_mb_lock", asyncio.Lock())
    monkeypatch.setattr(listenbrainz, "_throttle_lock", asyncio.Lock())
    monkeypatch.setattr(fanart, "_CACHE_PATH", str(tmp_path / "fanart.json"))
    monkeypatch.setattr(fanart, "_IMAGE_DIR", str(tmp_path / "fanart_images"))
    monkeypatch.setattr(fanart, "_cache", {})

    async def no_prefetch(*_args):
        return None

    # The background image download would outlive the test's event loop.
    monkeypatch.setattr(fanart, "_prefetch_images", no_prefetch)
    monkeypatch.setattr(radio_browser, "_cached_servers", [])
    monkeypatch.setattr(radio_browser, "_cached_countries", None)

    yield

    for client in clients:
        await client.aclose()


# --- Deezer ------------------------------------------------------------------


async def test_deezer_charts_and_genres():
    genres = await deezer.get_genres()
    assert any(g["id"] == 0 for g in genres), "the overall chart (id 0) is missing"

    chart = await deezer.get_chart(0, 5)
    assert chart and all(t["title"] and t["artist"] and t["deezerId"] for t in chart)


async def test_deezer_artist_top_and_radio():
    top = await deezer.get_artist_top(ARTIST, 5)
    assert top and all(t["artist"] for t in top)

    radio = await deezer.get_artist_radio(ARTIST, 5)
    assert radio


async def test_deezer_playlists():
    playlists = await deezer.search_playlists("")
    assert playlists and playlists[0]["id"]

    tracks = await deezer.get_playlist_tracks(playlists[0]["id"])
    assert tracks


async def test_deezer_preview_and_album():
    preview = await deezer.get_preview(ARTIST, TRACK)
    assert preview and preview["id"]
    audio = await deezer.preview_stream_url(f"{deezer.PREVIEW_ID_PREFIX}{preview['id']}")
    assert audio and audio.startswith("https://")

    album = await deezer.get_album(ARTIST, ALBUM)
    assert album and len(album["tracks"]) >= 10


async def test_deezer_artist_images():
    images = await recommendations.get_artist_images([ARTIST])
    assert images[ARTIST] and images[ARTIST]["image"]


# --- Radio Browser -----------------------------------------------------------


async def test_radio_browser_search():
    stations = await radio_browser.search_stations("Radio Paradise", limit=5)
    assert stations, "None means no mirror was reachable, [] that the search found nothing"
    assert all(s["stationuuid"] and s["url"] for s in stations)

    by_uuid = await radio_browser.stations_by_uuid([stations[0]["stationuuid"]])
    assert by_uuid and by_uuid[0]["stationuuid"] == stations[0]["stationuuid"]


async def test_radio_browser_countries():
    countries = await radio_browser.list_countries()
    assert countries and any(c["code"] == "DE" for c in countries)


# --- MusicBrainz, ListenBrainz Labs, Wikidata, Wikipedia ---------------------


async def test_musicbrainz_and_links():
    links = await recommendations.get_artist_links([ARTIST])
    assert links[ARTIST].get("musicbrainz"), "MusicBrainz did not resolve the artist"
    assert len(links[ARTIST]) > 1, "MusicBrainz returned no streaming/Discogs links"


async def test_listenbrainz_similar_artists():
    similar = await recommendations.get_similar_artists([ARTIST], limit=10)
    assert similar and all(a["name"] for a in similar)


async def test_wikipedia_artist_bio():
    bio = await recommendations.get_artist_bio(ARTIST, "de")
    assert bio and bio["text"] and bio["url"]
    assert bio["lang"] == "de"


async def test_wikipedia_album_bio():
    bio = await recommendations.get_album_bio(None, ARTIST, ALBUM, "en", "album")
    assert bio and bio["text"]


# --- ListenBrainz API, Cover Art Archive -------------------------------------


async def test_listenbrainz_sitewide_chart():
    tracks = await listenbrainz.get_sitewide_top_recordings("week", 10)
    assert tracks


async def test_listenbrainz_tag_radio_and_cover_art():
    tracks = await listenbrainz.get_tag_recordings("rock", 10)
    assert tracks, "LB Radio or the metadata lookup returned nothing"

    cover = next((t["coverArtUrl"] for t in tracks if t["coverArtUrl"]), None)
    assert cover, "no recording came with a Cover Art Archive image"
    async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
        response = await client.get(cover)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/")


async def test_listenbrainz_artist_top():
    tracks = await listenbrainz.get_artist_top_recordings(ARTIST, 5)
    assert tracks


# --- fanart.tv ---------------------------------------------------------------


async def test_fanart_artist_art():
    art = await fanart.get_artist_art(ARTIST)
    assert art and (art["background"] or art["banner"])


# --- Last.fm -----------------------------------------------------------------


@pytest.fixture
def _lastfm_key():
    if not lastfm.is_configured():
        pytest.skip("no Last.fm key (Settings or LASTFM_API_KEY)")


@pytest.mark.usefixtures("_lastfm_key")
async def test_lastfm_artist_top_and_similar():
    top = await lastfm.get_artist_top_tracks(ARTIST, 5)
    assert top

    similar = await lastfm.get_similar_tracks(ARTIST, TRACK, 5)
    assert similar


@pytest.mark.usefixtures("_lastfm_key")
async def test_lastfm_global_chart():
    assert await lastfm.get_global_top_tracks(5)


# --- plex.tv -----------------------------------------------------------------


def test_plex_pin_login(monkeypatch):
    """The first two steps of the Plex login. The PIN created here is never
    approved and simply expires on plex.tv."""
    monkeypatch.setattr(plex, "client_identifier", lambda: "beacon-live-test")
    pin = plex.create_pin()
    assert pin["id"] and pin["code"]
    assert plex.check_pin(pin["id"]) is None


# --- Cloudflare DNS (party reachability check) -------------------------------


async def test_public_dns_lookup():
    async with httpx.AsyncClient(timeout=10) as client:
        found = await party_probe.public_lookup(client, "github.com")
        missing = await party_probe.public_lookup(client, "no-such-name.invalid")
    assert found, "None means the resolver could not be asked"
    assert missing == []


# --- GitHub (update check, auto-update, "What's new") ------------------------


async def test_github_latest_release():
    """What the web build's update check reads, and where the desktop app's
    auto-updater finds its latest*.yml."""
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest")
    if response.status_code == 403 and response.headers.get("x-ratelimit-remaining") == "0":
        pytest.skip("GitHub API rate limit for this address is used up")
    assert response.status_code == 200
    release = response.json()
    assert release["tag_name"]
    assets = [a["name"] for a in release.get("assets") or []]
    assert any(name.startswith("latest") and name.endswith(".yml") for name in assets), assets


async def test_github_upcoming_changelog():
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(
            f"https://raw.githubusercontent.com/{GITHUB_REPO}/development/CHANGELOG.md"
        )
    assert response.status_code == 200
    assert "## [" in response.text
