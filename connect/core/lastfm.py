"""core/lastfm.py — Last.fm track lists for the playlist builder.

Five queries, all read-only and all answered with plain title/artist text:
country and global charts, a genre tag's top tracks, one artist's top
tracks, and a person's own top tracks. Turning those names back into songs
that exist in *this* library happens in the renderer
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

It is entered in Settings and persisted here rather than only read from
LASTFM_API_KEY, because a desktop install has no way to set that variable -
see api_key() below.
"""

import logging
import os
import threading

import httpx

from lyrics.shared import USER_AGENT

logger = logging.getLogger("connect.lastfm")

_BASE_URL = "https://ws.audioscrobbler.com/2.0/"
_TIMEOUT = 15.0

# Persisted the same way as the log level (see core/log_level.py):
# CONNECT_DATA_DIR survives an Electron app update, whose packaged resources
# folder is replaced wholesale, and a Docker container recreation. Which
# matters more here than it does for a log level - a desktop install has
# nowhere else to put this. The bundled backend inherits Electron's own
# environment (src/main/index.ts's startConnectServer), and nobody who opens
# an app by double-clicking it has LASTFM_API_KEY in there.
_DATA_DIR = os.environ.get("CONNECT_DATA_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
_PATH = os.path.join(_DATA_DIR, "lastfm_api_key.txt")

# Never read at import time, unlike the rest of connect's config: Settings
# can change this key while the process runs, and an import-time constant
# would keep serving the old one until a restart.
_cached_key: str | None = None
_key_lock = threading.Lock()

# Last.fm caps a single page at 1000; the builder's own ceiling is far
# lower, this only stops a hand-crafted request from asking for a page the
# API would reject outright.
_MAX_LIMIT = 1000

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


def _load_persisted() -> str:
    try:
        with open(_PATH, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""
    except Exception as e:
        logger.warning(f"[lastfm] Could not read the stored API key: {e}")
        return ""


def api_key() -> str:
    """The key in effect: whatever Settings stored, else LASTFM_API_KEY.

    Same precedence as core/log_level.py's initial_level() - a value
    entered in the app wins over the environment, so a Docker deployment
    that sets the variable still gets a sensible starting point while
    anyone can change it later without touching the container."""
    global _cached_key
    with _key_lock:
        if _cached_key is None:
            _cached_key = _load_persisted() or os.getenv("LASTFM_API_KEY", "").strip()
        return _cached_key


def set_api_key(key: str) -> None:
    """Stores a key entered in Settings, or clears it when given ''. An
    empty value falls back to LASTFM_API_KEY rather than to nothing, which
    is what makes clearing the field in a Docker deployment return to the
    environment's key instead of switching the builder off."""
    global _cached_key
    cleaned = key.strip()
    with _key_lock:
        try:
            os.makedirs(os.path.dirname(_PATH), exist_ok=True)
            if cleaned:
                with open(_PATH, "w", encoding="utf-8") as f:
                    f.write(cleaned)
            else:
                try:
                    os.unlink(_PATH)
                except FileNotFoundError:
                    pass
        except Exception as e:
            logger.error(f"[lastfm] Could not store the API key: {e}")
        # Re-resolved on the next api_key() call rather than set straight
        # to `cleaned`, so clearing it picks the environment's key back up.
        _cached_key = None
    logger.info(f"[lastfm] API key {'stored' if cleaned else 'cleared'}")


def stored_key() -> str:
    """Only what Settings persisted, ignoring the environment - what the
    route needs to tell the two sources apart."""
    return _load_persisted()


def is_configured() -> bool:
    return bool(api_key())


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


async def get_user_top_tracks(username: str, period: str, limit: int) -> list[dict]:
    data = await _get("user.getTopTracks", user=username, period=period, limit=_clamp(limit))
    return _to_tracks(_track_list(data.get("toptracks")))
