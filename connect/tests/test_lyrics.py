"""Tests for the remote-lyrics endpoints (/lyrics/search, /lyrics/auto,
/lyrics/by-remote-id) and the shared search-result ranking."""

import logging
from unittest.mock import AsyncMock, patch

from lyrics import LyricSource, artist_matches, has_sung_lines, order_search_results
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
    ranked = order_search_results({"artist": "The Artist", "name": "Exact Song"}, results)
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


def test_order_search_results_prefers_the_recording_of_the_right_length():
    """A radio edit and an album version share a title and artist exactly,
    so the only thing telling them apart is how long they run — and lyrics
    fetched for the wrong one drift further out of sync the longer the
    song plays."""
    results = [
        {"artist": "A", "id": "radio-edit", "isSync": True, "name": "Song", "duration": 180},
        {"artist": "A", "id": "album", "isSync": True, "name": "Song", "duration": 245},
    ]

    ranked = order_search_results({"artist": "A", "name": "Song", "duration": 244}, results)

    assert ranked[0]["id"] == "album"


def test_order_search_results_puts_length_before_synced_lyrics():
    # Timed lyrics for a different edit are worse than untimed ones for
    # this one.
    results = [
        {"artist": "A", "id": "wrong-length", "isSync": True, "name": "Song", "duration": 300},
        {"artist": "A", "id": "right-length", "isSync": False, "name": "Song", "duration": 200},
    ]

    ranked = order_search_results({"artist": "A", "name": "Song", "duration": 200}, results)

    assert ranked[0]["id"] == "right-length"


def test_order_search_results_tolerates_a_few_seconds_of_tag_imprecision():
    # Tagged durations are routinely a second or two out; that is not a
    # different recording.
    results = [
        {"artist": "A", "id": "close", "isSync": False, "name": "Song", "duration": 197},
        {"artist": "A", "id": "exact-name", "isSync": False, "name": "Song", "duration": 260},
    ]

    ranked = order_search_results({"artist": "A", "name": "Song", "duration": 200}, results)

    assert ranked[0]["id"] == "close"


def test_order_search_results_ranks_an_unknown_length_between_match_and_mismatch():
    """Some providers return no duration at all (NetEase's search). That is
    not evidence of a good match, but it isn't evidence of a bad one
    either."""
    results = [
        {"artist": "A", "id": "mismatch", "isSync": True, "name": "Song", "duration": 400},
        {"artist": "A", "id": "unknown", "isSync": False, "name": "Song"},
        {"artist": "A", "id": "match", "isSync": False, "name": "Song", "duration": 200},
    ]

    ranked = order_search_results({"artist": "A", "name": "Song", "duration": 200}, results)

    assert [r["id"] for r in ranked] == ["match", "unknown", "mismatch"]


def test_order_search_results_ignores_length_when_the_track_has_none():
    # Radio streams and anything else without a known duration must rank
    # exactly as they did before.
    results = [
        {"artist": "A", "id": "plain", "isSync": False, "name": "Song", "duration": 100},
        {"artist": "A", "id": "synced", "isSync": True, "name": "Song", "duration": 400},
    ]

    ranked = order_search_results({"artist": "A", "name": "Song"}, results)

    assert ranked[0]["id"] == "synced"


# ── artist_matches / has_sung_lines ───────────────────────────────────────


def test_artist_matches_accepts_the_same_act_billed_differently():
    # A featured artist, a dropped article, a spacing difference — all the
    # same act, and all of them fail a plain similarity check.
    assert artist_matches("Dua Lipa", "Dua Lipa, Gwen Stefani")
    assert artist_matches("The Weeknd", "Weeknd")
    assert artist_matches("Massappeals", "Mass Appeals")
    assert artist_matches("Simon & Garfunkel", "Simon and Garfunkel")


def test_artist_matches_rejects_somebody_else():
    """The case this exists for: "Drowning in Beauty" by Massappeals was
    matched to Amanda Palmer's "Drowning in the Sound" (2026-08-27),
    because the two names happen to share most of their letters and the
    general threshold is lenient enough for a title to differ."""
    assert not artist_matches("Massappeals", "Amanda Palmer")
    assert not artist_matches("Dua Lipa", "Olivia Newton-John")
    assert not artist_matches("Queen", "Adam Lambert")


