"""shared.py — search-result ranking.

Port of src/main/features/core/lyrics/shared.ts (orderSearchResults), which
uses Fuse.js. The Connect backend uses the stdlib difflib instead to avoid an
extra dependency — scores are still in the Fuse convention (0 = perfect
match, 1 = worst), so the existing MATCH_THRESHOLD = 0.55 behaves the same.
"""

import re
from difflib import SequenceMatcher
from typing import Any

# Kept in sync with package.json by scripts/sync-connect-version.mjs
# (runs via the `postversion` hook on `pnpm version`).
CONNECT_VERSION = "0.1.4"

# Shared across providers — some (e.g. SimpMusic) reject requests without one.
USER_AGENT = (
    f"Beacon/{CONNECT_VERSION} (https://github.com/mihaitom/beacon)"
)


def _distance(a: str | None, b: str | None) -> float:
    """0 = identical (ignoring case), 1 = completely different."""
    if not a or not b:
        return 1.0
    return 1.0 - SequenceMatcher(None, a.lower(), b.lower()).ratio()


# How far a candidate's own length may be from the track's before it is
# treated as a different recording rather than an imprecise tag. Kept the
# same as LyricsCandidateList.vue's DURATION_MISMATCH_THRESHOLD_S, which
# marks such a candidate red in the picker — the automatic choice and what
# the list flags by eye have to agree, or the app picks something it then
# shows as wrong.
DURATION_TOLERANCE_S = 5


def _duration_rank(expected: float | None, actual: float | None) -> int:
    """0 = length matches, 1 = nothing to compare, 2 = clearly a different
    recording.

    Unknown sits between the two on purpose: a provider that returns no
    duration (NetEase's search, some SimpMusic entries) has said nothing
    about the recording, which is no reason to prefer it over a confirmed
    match — but also no reason to rank it with the ones that are provably
    the wrong edit."""
    if expected is None or actual is None:
        return 1
    return 0 if abs(expected - actual) <= DURATION_TOLERANCE_S else 2


# A leading LRC timestamp, including the trailing "-N" some sources append
# (`[00:00.00-1]`).
_TIMESTAMP = re.compile(r"^\[\d{1,3}:\d{2}(?:\.\d{1,3})?(?:-\d+)?\]")
# An LRC header tag: [ar:...], [ti:...], [offset:+200].
_METADATA_TAG = re.compile(r"^\[[a-zA-Z#][^\]]*\]$")
# Songwriter/producer credits, which several sources put at the top of a
# sheet — "作词 : ...", "Written by ...". Kept in step with parseLrc.ts's
# own pair, which decides where they are shown.
_CREDIT_PREFIX = re.compile(r"^\s*(?:[^:\s][^:]{0,29})\s:\s")
_CREDIT_BY = re.compile(
    r"^\s*(?:lyrics?|music|composed|written|arranged|produced|mixed|mastered|vocals?)\s+by\b",
    re.IGNORECASE,
)


# How different a candidate's artist may read before it counts as somebody
# else's song. Measured against real pairs (2026-08-27): genuine matches
# that aren't caught by the containment rule below sit at 0.11 and under
# ("Massappeals"/"Mass Appeals", "Simon & Garfunkel"/"Simon and
# Garfunkel"), while the closest wrong one measured — "Massappeals" against
# "Amanda Palmer", which shares most of its letters — is 0.50.
ARTIST_TOLERANCE = 0.35


def artist_matches(expected: str | None, actual: str | None) -> bool:
    """Whether two artist names plausibly name the same act.

    Deliberately separate from the overall similarity score: a title may
    legitimately differ ("Song" vs "Song - Remastered 2011"), an artist
    much less so, and a lyric sheet by the wrong artist is the wrong song's
    words no matter how close the title reads. Exactly how "Drowning in
    Beauty" by Massappeals ended up matched to Amanda Palmer's "Drowning in
    the Sound" (2026-08-27): a 0.50 score, under the general threshold.

    Containment first, since a featured artist ("Dua Lipa" against "Dua
    Lipa, Gwen Stefani") or a dropped article ("The Weeknd" against
    "Weeknd") is the same act billed differently — and both would otherwise
    fail on distance alone."""
    if not expected or not actual:
        return True
    left, right = expected.lower(), actual.lower()
    if left in right or right in left:
        return True
    return _distance(left, right) <= ARTIST_TOLERANCE


def has_sung_lines(text: str) -> bool:
    """Whether a lyric sheet contains any actual singing, as opposed to
    nothing but credits and metadata.

    Some sources answer with a "lyric sheet" that is only the songwriter
    and composer — NetEase does this for tracks it has no words for
    (verified 2026-08-27 on "Drowning in Beauty"). Showing those two lines
    as if they were the song is worse than admitting there are no lyrics,
    so /auto passes over such a result and tries the next candidate."""
    for raw in text.splitlines():
        line = raw.strip()
        while True:
            stripped = _TIMESTAMP.sub("", line, count=1).strip()
            if stripped == line:
                break
            line = stripped
        if not line or _METADATA_TAG.match(line):
            continue
        if _CREDIT_PREFIX.match(line) or _CREDIT_BY.match(line):
            continue
        return True
    return False


def order_search_results(
    params: dict[str, Any], results: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Rank `results` by how well they match the track: first by length,
    then synced before plain, then by title/artist similarity.

    Returns a new list of result dicts with a `score` key added (lower is
    better).

    Length leads because it is the only signal here that is about the
    *recording* rather than about its name. A radio edit, a live take and
    an album version share a title and artist exactly, and lyrics fetched
    for the wrong one of them are wrong in the way that shows: synced lines
    drift further apart the longer the song plays. A title that reads
    slightly differently, which is all `score` can see, is a far weaker
    signal than a duration that is a minute off.

    For the same reason length outranks synced-vs-plain: timed lyrics
    belonging to a different edit are worse than untimed ones belonging to
    this one."""
    name = params.get("name")
    artist = params.get("artist")
    duration = params.get("duration")

    scored = []
    for item in results:
        name_score = _distance(name, item.get("name")) if name else 0.0
        artist_score = _distance(artist, item.get("artist")) if artist else 0.0

        if name and artist:
            score = max(name_score, artist_score)
        else:
            score = name_score or artist_score

        scored.append({**item, "score": score})

    scored.sort(
        key=lambda r: (
            _duration_rank(duration, r.get("duration")),
            0 if r.get("isSync") else 1,
            r["score"],
        )
    )
    return scored
