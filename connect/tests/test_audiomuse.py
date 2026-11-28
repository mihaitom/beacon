"""Tests for core/audiomuse.py and routes/audiomuse.py: configuration, the
"use what you used before" failures, finding which AudioMuse server holds
the session's ids, and turning AudioMuse's results into songs.

AudioMuse's answers below are trimmed copies of a real v3.7.4 instance's,
ids made up."""

import types
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from core import api_keys, audiomuse

SERVER = {
    "server_id": "srv-nav",
    "name": "Navidrome",
    "server_type": "navidrome",
    "is_default": True,
    "creds": {"url": "http://music.local:4533", "user": "someone"},
}
OTHER_SERVER = {
    "server_id": "srv-other",
    "name": "Other Navidrome",
    "server_type": "navidrome",
    "is_default": False,
    "creds": {"url": "http://elsewhere.local:4533"},
}
JELLYFIN_SERVER = {
    "server_id": "srv-jf",
    "name": "Jellyfin",
    "server_type": "jellyfin",
    "is_default": False,
    "creds": {"url": "http://music.local:8096"},
}

LIBRARY = {
    "seed": "Seed Song",
    "a": "Song A",
    "b": "Song B",
    "c": "Song C",
    "d": "Song D",
    "probe": "Probe Song",
}


def _media(url="http://music.local:4533"):
    # Neither a JellyfinClient nor a PlexClient, so server_type_name() reads
    # it as a Subsonic server.
    return types.SimpleNamespace(base_url=url, internal_url=url)


class FakeAudioMuse:
    """Answers like AudioMuse; records what was asked."""

    def __init__(self):
        self.version = "v3.7.4"
        self.servers = [SERVER]
        self.status_for: dict[str, int] = {}
        self.results: list[str] = ["a", "b", "c"]
        # Which song each server's search returns for the probe, by server id.
        self.probe_rows = {
            "srv-nav": [{"item_id": "probe", "title": "Probe Song"}],
            "srv-other": [{"item_id": "probe", "title": "Something Else"}],
            "srv-jf": [{"item_id": "probe", "title": "Probe Song"}],
        }
        self.moods = {
            "happy": [
                {"index": 0, "n_songs": 80, "top_tags": ["pop", "dance", "rock"]},
                {"index": 1, "n_songs": 40, "top_tags": ["Hip-Hop", "rnb", "pop"]},
            ],
            "sad": [{"index": 0, "n_songs": 70, "top_tags": ["indie", "rock", "folk"]}],
        }
        self.axes = {
            "AXIS_1_SETTING": {"labels": {"TRANSIT": "x", "URBAN": "x", "WILDERNESS": "x"}},
            "AXIS_2_SOCIAL_DYNAMIC": {"labels": {"ROMANTIC": "x"}},
            # No RADIANT: "in love" cannot be asked for here.
            "AXIS_3_EMOTIONAL_VALENCE": {"labels": {"MELANCHOLIC": "x"}},
        }
        self.artist_rows = [
            {"artist": "Artist X", "artist_id": "x", "divergence": 0.04},
            {"artist": "Featured Guest", "artist_id": None, "divergence": 0.05},
            {"artist": "Artist Y", "artist_id": "y", "divergence": 0.06},
        ]
        self.calls: list[tuple[str, str, dict]] = []
        self.raise_error: Exception | None = None
        self.timeouts: dict[str, object] = {}

    async def request(self, method, url, headers=None, params=None, json=None, timeout=None):
        path = url.split("://", 1)[1].split("/", 1)[1]
        path = "/" + path
        self.calls.append((method, path, params or json or {}))
        self.timeouts[path] = timeout
        if self.raise_error:
            raise self.raise_error
        if path in self.status_for:
            return httpx.Response(self.status_for[path], json={"error": "x"}, request=_req(url))
        if path == "/api/version":
            body = {"app_version": self.version}
        elif path == "/api/servers":
            body = {"servers": self.servers, "default_id": "srv-nav"}
        elif path == "/api/search_tracks":
            body = self.probe_rows.get(params["server"], [])
        elif path == "/api/find_path":
            body = {
                "path": [{"item_id": i, "title": i} for i in self.results],
                "total_distance": 1.0,
            }
        elif path == "/api/mood_centroids":
            body = self.moods
        elif path == "/api/lyrics/axes":
            body = {"axes": self.axes}
        elif path == "/api/similar_artists":
            body = self.artist_rows
        elif path == "/api/similar_tracks":
            body = [{"item_id": i, "title": i, "distance": 0.1} for i in self.results]
        else:  # hyperbolic and alchemy wrap their rows
            body = {"results": [{"item_id": i, "title": i} for i in self.results]}
        return httpx.Response(200, json=body, request=_req(url))

    def paths(self):
        return [path for _, path, _ in self.calls]

    def last(self, path):
        return [body for _, p, body in self.calls if p == path][-1]


