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


def test_similarity_of_a_string_with_itself_is_one():
    assert title_match.similarity("Wonderwall", "wonderwall") == 1.0


def test_similarity_needs_bigrams_so_a_single_character_is_zero():
    assert title_match.similarity("a", "a") == 1.0
    assert title_match.similarity("a", "b") == 0.0


def test_matches_searches_artist_and_track_in_any_order():
    title = "Kate Bush - Running Up That Hill"
    assert title_match.matches(title, "kate bush hill")
    assert title_match.matches(title, "running up that hill kate bush")
    assert title_match.matches(title, "hill bush")


def test_matches_accepts_a_half_typed_word_by_prefix():
    assert title_match.matches("Wonderwall - Oasis", "wonder")


def test_matches_tolerates_a_misspelling():
    assert title_match.matches("The Beatles - Hey Jude", "beattles")
    assert title_match.matches("Metallica - Nothing Else Matters", "metalica")


def test_matches_rejects_a_different_word_that_merely_looks_similar():
    # Dice similarity of "oasis" against "basis" is 0.75, under the floor.
    assert not title_match.matches("Wonderwall - Oasis", "basis")


def test_matches_requires_every_query_word_to_land():
    assert not title_match.matches("Wonderwall - Oasis", "wonderwall blur")


def test_matches_searches_a_title_with_no_separator_as_itself():
    assert title_match.matches("Nachrichten", "nachricht")


def test_an_empty_query_matches_everything():
    assert title_match.matches("Anything - At All", "")
    assert title_match.matches("Anything - At All", "   ")
