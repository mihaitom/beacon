"""Tests for core/radio_ads.py — the one shape a station's advertising has
that its music never does. Every string here was sampled from real station
logs (see that module's own docstring), not invented."""

import pytest

from core.radio_ads import looks_like_advert


@pytest.mark.parametrize(
    "title",
    [
        "booking.com - Ein bisschen Verbraucherinformationen ...",
        "booking.com - ...  gleich geht's los mit laut.fm/mangoradio ...",
        "booking.com - ...  zweite Halbzeit ...",
        "vodafone.de - Ein bisschen Verbraucherinformationen ...",
    ],
)
def test_an_advertisers_domain_in_the_artist_field_is_an_advert(title):
    assert looks_like_advert(title)


@pytest.mark.parametrize(
    "title",
    [
        "Years & Years - Eyes Shut",
        "Aronchupa, Little Sis Nora - Little Swing",
        "Becky Hill & David Guetta - Remember",
        "Mark Forster - Übermorgen",
    ],
)
def test_a_song_is_not_an_advert(title):
    assert not looks_like_advert(title)


@pytest.mark.parametrize(
    "artist",
    [
        "BUNT., MALOU",
        "D.O.D, IZZY BIZU",
        "G. CLUB, BANDA SONORA, FUNKAGENDA",
        "JAN BLOMQVIST, RODRIGUEZ JR.",
    ],
)
def test_an_artist_name_carrying_dots_is_still_a_name(artist):
    """All four are real artists out of the same logs the ads came from —
    the reason the rule is "a bare domain" rather than "contains a dot"."""
    assert not looks_like_advert(f"{artist} - Some Track")


def test_a_domain_further_along_the_line_says_nothing():
    """Only the artist half is a domain in an ad. A song whose *title*
    mentions one is a song."""
    assert not looks_like_advert("Some Artist - Listen at example.com")


def test_a_line_with_no_separator_at_all_is_left_alone():
    # A station name, a programme title, a news headline — see
    # core/session.py's _record_radio_title() on why those are all kept.
    assert not looks_like_advert("Informationen am Morgen")
    assert not looks_like_advert("booking.com")


def test_a_hyphenated_word_is_not_a_separator():
    """The same rule RadioTitleLog.vue splits by: spaces around the dash
    are required, or "ARD-Infosamstag" would be torn in half."""
    assert not looks_like_advert("example.com-Werbung")


def test_the_separator_at_the_very_start_is_not_an_artist():
    assert not looks_like_advert(" - Eyes Shut")
