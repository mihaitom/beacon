"""Tests for core/listenbrainz.py and routes/listenbrainz.py — the stats,
LB Radio (genre and artist) and collaborative-filtering queries, the batched
metadata resolve, and the route's mapping of failures onto status codes."""

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from core import listenbrainz


@pytest.fixture(autouse=True)
def _disable_throttle():
    # Two calls in the recommendation path would otherwise sleep a real
    # 1.1s. Nothing here tests the limit itself.
    with patch.object(listenbrainz, "_MIN_INTERVAL", 0.0):
        yield


def _response(status: int, payload: object = None) -> httpx.Response:
    if payload is None:
        return httpx.Response(status, request=httpx.Request("GET", listenbrainz._BASE_URL))
    return httpx.Response(
        status, json=payload, request=httpx.Request("GET", listenbrainz._BASE_URL)
    )


def _patch_request(status: int, payload: object = None):
    return patch.object(
        listenbrainz._client, "request", AsyncMock(return_value=_response(status, payload))
    )


# ── parsing ──────────────────────────────────────────────────────────────────


def test_recordings_from_stats_reads_the_payload_array():
    data = {
        "payload": {
            "recordings": [
                {
                    "track_name": "Strangers",
                    "artist_name": "Portishead",
                    "recording_mbid": "abc",
                    "release_name": "Dummy",
                }
            ]
        }
    }
    assert listenbrainz._recordings_from_stats(data) == [
        {
            "title": "Strangers",
            "artist": "Portishead",
            "mbid": "abc",
            "album": "Dummy",
            "coverArtUrl": "",
            "duration": 0,
        }
    ]


def test_recordings_from_stats_tolerates_a_missing_or_odd_shape():
    assert listenbrainz._recordings_from_stats(None) == []
    assert listenbrainz._recordings_from_stats({}) == []
    assert listenbrainz._recordings_from_stats({"payload": {}}) == []
    assert listenbrainz._recordings_from_stats({"payload": {"recordings": "nonsense"}}) == []


def test_recordings_from_stats_drops_entries_without_a_title_or_artist():
    data = {
        "payload": {
            "recordings": [
                {"track_name": "Teardrop", "artist_name": "Massive Attack"},
                {"track_name": "", "artist_name": "Massive Attack"},
                {"track_name": "Angel", "artist_name": "  "},
                {"track_name": "Risingson"},
                "not a dict",
            ]
        }
    }
    titles = [track["title"] for track in listenbrainz._recordings_from_stats(data)]
    assert titles == ["Teardrop"]


def test_recordings_from_stats_drops_the_apis_own_duplicates():
    """Measured live: 16 of 50 sitewide entries were the same recording
    twice. Left in, the matcher looks each one up and the dialog shows the
    same song twice."""
    data = {
        "payload": {
            "recordings": [
                {"track_name": "SWIM", "artist_name": "BTS", "recording_mbid": "m1"},
                {"track_name": "SWIM", "artist_name": "BTS", "recording_mbid": "m1"},
            ]
        }
    }
    assert len(listenbrainz._recordings_from_stats(data)) == 1


def test_recordings_from_stats_dedupes_by_name_when_there_is_no_mbid():
    data = {
        "payload": {
            "recordings": [
                {"track_name": "SWIM", "artist_name": "BTS"},
                {"track_name": "swim", "artist_name": "bts"},
            ]
        }
    }
    assert len(listenbrainz._recordings_from_stats(data)) == 1


def test_recordings_from_stats_caps_how_many_one_artist_contributes():
    data = {
        "payload": {
            "recordings": [
                {"track_name": "One", "artist_name": "BTS", "recording_mbid": "1"},
                {"track_name": "Two", "artist_name": "BTS", "recording_mbid": "2"},
                {"track_name": "Three", "artist_name": "BTS", "recording_mbid": "3"},
                {"track_name": "Four", "artist_name": "Other", "recording_mbid": "4"},
            ]
        }
    }
    tracks = listenbrainz._recordings_from_stats(data, max_per_artist=2)
    assert [track["title"] for track in tracks] == ["One", "Two", "Four"]


def test_recordings_from_stats_has_no_cap_by_default():
    """A listener's own history is allowed to be one artist — see
    get_user_top_recordings()."""
    data = {
        "payload": {
            "recordings": [
                {"track_name": "One", "artist_name": "BTS", "recording_mbid": "1"},
                {"track_name": "Two", "artist_name": "BTS", "recording_mbid": "2"},
                {"track_name": "Three", "artist_name": "BTS", "recording_mbid": "3"},
            ]
        }
    }
    assert len(listenbrainz._recordings_from_stats(data)) == 3


