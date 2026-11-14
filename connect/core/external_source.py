"""core/external_source.py - apps of the user's own that bring songs the
library does not have. Each is a "source" with a tab of its own.

Beacon ships no such app and knows nothing about where its audio comes from.
The app serves a page for a tab (passed through by routes/external_source.py)
and audio behind URLs on its own address. A song from it gets an `ext:` id
here, and from then on it is a song like any other: the media clients hand
`ext:` ids to this module (media/base.py's routes_external), so casting,
transitions, waveforms and the lights need no change of their own.

See docs/plans/external-source.md and docs/help/guides/external-sources.md.
"""

import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from urllib.parse import urljoin, urlsplit

from core.paths import data_dir
from media.base import Track

logger = logging.getLogger("connect.external_source")

ID_PREFIX = "ext:"

_CONFIG_PATH = os.path.join(data_dir(), "external_sources.json")
# A single source, from before there could be several. Read once, then moved.
_OLD_CONFIG_PATH = os.path.join(data_dir(), "external_source.json")
_ITEMS_PATH = os.path.join(data_dir(), "external_items.sqlite")

# A queue restored after a while must still find its songs, a song nobody has
# played for months need not be kept. The app is asked to keep its URLs valid
# for a day; this is only about the metadata.
_ITEM_MAX_AGE_SECONDS = 90 * 24 * 3600

_TEXT_LIMIT = 500

# Each source is a tab in the navigation; past a dozen that is no longer a
# navigation.
MAX_SOURCES = 12

DEFAULT_ICON = "mdi-web"
# An icon name the renderer can show, nothing it would have to interpret.
_ICON = re.compile(r"^mdi-[a-z0-9-]{1,40}$")

_lock = threading.Lock()

# The tab's address carries this instead of the connect token: the page's own
# requests come from a sandboxed, origin-less document that can attach no
# header and no cookie. New on every start, so an old link stops working.
_ui_secret = secrets.token_urlsafe(24)


class ExternalSourceError(ValueError):
    """A request about the external source that cannot be honoured, with a
    message meant for the person who made it."""


def is_external_id(item_id: object) -> bool:
    return isinstance(item_id, str) and item_id.startswith(ID_PREFIX)


def ui_secret() -> str:
    return _ui_secret


def ui_secret_matches(candidate: str) -> bool:
    return secrets.compare_digest(candidate, _ui_secret)


# --- configuration -----------------------------------------------------------


def normalize_base_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ExternalSourceError("The address must start with http:// or https://")
    if parts.query or parts.fragment:
        raise ExternalSourceError("The address must not contain ? or #")
    return url


def _clean(entry: object) -> dict | None:
    if not isinstance(entry, dict) or not entry.get("base_url") or not entry.get("id"):
        return None
    icon = str(entry.get("icon") or "")
    return {
        "id": str(entry["id"]),
        "name": str(entry.get("name") or ""),
        "icon": icon if _ICON.match(icon) else DEFAULT_ICON,
        "base_url": str(entry["base_url"]),
        "token": str(entry.get("token") or ""),
    }


def _write(sources: list[dict]) -> None:
    os.makedirs(os.path.dirname(_CONFIG_PATH), exist_ok=True)
    tmp = f"{_CONFIG_PATH}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"sources": sources}, f, indent=2)
    # The tokens are credentials for the user's apps.
    os.chmod(tmp, 0o600)
    os.replace(tmp, _CONFIG_PATH)


def _read_old() -> list[dict]:
    try:
        with open(_OLD_CONFIG_PATH, encoding="utf-8") as f:
            old = json.load(f)
    except FileNotFoundError:
        return []
    except Exception as e:
        logger.warning(f"[external-source] Could not read the old configuration: {e}")
        return []
    source = _clean({**old, "id": secrets.token_hex(4)}) if isinstance(old, dict) else None
    sources = [source] if source else []
    _write(sources)
    os.unlink(_OLD_CONFIG_PATH)
    return sources


