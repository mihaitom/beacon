"""core/lastfm.py — Last.fm track lists for the playlist builder.

Six queries, all read-only and all answered with plain title/artist text:
country and global charts, a genre tag's top tracks, one artist's top
tracks, one track's similar tracks, and a person's own top tracks. Turning
those names back into songs that exist in *this* library happens in the
renderer
(services/library/lastfmMatcher.ts), for the same reason
core/recommendations.py leaves its artist names to the frontend: connect
has no unified way to search a library. MediaClient (media/base.py) only
resolves a track that is already known by id, and search3 lives in the
bridge dispatch behind routes/proxy.py — which the renderer already speaks
to for all three server types.

Only an *application* key is needed (LASTFM_API_KEY). Last.fm's
`user.getTopTracks` takes a plain public username as a parameter, so
reading someone's top tracks needs no OAuth and no per-user secret; the
signed auth flow would only come in for writing (scrobbling, loving a
track), which this does not do. The key is deliberately server-side: the
web build's bundle is public, and an application key does not belong in it.

It is entered in Settings and stored by core/api_keys.py alongside the other
installation-wide keys, rather than read only from LASTFM_API_KEY, because a
desktop install has no way to set that variable. The value itself is an
*application* key for reading public charts, not a login: it grants no access
to anyone's Last.fm account and cannot write anything (that needs the shared
secret and a signed session, neither of which Beacon holds).
"""

import logging

import httpx

from core import api_keys, title_match
from lyrics.shared import USER_AGENT

logger = logging.getLogger("connect.lastfm")

_BASE_URL = "https://ws.audioscrobbler.com/2.0/"
_TIMEOUT = 15.0

# Last.fm caps a single page at 1000; the builder's own ceiling is far
# lower, this only stops a hand-crafted request from asking for a page the
# API would reject outright.
_MAX_LIMIT = 1000

# How many track.search hits the similar-tracks fallback weighs. Enough to
# contain the widely-scrobbled version of a song without pulling a page of
# unrelated names with it.
_SEARCH_LIMIT = 10

# Last.fm answers an application error with HTTP 200 and an `error` number
# in the body, so status_code alone never reveals it. Only the ones worth
# telling apart downstream — everything else becomes a plain upstream
# failure. 6 covers both an unknown user and an unknown artist/tag.
_ERR_INVALID_PARAM = 6
_ERR_SUSPENDED_KEY = 26

_client = httpx.AsyncClient(timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT})


class LastfmError(Exception):
    """A failure the caller can report on. `not_found` separates "you asked
    for something that does not exist" (a bad username or tag, worth showing
    the user) from an upstream problem they can do nothing about."""

    def __init__(self, message: str, not_found: bool = False) -> None:
        super().__init__(message)
        self.not_found = not_found


def api_key() -> str:
    """The key in effect: whatever Settings stored, else LASTFM_API_KEY
    (see core/api_keys.py for the storage and precedence)."""
    return api_keys.get("lastfm")


def set_api_key(key: str) -> None:
    """Stores a key entered in Settings, or clears it when given ''."""
    api_keys.set("lastfm", key)


def stored_key() -> str:
    """Only what Settings persisted, ignoring the environment - what the
    status needs to tell the two sources apart."""
    return api_keys.stored("lastfm")


def is_configured() -> bool:
    return api_keys.is_configured("lastfm")


async def _get(method: str, **params) -> dict:
    try:
        resp = await _client.get(
            _BASE_URL,
            params={"method": method, "api_key": api_key(), "format": "json", **params},
        )
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as e:
        logger.warning(f"[lastfm] {method} failed: {e}")
        raise LastfmError(f"Last.fm request failed: {e}") from e
    except ValueError as e:  # non-JSON body
        logger.warning(f"[lastfm] {method} returned an unparseable body: {e}")
        raise LastfmError("Last.fm returned an unreadable response") from e

    if isinstance(data, dict) and "error" in data:
        code = data.get("error")
        message = data.get("message", "Unknown Last.fm error")
        logger.warning(f"[lastfm] {method} -> error {code}: {message}")
        if code == _ERR_SUSPENDED_KEY:
            raise LastfmError("This Beacon installation's Last.fm API key was rejected")
        raise LastfmError(message, not_found=(code == _ERR_INVALID_PARAM))
    return data


def _track_list(container: dict | None) -> list[dict]:
    """The `track` member of a Last.fm response, always as a list. The API
    is generated from its XML form, so a single result comes back as a bare
    object rather than a one-element list — asking for the top 1 track of a
    tag otherwise iterates over the *keys* of that object."""
    if not isinstance(container, dict):
        return []
    raw = container.get("track")
    if isinstance(raw, dict):
        return [raw]
    return raw if isinstance(raw, list) else []