def test_cover_art_url_is_empty_without_both_fields():
    assert listenbrainz._cover_art_url(None, "rel") == ""
    assert listenbrainz._cover_art_url(123, None) == ""
    assert listenbrainz._cover_art_url(0, "rel") == ""


def test_limit_is_clamped_to_what_the_api_accepts():
    assert listenbrainz._clamp(99999) == listenbrainz._MAX_LIMIT
    assert listenbrainz._clamp(0) == 1


# ── queries ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sitewide_query_fetches_a_larger_pool_than_the_limit():
    """The chart is capped per artist (_MAX_PER_ARTIST), so the pool has to
    be big enough that `limit` tracks survive the cap."""
    with _patch_request(200, {"payload": {"recordings": []}}) as request:
        await listenbrainz.get_sitewide_top_recordings("month", 25)

    args = request.await_args
    assert args.args[1].endswith("/1/stats/sitewide/recordings")
    assert args.kwargs["params"] == {"range": "month", "count": 250}


@pytest.mark.asyncio
async def test_user_query_names_the_user_in_the_path():
    with _patch_request(200, {"payload": {"recordings": []}}) as request:
        await listenbrainz.get_user_top_recordings("listener", "year", 10)

    assert request.await_args.args[1].endswith("/1/stats/user/listener/recordings")


@pytest.mark.asyncio
async def test_artist_query_resolves_the_name_to_an_mbid():
    with (
        patch.object(listenbrainz, "resolve_mbid", AsyncMock(return_value="artist-mbid")),
        _patch_request(200, {}) as request,
    ):
        await listenbrainz.get_artist_top_recordings("Portishead", 10)

    # The popularity endpoint is token-gated now, so LB Radio's public
    # artist endpoint is the one used.
    assert request.await_args.args[1].endswith("/1/lb-radio/artist/artist-mbid")


@pytest.mark.asyncio
async def test_artist_query_sorts_by_listen_count_and_caps_to_the_limit():
    payload = {
        "artist-mbid": [
            {"recording_mbid": "b", "total_listen_count": 5},
            {"recording_mbid": "a", "total_listen_count": 50},
            {"recording_mbid": "c", "total_listen_count": 1},
        ]
    }
    metadata = {
        "a": {"recording": {"name": "A"}, "artist": {"name": "Act"}},
        "b": {"recording": {"name": "B"}, "artist": {"name": "Act"}},
    }

    async def fake_request(method, path, **kwargs):
        return _response(200, payload if "lb-radio/artist" in path else metadata)

    with (
        patch.object(listenbrainz, "resolve_mbid", AsyncMock(return_value="artist-mbid")),
        patch.object(listenbrainz._client, "request", AsyncMock(side_effect=fake_request)),
    ):
        tracks = await listenbrainz.get_artist_top_recordings("Act", 2)

    # "a" (50 listens) first, then "b" (5); "c" falls past the limit.
    assert [track["title"] for track in tracks] == ["A", "B"]


@pytest.mark.asyncio
async def test_tag_recordings_resolve_the_lb_radio_mbids():
    tags = [{"recording_mbid": "a"}, {"recording_mbid": "a"}, {"recording_mbid": "b"}]
    metadata = {
        "a": {"recording": {"name": "Song A"}, "artist": {"name": "Artist A"}},
        "b": {"recording": {"name": "Song B"}, "artist": {"name": "Artist B"}},
    }

    async def fake_request(method, path, **kwargs):
        return _response(200, tags if "lb-radio/tags" in path else metadata)

    with patch.object(
        listenbrainz._client, "request", AsyncMock(side_effect=fake_request)
    ) as request:
        tracks = await listenbrainz.get_tag_recordings("rock", 10)

    assert [track["title"] for track in tracks] == ["Song A", "Song B"]
    # The required LB Radio params the endpoint 400s without.
    params = request.await_args_list[0].kwargs["params"]
    assert params["tag"] == "rock"
    assert params["count"] == 10
    assert params["mode"] == "easy"


@pytest.mark.asyncio
async def test_tag_is_lowercased_before_the_lookup():
    """MusicBrainz tags are lower-case and LB Radio matches literally:
    measured live, "Rock" returns nothing where "rock" returns a list. The
    builder's suggestions are capitalised."""
    with _patch_request(200, []) as request:
        await listenbrainz.get_tag_recordings("Rock", 10)

    assert request.await_args.kwargs["params"]["tag"] == "rock"