def _req(url):
    return httpx.Request("GET", url)


ARTISTS = {"seed-artist": "Seed Artist", "x": "Artist X", "y": "Artist Y"}


async def _library_song(media, endpoint, **params):
    if endpoint == "getArtist.view":
        artist_id = params["id"]
        if artist_id not in ARTISTS:
            raise RuntimeError("Artist not found")
        return {
            "artist": {
                "id": artist_id,
                "name": ARTISTS[artist_id],
                "albumCount": 2,
                "album": [{"id": "al1"}, {"id": "al2"}],
            }
        }
    song_id = params["id"]
    if song_id not in LIBRARY:
        raise RuntimeError("Song not found")
    return {"song": {"id": song_id, "title": LIBRARY[song_id], "artist": "Artist " + song_id}}


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(api_keys, "_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(audiomuse, "_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("AUDIOMUSE_URL", raising=False)
    monkeypatch.delenv("AUDIOMUSE_API_KEY", raising=False)
    api_keys._cache.clear()
    audiomuse.forget_cached_state()
    yield
    api_keys._cache.clear()
    audiomuse.forget_cached_state()


@pytest.fixture
def fake(monkeypatch):
    server = FakeAudioMuse()
    monkeypatch.setattr(audiomuse._client, "request", server.request)
    monkeypatch.setattr(audiomuse, "subsonic_call", AsyncMock(side_effect=_library_song))
    return server


@pytest.fixture
def configured():
    audiomuse.set_url("http://audiomuse.local:8000")
    api_keys.set(audiomuse.SERVICE, "token")


# ── configuration ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("typed", "stored"),
    [
        ("audiomuse.local:8000", "http://audiomuse.local:8000"),
        ("https://am.example.org/", "https://am.example.org"),
        ("  http://10.0.0.5:8000//  ", "http://10.0.0.5:8000"),
        ("", ""),
    ],
)
def test_the_address_is_stored_normalised(typed, stored):
    audiomuse.set_url(typed)
    assert audiomuse.base_url() == stored


def test_an_address_that_is_not_http_is_refused():
    with pytest.raises(ValueError):
        audiomuse.set_url("ftp://audiomuse.local")


def test_it_needs_both_the_address_and_the_key():
    audiomuse.set_url("http://audiomuse.local:8000")
    assert audiomuse.is_configured() is False
    api_keys.set(audiomuse.SERVICE, "token")
    assert audiomuse.is_configured() is True
    audiomuse.set_url("")
    assert audiomuse.is_configured() is False


def test_the_environment_and_a_paired_server_fill_in_for_settings(monkeypatch):
    audiomuse.set_shared_url("http://lent.local:8000")
    assert audiomuse.base_url() == "http://lent.local:8000"
    assert audiomuse.settings_status()["urlFromServer"] is True
    monkeypatch.setenv("AUDIOMUSE_URL", "http://env.local:8000")
    assert audiomuse.base_url() == "http://env.local:8000"
    assert audiomuse.settings_status()["urlFromEnvironment"] is True
    audiomuse.set_url("http://settings.local:8000")
    assert audiomuse.base_url() == "http://settings.local:8000"


async def test_without_configuration_nothing_is_asked(fake):
    assert await audiomuse.session_status(_media()) == {
        "available": False,
        "reason": "not-configured",
    }
    assert fake.calls == []


# ── status ───────────────────────────────────────────────────────────────────


async def test_the_key_is_sent_as_a_bearer_token(fake, configured, monkeypatch):
    seen = {}
    original = fake.request

    async def spy(method, url, headers=None, **kwargs):
        seen.update(headers or {})
        return await original(method, url, headers=headers, **kwargs)

    monkeypatch.setattr(audiomuse._client, "request", spy)
    await audiomuse.check()
    assert seen["Authorization"] == "Bearer token"