def test_artist_matches_says_yes_when_there_is_nothing_to_compare():
    # A search by title alone must not be filtered out by a rule about
    # artists.
    assert artist_matches(None, "Anyone")
    assert artist_matches("Anyone", "")


def test_has_sung_lines_sees_actual_lyrics():
    assert has_sung_lines("[00:13.06] Common love isn't for us")
    assert has_sung_lines("Just some plain words")
    # Credits followed by the real thing is a normal sheet.
    assert has_sung_lines("[00:00.00] 作词 : X\n[00:13.06] Common love isn't for us")


def test_has_sung_lines_rejects_a_sheet_that_is_only_credits():
    """What NetEase returns for a song it has no words for (verified
    2026-08-27 on "Drowning in Beauty"): the songwriter and composer, and
    nothing else. Showing those two lines as the lyrics is worse than
    saying there are none."""
    assert not has_sung_lines("[00:00.00-1] 作词 : Darryl Reid\n[00:00.00-1] 作曲 : Darryl Reid")
    assert not has_sung_lines("[ar:Some Artist]\n[ti:Some Title]")
    assert not has_sung_lines("")


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
    lrclib_results = AsyncMock(return_value=[{"id": "1", "name": "Song", "source": "lrclib.net"}])
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
        r = client.get("/lyrics/search", params={"name": "Song", "sources": "lrclib.net"})

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
    with patch.dict(SEARCH_FETCHERS, {LyricSource.LRCLIB: AsyncMock(return_value=search_result)}):
        r = client.get(
            "/lyrics/auto",
            params={"name": "Song", "artist": "Artist", "sources": "lrclib.net"},
        )

    assert r.status_code == 200
    assert r.json() is None


def test_auto_takes_the_best_named_match_among_the_well_ranked(client):
    """Ranking leads with the recording's length, so the top entry can be
    one that matches this edit while being titled differently enough to
    fail the name threshold. The next one down may still be a good match —
    checking only the top entry used to discard the whole search."""
    search_result = [
        {
            "artist": "Artist",
            "id": "odd-title",
            "isSync": True,
            "name": "Song (Extended Mix Remastered 2011 Version)",
            "source": "lrclib.net",
            "duration": 200,
        },
        {
            "artist": "Artist",
            "id": "good",
            "isSync": True,
            "name": "Song",
            "source": "lrclib.net",
            "duration": 200,
        },
    ]
    get_fn = AsyncMock(return_value="[00:01.00]La la la")

    with (
        patch.dict(SEARCH_FETCHERS, {LyricSource.LRCLIB: AsyncMock(return_value=search_result)}),
        patch.dict(GET_FETCHERS, {LyricSource.LRCLIB: get_fn}),
    ):
        r = client.get(
            "/lyrics/auto",
            params={
                "name": "Song",
                "artist": "Artist",
                "duration": 200,
                "sources": "lrclib.net",
            },
        )

    assert r.status_code == 200
    assert r.json()["id"] == "good"
    get_fn.assert_awaited_once_with("good")


def test_auto_prefers_the_candidate_whose_length_fits(client):
    search_result = [
        {
            "artist": "Artist",
            "id": "radio-edit",
            "isSync": True,
            "name": "Song",
            "source": "lrclib.net",
            "duration": 180,
        },
        {
            "artist": "Artist",
            "id": "album",
            "isSync": True,
            "name": "Song",
            "source": "lrclib.net",
            "duration": 245,
        },
    ]
    get_fn = AsyncMock(return_value="[00:01.00]La la la")

    with (
        patch.dict(SEARCH_FETCHERS, {LyricSource.LRCLIB: AsyncMock(return_value=search_result)}),
        patch.dict(GET_FETCHERS, {LyricSource.LRCLIB: get_fn}),
    ):
        r = client.get(
            "/lyrics/auto",
            params={
                "name": "Song",
                "artist": "Artist",
                "duration": 244,
                "sources": "lrclib.net",
            },
        )

    assert r.json()["id"] == "album"