@pytest.mark.asyncio
async def test_an_unresolvable_artist_is_not_found():
    with patch.object(listenbrainz, "resolve_mbid", AsyncMock(return_value=None)):
        with pytest.raises(listenbrainz.ListenbrainzError) as excinfo:
            await listenbrainz.get_artist_top_recordings("nobody", 10)

    assert excinfo.value.not_found is True


@pytest.mark.asyncio
async def test_recommendation_mbids_are_extracted_in_order():
    payload = {
        "payload": {
            "mbids": [
                {"recording_mbid": "a", "score": 0.9},
                {"recording_mbid": "b", "score": 0.5},
                {"score": 0.4},
            ]
        }
    }
    with _patch_request(200, payload):
        assert await listenbrainz.get_recommendation_mbids("someone", 3) == ["a", "b"]


@pytest.mark.asyncio
async def test_recommendation_mbids_dedupe():
    payload = {
        "payload": {
            "mbids": [
                {"recording_mbid": "a"},
                {"recording_mbid": "a"},
                {"recording_mbid": "b"},
            ]
        }
    }
    with _patch_request(200, payload):
        assert await listenbrainz.get_recommendation_mbids("someone", 3) == ["a", "b"]


@pytest.mark.asyncio
async def test_resolve_recordings_batches_one_call_and_keeps_order():
    metadata = {
        "a": {
            "recording": {"name": "First", "length": 100000},
            "artist": {"name": "Artist A"},
            "release": {"name": "Album", "caa_id": 1, "caa_release_mbid": "rel"},
        },
        "b": {"recording": {"name": "Second"}, "artist": {"name": "Artist B"}},
    }
    with _patch_request(200, metadata) as request:
        tracks = await listenbrainz.resolve_recordings(["b", "a", "missing"])

    assert [t["title"] for t in tracks] == ["Second", "First"]
    assert request.await_count == 1
    body = request.await_args.kwargs["json"]
    assert body["recording_mbids"] == ["b", "a", "missing"]
    assert body["inc"] == "artist release"


@pytest.mark.asyncio
async def test_resolve_recordings_drops_entries_with_no_title():
    metadata = {"a": {"recording": {"name": ""}, "artist": {"name": "Artist"}}}
    with _patch_request(200, metadata):
        assert await listenbrainz.resolve_recordings(["a"]) == []


@pytest.mark.asyncio
async def test_recommendations_compose_the_feed_and_the_resolve():
    feed = {"payload": {"mbids": [{"recording_mbid": "a"}]}}
    metadata = {"a": {"recording": {"name": "Song"}, "artist": {"name": "Artist"}}}

    async def fake_request(method, path, **kwargs):
        return _response(200, feed if "cf/recommendation" in path else metadata)

    with patch.object(listenbrainz._client, "request", AsyncMock(side_effect=fake_request)):
        tracks = await listenbrainz.get_recommendations("someone", 5)

    assert tracks[0]["title"] == "Song"


@pytest.mark.asyncio
async def test_recommended_artists_rank_by_how_many_recordings_they_account_for():
    feed = {
        "payload": {
            "mbids": [
                {"recording_mbid": "a"},
                {"recording_mbid": "b"},
                {"recording_mbid": "c"},
            ]
        }
    }
    metadata = {
        "a": {
            "artist": {
                "name": "Portishead",
                "artists": [{"name": "Portishead", "artist_mbid": "p"}],
            }
        },
        "b": {
            "artist": {
                "name": "Portishead",
                "artists": [{"name": "Portishead", "artist_mbid": "p"}],
            }
        },
        "c": {
            "artist": {
                "name": "Massive Attack",
                "artists": [{"name": "Massive Attack", "artist_mbid": "m"}],
            }
        },
    }

    async def fake_request(method, path, **kwargs):
        return _response(200, feed if "cf/recommendation" in path else metadata)

    with patch.object(listenbrainz._client, "request", AsyncMock(side_effect=fake_request)):
        artists = await listenbrainz.get_recommended_artists("someone", 10)

    assert artists == [
        {"name": "Portishead", "mbid": "p", "score": 2},
        {"name": "Massive Attack", "mbid": "m", "score": 1},
    ]


