"""core/audiomuse.py - AudioMuse-AI as the source of "what sounds like this".

AudioMuse-AI analyses a library's audio itself and answers similarity
questions from that analysis. A Navidrome with its plugin already answers
getSimilarSongs2 that way; talking to it directly is what adds the rest:
several seeds at once with songs to steer away from (Autoplay), a method
per request (Discovery Radio), and Jellyfin and Plex, whose own similar-songs
endpoints know nothing of it. See docs/plans/audiomuse.md.

Optional throughout. Every caller treats AudioMuseError as "use what you
used before", so not configured, not reachable, too old and "has not
analysed this song" all end in today's behaviour.

Ids are the media server's own in both directions: AudioMuse translates to
its internal content ids and back. Which of its servers is the session's is
found by asking it for one song and looking that id up on the session's own
server (`_probe()`), because a URL comparison alone cannot tell a
reverse-proxied name from a different server.

Its results carry title and artist but no duration, cover or album id, so
every result is looked up on the media server before it leaves here
(`_hydrate()`), through the same Subsonic calls the proxy answers - which is
what makes the bridges work unchanged.
"""

import asyncio
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from core import api_keys
from core.party_library import subsonic_call
from core.paths import data_dir
from lyrics.shared import USER_AGENT
from media import server_type_name

logger = logging.getLogger("connect.audiomuse")

SERVICE = "audiomuse"
MIN_VERSION = (3, 7, 0)

# Every similarity call measured well under half a second against a real
# instance. The short connect timeout is for a desktop app away from home,
# where the address simply does not answer: Autoplay must fall back before
# the queue runs out, not after.
_TIMEOUT = httpx.Timeout(6.0, connect=2.0)

# Status and server mapping are asked on every login and every mix; neither
# changes from one minute to the next. A failure is kept shorter so a
# restarted AudioMuse is picked up again soon.
_STATUS_TTL = 300.0
_FAILURE_TTL = 30.0

# How many results to ask for beyond what the caller wants: songs already
# in the queue come back as candidates and are dropped here. Capped, since
# the queue a long session excludes grows without bound.
_MAX_ASK = 200
_MAX_EXCLUDE = 1000

# Parallel getSong lookups. Enough to hydrate a batch in about one round
# trip, few enough not to be a burst against a small Navidrome.
_HYDRATE_CONCURRENCY = 8

# AudioMuse's server types that hold the ids a Beacon session of each kind
# uses.
_COMPATIBLE_TYPES = {
    "subsonic": {"navidrome"},
    "jellyfin": {"jellyfin"},
    "plex": {"plex"},
}

_DATA_DIR = data_dir()
_url_lock = threading.Lock()


class AudioMuseError(Exception):
    """Anything that means "answer without AudioMuse". `reason` is what
    Settings shows: not-configured, unreachable, unauthorized, too-old,
    no-server, failed."""

    def __init__(self, reason: str, message: str = "") -> None:
        super().__init__(message or reason)
        self.reason = reason


# ── configuration ───────────────────────────────────────────────────────────
#
# The key lives in core/api_keys.py like every other one (so it is lent to a
# paired desktop the same way); the base URL is not a secret and has its own
# small file, with the same three sources in the same order.


def _url_path() -> str:
    return os.path.join(_DATA_DIR, "audiomuse_url.txt")


def _shared_url_path() -> str:
    return os.path.join(_DATA_DIR, "audiomuse_url.shared.txt")


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""
    except OSError as e:
        logger.warning(f"[audiomuse] Could not read {os.path.basename(path)}: {e}")
        return ""


def _write(path: str, value: str) -> None:
    with _url_lock:
        try:
            if value:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(value)
            else:
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass
        except OSError as e:
            logger.error(f"[audiomuse] Could not store {os.path.basename(path)}: {e}")
    _forget_cached_state()


def normalise_url(value: str) -> str:
    """What Settings stores: scheme and host, no trailing slash. A bare host
    gets http://, since that is how AudioMuse is reached on a home network."""
    cleaned = value.strip().rstrip("/")
    if not cleaned:
        return ""
    if not re.match(r"^[a-z][a-z0-9+.-]*://", cleaned, re.IGNORECASE):
        cleaned = f"http://{cleaned}"
    parts = urlsplit(cleaned)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("Not an http(s) address")
    return cleaned


def stored_url() -> str:
    return _read(_url_path())


def base_url() -> str:
    """Settings, else AUDIOMUSE_URL, else what a paired server lent."""
    return stored_url() or os.getenv("AUDIOMUSE_URL", "").strip().rstrip("/") or _shared_url()


