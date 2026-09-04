"""routes/lyrics.py — /lyrics/search, /lyrics/auto, /lyrics/by-remote-id

Remote-lyrics counterpart to src/main/features/core/lyrics/* (Electron main
process IPC). The web/Docker build has no Electron main process, so the
renderer falls back to these endpoints when not running in Electron.

Answers are cached in memory (see _cache below). Every one of them costs
requests to third-party services — up to three searches plus a fetch for a
single song — and those are requests that carry this deployment's listening
habits off it, so not making them twice matters here for more than speed:
one shared cache means a second device, a second person and a browser that
reloaded are all answered without lrclib/NetEase/SimpMusic hearing about it
again. The browser keeps its own copy too (src/renderer/src/stores/
lyrics.ts); this is what makes that copy cheap to rebuild and what covers
every client at once.

Same shape as routes/coverart.py's and radio.py's caches — an LRU bounded by
what it actually holds, a long life for an answer and a short one for "there
is nothing", and one in-flight lookup per key so a burst asks once.
"""

import asyncio
import json
import logging
import time
from collections import OrderedDict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

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

# How long a found answer is kept. Lyrics for a given recording do not
# change, and the identity of the request (title, artist, album, length,
# which providers were asked) already covers everything that would make the
# answer different — so this is long, and mostly a bound on memory rather
# than on staleness.
_CACHE_TTL = 30 * 86400.0

# How long "nothing found" is kept. Far shorter, and deliberately the same
# day the browser's own cache uses for the same answer (see
# NEGATIVE_TTL_MS in stores/lyrics.ts): a song missing from every provider
# today may well be added tomorrow, and a mistagged file that gets fixed
# should not keep being answered from a lookup made under the old tags.
_NEGATIVE_CACHE_TTL = 86400.0

# Lyrics are text — a few kilobytes each, where a cover is tens. This holds
# a very large listening history and still costs less memory than a single
# screenful of artwork.
_CACHE_MAX_BYTES = 8 * 1024 * 1024

_CacheKey = tuple
_cache: OrderedDict[_CacheKey, tuple[float, Any]] = OrderedDict()
_cache_bytes = 0
# One in-flight lookup per key, so the same song asked for by two devices at
# the same moment is searched for once.
_inflight: dict[_CacheKey, asyncio.Task] = {}


def _sizeof(key: _CacheKey, value: Any) -> int:
    """What one entry costs. The key counts as well as the value, and
    deliberately so: a remembered "this song has nothing" is four bytes of
    value against a key carrying a title, an artist, an album and a provider
    list, so charging only for the value would leave a cache made entirely
    of misses growing without limit no matter what the budget says."""
    try:
        return len(str(key)) + len(json.dumps(value, default=str))
    except Exception:
        return len(str(key))


def _cache_drop(key: _CacheKey) -> None:
    global _cache_bytes
    entry = _cache.pop(key, None)
    if entry is not None:
        _cache_bytes -= _sizeof(key, entry[1])


def _cache_get(key: _CacheKey) -> tuple[bool, Any]:
    """(whether this key is cached at all, what it resolved to) — separate,
    since a cached "no lyrics anywhere" is a real answer and is also None."""
    entry = _cache.get(key)
    if entry is None:
        return False, None
    expires, value = entry
    if time.monotonic() >= expires:
        _cache_drop(key)
        return False, None
    _cache.move_to_end(key)
    return True, value


def _cache_put(key: _CacheKey, value: Any) -> None:
    global _cache_bytes
    _cache_drop(key)
    ttl = _NEGATIVE_CACHE_TTL if _is_empty(value) else _CACHE_TTL
    _cache[key] = (time.monotonic() + ttl, value)
    _cache_bytes += _sizeof(key, value)
    while _cache_bytes > _CACHE_MAX_BYTES and len(_cache) > 1:
        _cache_drop(next(iter(_cache)))


def _is_empty(value: Any) -> bool:
    """Whether this counts as "nothing was found" for the TTL above — None
    for /auto and /by-remote-id, and a set of per-source lists with nothing
    in any of them for /search."""
    if not value:
        return True
    if isinstance(value, dict) and all(isinstance(v, list) for v in value.values()):
        return not any(value.values())
    return False


# What a lookup that could not actually be carried out answers with —
# distinct from "asked, and there are no lyrics", which is a real result.
# The two must not be confused anywhere: telling a caller "this song has no
# lyrics" because a provider happened to be unreachable is an answer it will
# remember, on both sides of the wire (see stores/lyrics.ts, which caches a
# miss for a day), so a five-second outage would leave songs blank long
# after it ended. The endpoints turn this into a 503, which the frontend
# treats as the transient failure it is.
_UNAVAILABLE = object()


async def _lookup(key: _CacheKey, produce) -> Any:
    """`produce` returns (answer, whether it is worth remembering). An
    answer that only came out empty because a provider was unreachable is
    not worth remembering *and* is not an answer — it comes back as
    _UNAVAILABLE rather than as "nothing found"."""
    hit, value = _cache_get(key)
    if hit:
        return value

    async def run() -> Any:
        # Deliberately returns rather than raises, so a caller that walks
        # away (a disconnected client) leaves a task that still finishes and
        # still fills the cache, instead of one whose exception nobody
        # retrieves.
        try:
            answer, worth_keeping = await produce()
        except Exception:
            logger.exception(f"[lyrics] lookup for {key[0]} failed")
            return _UNAVAILABLE
        finally:
            _inflight.pop(key, None)
        if worth_keeping:
            _cache_put(key, answer)
            return answer
        # Not worth keeping and empty: every provider that was asked failed,
        # so there is no answer here at all. A *partial* result (one
        # provider answered, another didn't) is still an answer worth
        # showing — it just isn't one worth storing.
        return _UNAVAILABLE if _is_empty(answer) else answer

    task = _inflight.get(key)
    if task is None:
        task = asyncio.ensure_future(run())
        _inflight[key] = task
    # Shielded: one client giving up must not cancel the lookup the others
    # are still waiting on.
    return await asyncio.shield(task)