@pytest.mark.parametrize("version", ["v3.6.9", "3.6.1", "nonsense", None])
async def test_older_than_3_7_counts_as_unavailable(fake, configured, version):
    fake.version = version
    status = await audiomuse.session_status(_media())
    assert status == {"available": False, "reason": "too-old"}


@pytest.mark.parametrize("version", ["v3.7.0", "3.7.5", "v4.0"])
async def test_3_7_and_newer_is_accepted(fake, configured, version):
    fake.version = version
    assert (await audiomuse.session_status(_media()))["available"] is True


async def test_a_rejected_key_is_reported_as_such(fake, configured):
    fake.status_for["/api/version"] = 401
    assert (await audiomuse.session_status(_media()))["reason"] == "unauthorized"


async def test_an_unreachable_address_is_reported_as_such(fake, configured):
    fake.raise_error = httpx.ConnectTimeout("timed out")
    assert (await audiomuse.session_status(_media()))["reason"] == "unreachable"


async def test_a_failure_is_remembered_briefly_rather_than_asked_again(fake, configured):
    fake.raise_error = httpx.ConnectTimeout("timed out")
    await audiomuse.session_status(_media())
    await audiomuse.session_status(_media())
    assert len(fake.calls) == 1


async def test_a_new_key_forgets_what_the_old_one_was_told(fake, configured):
    fake.status_for["/api/version"] = 401
    await audiomuse.session_status(_media())
    del fake.status_for["/api/version"]
    api_keys.set(audiomuse.SERVICE, "better-token")
    audiomuse.forget_cached_state()
    assert (await audiomuse.session_status(_media()))["available"] is True


# ── which server ─────────────────────────────────────────────────────────────


async def test_the_server_whose_song_is_the_same_under_the_same_id_is_chosen(fake, configured):
    fake.servers = [OTHER_SERVER, SERVER]
    server = await audiomuse.server_for(_media())
    assert server["id"] == "srv-nav"


async def test_a_server_at_the_same_address_is_tried_first(fake, configured):
    fake.servers = [{**OTHER_SERVER, "is_default": True}, {**SERVER, "is_default": False}]
    await audiomuse.server_for(_media())
    probed = [body["server"] for _, path, body in fake.calls if path == "/api/search_tracks"]
    assert probed == ["srv-nav"]


async def test_a_reverse_proxied_name_still_finds_its_server(fake, configured):
    """The address Beacon logs in with need not be the one AudioMuse uses;
    the song lookup decides, not the URL."""
    server = await audiomuse.server_for(_media("https://music.example.org"))
    assert server["id"] == "srv-nav"


async def test_a_server_of_another_type_is_never_used(fake, configured):
    fake.servers = [JELLYFIN_SERVER]
    with pytest.raises(audiomuse.AudioMuseError) as e:
        await audiomuse.server_for(_media())
    assert e.value.reason == "no-server"
    assert "/api/search_tracks" not in fake.paths()


async def test_a_server_whose_ids_mean_other_songs_is_not_used(fake, configured):
    fake.servers = [OTHER_SERVER]
    assert (await audiomuse.session_status(_media()))["reason"] == "no-server"


async def test_the_mapping_is_remembered(fake, configured):
    await audiomuse.server_for(_media())
    await audiomuse.server_for(_media())
    assert fake.paths().count("/api/search_tracks") == 1


# ── mixes ────────────────────────────────────────────────────────────────────

SEED = [{"id": "seed", "type": "song"}]


async def test_similar_asks_for_neighbours_on_the_sessions_server(fake, configured):
    songs = await audiomuse.mix(_media(), "similar", SEED, [], 2, [])
    asked = fake.last("/api/similar_tracks")
    assert asked["item_id"] == "seed"
    assert asked["server"] == "srv-nav"
    assert [s["id"] for s in songs] == ["a", "b"]


async def test_discovery_asks_for_the_niche_of_the_seed(fake, configured):
    await audiomuse.mix(_media(), "discovery", SEED, [], 3, [])
    asked = fake.last("/api/hyperbolic/similar")
    assert asked["mode"] == "niche"
    assert asked["item_id"] == "seed"
    assert asked["server"] == "srv-nav"