def _read() -> list[dict]:
    try:
        with open(_CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return _read_old()
    except Exception as e:
        logger.warning(f"[external-source] Could not read the configuration: {e}")
        return []
    entries = data.get("sources") if isinstance(data, dict) else None
    return [s for s in map(_clean, entries or []) if s]


def load_sources() -> list[dict]:
    """Every source, in the order they were added: {"id", "name", "icon",
    "base_url", "token"}."""
    with _lock:
        return _read()


def get_source(source_id: str) -> dict | None:
    return next((s for s in load_sources() if s["id"] == source_id), None)


def save_source(source_id: str | None, name: str, icon: str, base_url: str, token: str) -> dict:
    """Adds a source (`source_id` None) or changes one."""
    name = (name or "").strip()[:60]
    if not name:
        raise ExternalSourceError("The source needs a name")
    icon = (icon or "").strip() or DEFAULT_ICON
    if not _ICON.match(icon):
        raise ExternalSourceError("Unknown icon")
    source = {
        "id": source_id or secrets.token_hex(4),
        "name": name,
        "icon": icon,
        "base_url": normalize_base_url(base_url),
        "token": (token or "").strip(),
    }
    with _lock:
        sources = _read()
        index = next((i for i, s in enumerate(sources) if s["id"] == source_id), None)
        if source_id is not None and index is None:
            raise KeyError(source_id)
        if index is None:
            if len(sources) >= MAX_SOURCES:
                raise ExternalSourceError(f"At most {MAX_SOURCES} sources")
            sources.append(source)
        else:
            sources[index] = source
        _write(sources)
    return source


def remove_source(source_id: str) -> bool:
    with _lock:
        sources = _read()
        kept = [s for s in sources if s["id"] != source_id]
        if len(kept) == len(sources):
            return False
        _write(kept)
    return True


def _origin(url: str) -> tuple:
    parts = urlsplit(url)
    return (parts.scheme, parts.hostname, parts.port)


def resolve_app_url(config: dict, url: str) -> str:
    """`url` as the page sent it, made absolute against the app's `ui/`
    folder and refused unless it points at the app itself.

    The page is not Beacon's code, and without this check connect would fetch
    whatever address it is handed, from inside the user's network."""
    base = config["base_url"]
    absolute = urljoin(f"{base}/ui/", (url or "").strip())
    if _origin(absolute) != _origin(base):
        raise ExternalSourceError("Audio and cover must come from the source's own address")
    return absolute


# --- the songs ---------------------------------------------------------------


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(_ITEMS_PATH), exist_ok=True)
    conn = sqlite3.connect(_ITEMS_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            artist TEXT NOT NULL,
            album TEXT NOT NULL,
            duration INTEGER NOT NULL,
            audio_url TEXT NOT NULL,
            cover_url TEXT NOT NULL,
            used_at REAL NOT NULL
        )"""
    )
    return conn


def _text(value, fallback: str = "") -> str:
    return (str(value).strip() if value is not None else "")[:_TEXT_LIMIT] or fallback


def register(source_id: str, item: dict) -> Track:
    """Stores a song a source's page asked to play and returns it with its
    `ext:` id. The same audio URL always gets the same id, so playing a song
    twice does not leave two of it in the history."""
    config = get_source(source_id)
    if config is None:
        raise ExternalSourceError("No such external source")
    audio_url = resolve_app_url(config, item.get("audioUrl") or "")
    cover_url = resolve_app_url(config, item["coverUrl"]) if item.get("coverUrl") else ""
    try:
        duration = max(0, int(float(item.get("duration") or 0)))
    except (TypeError, ValueError):
        duration = 0
    track = Track(
        id=ID_PREFIX + hashlib.sha256(audio_url.encode()).hexdigest()[:24],
        title=_text(item.get("title"), "Unknown"),
        artist=_text(item.get("artist"), "Unknown"),
        duration=duration,
        album=_text(item.get("album")),
    )
    track.cover_art_id = track.id if cover_url else ""
    now = time.time()
    with _lock, _connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                track.id,
                track.title,
                track.artist,
                track.album,
                track.duration,
                audio_url,
                cover_url,
                now,
            ),
        )
        conn.execute("DELETE FROM items WHERE used_at < ?", (now - _ITEM_MAX_AGE_SECONDS,))
    return track


def _row(item_id: str) -> tuple | None:
    with _lock, _connect() as conn:
        return conn.execute(
            "SELECT id, title, artist, album, duration, audio_url, cover_url "
            "FROM items WHERE id = ?",
            (item_id,),
        ).fetchone()


def _require_row(item_id: str) -> tuple:
    row = _row(item_id)
    if row is None:
        raise KeyError(f"Unknown external song: {item_id}")
    return row


def get_track(item_id: str) -> Track:
    row = _require_row(item_id)
    return Track(
        id=row[0],
        title=row[1],
        artist=row[2],
        album=row[3],
        duration=row[4],
        cover_art_id=row[0] if row[6] else "",
    )


def _still_offered(url: str) -> bool:
    """Whether a source with this address is still set up: once one is
    removed, connect stops fetching from it, history or not."""
    return any(_origin(s["base_url"]) == _origin(url) for s in load_sources())


def get_stream_url(item_id: str) -> str:
    url = _require_row(item_id)[5]
    if not _still_offered(url):
        raise KeyError(f"External song from a removed source: {item_id}")
    return url


def get_cover_art_url(item_id: str, internal: bool = False, size: int = 300) -> str | None:
    # Both audiences get the app's own address: a cast device fetches it
    # directly, and the renderer always goes through /rest/getCoverArt,
    # which connect answers from here (media/external_bridge.py).
    row = _row(item_id)
    return row[6] if row and row[6] and _still_offered(row[6]) else None


def subsonic_song(track: Track) -> dict:
    """The shape getSong answers with, so the renderer can treat the song
    like a library one."""
    song = {
        "id": track.id,
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "duration": track.duration,
        "isDir": False,
        "type": "music",
    }
    if track.cover_art_id:
        song["coverArt"] = track.cover_art_id
    return song
