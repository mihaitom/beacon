"""core/title_match.py — Whether a radio log entry matches what the listener
typed into the title log's search field.

The log stores whatever the station put in its ICY field, usually
"Artist - Title". Searching it used to be a case-insensitive substring over
that whole string, which misses the ordinary ways a listener types: without
accents, with artist and track the other way round, or with a typo. This
module normalises both sides (case, accents, punctuation), splits the entry
into artist and track, and asks whether every word of the query has a match
on either side — order independent, with prefix matching for a half-typed
word and a bigram similarity for a misspelling.

The normalisation and the similarity are the ones
services/library/lastfmMatcher.ts arrived at for the same kind of name
comparison, ported here because this search runs on the backend over the whole
log (see SessionState.radio_title_log) rather than over the page a client
happens to hold. Keep the two in step: they are the same deliberate leniency,
not two independent guesses.
"""

import re
import unicodedata
from collections.abc import Callable

# The separator an ICY title conventionally uses between artist and track.
# Spaces around the dash are required, same as RadioTitleLog.vue: plenty of
# legitimate single-line titles are hyphenated words ("ARD-Infosamstag").
_SEPARATOR = " - "

# How close a query word has to be to an entry word to be that word
# misspelled. High enough that "bush" is not "push" and "oasis" is not
# "basis" (both 0.67/0.75); low enough that "beattles" finds "beatles" (0.92).
_TOKEN_FLOOR = 0.8


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


def _bigram_similarity(left: str, right: str) -> float:
    """Dice coefficient over character bigrams on two already-normalised
    strings: the share of adjacent letter pairs they have in common. Chosen
    over an edit distance because it barely punishes an extra word at the end
    while a reordering or a different word drops the score sharply — the shape
    of the difference between a spelling variant and a different title.
    Returns 0..1."""
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    # A single-character string has no bigrams at all, so the general path
    # below would score it 0 against everything including itself.
    if len(left) < 2 or len(right) < 2:
        return 0.0

    bigrams: dict[str, int] = {}
    for i in range(len(left) - 1):
        pair = left[i : i + 2]
        bigrams[pair] = bigrams.get(pair, 0) + 1

    shared = 0
    for i in range(len(right) - 1):
        pair = right[i : i + 2]
        remaining = bigrams.get(pair, 0)
        if remaining:
            bigrams[pair] = remaining - 1
            shared += 1
    return (2 * shared) / ((len(left) - 1) + (len(right) - 1))


def similarity(a: str, b: str) -> float:
    return _bigram_similarity(normalize(a), normalize(b))


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


def _word_matches(entry_word: str, query_word: str) -> bool:
    if entry_word == query_word:
        return True
    # The listener is still typing: "wonder" is a prefix of "wonderwall".
    if entry_word.startswith(query_word):
        return True
    return _bigram_similarity(entry_word, query_word) >= _TOKEN_FLOOR


def matcher(query: str) -> Callable[[str], bool]:
    """A predicate over log titles for one search.

    The query is normalised once here rather than per entry, since a station's
    log runs to a thousand titles. An empty or punctuation-only query matches
    everything, which is how "no search in force" is expressed."""
    wanted = normalize(query).split()
    if not wanted:
        return lambda _title: True

    def matches(title: str) -> bool:
        words = _entry_words(title)
        return all(
            any(_word_matches(word, word_wanted) for word in words) for word_wanted in wanted
        )

    return matches


def matches(title: str, query: str) -> bool:
    """One entry against one query — the whole of matcher()'s work, for a
    single call."""
    return matcher(query)(title)