@pytest.mark.asyncio
async def test_recommended_artists_dedupe_by_mbid_not_by_spelling():
    feed = {"payload": {"mbids": [{"recording_mbid": "a"}, {"recording_mbid": "b"}]}}
    metadata = {
        "a": {"artist": {"name": "A Band", "artists": [{"name": "A Band", "artist_mbid": "x"}]}},
        "b": {
            "artist": {
                "name": "A Band (2)",
                "artists": [{"name": "A Band (2)", "artist_mbid": "x"}],
            }
        },
    }

    async def fake_request(method, path, **kwargs):
        return _response(200, feed if "cf/recommendation" in path else metadata)

    with patch.object(listenbrainz._client, "request", AsyncMock(side_effect=fake_request)):
        artists = await listenbrainz.get_recommended_artists("someone", 10)

    assert artists == [{"name": "A Band", "mbid": "x", "score": 2}]


@pytest.mark.asyncio
async def test_recommended_artists_fall_back_to_the_name_without_an_mbid():
    feed = {"payload": {"mbids": [{"recording_mbid": "a"}, {"recording_mbid": "b"}]}}
    metadata = {
        "a": {"artist": {"name": "No MBID", "artists": []}},
        "b": {"artist": {"name": "No MBID", "artists": []}},
    }

    async def fake_request(method, path, **kwargs):
        return _response(200, feed if "cf/recommendation" in path else metadata)

    with patch.object(listenbrainz._client, "request", AsyncMock(side_effect=fake_request)):
        artists = await listenbrainz.get_recommended_artists("someone", 10)

    assert artists == [{"name": "No MBID", "mbid": "", "score": 2}]


@pytest.mark.asyncio
async def test_recommended_artists_split_a_collaboration_credit():
    """ListenBrainz credits "David Guetta & Bebe Rexha" as one string plus
    the artists on it. The individuals are what the shelf can actually use -
    each has a photo and matches a library artist by name - so they are
    counted separately, not as one unrecognisable string."""
    feed = {"payload": {"mbids": [{"recording_mbid": "a"}]}}
    metadata = {
        "a": {
            "artist": {
                "name": "David Guetta & Bebe Rexha",
                "artists": [
                    {"name": "David Guetta", "artist_mbid": "d"},
                    {"name": "Bebe Rexha", "artist_mbid": "b"},
                ],
            }
        }
    }

    async def fake_request(method, path, **kwargs):
        return _response(200, feed if "cf/recommendation" in path else metadata)

    with patch.object(listenbrainz._client, "request", AsyncMock(side_effect=fake_request)):
        artists = await listenbrainz.get_recommended_artists("someone", 10)

    assert artists == [
        {"name": "David Guetta", "mbid": "d", "score": 1},
        {"name": "Bebe Rexha", "mbid": "b", "score": 1},
    ]


# ── error handling ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_204_is_an_empty_answer_not_a_failure():
    with _patch_request(204):
        assert await listenbrainz.get_sitewide_top_recordings("month", 10) == []


@pytest.mark.asyncio
async def test_user_stats_not_computed_yet_is_named_clearly():
    """A 204 on the user stats means the account's statistics have not been
    computed yet (routine for a new account), which reads better than an
    empty result — the user stats path says so instead of returning []."""
    with _patch_request(204):
        with pytest.raises(listenbrainz.ListenbrainzError) as excinfo:
            await listenbrainz.get_user_top_recordings("newbie", "month", 10)

    assert "statistics" in str(excinfo.value)
    assert excinfo.value.not_found is False


@pytest.mark.asyncio
async def test_a_401_names_the_login_requirement():
    """ListenBrainz keeps moving endpoints behind a token; a 401 should read
    as that, not as an unreachable server."""
    with _patch_request(401):
        with pytest.raises(listenbrainz.ListenbrainzError) as excinfo:
            await listenbrainz.get_sitewide_top_recordings("month", 10)

    assert "login" in str(excinfo.value)
    assert excinfo.value.not_found is False


@pytest.mark.asyncio
async def test_a_404_is_reported_as_not_found():
    with _patch_request(404):
        with pytest.raises(listenbrainz.ListenbrainzError) as excinfo:
            await listenbrainz.get_user_top_recordings("nobody", "month", 10)

    assert excinfo.value.not_found is True


@pytest.mark.asyncio
async def test_a_server_error_is_not_reported_as_not_found():
    with _patch_request(500):
        with pytest.raises(listenbrainz.ListenbrainzError) as excinfo:
            await listenbrainz.get_sitewide_top_recordings("month", 10)

    assert excinfo.value.not_found is False