def _shared_url() -> str:
    return _read(_shared_url_path())


def set_url(value: str) -> None:
    _write(_url_path(), normalise_url(value))


def set_shared_url(value: str) -> None:
    """The address a paired Beacon server lent along with its key."""
    try:
        cleaned = normalise_url(value) if value else ""
    except ValueError:
        cleaned = ""
    if cleaned != _shared_url():
        _write(_shared_url_path(), cleaned)


def is_configured() -> bool:
    return bool(base_url() and api_keys.get(SERVICE))


def settings_status() -> dict:
    url_from_settings = bool(stored_url())
    url_from_env = bool(os.getenv("AUDIOMUSE_URL", "").strip())
    url = base_url()
    return {
        "url": url,
        "urlFromEnvironment": bool(url) and not url_from_settings and url_from_env,
        "urlFromServer": bool(url) and not url_from_settings and not url_from_env,
        "key": api_keys.status(SERVICE),
    }


# ── HTTP ────────────────────────────────────────────────────────────────────

_client = httpx.AsyncClient(timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT})


async def _request(method: str, path: str, **kwargs) -> object:
    url, key = base_url(), api_keys.get(SERVICE)
    if not url or not key:
        raise AudioMuseError("not-configured")
    try:
        resp = await _client.request(
            method, f"{url}{path}", headers={"Authorization": f"Bearer {key}"}, **kwargs
        )
    except httpx.HTTPError as e:
        logger.info(f"[audiomuse] {path} unreachable: {e!r}")
        raise AudioMuseError("unreachable", str(e)) from e
    if resp.status_code in (401, 403):
        raise AudioMuseError("unauthorized")
    if resp.status_code >= 400:
        # 404 is AudioMuse's "this song is not in the index"; 400 its
        # "this index is not built" - both an answer about one request.
        logger.info(f"[audiomuse] {path} answered {resp.status_code}")
        raise AudioMuseError("failed", f"HTTP {resp.status_code}")
    try:
        return resp.json()
    except ValueError as e:
        raise AudioMuseError("failed", "unreadable response") from e


def _parse_version(value: object) -> tuple[int, ...] | None:
    match = re.match(r"^v?(\d+)\.(\d+)(?:\.(\d+))?", str(value or "").strip())
    if not match:
        return None
    return tuple(int(part or 0) for part in match.groups())


# ── status and server mapping ───────────────────────────────────────────────


@dataclass
class _Cached:
    value: object
    expires: float


_status_cache: _Cached | None = None
_mapping_cache: dict[tuple, _Cached] = {}


def _forget_cached_state() -> None:
    global _status_cache
    _status_cache = None
    _mapping_cache.clear()


def forget_cached_state() -> None:
    """After the key changed: what was checked with the old one is void."""
    _forget_cached_state()


async def check() -> dict:
    """Whether this installation can use AudioMuse at all: reachable, the
    key accepted, new enough. Raises AudioMuseError otherwise."""
    global _status_cache
    now = time.monotonic()
    cached = _status_cache
    if cached and cached.expires > now:
        if isinstance(cached.value, AudioMuseError):
            raise cached.value
        return cached.value  # type: ignore[return-value]
    try:
        version_body = await _request("GET", "/api/version")
        version = _parse_version(
            version_body.get("app_version") if isinstance(version_body, dict) else None
        )
        if version is None or version < MIN_VERSION:
            raise AudioMuseError("too-old", f"AudioMuse-AI {version_body!r}")
        servers = await _servers()
        result = {
            "version": ".".join(str(part) for part in version),
            "servers": servers,
        }
        _status_cache = _Cached(result, now + _STATUS_TTL)
        return result
    except AudioMuseError as e:
        if e.reason != "not-configured":
            _status_cache = _Cached(e, now + _FAILURE_TTL)
        raise


async def _servers() -> list[dict]:
    body = await _request("GET", "/api/servers")
    rows = body.get("servers") if isinstance(body, dict) else None
    servers = []
    for row in rows or []:
        if not isinstance(row, dict) or not row.get("server_id"):
            continue
        creds = row.get("creds") if isinstance(row.get("creds"), dict) else {}
        servers.append(
            {
                "id": str(row["server_id"]),
                "name": str(row.get("name") or ""),
                "type": str(row.get("server_type") or "").lower(),
                "url": str(creds.get("url") or ""),
                "default": bool(row.get("is_default")),
            }
        )
    return servers


