"""Tests for the remote-lyrics endpoints (/lyrics/search, /lyrics/auto,
/lyrics/by-remote-id) and the shared search-result ranking."""

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