def _answer(result: Any) -> Any:
    """Hands a real result back, and turns "could not be asked" into a plain
    failure. 503 rather than an empty 200 on purpose: the frontend stores
    what a 200 says (see stores/lyrics.ts), and what it must not store is a
    "no lyrics" that only means the providers were unreachable — a thrown
    request is exactly what it already treats as transient."""
    if result is _UNAVAILABLE:
        raise HTTPException(status_code=503, detail="No lyrics provider could be reached")
    return result


def _key(endpoint: str, params: dict, wanted: list[LyricSource]) -> _CacheKey:
    """What makes two lookups the same one. The providers are part of it,
    not just the song: asking lrclib alone and asking all three are
    different questions with legitimately different answers, and the
    frontend changes that set from Settings."""
    return (
        endpoint,
        params["name"],
        params["artist"],
        params["album"],
        params["duration"],
        tuple(sorted(s.value for s in wanted)),
    )


def _reset_cache() -> None:
    """Test seam — the cache outlives any one request, so a test that
    doesn't clear it is answered by the previous one's fixtures."""
    global _cache_bytes
    _cache.clear()
    _cache_bytes = 0
    _inflight.clear()


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
    wanted = _parse_sources(sources)
    return _answer(
        await _lookup(_key("search", params, wanted), lambda: _do_search(params, wanted))
    )


async def _do_search(
    params: dict, wanted: list[LyricSource]
) -> tuple[dict[str, list[dict[str, Any]]], bool]:
    name, artist = params["name"], params["artist"]
    logger.info(f"[search] name={name!r} artist={artist!r} sources={_fmt_sources(wanted)}")

    results: dict[str, list[dict[str, Any]]] = {}
    reachable = True
    for source in wanted:
        try:
            found = await SEARCH_FETCHERS[source](params)
        except Exception as e:
            logger.warning(f"[search] {source}: {e}")
            found = None
            reachable = False
        results[source.value] = found or []

    total = sum(len(v) for v in results.values())
    logger.info(f"[search] name={name!r} artist={artist!r} -> {total} result(s)")
    # A partial answer is not one to keep: whatever the reachable providers
    # returned is fine to show now, but caching it would hide the missing
    # provider's results for as long as the entry lives.
    return results, reachable


@router.get("/auto")
async def auto(
    name: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    duration: float | None = None,
    sources: str | None = None,
) -> dict[str, Any] | None:
    params = {"album": album, "artist": artist, "duration": duration, "name": name}
    wanted = _parse_sources(sources)
    return _answer(await _lookup(_key("auto", params, wanted), lambda: _do_auto(params, wanted)))


async def _do_auto(params: dict, wanted: list[LyricSource]) -> tuple[dict[str, Any] | None, bool]:
    name, artist, album = params["name"], params["artist"], params["album"]
    logger.info(
        f"[auto] name={name!r} artist={artist!r} album={album!r} sources={_fmt_sources(wanted)}"
    )

    all_results: list[dict[str, Any]] = []
    # Whether every provider this asked actually answered. A "no lyrics"
    # produced while one of them was unreachable says nothing about the
    # song, so it is deliberately not remembered — same reasoning as
    # stores/lyrics.ts's own "deliberately not cached" for a failed request.
    reachable = True
    for source in wanted:
        try:
            found = await SEARCH_FETCHERS[source](params)
        except Exception as e:
            logger.warning(f"[auto] {source}: {e}")
            found = None
            reachable = False
        if found:
            all_results.extend(found)

    if not all_results:
        logger.info(f"[auto] name={name!r} artist={artist!r} -> no search results")
        return None, reachable

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
        return None, reachable

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
            reachable = False
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
        # Found — worth keeping whatever else went wrong along the way: a
        # provider that failed cannot make this answer any less correct.
        return {
            "artist": candidate["artist"],
            "id": candidate["id"],
            "lyrics": lyrics,
            "name": candidate["name"],
            "source": candidate["source"],
        }, True

    logger.info(f"[auto] name={name!r} artist={artist!r} -> no candidate had usable lyrics")
    return None, reachable


@router.get("/by-remote-id")
async def by_remote_id(source: str, id: str) -> str | None:
    return _answer(
        await _lookup(("by-remote-id", source, id), lambda: _do_by_remote_id(source, id))
    )


async def _do_by_remote_id(source: str, id: str) -> tuple[str | None, bool]:
    logger.info(f"[by-remote-id] source={source!r} id={id!r}")
    try:
        src = LyricSource(source)
    except ValueError:
        logger.warning(f"[by-remote-id] unknown source: {source!r}")
        # A source this build doesn't know will never become one it does
        # without a restart, so this is worth remembering.
        return None, True

    try:
        result = await GET_FETCHERS[src](id)
    except Exception as e:
        logger.warning(f"[by-remote-id] {src}: {e}")
        return None, False

    logger.info(
        f"[by-remote-id] source={source!r} id={id!r} -> {'found' if result else 'no lyrics'}"
    )
    return result, True
