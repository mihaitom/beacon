"""core/deezer.py — Deezer charts and an artist's top tracks, for the
playlist builder.

Deezer's public API needs no key and no login, and its charts are the most
current of the builder's sources: they follow what is being streamed right
now, where Last.fm and ListenBrainz follow what their own (much smaller)
userbases scrobble. Like core/lastfm.py and core/listenbrainz.py this only
returns names; finding the ones the library holds is the renderer's job
(services/library/lastfmMatcher.ts).

Deezer has no country parameter: a chart is the one for the country the
request comes from, which here is the connect server's. For a server at home
that is the listener's own country.
"""

import logging

import httpx

from lyrics.shared import USER_AGENT

logger = logging.getLogger("connect.deezer")

_BASE_URL = "https://api.deezer.com"
_TIMEOUT = 15.0

# Deezer's own ceilings, measured 2026-11-01: a chart goes to 200 tracks,
# an artist's top tracks to 100. Asking for more is not an error, it just
# returns the ceiling.
_MAX_LIMIT = 200

# "Audiobooks" is one of Deezer's chart genres. Beacon has no audiobooks,
# so a chart of them could only ever match nothing.
_EXCLUDED_GENRES = {457}

_client = httpx.AsyncClient(timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT})


class DeezerError(Exception):
    """Same split as core/listenbrainz.py's ListenbrainzError: `not_found`
    is something the listener can correct (an artist Deezer does not know),
    anything else is upstream."""

    def __init__(self, message: str, not_found: bool = False) -> None:
        super().__init__(message)
        self.not_found = not_found


def _clamp(limit: int) -> int:
    return max(1, min(int(limit), _MAX_LIMIT))


async def _get(path: str, *, language: str = "", **params) -> dict:
    headers = {"Accept-Language": language} if language else {}
    try:
        resp = await _client.get(f"{_BASE_URL}{path}", params=params, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(f"[deezer] {path} failed: {e}")
        raise DeezerError(f"Deezer request failed: {e}") from e
    if not isinstance(data, dict):
        raise DeezerError("Deezer returned an unreadable response")
    # Deezer answers a failure with HTTP 200 and an error object, the
    # common one being its request quota (50 per 5 seconds).
    error = data.get("error")
    if error:
        message = error.get("message") if isinstance(error, dict) else str(error)
        logger.warning(f"[deezer] {path} -> {message}")
        raise DeezerError(f"Deezer: {message}")
    return data


def _tracks(data: dict) -> list[dict]:
    """Deezer's track objects in the shape every builder source returns.
    Deezer has no MBIDs, so that field stays empty."""
    tracks = []
    for entry in data.get("data") or []:
        if not isinstance(entry, dict):
            continue
        # title_short drops Deezer's version suffix ("Get Lucky (Radio Edit -
        # feat. ...)" -> "Get Lucky"), which a library file rarely carries.
        title = (entry.get("title_short") or entry.get("title") or "").strip()
        artist = ((entry.get("artist") or {}).get("name") or "").strip()
        if not title or not artist:
            continue
        album = entry.get("album") or {}
        duration = entry.get("duration")
        tracks.append(
            {
                "title": title,
                "artist": artist,
                "mbid": "",
                "album": (album.get("title") or "").strip(),
                "coverArtUrl": album.get("cover_medium") or "",
                "duration": duration if isinstance(duration, int) else 0,
            }
        )
    return tracks


async def get_genres(language: str = "") -> list[dict]:
    """The genres Deezer keeps a chart for, named in `language` where Deezer
    has a translation. Id 0 is "All", the overall chart."""
    data = await _get("/genre", language=language)
    genres = []
    for entry in data.get("data") or []:
        if not isinstance(entry, dict):
            continue
        genre_id = entry.get("id")
        name = (entry.get("name") or "").strip()
        if not isinstance(genre_id, int) or not name or genre_id in _EXCLUDED_GENRES:
            continue
        genres.append({"id": genre_id, "name": name})
    return genres


async def get_chart(genre: int, limit: int) -> list[dict]:
    data = await _get(f"/chart/{int(genre)}/tracks", limit=_clamp(limit))
    return _tracks(data)


async def _find_artist(name: str) -> int:
    """The Deezer id for an artist name. Search order is not "the famous one
    first" (see core/recommendations.py's _fetch_deezer), so exact name
    matches are preferred and the one with the most fans wins; only when
    nothing matches exactly is the top hit trusted."""
    data = await _get("/search/artist", q=name)
    candidates = [entry for entry in data.get("data") or [] if isinstance(entry, dict)]
    if not candidates:
        raise DeezerError("Deezer has no such artist", not_found=True)
    key = name.strip().casefold()
    exact = [a for a in candidates if (a.get("name") or "").strip().casefold() == key]
    best = max(exact, key=lambda a: a.get("nb_fan") or 0) if exact else candidates[0]
    artist_id = best.get("id")
    if not isinstance(artist_id, int):
        raise DeezerError("Deezer has no such artist", not_found=True)
    return artist_id


async def get_artist_top(artist: str, limit: int) -> list[dict]:
    artist_id = await _find_artist(artist)
    data = await _get(f"/artist/{artist_id}/top", limit=_clamp(limit))
    return _tracks(data)
