"""core/deezer.py — Deezer charts, an artist's top tracks or radio, and
public Deezer playlists, for the playlist builder.

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
import re
import unicodedata
from urllib.parse import urlsplit

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

# A playlist is matched against the library whole rather than cut to the
# builder's track count - a curated list cut in half is not that list. This
# only stops a 10,000-track user playlist from turning into 10,000 library
# searches.
_MAX_PLAYLIST_TRACKS = 500

# Deezer's "no data" error code: an id that does not exist.
_NO_DATA = 800

_PLAYLIST_PATH = re.compile(r"/playlist/(\d+)")
# Share links are short redirects to the real page. Only these hosts are
# followed - a pasted link is user input, and connect must not fetch
# whatever address it is handed.
_SHARE_HOSTS = {"link.deezer.com", "deezer.page.link"}
_DEEZER_HOSTS = {"deezer.com", "www.deezer.com"}

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
        code = error.get("code") if isinstance(error, dict) else None
        logger.warning(f"[deezer] {path} -> {message}")
        raise DeezerError(f"Deezer: {message}", not_found=code == _NO_DATA)
    return data


def _tracks(data: dict) -> list[dict]:
    """Deezer's track objects in the shape every builder source returns.
    Deezer has no MBIDs, so that field stays empty; `deezerId` is what lets
    a preview of this exact track be fetched later (get_preview())."""
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
        track_id = entry.get("id")
        tracks.append(
            {
                "title": title,
                "artist": artist,
                "mbid": "",
                "album": (album.get("title") or "").strip(),
                "coverArtUrl": album.get("cover_medium") or "",
                "duration": duration if isinstance(duration, int) else 0,
                "deezerId": track_id if isinstance(track_id, int) else 0,
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


async def get_artist_radio(artist: str, limit: int) -> list[dict]:
    """Deezer's mix of the artist and acts like them - newly shuffled on
    every call, so a second run gives a different playlist."""
    artist_id = await _find_artist(artist)
    data = await _get(f"/artist/{artist_id}/radio", limit=_clamp(limit))
    return _tracks(data)


def _playlist(entry: dict) -> dict | None:
    playlist_id = entry.get("id")
    title = (entry.get("title") or "").strip()
    if not isinstance(playlist_id, int) or not title:
        return None
    # A search result names its owner "user", a playlist fetched by id
    # "creator".
    owner = entry.get("user") or entry.get("creator") or {}
    track_count = entry.get("nb_tracks")
    return {
        "id": playlist_id,
        "title": title,
        "owner": (owner.get("name") or "").strip(),
        "trackCount": track_count if isinstance(track_count, int) else 0,
        "pictureUrl": entry.get("picture_medium") or "",
    }


async def _playlist_id_from_link(text: str) -> int | None:
    """The playlist id in a pasted Deezer link, following a share link's
    redirect to find it. None when the text is not a Deezer link at all."""
    url = text.strip()
    host = (urlsplit(url).hostname or "").lower()
    if host in _SHARE_HOSTS:
        for _ in range(3):
            try:
                resp = await _client.get(url, follow_redirects=False)
            except httpx.HTTPError as e:
                raise DeezerError(f"Deezer request failed: {e}") from e
            location = resp.headers.get("location")
            if not resp.is_redirect or not location:
                break
            url = location
            host = (urlsplit(url).hostname or "").lower()
            if host not in _SHARE_HOSTS:
                break
    if host not in _DEEZER_HOSTS:
        return None
    match = _PLAYLIST_PATH.search(urlsplit(url).path)
    if not match:
        raise DeezerError("That Deezer link is not a playlist", not_found=True)
    return int(match.group(1))


async def search_playlists(query: str, limit: int = 25) -> list[dict]:
    """Public Deezer playlists for the builder's picker: the most popular
    ones for an empty query, a search otherwise, and the one playlist when
    the query is a pasted Deezer link."""
    query = query.strip()
    if query.lower().startswith(("http://", "https://")):
        playlist_id = await _playlist_id_from_link(query)
        if playlist_id is None:
            return []
        found = _playlist(await _get(f"/playlist/{playlist_id}"))
        return [found] if found else []
    if query:
        data = await _get("/search/playlist", q=query, limit=limit)
    else:
        data = await _get("/chart/0/playlists", limit=limit)
    entries = (_playlist(e) for e in data.get("data") or [] if isinstance(e, dict))
    return [entry for entry in entries if entry]


async def get_playlist_tracks(playlist_id: int) -> list[dict]:
    data = await _get(f"/playlist/{int(playlist_id)}/tracks", limit=_MAX_PLAYLIST_TRACKS)
    return _tracks(data)


# How many search hits to look through for a preview. Deezer ranks remixes
# and covers above the original often enough (measured: "Massive Attack
# Teardrop" put three other versions first) that the top few are not enough.
_PREVIEW_CANDIDATES = 25


def _plain(text: str) -> str:
    """Case, accents and punctuation folded away, for comparing a name the
    way the renderer's own matcher does (services/stringMatch.ts)."""
    folded = unicodedata.normalize("NFKD", text.casefold())
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    folded = re.sub(r"['’`´]", "", folded)
    return " ".join(re.sub(r"[^\w]+", " ", folded).split())