def test_auto_passes_over_a_result_that_is_only_credits(client):
    """A match can be the right song and still have no usable words —
    NetEase answers with just the songwriter for tracks it has no lyrics
    for. The next candidate gets a turn instead."""
    search_result = [
        {
            "artist": "Artist",
            "id": "credits-only",
            "isSync": True,
            "name": "Song",
            "source": "lrclib.net",
            "duration": 200,
        },
        {
            "artist": "Artist",
            "id": "real",
            "isSync": True,
            "name": "Song",
            "source": "lrclib.net",
            "duration": 200,
        },
    ]
    bodies = {
        "credits-only": "[00:00.00-1] 作词 : Someone\n[00:00.00-1] 作曲 : Someone",
        "real": "[00:12.00] Actual words",
    }
    get_fn = AsyncMock(side_effect=lambda song_id: bodies[song_id])

    with (
        patch.dict(SEARCH_FETCHERS, {LyricSource.LRCLIB: AsyncMock(return_value=search_result)}),
        patch.dict(GET_FETCHERS, {LyricSource.LRCLIB: get_fn}),
    ):
        r = client.get(
            "/lyrics/auto",
            params={"name": "Song", "artist": "Artist", "duration": 200, "sources": "lrclib.net"},
        )

    assert r.json()["id"] == "real"


def test_auto_returns_nothing_when_every_candidate_is_only_credits(client):
    search_result = [
        {
            "artist": "Artist",
            "id": "credits-only",
            "isSync": True,
            "name": "Song",
            "source": "lrclib.net",
        }
    ]
    with (
        patch.dict(SEARCH_FETCHERS, {LyricSource.LRCLIB: AsyncMock(return_value=search_result)}),
        patch.dict(
            GET_FETCHERS,
            {LyricSource.LRCLIB: AsyncMock(return_value="[00:00.00] 作词 : Someone")},
        ),
    ):
        r = client.get(
            "/lyrics/auto",
            params={"name": "Song", "artist": "Artist", "sources": "lrclib.net"},
        )

    # Better than two names presented as the song's words.
    assert r.json() is None


def test_auto_refuses_a_close_title_by_a_different_artist(client):
    """The general threshold is lenient enough for "Drowning in Beauty" by
    Massappeals to match Amanda Palmer's "Drowning in the Sound" — those
    two names score 0.50 against each other. Lyrics by the wrong artist are
    the wrong song's words however close the title reads."""
    search_result = [
        {
            "artist": "Amanda Palmer",
            "id": "wrong-artist",
            "isSync": True,
            "name": "Drowning in the Sound",
            "source": "SimpMusic",
        }
    ]
    get_fn = AsyncMock(return_value="[00:14.09] You worship the sun")

    with (
        patch.dict(SEARCH_FETCHERS, {LyricSource.SIMPMUSIC: AsyncMock(return_value=search_result)}),
        patch.dict(GET_FETCHERS, {LyricSource.SIMPMUSIC: get_fn}),
    ):
        r = client.get(
            "/lyrics/auto",
            params={"name": "Drowning in Beauty", "artist": "Massappeals", "sources": "SimpMusic"},
        )

    assert r.json() is None
    get_fn.assert_not_awaited()


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
        r = client.get("/lyrics/by-remote-id", params={"source": "lrclib.net", "id": "42"})

    assert r.status_code == 200
    assert r.json() == "[00:01.00]La la la"
    get_fn.assert_awaited_once_with("42")


def test_by_remote_id_returns_none_for_unknown_source(client):
    r = client.get("/lyrics/by-remote-id", params={"source": "Genius", "id": "42"})
    assert r.status_code == 200
    assert r.json() is None


def test_by_remote_id_returns_none_when_the_fetch_fails(client, caplog):
    with (
        patch.dict(GET_FETCHERS, {LyricSource.LRCLIB: AsyncMock(side_effect=RuntimeError("boom"))}),
        caplog.at_level(logging.WARNING, logger="connect.lyrics"),
    ):
        r = client.get("/lyrics/by-remote-id", params={"source": "lrclib.net", "id": "42"})

    assert r.json() is None
    assert "boom" in caplog.text
