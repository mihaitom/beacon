"""Tests for core/lastfm.py and routes/lastfm.py — the six track queries,
Last.fm's HTTP-200-with-an-error-body convention, and the route's mapping
of those onto status codes."""

import logging
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from core import api_keys, lastfm


def _response(payload: dict) -> httpx.Response:
    return httpx.Response(200, json=payload, request=httpx.Request("GET", lastfm._BASE_URL))


@pytest.fixture(autouse=True)
def _configured_key(tmp_path, monkeypatch):
    """A key, an isolated store for it, and a clean cache. Every test here
    assumes an installation that has one; the ones about a missing key use
    `no_key` below."""
    monkeypatch.setattr(api_keys, "_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LASTFM_API_KEY", "test-key")
    api_keys._cache.clear()
    yield
    api_keys._cache.clear()


@pytest.fixture
def no_key(monkeypatch):
    monkeypatch.delenv("LASTFM_API_KEY", raising=False)
    api_keys._cache.clear()
    yield
    api_keys._cache.clear()


def _patch_get(payload: dict):
    return patch.object(lastfm._client, "get", AsyncMock(return_value=_response(payload)))


# ── is_configured ────────────────────────────────────────────────────────────


def test_is_configured_follows_the_api_key(no_key):
    assert lastfm.is_configured() is False
    lastfm.set_api_key("from-settings")
    assert lastfm.is_configured() is True


# ── _to_tracks / _track_list ─────────────────────────────────────────────────


def test_single_result_comes_back_as_a_list():
    """Last.fm's JSON is generated from its XML form, so one result is a
    bare object rather than a one-element list. Iterating that directly
    would walk its keys instead of its tracks."""
    single = {"track": {"name": "Alone", "artist": {"name": "Heart"}}}
    assert lastfm._track_list(single) == [{"name": "Alone", "artist": {"name": "Heart"}}]


def test_missing_or_malformed_containers_yield_no_tracks():
    assert lastfm._track_list(None) == []
    assert lastfm._track_list({}) == []
    assert lastfm._track_list({"track": "nonsense"}) == []


def test_to_tracks_accepts_an_artist_given_as_a_bare_string():
    raw = [{"name": "Roads", "artist": "Portishead"}]
    assert lastfm._to_tracks(raw) == [{"title": "Roads", "artist": "Portishead", "mbid": ""}]


def test_to_tracks_drops_entries_without_a_title_or_artist():
    """A track with no artist name cannot be matched against a library, so
    it is dropped here rather than sent on to be searched for as ''."""
    raw = [
        {"name": "Teardrop", "artist": {"name": "Massive Attack"}},
        {"name": "", "artist": {"name": "Massive Attack"}},
        {"name": "Angel", "artist": {"name": "  "}},
        {"name": "Risingson"},
        "not a dict",
    ]
    assert lastfm._to_tracks(raw) == [{"title": "Teardrop", "artist": "Massive Attack", "mbid": ""}]


def test_to_tracks_keeps_the_mbid_when_there_is_one():
    raw = [{"name": "Karma Police", "artist": {"name": "Radiohead"}, "mbid": "abc-123"}]
    assert lastfm._to_tracks(raw)[0]["mbid"] == "abc-123"


# ── the six queries ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_geo_top_tracks_reads_the_tracks_container():
    payload = {"tracks": {"track": [{"name": "99 Luftballons", "artist": {"name": "Nena"}}]}}
    with _patch_get(payload) as get:
        result = await lastfm.get_geo_top_tracks("germany", 10)

    assert result == [{"title": "99 Luftballons", "artist": "Nena", "mbid": ""}]
    assert get.await_args.kwargs["params"]["method"] == "geo.getTopTracks"
    assert get.await_args.kwargs["params"]["country"] == "germany"


@pytest.mark.asyncio
async def test_artist_and_user_queries_read_the_toptracks_container():
    """artist.getTopTracks and user.getTopTracks nest under `toptracks`,
    while the chart/geo/tag ones use `tracks` — reading the wrong key
    silently returns nothing at all."""
    payload = {"toptracks": {"track": [{"name": "Zombie", "artist": {"name": "The Cranberries"}}]}}
    with _patch_get(payload):
        by_artist = await lastfm.get_artist_top_tracks("The Cranberries", 10)
        by_user = await lastfm.get_user_top_tracks("someone", "1month", 10)

    assert by_artist == [{"title": "Zombie", "artist": "The Cranberries", "mbid": ""}]
    assert by_user == by_artist