def _host_port(url: str) -> tuple[str, int | None] | None:
    try:
        parts = urlsplit(url if "://" in url else f"http://{url}")
        if not parts.hostname:
            return None
        port = parts.port or {"http": 80, "https": 443}.get(parts.scheme)
        return parts.hostname.lower(), port
    except ValueError:
        return None


def _media_addresses(media) -> set[tuple[str, int | None]]:
    addresses = set()
    for attr in ("base_url", "internal_url"):
        value = getattr(media, attr, "")
        address = _host_port(value) if isinstance(value, str) and value else None
        if address:
            addresses.add(address)
    return addresses


def candidates(media, servers: list[dict]) -> list[dict]:
    """AudioMuse's servers that could be the session's, most likely first:
    the right type, those reached under the same address before the rest,
    the default before others."""
    kinds = _COMPATIBLE_TYPES.get(server_type_name(media), set())
    addresses = _media_addresses(media)
    matching = [s for s in servers if s["type"] in kinds]
    return sorted(
        matching,
        key=lambda s: (_host_port(s["url"]) not in addresses, not s["default"]),
    )


def _same_title(a: object, b: object) -> bool:
    return str(a or "").strip().casefold() == str(b or "").strip().casefold()


async def _probe(media, server: dict) -> bool:
    """Whether a song AudioMuse lists for `server` is the same song under the
    same id on the session's media server."""
    try:
        rows = await _request(
            "GET",
            "/api/search_tracks",
            params={"search_query": "e", "end": 3, "server": server["id"]},
        )
    except AudioMuseError as e:
        if e.reason in ("unreachable", "unauthorized"):
            raise
        return False
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not row.get("item_id"):
            continue
        song = await _get_song(media, str(row["item_id"]))
        return song is not None and _same_title(song.get("title"), row.get("title"))
    return False


def _mapping_key(media) -> tuple:
    return (server_type_name(media), getattr(media, "base_url", ""))


async def server_for(media) -> dict:
    """The AudioMuse server holding this session's ids. Raises
    AudioMuseError("no-server") when none of them does."""
    status = await check()
    key = _mapping_key(media)
    now = time.monotonic()
    cached = _mapping_cache.get(key)
    if cached and cached.expires > now:
        if cached.value is None:
            raise AudioMuseError("no-server")
        return cached.value  # type: ignore[return-value]
    for server in candidates(media, status["servers"])[:3]:
        if await _probe(media, server):
            _mapping_cache[key] = _Cached(server, now + _STATUS_TTL)
            logger.info(f"[audiomuse] Session server matched AudioMuse server {server['name']!r}")
            return server
    _mapping_cache[key] = _Cached(None, now + _FAILURE_TTL)
    logger.info("[audiomuse] None of AudioMuse's servers holds this session's song ids")
    raise AudioMuseError("no-server")


async def session_status(media) -> dict:
    """What the renderer needs: whether the extra features are on, and if
    not, why (for Settings)."""
    if not is_configured():
        return {"available": False, "reason": "not-configured"}
    try:
        status = await check()
        server = await server_for(media)
    except AudioMuseError as e:
        return {"available": False, "reason": e.reason}
    return {"available": True, "version": status["version"], "server": server["name"]}


# ── songs ───────────────────────────────────────────────────────────────────


async def _get_song(media, song_id: str) -> dict | None:
    try:
        data = await subsonic_call(media, "getSong.view", id=song_id)
    except Exception as e:
        # Analysed once, since removed from the library, or not on this
        # server at all: not a failure of the mix, one song fewer in it.
        logger.debug(f"[audiomuse] getSong {song_id} failed: {e!r}")
        return None
    song = data.get("song") if isinstance(data, dict) else None
    return song if isinstance(song, dict) and song.get("id") else None


def _identity(song: dict) -> tuple[str, str]:
    return (
        str(song.get("title") or "").strip().casefold(),
        str(song.get("artist") or "").strip().casefold(),
    )


