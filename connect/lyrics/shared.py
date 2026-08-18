"""shared.py — search-result ranking.

Port of src/main/features/core/lyrics/shared.ts (orderSearchResults), which
uses Fuse.js. The Connect backend uses the stdlib difflib instead to avoid an
extra dependency — scores are still in the Fuse convention (0 = perfect
match, 1 = worst), so the existing MATCH_THRESHOLD = 0.55 behaves the same.
"""

from difflib import SequenceMatcher
from typing import Any

# Kept in sync with package.json by scripts/sync-connect-version.mjs
# (runs via the `postversion` hook on `pnpm version`).
CONNECT_VERSION = "0.1.3"

# Shared across providers — some (e.g. SimpMusic) reject requests without one.
USER_AGENT = (
    f"Beacon/{CONNECT_VERSION} (https://github.com/mihaitom/beacon)"
)


def _distance(a: str | None, b: str | None) -> float:
    """0 = identical (ignoring case), 1 = completely different."""
    if not a or not b:
        return 1.0
    return 1.0 - SequenceMatcher(None, a.lower(), b.lower()).ratio()


def order_search_results(
    params: dict[str, Any], results: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Rank `results` by similarity to `params["name"]`/`params["artist"]`.

    Returns a new list of result dicts with a `score` key added (lower is
    better), sorted with synced-lyrics results preferred and ties broken by
    score.
    """
    name = params.get("name")
    artist = params.get("artist")

    scored = []
    for item in results:
        name_score = _distance(name, item.get("name")) if name else 0.0
        artist_score = _distance(artist, item.get("artist")) if artist else 0.0

        if name and artist:
            score = max(name_score, artist_score)
        else:
            score = name_score or artist_score

        scored.append({**item, "score": score})

    scored.sort(key=lambda r: (0 if r.get("isSync") else 1, r["score"]))
    return scored