@pytest.mark.asyncio
async def test_a_transport_error_becomes_a_listenbrainz_error():
    failing = AsyncMock(side_effect=httpx.ConnectError("no route to host"))
    with patch.object(listenbrainz._client, "request", failing):
        with pytest.raises(listenbrainz.ListenbrainzError):
            await listenbrainz.get_sitewide_top_recordings("month", 10)


# ── routes/listenbrainz.py ───────────────────────────────────────────────────


def test_charts_reads_the_sitewide_stats(client):
    payload = {"payload": {"recordings": [{"track_name": "T", "artist_name": "A"}]}}
    with _patch_request(200, payload) as request:
        resp = client.get("/listenbrainz/songs", params={"op": "charts", "period": "year"})

    assert resp.status_code == 200
    assert resp.json()["tracks"][0]["title"] == "T"
    assert request.await_args.kwargs["params"] == {"range": "year", "count": 500}


@pytest.mark.parametrize("params", [{"op": "artist"}, {"op": "mytop"}, {"op": "recommended"}])
def test_ops_that_need_an_argument_reject_an_empty_one(client, params):
    assert client.get("/listenbrainz/songs", params=params).status_code == 422


def test_an_unknown_period_is_rejected_before_reaching_listenbrainz(client):
    resp = client.get("/listenbrainz/songs", params={"op": "charts", "period": "last-tuesday"})
    assert resp.status_code == 422


def test_an_unknown_user_becomes_a_404(client):
    with _patch_request(404):
        resp = client.get("/listenbrainz/songs", params={"op": "mytop", "username": "nobody"})
    assert resp.status_code == 404


def test_an_upstream_failure_becomes_a_502(client):
    with _patch_request(500):
        resp = client.get("/listenbrainz/songs", params={"op": "charts"})
    assert resp.status_code == 502


def test_genre_without_a_tag_is_a_422(client):
    assert client.get("/listenbrainz/songs", params={"op": "genre"}).status_code == 422


def test_genre_returns_the_resolved_tag_recordings(client):
    tags = [{"recording_mbid": "a"}]
    metadata = {"a": {"recording": {"name": "Song"}, "artist": {"name": "Artist"}}}

    async def fake_request(method, path, **kwargs):
        return _response(200, tags if "lb-radio/tags" in path else metadata)

    with patch.object(listenbrainz._client, "request", AsyncMock(side_effect=fake_request)):
        resp = client.get("/listenbrainz/songs", params={"op": "genre", "tag": "rock"})

    assert resp.status_code == 200
    assert resp.json()["tracks"][0]["title"] == "Song"


def test_recommended_returns_resolved_tracks(client):
    feed = {"payload": {"mbids": [{"recording_mbid": "a"}]}}
    metadata = {"a": {"recording": {"name": "Song"}, "artist": {"name": "Artist"}}}

    async def fake_request(method, path, **kwargs):
        return _response(200, feed if "cf/recommendation" in path else metadata)

    with patch.object(listenbrainz._client, "request", AsyncMock(side_effect=fake_request)):
        resp = client.get(
            "/listenbrainz/songs", params={"op": "recommended", "username": "someone"}
        )

    assert resp.status_code == 200
    assert resp.json()["tracks"][0] == {
        "title": "Song",
        "artist": "Artist",
        "mbid": "a",
        "album": "",
        "coverArtUrl": "",
        "duration": 0,
    }


def test_artists_route_returns_the_ranking(client):
    feed = {"payload": {"mbids": [{"recording_mbid": "a"}, {"recording_mbid": "b"}]}}
    metadata = {
        "a": {
            "artist": {
                "name": "Portishead",
                "artists": [{"name": "Portishead", "artist_mbid": "p"}],
            }
        },
        "b": {
            "artist": {
                "name": "Massive Attack",
                "artists": [{"name": "Massive Attack", "artist_mbid": "m"}],
            }
        },
    }

    async def fake_request(method, path, **kwargs):
        return _response(200, feed if "cf/recommendation" in path else metadata)

    with patch.object(listenbrainz._client, "request", AsyncMock(side_effect=fake_request)):
        resp = client.get("/listenbrainz/artists", params={"username": "someone"})

    assert resp.status_code == 200
    assert resp.json() == {
        "artists": [
            {"name": "Portishead", "mbid": "p", "score": 1},
            {"name": "Massive Attack", "mbid": "m", "score": 1},
        ]
    }


def test_artists_route_needs_a_username(client):
    assert client.get("/listenbrainz/artists").status_code == 422
