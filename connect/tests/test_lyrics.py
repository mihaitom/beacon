"""Tests for the remote-lyrics endpoints (/lyrics/search, /lyrics/auto,
/lyrics/by-remote-id) and the shared search-result ranking."""

import logging
from unittest.mock import AsyncMock, patch

from lyrics import LyricSource, order_search_results
from routes.lyrics import GET_FETCHERS, SEARCH_FETCHERS, _parse_sources

# ── order_search_results ───────────────────────────────────────────────────


def test_order_search_results_prefers_exact_match():
    results = [
        {
            "artist": "Some Artist",
            "id": "1",
            "isSync": False,
            "name": "Totally Different",
        },
        {"artist": "The Artist", "id": "2", "isSync": False, "name": "Exact Song"},
    ]
    ranked = order_search_results(
        {"artist": "The Artist", "name": "Exact Song"}, results
    )
    assert ranked[0]["id"] == "2"
    assert ranked[0]["score"] < ranked[1]["score"]


def test_order_search_results_prefers_synced_on_tie():
    results = [
        {"artist": "A", "id": "unsynced", "isSync": False, "name": "Song"},
        {"artist": "A", "id": "synced", "isSync": True, "name": "Song"},
    ]
    ranked = order_search_results({"artist": "A", "name": "Song"}, results)
    assert ranked[0]["id"] == "synced"


def test_order_search_results_ranks_by_name_only_when_no_artist_given():
    results = [
        {"artist": "Anyone", "id": "1", "isSync": False, "name": "Totally Different"},
        {"artist": "Someone Else", "id": "2", "isSync": False, "name": "Exact Song"},
    ]
    ranked = order_search_results({"name": "Exact Song"}, results)
    assert ranked[0]["id"] == "2"


def test_order_search_results_treats_a_missing_result_field_as_maximally_different():
    results = [
        {"id": "1", "isSync": False},  # no name/artist fields at all
        {"artist": "The Artist", "id": "2", "isSync": False, "name": "Exact Song"},
    ]
    ranked = order_search_results({"artist": "The Artist", "name": "Exact Song"}, results)
    assert ranked[0]["id"] == "2"
    assert ranked[-1]["id"] == "1"


# ── _parse_sources ────────────────────────────────────────────────────────


def test_parse_sources_defaults_to_all():
    assert _parse_sources(None) == list(LyricSource)
    assert _parse_sources("") == list(LyricSource)


def test_parse_sources_filters_unknown():
    assert _parse_sources("lrclib.net,unknown,SimpMusic") == [
        LyricSource.LRCLIB,
        LyricSource.SIMPMUSIC,
    ]


def test_parse_sources_falls_back_to_all_when_nothing_recognized():
    assert _parse_sources("unknown") == list(LyricSource)


# ── /lyrics/search ────────────────────────────────────────────────────────


def test_search_groups_results_by_source(client):
    lrclib_results = AsyncMock(
        return_value=[{"id": "1", "name": "Song", "source": "lrclib.net"}]
    )
    simpmusic_results = AsyncMock(return_value=None)

    with patch.dict(
        SEARCH_FETCHERS,
        {LyricSource.LRCLIB: lrclib_results, LyricSource.SIMPMUSIC: simpmusic_results},
    ):
        r = client.get("/lyrics/search", params={"name": "Song", "artist": "Artist"})

    assert r.status_code == 200
    data = r.json()
    assert data["lrclib.net"] == [{"id": "1", "name": "Song", "source": "lrclib.net"}]
    assert data["SimpMusic"] == []


def test_search_respects_sources_param(client):
    lrclib_results = AsyncMock(return_value=[])
    simpmusic_results = AsyncMock(return_value=[])

    with patch.dict(
        SEARCH_FETCHERS,
        {LyricSource.LRCLIB: lrclib_results, LyricSource.SIMPMUSIC: simpmusic_results},
    ):
        r = client.get(
            "/lyrics/search", params={"name": "Song", "sources": "lrclib.net"}
        )

    assert r.status_code == 200
    assert "lrclib.net" in r.json()
    assert "SimpMusic" not in r.json()
    lrclib_results.assert_awaited_once()
    simpmusic_results.assert_not_awaited()


def test_search_treats_a_fetcher_exception_as_no_results(client, caplog):
    failing = AsyncMock(side_effect=RuntimeError("provider down"))
    with (
        patch.dict(SEARCH_FETCHERS, {LyricSource.LRCLIB: failing}),
        caplog.at_level(logging.WARNING, logger="connect.lyrics"),
    ):
        r = client.get("/lyrics/search", params={"name": "Song", "sources": "lrclib.net"})

    assert r.status_code == 200
    assert r.json() == {"lrclib.net": []}
    assert "provider down" in caplog.text


# ── /lyrics/auto ──────────────────────────────────────────────────────────