async def test_a_blend_adds_and_subtracts(fake, configured):
    await audiomuse.mix(
        _media(),
        "blend",
        [{"id": "seed", "type": "song"}, {"id": "artist-1", "type": "artist"}],
        [{"id": "d", "type": "song"}],
        3,
        [],
    )
    asked = fake.last("/api/alchemy")
    assert asked["items"] == [
        {"id": "seed", "op": "ADD", "type": "song"},
        {"id": "artist-1", "op": "ADD", "type": "artist"},
        {"id": "d", "op": "SUBTRACT", "type": "song"},
    ]
    assert asked["server"] == "srv-nav"


async def test_results_come_back_as_full_songs(fake, configured):
    songs = await audiomuse.mix(_media(), "blend", SEED, [], 1, [])
    assert songs == [{"id": "a", "title": "Song A", "artist": "Artist a"}]


async def test_excluded_songs_and_the_seeds_never_come_back(fake, configured):
    fake.results = ["seed", "a", "b", "c", "d"]
    songs = await audiomuse.mix(_media(), "blend", SEED, [{"id": "d", "type": "song"}], 10, ["a"])
    assert [s["id"] for s in songs] == ["b", "c"]


async def test_the_exclusions_are_made_up_for_in_what_is_asked(fake, configured):
    """Otherwise a long queue leaves nothing new among the results."""
    await audiomuse.mix(_media(), "similar", SEED, [], 10, ["x1", "x2", "x3"])
    # Ten wanted, three queued and the seed itself excluded.
    assert fake.last("/api/similar_tracks")["n"] == 14


async def test_a_song_the_media_server_does_not_know_is_left_out(fake, configured):
    fake.results = ["a", "gone", "b"]
    songs = await audiomuse.mix(_media(), "blend", SEED, [], 10, [])
    assert [s["id"] for s in songs] == ["a", "b"]


async def test_the_same_recording_twice_comes_back_once(fake, configured, monkeypatch):
    async def duplicates(media, endpoint, **params):
        title = "Same Song" if params["id"] in ("a", "b") else params["id"]
        return {"song": {"id": params["id"], "title": title, "artist": "Same Artist"}}

    await audiomuse.server_for(_media())
    monkeypatch.setattr(audiomuse, "subsonic_call", AsyncMock(side_effect=duplicates))
    songs = await audiomuse.mix(_media(), "blend", SEED, [], 10, [])
    assert [s["id"] for s in songs] == ["a", "c"]


async def test_only_as_many_songs_as_wanted_are_looked_up(fake, configured):
    fake.results = [f"s{i}" for i in range(60)]
    lookups = AsyncMock(side_effect=lambda media, endpoint, **p: {"song": {"id": p["id"]}})
    await audiomuse.server_for(_media())
    with patch.object(audiomuse, "subsonic_call", lookups):
        songs = await audiomuse.mix(_media(), "blend", SEED, [], 4, [])
    assert len(songs) == 4
    assert lookups.await_count < 10


async def test_a_seed_audiomuse_has_not_analysed_is_an_error_to_fall_back_on(fake, configured):
    await audiomuse.server_for(_media())
    fake.status_for["/api/similar_tracks"] = 404
    with pytest.raises(audiomuse.AudioMuseError):
        await audiomuse.mix(_media(), "similar", SEED, [], 10, [])


# ── path ─────────────────────────────────────────────────────────────────────


async def test_a_path_leads_from_the_playing_song_to_the_chosen_one(fake, configured):
    fake.results = ["seed", "a", "b", "d"]
    songs = await audiomuse.path(_media(), "seed", "d")
    asked = fake.last("/api/find_path")
    assert (asked["start_song_id"], asked["end_song_id"]) == ("seed", "d")
    assert asked["server"] == "srv-nav"
    assert asked["max_steps"] == audiomuse.PATH_STEPS
    assert "path_fix_size" not in asked
    assert [s["id"] for s in songs] == ["a", "b", "d"]


async def test_a_path_of_a_chosen_length_asks_for_exactly_that_many(fake, configured):
    """A playlist's length is the whole path, and without path_fix_size
    AudioMuse quietly drops the steps it finds nothing for."""
    fake.results = ["seed", "a", "b", "c", "d"]
    songs = await audiomuse.path(_media(), "seed", "d", length=5)
    asked = fake.last("/api/find_path")
    assert asked["max_steps"] == 5
    assert asked["path_fix_size"] == "true"
    assert [s["id"] for s in songs] == ["a", "b", "c", "d"]


