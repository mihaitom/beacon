"""Live smoke tests for each remote lyrics provider.

These hit the real lrclib.net / SimpMusic / NetEase APIs, so they're excluded
from the default test run (see `addopts` in pyproject.toml) and from CI —
third-party APIs can be flaky/rate-limited/down, which would make CI flaky
for reasons unrelated to this codebase.

Run locally with:
    uv run pytest -m live tests/test_lyrics_live.py
"""

import pytest

from lyrics import lrclib, netease, simpmusic

pytestmark = pytest.mark.live

# A well-known track that should reliably have lyrics on all providers.
PARAMS = {"artist": "Michael Jackson", "name": "Billie Jean"}


async def _search_and_fetch(provider) -> None:
    results = await provider.get_search_results(PARAMS)
    assert results, f"{provider.__name__}: expected search results"

    best = results[0]
    lyrics = await provider.get_lyrics_by_song_id(best["id"])
    assert lyrics, f"{provider.__name__}: expected lyrics for {best!r}"


async def test_lrclib_live():
    await _search_and_fetch(lrclib)


async def test_simpmusic_live():
    await _search_and_fetch(simpmusic)


async def test_netease_live():
    await _search_and_fetch(netease)