@pytest.mark.asyncio
async def test_similar_tracks_read_the_similartracks_container_and_autocorrect():
    """track.getSimilar nests under `similartracks`, and the seed is a
    file's own spelling rather than Last.fm's canonical one — autocorrect
    is what bridges the two."""
    payload = {
        "similartracks": {"track": [{"name": "Teardrop", "artist": {"name": "Massive Attack"}}]}
    }
    with _patch_get(payload) as get:
        result = await lastfm.get_similar_tracks("Portishead", "Roads", 10)

    assert result == [{"title": "Teardrop", "artist": "Massive Attack", "mbid": ""}]
    params = get.await_args.kwargs["params"]
    assert params["method"] == "track.getSimilar"
    assert params["artist"] == "Portishead"
    assert params["track"] == "Roads"
    assert params["autocorrect"] == 1


@pytest.mark.asyncio
async def test_a_seed_without_similar_data_falls_back_to_its_most_listened_match():
    """A track can be known to Last.fm and still have no similar-tracks data
    (too few scrobbles on that exact spelling). The widely-scrobbled version
    of the same song usually does, so it is tried before giving up."""
    empty = {"similartracks": {"track": []}}
    search = {
        "results": {
            "trackmatches": {
                "track": [
                    {"name": "Bamba", "artist": "Luciano", "listeners": "2169"},
                    {
                        "name": "Bamba (feat. Aitch & BIA)",
                        "artist": "Luciano",
                        "listeners": "90672",
                    },
                ]
            }
        }
    }
    found = {"similartracks": {"track": [{"name": "Butcher", "artist": {"name": "Sosa La M"}}]}}
    responses = [_response(empty), _response(search), _response(found)]
    with patch.object(lastfm._client, "get", AsyncMock(side_effect=responses)) as get:
        result = await lastfm.get_similar_tracks("Luciano", "Bamba", 10)

    assert result == [{"title": "Butcher", "artist": "Sosa La M", "mbid": ""}]
    methods = [call.kwargs["params"]["method"] for call in get.await_args_list]
    assert methods == ["track.getSimilar", "track.search", "track.getSimilar"]
    assert get.await_args_list[2].kwargs["params"]["track"] == "Bamba (feat. Aitch & BIA)"


@pytest.mark.asyncio
async def test_the_fallback_version_is_not_listed_as_similar_to_itself():
    empty = {"similartracks": {"track": []}}
    search = {
        "results": {
            "trackmatches": {
                "track": [
                    {"name": "Bamba (feat. Aitch & BIA)", "artist": "Luciano", "listeners": "90672"}
                ]
            }
        }
    }
    found = {
        "similartracks": {
            "track": [
                {"name": "Bamba (feat. Aitch & BIA)", "artist": {"name": "Luciano"}},
                {"name": "Butcher", "artist": {"name": "Sosa La M"}},
            ]
        }
    }
    responses = [_response(empty), _response(search), _response(found)]
    with patch.object(lastfm._client, "get", AsyncMock(side_effect=responses)):
        result = await lastfm.get_similar_tracks("Luciano", "Bamba", 10)

    assert [entry["title"] for entry in result] == ["Butcher"]


@pytest.mark.asyncio
async def test_the_seed_itself_is_not_used_as_its_own_fallback():
    """The seed is the one version known to have no similar data, so finding
    it in the search results is not a reason to ask again."""
    empty = {"similartracks": {"track": []}}
    search = {
        "results": {
            "trackmatches": {"track": [{"name": "Bamba", "artist": "Luciano", "listeners": "2169"}]}
        }
    }
    responses = [_response(empty), _response(search)]
    with patch.object(lastfm._client, "get", AsyncMock(side_effect=responses)) as get:
        result = await lastfm.get_similar_tracks("Luciano", "Bamba", 10)

    assert result == []
    assert len(get.await_args_list) == 2


@pytest.mark.asyncio
async def test_no_fallback_match_still_answers_empty():
    empty = {"similartracks": {"track": []}}
    search = {"results": {"trackmatches": {"track": []}}}
    responses = [_response(empty), _response(search)]
    with patch.object(lastfm._client, "get", AsyncMock(side_effect=responses)) as get:
        result = await lastfm.get_similar_tracks("Nobody", "Nothing", 10)

    assert result == []
    methods = [call.kwargs["params"]["method"] for call in get.await_args_list]
    assert methods == ["track.getSimilar", "track.search"]


@pytest.mark.asyncio
async def test_user_top_tracks_passes_the_username_and_period():
    with _patch_get({"toptracks": {"track": []}}) as get:
        await lastfm.get_user_top_tracks("listener", "12month", 25)

    params = get.await_args.kwargs["params"]
    assert params["method"] == "user.getTopTracks"
    assert params["user"] == "listener"
    assert params["period"] == "12month"


@pytest.mark.asyncio
async def test_limit_is_clamped_to_what_the_api_accepts():
    with _patch_get({"tracks": {"track": []}}) as get:
        await lastfm.get_global_top_tracks(99999)
        assert get.await_args.kwargs["params"]["limit"] == lastfm._MAX_LIMIT

        await lastfm.get_global_top_tracks(0)
        assert get.await_args.kwargs["params"]["limit"] == 1