async def _hydrate(media, ids: list[str], limit: int, exclude: set[str]) -> list[dict]:
    """Full songs for `ids`, in order, without excluded ones, without a
    second copy of a recording (the same song on a compilation comes back
    as its own result), at most `limit` of them."""
    wanted = []
    for song_id in ids:
        if song_id and song_id not in exclude and song_id not in wanted:
            wanted.append(song_id)
    semaphore = asyncio.Semaphore(_HYDRATE_CONCURRENCY)

    async def one(song_id: str) -> dict | None:
        async with semaphore:
            return await _get_song(media, song_id)

    songs: list[dict] = []
    seen: set[tuple[str, str]] = set()
    # In slices of a little more than needed: most results survive, and a
    # whole over-fetched list would cost a lookup per song nobody hears.
    step = max(limit + limit // 2, 4)
    for start in range(0, len(wanted), step):
        for song in await asyncio.gather(*(one(i) for i in wanted[start : start + step])):
            if song is None:
                continue
            identity = _identity(song)
            if identity[0] and identity in seen:
                continue
            seen.add(identity)
            songs.append(song)
            if len(songs) >= limit:
                return songs
    return songs


def _result_ids(body: object) -> list[str]:
    rows = body.get("results") if isinstance(body, dict) else body
    if not isinstance(rows, list):
        return []
    return [str(row["item_id"]) for row in rows if isinstance(row, dict) and row.get("item_id")]


METHODS = ("similar", "discovery", "blend")


async def mix(
    media,
    method: str,
    add: list[dict],
    subtract: list[dict],
    n: int,
    exclude: list[str],
) -> list[dict]:
    """Songs for one of the three ways Beacon asks:

    - similar: neighbours of one song (Song Radio)
    - discovery: songs that sound related but sit further from the
      mainstream of the library, AudioMuse's hyperbolic "niche" (Discovery
      Radio)
    - blend: Song Alchemy over several songs or artists, minus others
      (Autoplay, Artist Radio)

    `add`/`subtract` items are {"id", "type": "song" | "artist"}. Results
    are full Subsonic songs, never one of the seeds or `exclude`."""
    if method not in METHODS:
        raise ValueError(f"Unknown method {method!r}")
    if not add:
        raise ValueError("At least one seed is needed")
    server = await server_for(media)
    excluded = set(exclude[:_MAX_EXCLUDE]) | {item["id"] for item in add + subtract}
    ask = min(n + len(excluded), _MAX_ASK)

    if method == "similar":
        body = await _request(
            "GET",
            "/api/similar_tracks",
            params={"item_id": add[0]["id"], "n": ask, "server": server["id"]},
        )
    elif method == "discovery":
        body = await _request(
            "POST",
            "/api/hyperbolic/similar",
            json={"item_id": add[0]["id"], "mode": "niche", "limit": ask, "server": server["id"]},
        )
    else:
        items = [{"id": i["id"], "op": "ADD", "type": i["type"]} for i in add] + [
            {"id": i["id"], "op": "SUBTRACT", "type": i["type"]} for i in subtract
        ]
        body = await _request(
            "POST", "/api/alchemy", json={"items": items, "n": ask, "server": server["id"]}
        )
    return await _hydrate(media, _result_ids(body), n, excluded)


# How many songs a path puts between the one playing and the one chosen, at
# most: about half an hour of getting there. AudioMuse's own default (25)
# is an evening's worth, more than "take me over to that song" means.
PATH_STEPS = 8

# The text searches run a model over the query (about 3 s for sound and 1.6 s
# for lyrics, measured), well past what a similarity lookup takes.
_SEARCH_TIMEOUT = httpx.Timeout(20.0, connect=2.0)

SEARCH_KINDS = ("sound", "lyrics")


async def path(media, start_id: str, end_id: str) -> list[dict]:
    """The songs leading from `start_id` to `end_id`, `end_id` last and
    `start_id` left out (it is the one already playing)."""
    server = await server_for(media)
    body = await _request(
        "GET",
        "/api/find_path",
        params={
            "start_song_id": start_id,
            "end_song_id": end_id,
            "max_steps": PATH_STEPS,
            "server": server["id"],
        },
    )
    rows = body.get("path") if isinstance(body, dict) else None
    ids = _result_ids(rows)
    songs = await _hydrate(media, ids, PATH_STEPS + 2, {start_id})
    # The path ends on the chosen song even where the lookup dropped or
    # merged songs on the way.
    if not songs or songs[-1].get("id") != end_id:
        end = await _get_song(media, end_id)
        if end is None:
            raise AudioMuseError("failed", "the chosen song is not on the media server")
        songs = [song for song in songs if song.get("id") != end_id] + [end]
    return songs


async def search(media, kind: str, query: str, n: int) -> list[dict]:
    """Songs found by describing their sound ("calm piano") or what their
    lyrics are about ("leaving home")."""
    if kind not in SEARCH_KINDS:
        raise ValueError(f"Unknown search kind {kind!r}")
    server = await server_for(media)
    endpoint = "/api/clap/search" if kind == "sound" else "/api/lyrics/search/text"
    body = await _request(
        "POST",
        endpoint,
        json={"query": query, "limit": n, "server": server["id"]},
        timeout=_SEARCH_TIMEOUT,
    )
    return await _hydrate(media, _result_ids(body), n, set())