def test_auto_returns_best_match_lyrics(client):
    search_result = [
        {
            "artist": "Artist",
            "id": "42",
            "isSync": True,
            "name": "Song",
            "source": "lrclib.net",
        }
    ]
    search_fn = AsyncMock(return_value=search_result)
    get_fn = AsyncMock(return_value="[00:01.00]La la la")

    with (
        patch.dict(SEARCH_FETCHERS, {LyricSource.LRCLIB: search_fn}),
        patch.dict(GET_FETCHERS, {LyricSource.LRCLIB: get_fn}),
    ):
        r = client.get(
            "/lyrics/auto",
            params={"name": "Song", "artist": "Artist", "sources": "lrclib.net"},
        )

    assert r.status_code == 200
    body = r.json()
    assert body["lyrics"] == "[00:01.00]La la la"
    assert body["source"] == "lrclib.net"
    get_fn.assert_awaited_once_with("42")


def test_auto_returns_none_when_no_results(client):
    with patch.dict(
        SEARCH_FETCHERS, {LyricSource.LRCLIB: AsyncMock(return_value=None)}, clear=False
    ):
        r = client.get("/lyrics/auto", params={"name": "Song", "sources": "lrclib.net"})

    assert r.status_code == 200
    assert r.json() is None


def test_auto_returns_none_when_match_below_threshold(client):
    search_result = [
        {
            "artist": "Completely Unrelated",
            "id": "1",
            "isSync": False,
            "name": "Nothing Alike",
            "source": "lrclib.net",
        }
    ]
    with patch.dict(
        SEARCH_FETCHERS, {LyricSource.LRCLIB: AsyncMock(return_value=search_result)}
    ):
        r = client.get(
            "/lyrics/auto",
            params={"name": "Song", "artist": "Artist", "sources": "lrclib.net"},
        )

    assert r.status_code == 200
    assert r.json() is None


def test_auto_skips_a_source_whose_search_fails(client):
    """One provider erroring must not abort the whole /auto lookup — the
    others still get a chance."""
    failing = AsyncMock(side_effect=RuntimeError("provider down"))
    good_result = [
        {"artist": "Artist", "id": "42", "isSync": True, "name": "Song", "source": "SimpMusic"}
    ]
    with (
        patch.dict(
            SEARCH_FETCHERS,
            {
                LyricSource.LRCLIB: failing,
                LyricSource.SIMPMUSIC: AsyncMock(return_value=good_result),
            },
        ),
        patch.dict(
            GET_FETCHERS,
            {LyricSource.SIMPMUSIC: AsyncMock(return_value="[00:01.00]La la la")},
        ),
    ):
        r = client.get(
            "/lyrics/auto",
            params={"name": "Song", "artist": "Artist", "sources": "lrclib.net,SimpMusic"},
        )

    assert r.json()["lyrics"] == "[00:01.00]La la la"


def test_auto_returns_none_when_the_winning_matchs_fetch_fails(client, caplog):
    search_result = [
        {"artist": "Artist", "id": "42", "isSync": True, "name": "Song", "source": "lrclib.net"}
    ]
    with (
        patch.dict(SEARCH_FETCHERS, {LyricSource.LRCLIB: AsyncMock(return_value=search_result)}),
        patch.dict(
            GET_FETCHERS, {LyricSource.LRCLIB: AsyncMock(side_effect=RuntimeError("timeout"))}
        ),
        caplog.at_level(logging.WARNING, logger="connect.lyrics"),
    ):
        r = client.get(
            "/lyrics/auto",
            params={"name": "Song", "artist": "Artist", "sources": "lrclib.net"},
        )

    assert r.json() is None
    assert "timeout" in caplog.text


def test_auto_returns_none_when_the_matched_source_has_no_lyrics_body(client):
    """A real match, but the actual lyrics-by-id fetch comes back empty —
    distinct from the fetch raising (covered above)."""
    search_result = [
        {"artist": "Artist", "id": "42", "isSync": True, "name": "Song", "source": "lrclib.net"}
    ]
    with (
        patch.dict(SEARCH_FETCHERS, {LyricSource.LRCLIB: AsyncMock(return_value=search_result)}),
        patch.dict(GET_FETCHERS, {LyricSource.LRCLIB: AsyncMock(return_value=None)}),
    ):
        r = client.get(
            "/lyrics/auto",
            params={"name": "Song", "artist": "Artist", "sources": "lrclib.net"},
        )

    assert r.json() is None


# ── /lyrics/by-remote-id ──────────────────────────────────────────────────


def test_by_remote_id_returns_lyrics(client):
    get_fn = AsyncMock(return_value="[00:01.00]La la la")
    with patch.dict(GET_FETCHERS, {LyricSource.LRCLIB: get_fn}):
        r = client.get(
            "/lyrics/by-remote-id", params={"source": "lrclib.net", "id": "42"}
        )

    assert r.status_code == 200
    assert r.json() == "[00:01.00]La la la"
    get_fn.assert_awaited_once_with("42")


def test_by_remote_id_returns_none_for_unknown_source(client):
    r = client.get("/lyrics/by-remote-id", params={"source": "Genius", "id": "42"})
    assert r.status_code == 200
    assert r.json() is None


def test_by_remote_id_returns_none_when_the_fetch_fails(client, caplog):
    with (
        patch.dict(
            GET_FETCHERS, {LyricSource.LRCLIB: AsyncMock(side_effect=RuntimeError("boom"))}
        ),
        caplog.at_level(logging.WARNING, logger="connect.lyrics"),
    ):
        r = client.get("/lyrics/by-remote-id", params={"source": "lrclib.net", "id": "42"})

    assert r.json() is None
    assert "boom" in caplog.text
