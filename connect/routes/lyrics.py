"""routes/lyrics.py — /lyrics/search, /lyrics/auto, /lyrics/by-remote-id

Remote-lyrics counterpart to src/main/features/core/lyrics/* (Electron main
process IPC). The web/Docker build has no Electron main process, so the
renderer falls back to these endpoints when not running in Electron.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends

from core.auth import require_token
from lyrics import (
    LyricSource,
    artist_matches,
    has_sung_lines,
    lrclib,
    netease,
    order_search_results,
    simpmusic,
)

logger = logging.getLogger("connect.lyrics")
router = APIRouter(prefix="/lyrics", dependencies=[Depends(require_token)])

# Mirrors src/shared/types/domain-types.ts LyricSource — Genius is not
# implemented here (HTML scraping needs extra deps in the PyInstaller build),
# but the response shape stays compatible with the frontend, which just
# iterates over whatever keys are present.
SEARCH_FETCHERS = {
    LyricSource.LRCLIB: lrclib.get_search_results,
    LyricSource.SIMPMUSIC: simpmusic.get_search_results,
    LyricSource.NETEASE: netease.get_search_results,
}
GET_FETCHERS = {
    LyricSource.LRCLIB: lrclib.get_lyrics_by_song_id,
    LyricSource.SIMPMUSIC: simpmusic.get_lyrics_by_song_id,
    LyricSource.NETEASE: netease.get_lyrics_by_song_id,
}

# Same as getRemoteLyrics' matchThreshold in index.ts.
MATCH_THRESHOLD = 0.55


def _parse_sources(sources: str | None) -> list[LyricSource]:
    if not sources:
        return list(LyricSource)

    parsed = []
    for raw in sources.split(","):
        try:
            parsed.append(LyricSource(raw.strip()))
        except ValueError:
            continue
    return parsed or list(LyricSource)


def _fmt_sources(sources: list[LyricSource]) -> str:
    return ",".join(s.value for s in sources)


@router.get("/search")
async def search(
    name: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    duration: float | None = None,
    sources: str | None = None,
) -> dict[str, list[dict[str, Any]]]:
    params = {"album": album, "artist": artist, "duration": duration, "name": name}
    logger.info(
        f"[search] name={name!r} artist={artist!r} sources={_fmt_sources(_parse_sources(sources))}"
    )

    results: dict[str, list[dict[str, Any]]] = {}
    for source in _parse_sources(sources):
        try:
            found = await SEARCH_FETCHERS[source](params)
        except Exception as e:
            logger.warning(f"[search] {source}: {e}")
            found = None
        results[source.value] = found or []

    total = sum(len(v) for v in results.values())
    logger.info(f"[search] name={name!r} artist={artist!r} -> {total} result(s)")
    return results


@router.get("/auto")
async def auto(
    name: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    duration: float | None = None,
    sources: str | None = None,
) -> dict[str, Any] | None:
    params = {"album": album, "artist": artist, "duration": duration, "name": name}
    logger.info(
        f"[auto] name={name!r} artist={artist!r} album={album!r} sources={_fmt_sources(_parse_sources(sources))}"
    )

    all_results: list[dict[str, Any]] = []
    for source in _parse_sources(sources):
        try:
            found = await SEARCH_FETCHERS[source](params)
        except Exception as e:
            logger.warning(f"[auto] {source}: {e}")
            found = None
        if found:
            all_results.extend(found)

    if not all_results:
        logger.info(f"[auto] name={name!r} artist={artist!r} -> no search results")
        return None

    ranked = order_search_results(params, all_results)
    # The first candidate whose *name* is close enough, not simply the
    # first one: ranking leads with the recording's length now (see
    # order_search_results), so the top entry can be one that matches this
    # exact edit while being titled differently enough to fail the
    # threshold — in which case the next one down may still be a perfectly
    # good match. Checking only the top entry used to throw the whole
    # search away in that case.
    best = next((r for r in ranked if r["score"] <= MATCH_THRESHOLD), None)
    if best is None:
        closest = min(ranked, key=lambda r: r["score"])
        logger.info(
            f"[auto] name={name!r} artist={artist!r} -> best match "
            f"{closest['name']!r}/{closest['artist']!r} match={(1 - closest['score']) * 100:.0f}% "
            f"below threshold {(1 - MATCH_THRESHOLD) * 100:.0f}%, discarding"
        )
        return None

    # Walks down the acceptable candidates rather than standing or falling
    # with the first: a match can be the right song and still come back
    # with no usable words — an empty body, or a "lyric sheet" that is
    # nothing but the songwriter credits (see has_sung_lines). Those are
    # skipped in favour of the next candidate, which may well be the same
    # song from a different source.
    for candidate in ranked:
        if candidate["score"] > MATCH_THRESHOLD:
            break
        # Checked separately from the score, which is lenient enough to let
        # a different act through on a similar title — see artist_matches().
        if not artist_matches(artist, candidate.get("artist")):
            logger.info(
                f"[auto] {candidate['name']!r} by {candidate.get('artist')!r}: other artist, next"
            )
            continue
        source = LyricSource(candidate["source"])
        try:
            lyrics = await GET_FETCHERS[source](candidate["id"])
        except Exception as e:
            logger.warning(f"[auto] fetch {source}: {e}")
            continue

        if not lyrics:
            logger.info(f"[auto] {candidate['name']!r} from {source}: no lyrics body, next")
            continue
        if not has_sung_lines(lyrics):
            logger.info(f"[auto] {candidate['name']!r} from {source}: credits only, next")
            continue

        logger.info(
            f"[auto] name={name!r} artist={artist!r} -> found via {source} "
            f"(match={(1 - candidate['score']) * 100:.0f}%)"
        )
        return {
            "artist": candidate["artist"],
            "id": candidate["id"],
            "lyrics": lyrics,
            "name": candidate["name"],
            "source": candidate["source"],
        }

    logger.info(f"[auto] name={name!r} artist={artist!r} -> no candidate had usable lyrics")
    return None


@router.get("/by-remote-id")
async def by_remote_id(source: str, id: str) -> str | None:
    logger.info(f"[by-remote-id] source={source!r} id={id!r}")
    try:
        src = LyricSource(source)
    except ValueError:
        logger.warning(f"[by-remote-id] unknown source: {source!r}")
        return None

    try:
        result = await GET_FETCHERS[src](id)
    except Exception as e:
        logger.warning(f"[by-remote-id] {src}: {e}")
        return None

    logger.info(
        f"[by-remote-id] source={source!r} id={id!r} -> {'found' if result else 'no lyrics'}"
    )
    return result