def _pick_preview(entries: list, artist: str, title: str) -> dict | None:
    """The hit that really is this artist's song: the artist has to match,
    and the title in order of preference exactly as asked, then the same
    title in another version (title_short drops "(Radio Edit)", "(Remix)"),
    then as the start of a longer title. Deezer ranks a popular remix above
    the plain version, so the plain one is preferred whatever its rank; the
    most popular only decides within a tier. No hit rather than a wrong one
    - a preview of a different song is worse than none."""
    want_artist, want_title = _plain(artist), _plain(title)
    as_asked, other_version, prefixed = [], [], []
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get("preview"):
            continue
        if _plain((entry.get("artist") or {}).get("name") or "") != want_artist:
            continue
        full = _plain(entry.get("title") or "")
        short = _plain(entry.get("title_short") or "") or full
        if full == want_title:
            as_asked.append(entry)
        elif short == want_title:
            other_version.append(entry)
        elif short.startswith(want_title + " "):
            prefixed.append(entry)
    pool = as_asked or other_version or prefixed
    return max(pool, key=lambda e: e.get("rank") or 0) if pool else None


# A Deezer preview stands in a preview run (core/preview.py) as a song with
# this id prefix, so the mix engine, the cast and the waveform can tell it
# from a library song and fetch its audio from Deezer instead.
PREVIEW_ID_PREFIX = "deezer:"


def is_preview_id(song_id: str | None) -> bool:
    return bool(song_id) and song_id.startswith(PREVIEW_ID_PREFIX)


async def get_preview(artist: str, title: str, track_id: int = 0) -> dict | None:
    """The Deezer track a preview can be played of, for a track from any
    of the builder's services: {id, link}, or None when Deezer has no
    preview of it. A Deezer track is checked by its id; anything else is
    looked up by name. The audio URL itself is not handed out - it expires
    (about 15 minutes, measured), so preview_stream_url() asks for a fresh
    one whenever the preview is played."""
    if track_id:
        entry = await _get(f"/track/{int(track_id)}")
    else:
        data = await _get("/search", q=f"{artist} {title}", limit=_PREVIEW_CANDIDATES)
        entry = _pick_preview(data.get("data") or [], artist, title)
    if not entry or not entry.get("preview") or not isinstance(entry.get("id"), int):
        return None
    return {"id": entry["id"], "link": entry.get("link") or ""}


async def preview_stream_url(song_id: str) -> str | None:
    """The audio of a preview id (PREVIEW_ID_PREFIX), freshly signed."""
    try:
        track_id = int(song_id.removeprefix(PREVIEW_ID_PREFIX))
        entry = await _get(f"/track/{track_id}")
    except (ValueError, DeezerError) as e:
        logger.warning(f"[deezer] No preview audio for {song_id}: {e}")
        return None
    return entry.get("preview") or None