def _to_tracks(raw: list[dict]) -> list[dict]:
    """Title + artist, plus the recording MBID where Last.fm has one. The
    MBID is frequently absent and frequently wrong when present, so the
    matcher treats it as a shortcut to confirm a candidate, never as the
    identity of the track — see lastfmMatcher.ts."""
    tracks = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        title = (entry.get("name") or "").strip()
        artist = entry.get("artist")
        # artist is an object on every endpoint used here, but a bare
        # string on some other Last.fm methods — cheap to tolerate both.
        if isinstance(artist, dict):
            artist_name = (artist.get("name") or "").strip()
        else:
            artist_name = (artist or "").strip()
        if not title or not artist_name:
            continue
        tracks.append({"title": title, "artist": artist_name, "mbid": entry.get("mbid") or ""})
    return tracks


def _clamp(limit: int) -> int:
    return max(1, min(int(limit), _MAX_LIMIT))


async def get_geo_top_tracks(country: str, limit: int) -> list[dict]:
    data = await _get("geo.getTopTracks", country=country, limit=_clamp(limit))
    return _to_tracks(_track_list(data.get("tracks")))


async def get_global_top_tracks(limit: int) -> list[dict]:
    data = await _get("chart.getTopTracks", limit=_clamp(limit))
    return _to_tracks(_track_list(data.get("tracks")))


async def get_tag_top_tracks(tag: str, limit: int) -> list[dict]:
    data = await _get("tag.getTopTracks", tag=tag, limit=_clamp(limit))
    return _to_tracks(_track_list(data.get("tracks")))


async def get_artist_top_tracks(artist: str, limit: int) -> list[dict]:
    data = await _get("artist.getTopTracks", artist=artist, limit=_clamp(limit))
    return _to_tracks(_track_list(data.get("toptracks")))


def _same_track(a: dict, b: dict) -> bool:
    """Whether two title/artist pairs name the same recording by spelling
    alone, using the normalisation the rest of the app compares names with.
    Only used to keep the seed out of its own similar list."""
    return title_match.normalize(a.get("title", "")) == title_match.normalize(
        b.get("title", "")
    ) and title_match.normalize(a.get("artist", "")) == title_match.normalize(b.get("artist", ""))


def _listeners(entry: dict) -> int:
    try:
        return int(entry.get("listeners") or 0)
    except (TypeError, ValueError):
        return 0


async def _similar_for(artist: str, track: str, limit: int) -> list[dict]:
    """track.getSimilar for one spelling. autocorrect is on: a file's tag is
    often the album spelling where Last.fm's canonical name is the single's,
    and without it those find nothing rather than the obvious track."""
    data = await _get(
        "track.getSimilar",
        artist=artist,
        track=track,
        autocorrect=1,
        limit=_clamp(limit),
    )
    return _to_tracks(_track_list(data.get("similartracks")))


async def _most_listened_match(artist: str, track: str) -> dict | None:
    """The most-listened Last.fm track for an artist/title pair. Used when
    the seed itself has no similar-tracks data: the widely-scrobbled version
    of the same song usually does."""
    data = await _get("track.search", track=track, artist=artist, limit=_SEARCH_LIMIT)
    results = data.get("results")
    matches = _track_list(results.get("trackmatches") if isinstance(results, dict) else None)

    best: dict | None = None
    best_listeners = -1
    for entry in matches:
        if not isinstance(entry, dict):
            continue
        name = (entry.get("name") or "").strip()
        entry_artist = entry.get("artist")
        if isinstance(entry_artist, dict):
            entry_artist = entry_artist.get("name")
        entry_artist = (entry_artist or "").strip()
        if not name or not entry_artist:
            continue
        candidate = {"title": name, "artist": entry_artist}
        # The seed itself is the one version already known to have no
        # similar data, so it cannot be its own fallback.
        if _same_track(candidate, {"title": track, "artist": artist}):
            continue
        if _listeners(entry) > best_listeners:
            best_listeners = _listeners(entry)
            best = candidate
    return best


async def get_similar_tracks(artist: str, track: str, limit: int) -> list[dict]:
    """Tracks Last.fm considers similar to one given track.

    A track with too few scrobbles has no similar-tracks data at all, even
    though Last.fm knows it - measured on "Luciano - Bamba", which answered
    an empty list while its widely-scrobbled "(feat. ...)" version answered
    normally. Trying the most-listened match for the same artist/title is
    the difference between an empty playlist and a useful one, so it is
    tried before giving up. The version that answered is the seed itself,
    spelled differently, and is dropped from the result."""
    similar = await _similar_for(artist, track, limit)
    if similar:
        return similar

    alternative = await _most_listened_match(artist, track)
    if alternative is None:
        return []

    similar = await _similar_for(alternative["artist"], alternative["title"], limit)
    seed = {"title": track, "artist": artist}
    return [
        entry
        for entry in similar
        if not _same_track(entry, alternative) and not _same_track(entry, seed)
    ]


async def get_user_top_tracks(username: str, period: str, limit: int) -> list[dict]:
    data = await _get("user.getTopTracks", user=username, period=period, limit=_clamp(limit))
    return _to_tracks(_track_list(data.get("toptracks")))