async def test_a_path_always_ends_on_the_chosen_song(fake, configured):
    """Even where AudioMuse's path ends elsewhere or the lookup lost it."""
    fake.results = ["seed", "a", "b"]
    songs = await audiomuse.path(_media(), "seed", "d")
    assert [s["id"] for s in songs] == ["a", "b", "d"]


async def test_a_path_to_a_song_the_server_does_not_have_is_an_error(fake, configured):
    fake.results = ["seed", "a"]
    with pytest.raises(audiomuse.AudioMuseError):
        await audiomuse.path(_media(), "seed", "gone")


# ── search ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("kind", "endpoint"),
    [("sound", "/api/clap/search"), ("lyrics", "/api/lyrics/search/text")],
)
async def test_a_search_asks_the_right_index(fake, configured, kind, endpoint):
    songs = await audiomuse.search(_media(), kind, "calm piano", 2)
    assert fake.last(endpoint) == {"query": "calm piano", "limit": 2, "server": "srv-nav"}
    assert [s["id"] for s in songs] == ["a", "b"]


async def test_a_search_may_take_longer_than_a_lookup(fake, configured):
    """The text searches run a model over the query; the short timeout made
    for Autoplay would cut them off."""
    await audiomuse.search(_media(), "sound", "calm piano", 2)
    timeout = fake.timeouts["/api/clap/search"]
    assert timeout is not None and timeout.read > audiomuse._TIMEOUT.read


async def test_a_new_address_is_checked_afresh(fake, configured):
    await audiomuse.check()
    audiomuse.set_url("http://elsewhere.local:8000")
    await audiomuse.check()
    assert fake.paths().count("/api/version") == 2


async def test_a_new_lent_address_is_checked_afresh(fake, configured):
    await audiomuse.check()
    audiomuse.set_shared_url("http://lent.local:8000")
    await audiomuse.check()
    assert fake.paths().count("/api/version") == 2


# ── moods and similar artists ───────────────────────────────────────────────


async def test_the_moods_are_the_ones_audiomuse_knows(fake, configured):
    assert await audiomuse.moods() == ["happy", "sad"]


async def test_the_moods_are_asked_for_once(fake, configured):
    await audiomuse.moods()
    await audiomuse.mood_mix(_media(), "sad", 3, [])
    assert fake.paths().count("/api/mood_centroids") == 1


async def test_a_mood_mix_starts_from_one_of_the_moods_clusters(fake, configured):
    songs = await audiomuse.mood_mix(_media(), "sad", 3, [])
    asked = fake.last("/api/similar_tracks")
    assert (asked["mood"], asked["centroid_index"], asked["server"]) == ("sad", 0, "srv-nav")
    assert [s["id"] for s in songs] == ["a", "b", "c"]


async def test_a_mood_sounds_different_each_time(fake, configured, monkeypatch):
    picks = iter([[fake.moods["happy"][1]], [fake.moods["happy"][0]]])
    monkeypatch.setattr(audiomuse.random, "choices", lambda options, weights: next(picks))
    await audiomuse.mood_mix(_media(), "happy", 3, [])
    await audiomuse.mood_mix(_media(), "happy", 3, [])
    asked = [body["centroid_index"] for _, p, body in fake.calls if p == "/api/similar_tracks"]
    assert asked == [1, 0]


async def test_bigger_clusters_are_picked_more_often(fake, configured, monkeypatch):
    seen = {}

    def choices(options, weights):
        seen["weights"] = weights
        return [options[0]]

    monkeypatch.setattr(audiomuse.random, "choices", choices)
    await audiomuse.mood_mix(_media(), "happy", 3, [])
    assert seen["weights"] == [80, 40]


async def test_a_mood_mix_leaves_out_what_is_queued(fake, configured):
    songs = await audiomuse.mood_mix(_media(), "sad", 3, ["b"])
    assert [s["id"] for s in songs] == ["a", "c"]
    assert fake.last("/api/similar_tracks")["n"] == 4


async def test_an_unknown_mood_is_an_error(fake, configured):
    with pytest.raises(audiomuse.AudioMuseError):
        await audiomuse.mood_mix(_media(), "grumpy", 3, [])


async def test_similar_artists_are_library_artists_closest_first(fake, configured):
    artists = await audiomuse.similar_artists(_media(), "seed-artist", 5)
    asked = fake.last("/api/similar_artists")
    assert (asked["artist_id"], asked["server"]) == ("seed-artist", "srv-nav")
    # The guest without an id has no page here.
    assert [a["id"] for a in artists] == ["x", "y"]