# ── error handling ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_an_error_body_on_a_200_becomes_an_exception(caplog):
    """Last.fm reports application errors with HTTP 200 and an `error`
    number in the body, so raise_for_status() never sees them."""
    payload = {"error": 6, "message": "User not found"}
    with _patch_get(payload), caplog.at_level(logging.WARNING, logger="connect.lastfm"):
        with pytest.raises(lastfm.LastfmError) as excinfo:
            await lastfm.get_user_top_tracks("nobody", "1month", 10)

    assert excinfo.value.not_found is True
    assert "User not found" in str(excinfo.value)


@pytest.mark.asyncio
async def test_an_upstream_failure_is_not_reported_as_not_found():
    payload = {"error": 8, "message": "Operation failed"}
    with _patch_get(payload):
        with pytest.raises(lastfm.LastfmError) as excinfo:
            await lastfm.get_global_top_tracks(10)

    assert excinfo.value.not_found is False


@pytest.mark.asyncio
async def test_a_suspended_key_names_the_installation_not_the_user():
    payload = {"error": lastfm._ERR_SUSPENDED_KEY, "message": "Suspended API key"}
    with _patch_get(payload):
        with pytest.raises(lastfm.LastfmError) as excinfo:
            await lastfm.get_global_top_tracks(10)

    assert "API key" in str(excinfo.value)
    assert excinfo.value.not_found is False


@pytest.mark.asyncio
async def test_a_transport_error_becomes_a_lastfm_error():
    failing = AsyncMock(side_effect=httpx.ConnectError("no route to host"))
    with patch.object(lastfm._client, "get", failing):
        with pytest.raises(lastfm.LastfmError):
            await lastfm.get_global_top_tracks(10)


# ── routes/lastfm.py ─────────────────────────────────────────────────────────


def test_tracks_without_a_key_is_a_503(client, no_key):
    resp = client.get("/lastfm/songs", params={"op": "charts"})
    assert resp.status_code == 503


def test_charts_without_a_country_asks_for_the_global_chart(client):
    """The frontend sends one op for both; an empty country is what
    distinguishes the global chart from a country's."""
    with _patch_get({"tracks": {"track": []}}) as get:
        client.get("/lastfm/songs", params={"op": "charts"})
    assert get.await_args.kwargs["params"]["method"] == "chart.getTopTracks"

    with _patch_get({"tracks": {"track": []}}) as get:
        client.get("/lastfm/songs", params={"op": "charts", "country": "spain"})
    assert get.await_args.kwargs["params"]["method"] == "geo.getTopTracks"


@pytest.mark.parametrize(
    "params",
    [
        {"op": "genre"},
        {"op": "artist"},
        {"op": "similar"},
        {"op": "similar", "artist": "Portishead"},
        {"op": "mytop"},
    ],
)
def test_ops_that_need_an_argument_reject_an_empty_one(client, params):
    assert client.get("/lastfm/songs", params=params).status_code == 422


def test_similar_asks_for_the_seed_track(client):
    payload = {
        "similartracks": {"track": [{"name": "Teardrop", "artist": {"name": "Massive Attack"}}]}
    }
    with _patch_get(payload) as get:
        resp = client.get(
            "/lastfm/songs",
            params={"op": "similar", "artist": "Portishead", "track": "Roads"},
        )

    assert resp.status_code == 200
    assert resp.json() == {
        "tracks": [{"title": "Teardrop", "artist": "Massive Attack", "mbid": ""}]
    }
    assert get.await_args.kwargs["params"]["method"] == "track.getSimilar"
    assert get.await_args.kwargs["params"]["track"] == "Roads"


def test_an_unknown_period_is_rejected_before_reaching_lastfm(client):
    resp = client.get(
        "/lastfm/songs", params={"op": "mytop", "username": "a", "period": "last-tuesday"}
    )
    assert resp.status_code == 422


def test_an_unknown_user_becomes_a_404(client):
    with _patch_get({"error": 6, "message": "User not found"}):
        resp = client.get("/lastfm/songs", params={"op": "mytop", "username": "nobody"})
    assert resp.status_code == 404


def test_an_upstream_failure_becomes_a_502(client):
    with _patch_get({"error": 8, "message": "Operation failed"}):
        resp = client.get("/lastfm/songs", params={"op": "charts"})
    assert resp.status_code == 502


def test_a_successful_query_returns_the_track_list(client):
    payload = {"tracks": {"track": [{"name": "Believe", "artist": {"name": "Cher"}}]}}
    with _patch_get(payload):
        resp = client.get("/lastfm/songs", params={"op": "genre", "tag": "pop"})

    assert resp.status_code == 200
    assert resp.json() == {"tracks": [{"title": "Believe", "artist": "Cher", "mbid": ""}]}
