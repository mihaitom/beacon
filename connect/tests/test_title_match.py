"""Tests for core/title_match.py — the word-based matching behind the radio
title log's search."""

from core import title_match


def test_normalize_folds_case_accents_and_punctuation():
    assert title_match.normalize("Bohème!  —  Queen") == "boheme queen"


def test_normalize_folds_the_german_sharp_s():
    # casefold(), not lower(): a station broadcasting in German sends
    # "Straße" and the listener types "strasse".
    assert title_match.normalize("Straße") == "strasse"
    assert title_match.matches("Auf der Straße - Band", "STRASSE")


def test_normalize_drops_apostrophes_without_splitting_the_word():
    assert title_match.normalize("Don't Stop") == "dont stop"


def test_matches_searches_artist_and_track_in_any_order():
    title = "Kate Bush - Running Up That Hill"
    assert title_match.matches(title, "kate bush hill")
    assert title_match.matches(title, "running up that hill kate bush")
    assert title_match.matches(title, "hill bush")


def test_matches_accepts_a_half_typed_word_by_prefix():
    assert title_match.matches("Wonderwall - Oasis", "wonder")


def test_matches_accepts_a_fragment_from_the_middle_of_a_word():
    # The substring search this replaced matched anywhere in the title, so a
    # fragment has always found its word and still does.
    assert title_match.matches("Earth Song - Michael Jackson", "rth song")


def test_matches_tolerates_a_misspelling():
    assert title_match.matches("The Beatles - Hey Jude", "beattles")
    assert title_match.matches("Metallica - Nothing Else Matters", "metalica")


def test_matches_tolerates_a_missing_letter():
    # The bigram coefficient this used before scored "earth" against "erth"
    # at 0.57 - every bigram shifts - so this is what the Jaro-Winkler switch
    # is for.
    assert title_match.matches("Earth Song - Michael Jackson", "erth song")


def test_matches_rejects_a_different_word_that_merely_looks_similar():
    # Jaro-Winkler of "oasis" against "basis" is 0.87, under the floor.
    assert not title_match.matches("Wonderwall - Oasis", "basis")


def test_exact_mode_drops_the_misspelling_but_keeps_fragments():
    title = "Earth Song - Michael Jackson"
    assert title_match.matches(title, "erth song", exact=True) is False
    assert title_match.matches(title, "rth song", exact=True) is True
    assert title_match.matches(title, "earth song", exact=True) is True
    # The same misspelling is lenient without the flag.
    assert title_match.matches(title, "erth song") is True


def test_matches_requires_every_query_word_to_land():
    assert not title_match.matches("Wonderwall - Oasis", "wonderwall blur")


def test_matches_searches_a_title_with_no_separator_as_itself():
    assert title_match.matches("Nachrichten", "nachricht")


def test_an_empty_query_matches_everything():
    assert title_match.matches("Anything - At All", "")
    assert title_match.matches("Anything - At All", "   ")
