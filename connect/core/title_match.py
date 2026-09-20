"""core/title_match.py — Whether a radio log entry matches what the listener
typed into the title log's search field.

The log stores whatever the station put in its ICY field, usually
"Artist - Title". Searching it used to be a case-insensitive substring over
that whole string, which misses the ordinary ways a listener types: without
accents, with artist and track the other way round, or with a typo. This
module normalises both sides (case, accents, punctuation), splits the entry
into artist and track, and asks whether every word of the query has a match
on either side — order independent, with a substring match for a half-typed
word and a Jaro-Winkler similarity for a misspelling.

The normalisation is the one services/library/lastfmMatcher.ts uses for the
same kind of name comparison, ported here because this search runs on the
backend over the whole log (see SessionState.radio_title_log) rather than over
the page a client happens to hold. The token-level typo match is Jaro-Winkler
rather than that matcher's bigram coefficient: a single missing letter shifts
every bigram ("earth" against "erth" scores 0.57 there), while Jaro-Winkler
stays at 0.94. The same choice is made in services/stringMatch.ts for the
in-app filter fields, so the two searches behave alike.
"""

import re
import unicodedata
from collections.abc import Callable

# The separator an ICY title conventionally uses between artist and track.
# Spaces around the dash are required, same as RadioTitleLog.vue: plenty of
# legitimate single-line titles are hyphenated words ("ARD-Infosamstag").
_SEPARATOR = " - "

# How close a query word has to be to an entry word to be that word
# misspelled. High enough that a different word sharing a tail ("oasis" /
# "basis", 0.87) is not accepted, low enough that a one-letter slip is.
_TOKEN_FLOOR = 0.9


def fold_diacritics(value: str) -> str:
    """Accent folding: "Bohème" and "Boheme" are the same title."""
    decomposed = unicodedata.normalize("NFD", value)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def normalize(value: str) -> str:
    """Case, accents and punctuation are never the difference between two
    spellings of one title.

    casefold(), not lower(): a German station sends "Straße" and the
    listener types "strasse", and only casefold folds the sharp s. Apostrophes
    are dropped rather than spaced, unlike every other punctuation mark, so
    "Don't" and "Dont" stay one word. Everything else becomes a space, so
    removing it cannot fuse two words into one."""
    text = fold_diacritics(value.casefold())
    text = re.sub(r"['’`´]", "", text)
    text = re.sub(r"[^\w]|_", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def _jaro_winkler(left: str, right: str) -> float:
    """Jaro-Winkler similarity of two already-normalised strings, 0..1.

    Counts characters that match within a window, then rewards a shared
    prefix — which is what lets a one-letter slip through ("earth" / "erth",
    0.94) while keeping a different word with the same tail out ("oasis" /
    "basis", 0.87)."""
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0

    window = max(0, max(len(left), len(right)) // 2 - 1)
    left_matched = [False] * len(left)
    right_matched = [False] * len(right)

    matches = 0
    for i, char in enumerate(left):
        for j in range(max(0, i - window), min(i + window + 1, len(right))):
            if right_matched[j] or char != right[j]:
                continue
            left_matched[i] = True
            right_matched[j] = True
            matches += 1
            break
    if matches == 0:
        return 0.0

    transpositions = 0
    j = 0
    for i, matched in enumerate(left_matched):
        if not matched:
            continue
        while not right_matched[j]:
            j += 1
        if left[i] != right[j]:
            transpositions += 1
        j += 1
    transpositions //= 2

    jaro = (matches / len(left) + matches / len(right) + (matches - transpositions) / matches) / 3

    prefix = 0
    for i in range(min(4, len(left), len(right))):
        if left[i] != right[i]:
            break
        prefix += 1

    return jaro + prefix * 0.1 * (1 - jaro)


def _entry_words(title: str) -> list[str]:
    """The words an entry can be matched against: artist and track together,
    so a query may name either or both in any order. A title with no separator
    (a news item, a station slogan) is searched as itself."""
    at = title.find(_SEPARATOR)
    if at > 0:
        artist = title[:at].strip()
        track = title[at + len(_SEPARATOR) :].strip()
        title = f"{artist} {track}"
    return normalize(title).split()


def _word_matches(entry_word: str, query_word: str, exact: bool) -> bool:
    # Anywhere in the word, not just at its start: the substring search this
    # replaced matched across the whole title, so a fragment like "rth" has
    # always found "earth" and has to keep doing so. `exact` only drops the
    # misspelling below - a fragment still counts.
    if query_word in entry_word:
        return True
    if exact:
        return False
    return _jaro_winkler(entry_word, query_word) >= _TOKEN_FLOOR


def matcher(query: str, exact: bool = False) -> Callable[[str], bool]:
    """A predicate over log titles for one search.

    The query is normalised once here rather than per entry, since a station's
    log runs to a thousand titles. An empty or punctuation-only query matches
    everything, which is how "no search in force" is expressed. `exact` drops
    the misspelling match, the same mode the app's filter fields have
    (services/textSearch.ts); a fragment still matches."""
    wanted = normalize(query).split()
    if not wanted:
        return lambda _title: True

    def matches(title: str) -> bool:
        words = _entry_words(title)
        return all(
            any(_word_matches(word, word_wanted, exact) for word in words) for word_wanted in wanted
        )

    return matches


def matches(title: str, query: str, exact: bool = False) -> bool:
    """One entry against one query — the whole of matcher()'s work, for a
    single call."""
    return matcher(query, exact)(title)