async def test_similar_artists_come_without_their_discography(fake, configured):
    artists = await audiomuse.similar_artists(_media(), "seed-artist", 5)
    assert artists[0] == {"id": "x", "name": "Artist X", "albumCount": 2}


async def test_similar_artists_never_include_the_artist_itself(fake, configured):
    fake.artist_rows.insert(0, {"artist": "Seed Artist", "artist_id": "seed-artist"})
    artists = await audiomuse.similar_artists(_media(), "seed-artist", 5)
    assert "seed-artist" not in [a["id"] for a in artists]


async def test_an_artist_the_media_server_does_not_know_is_left_out(fake, configured):
    fake.artist_rows.insert(0, {"artist": "Gone", "artist_id": "gone"})
    artists = await audiomuse.similar_artists(_media(), "seed-artist", 5)
    assert [a["id"] for a in artists] == ["x", "y"]


async def test_only_as_many_artists_as_wanted(fake, configured):
    fake.artist_rows += [{"artist": "Artist Z", "artist_id": "z"}]
    ARTISTS["z"] = "Artist Z"
    try:
        artists = await audiomuse.similar_artists(_media(), "seed-artist", 2)
    finally:
        del ARTISTS["z"]
    assert [a["id"] for a in artists] == ["x", "y"]


# ── themes ───────────────────────────────────────────────────────────────────


async def test_only_themes_whose_labels_audiomuse_knows_are_offered(fake, configured):
    assert await audiomuse.themes() == ["onTheRoad", "city", "nature", "heartbreak"]


async def test_without_lyrics_analysis_there_are_no_themes(fake, configured):
    fake.status_for["/api/lyrics/axes"] = 400
    with pytest.raises(audiomuse.AudioMuseError):
        await audiomuse.themes()


async def test_a_theme_asks_for_its_labels_on_the_sessions_server(fake, configured):
    await audiomuse.theme_mix(_media(), "heartbreak", 3, [])
    asked = fake.last("/api/lyrics/search/axes")
    assert asked["targets"] == {
        "AXIS_2_SOCIAL_DYNAMIC": "ROMANTIC",
        "AXIS_3_EMOTIONAL_VALENCE": "MELANCHOLIC",
    }
    assert asked["server"] == "srv-nav"


async def test_a_theme_draws_from_a_bigger_pool_in_a_new_order(fake, configured, monkeypatch):
    monkeypatch.setattr(audiomuse.random, "shuffle", lambda ids: ids.reverse())
    songs = await audiomuse.theme_mix(_media(), "city", 2, [])
    assert fake.last("/api/lyrics/search/axes")["limit"] > 2
    assert [s["id"] for s in songs] == ["c", "b"]


async def test_a_long_theme_mix_still_draws_from_three_times_its_length(fake, configured):
    """A playlist of 200 drawn from a pool of 150 would be no draw at all."""
    await audiomuse.theme_mix(_media(), "city", audiomuse.MAX_SONGS, [])
    assert fake.last("/api/lyrics/search/axes")["limit"] == 3 * audiomuse.MAX_SONGS


def test_the_song_routes_take_up_to_the_builders_maximum(client, fake, configured):
    longest = audiomuse.MAX_SONGS
    requests = [
        ("/audiomuse/mix", {"method": "similar", "add": [{"id": "seed"}]}),
        ("/audiomuse/search", {"kind": "sound", "query": "calm piano"}),
        ("/audiomuse/mood", {"mood": "happy"}),
        ("/audiomuse/theme", {"theme": "city"}),
    ]
    for route, body in requests:
        assert client.post(route, json={**body, "n": longest}).status_code == 200, route
        assert client.post(route, json={**body, "n": longest + 1}).status_code == 422, route


async def test_a_theme_mix_leaves_out_what_is_queued(fake, configured):
    songs = await audiomuse.theme_mix(_media(), "city", 3, ["b"])
    assert "b" not in [s["id"] for s in songs]


async def test_an_unknown_theme_is_an_error(fake, configured):
    with pytest.raises(audiomuse.AudioMuseError):
        await audiomuse.theme_mix(_media(), "space", 3, [])


# ── routes ───────────────────────────────────────────────────────────────────


@pytest.fixture
def client(monkeypatch):
    from core.auth import require_token
    from core.session import require_authenticated_session
    from main import app

    session = types.SimpleNamespace(media=_media())
    app.dependency_overrides[require_token] = lambda: None
    app.dependency_overrides[require_authenticated_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_settings_store_the_address_and_never_return_the_key(client):
    body = client.put(
        "/audiomuse/settings", json={"url": "audiomuse.local:8000", "key": "secret"}
    ).json()
    assert body["url"] == "http://audiomuse.local:8000"
    assert body["key"]["configured"] is True
    assert "secret" not in str(client.get("/audiomuse/settings").json())


def test_settings_leave_out_what_is_not_sent(client):
    client.put("/audiomuse/settings", json={"url": "audiomuse.local:8000", "key": "secret"})
    client.put("/audiomuse/settings", json={"url": "audiomuse.local:9000"})
    assert api_keys.get(audiomuse.SERVICE) == "secret"


def test_settings_refuse_an_address_that_is_not_http(client):
    assert client.put("/audiomuse/settings", json={"url": "ftp://x"}).status_code == 400


def test_a_mix_answers_songs(client, fake, configured):
    response = client.post("/audiomuse/mix", json={"method": "similar", "add": [{"id": "seed"}]})
    assert response.status_code == 200
    assert [s["id"] for s in response.json()["songs"]] == ["a", "b", "c"]


def test_every_reason_to_fall_back_is_a_503(client, fake):
    response = client.post("/audiomuse/mix", json={"method": "similar", "add": [{"id": "seed"}]})
    assert response.status_code == 503
    assert response.json() == {"detail": "not-configured"}


def test_a_mix_needs_a_seed(client, fake, configured):
    assert client.post("/audiomuse/mix", json={"method": "blend", "add": []}).status_code == 422


def test_a_search_answers_songs(client, fake, configured):
    response = client.post("/audiomuse/search", json={"kind": "lyrics", "query": " home "})
    assert response.status_code == 200
    assert fake.last("/api/lyrics/search/text")["query"] == "home"


def test_an_empty_search_is_refused(client, fake, configured):
    assert (
        client.post("/audiomuse/search", json={"kind": "sound", "query": "  "}).status_code == 422
    )


def test_a_path_answers_songs_or_a_503(client, fake, configured):
    fake.results = ["seed", "a", "d"]
    response = client.post("/audiomuse/path", json={"start": "seed", "end": "d"})
    assert [s["id"] for s in response.json()["songs"]] == ["a", "d"]
    assert fake.last("/api/find_path")["max_steps"] == audiomuse.PATH_STEPS
    client.post("/audiomuse/path", json={"start": "seed", "end": "d", "length": 40})
    assert fake.last("/api/find_path")["max_steps"] == 40
    too_long = {"start": "seed", "end": "d", "length": audiomuse.PATH_MAX_LENGTH + 1}
    assert client.post("/audiomuse/path", json=too_long).status_code == 422
    fake.raise_error = httpx.ConnectTimeout("timed out")
    audiomuse.forget_cached_state()
    assert client.post("/audiomuse/path", json={"start": "seed", "end": "d"}).status_code == 503


def test_the_moods_route_answers_names_or_a_503(client, fake, configured):
    assert client.get("/audiomuse/moods").json() == {"moods": ["happy", "sad"]}
    fake.status_for["/api/mood_centroids"] = 500
    audiomuse.forget_cached_state()
    assert client.get("/audiomuse/moods").status_code == 503


def test_a_mood_mix_answers_songs(client, fake, configured):
    response = client.post("/audiomuse/mood", json={"mood": "sad", "n": 2})
    assert [s["id"] for s in response.json()["songs"]] == ["a", "b"]
    assert client.post("/audiomuse/mood", json={"mood": "grumpy"}).status_code == 503


def test_similar_artists_answer_artists(client, fake, configured):
    response = client.get("/audiomuse/similar-artists", params={"id": "seed-artist"})
    assert [a["id"] for a in response.json()["artists"]] == ["x", "y"]
    assert client.get("/audiomuse/similar-artists", params={"id": ""}).status_code == 422


def test_the_theme_routes_answer_or_refuse(client, fake, configured):
    assert client.get("/audiomuse/themes").json()["themes"][0] == "onTheRoad"
    response = client.post("/audiomuse/theme", json={"theme": "city", "n": 2})
    assert len(response.json()["songs"]) == 2
    assert client.post("/audiomuse/theme", json={"theme": "space"}).status_code == 422
