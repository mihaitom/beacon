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
import ipaddress
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

# How long a removal is remembered for a paired side that has not heard of it
# yet; as long as the songs are kept.
_REMOVED_MAX_AGE_SECONDS = _ITEM_MAX_AGE_SECONDS

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
    try:
        updated_at = float(entry.get("updated_at") or 0)
    except (TypeError, ValueError):
        updated_at = 0.0
    return {
        "id": str(entry["id"]),
        "name": str(entry.get("name") or ""),
        "icon": icon if _ICON.match(icon) else DEFAULT_ICON,
        "base_url": str(entry["base_url"]),
        "token": str(entry.get("token") or ""),
        "updated_at": updated_at,
        # The rest is about a paired server, see the sync section below.
        "synced": bool(entry.get("synced")),
        "token_lent": bool(entry.get("token_lent")),
        "token_pending": bool(entry.get("token_pending")),
    }


def _clean_removed(removed: object, now: float) -> dict[str, float]:
    if not isinstance(removed, dict):
        return {}
    kept = {}
    for source_id, stamp in removed.items():
        try:
            stamp = float(stamp)
        except (TypeError, ValueError):
            continue
        if now - stamp < _REMOVED_MAX_AGE_SECONDS:
            kept[str(source_id)] = stamp
    return kept


def _write(sources: list[dict], removed: dict[str, float] | None = None) -> None:
    os.makedirs(os.path.dirname(_CONFIG_PATH), exist_ok=True)
    tmp = f"{_CONFIG_PATH}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"sources": sources, "removed": removed or {}}, f, indent=2)
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


def _read_all() -> tuple[list[dict], dict[str, float]]:
    """The sources and, by id, when one was removed."""
    try:
        with open(_CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return _read_old(), {}
    except Exception as e:
        logger.warning(f"[external-source] Could not read the configuration: {e}")
        return [], {}
    if not isinstance(data, dict):
        return [], {}
    sources = [s for s in map(_clean, data.get("sources") or []) if s]
    return sources, _clean_removed(data.get("removed"), time.time())


def _read() -> list[dict]:
    return _read_all()[0]


def load_sources() -> list[dict]:
    """Every source, in the order they were added: {"id", "name", "icon",
    "base_url", "token"} and the sync fields."""
    with _lock:
        return _read()


def get_source(source_id: str) -> dict | None:
    return next((s for s in load_sources() if s["id"] == source_id), None)


def _checked(name: str, icon: str, base_url: str) -> tuple[str, str, str]:
    name = (name or "").strip()[:60]
    if not name:
        raise ExternalSourceError("The source needs a name")
    icon = (icon or "").strip() or DEFAULT_ICON
    if not _ICON.match(icon):
        raise ExternalSourceError("Unknown icon")
    return name, icon, normalize_base_url(base_url)


def save_source(source_id: str | None, name: str, icon: str, base_url: str, token: str) -> dict:
    """Adds a source (`source_id` None) or changes one."""
    name, icon, base_url = _checked(name, icon, base_url)
    token = (token or "").strip()
    with _lock:
        sources, removed = _read_all()
        index = next((i for i, s in enumerate(sources) if s["id"] == source_id), None)
        if source_id is not None and index is None:
            raise KeyError(source_id)
        old = sources[index] if index is not None else None
        if old is None and len(sources) >= MAX_SOURCES:
            raise ExternalSourceError(f"At most {MAX_SOURCES} sources")
        source = {
            "id": source_id or secrets.token_hex(4),
            "name": name,
            "icon": icon,
            "base_url": base_url,
            "token": token,
            # Only what the other side shows counts as a change: a token
            # entered here must not make an older copy of the rest win.
            "updated_at": time.time(),
            "synced": False,
            "token_lent": False,
            "token_pending": bool(token),
        }
        if old is not None:
            if (old["name"], old["icon"], old["base_url"]) == (name, icon, base_url):
                source["updated_at"] = old["updated_at"]
            source["synced"] = old["synced"]
            if old["token"] == token:
                source["token_lent"] = old["token_lent"]
                source["token_pending"] = old["token_pending"]
            sources[index] = source
        else:
            sources.append(source)
        _write(sources, removed)
    return source


def remove_source(source_id: str) -> bool:
    with _lock:
        sources, removed = _read_all()
        kept = [s for s in sources if s["id"] != source_id]
        if len(kept) == len(sources):
            return False
        removed[source_id] = time.time()
        _write(kept, removed)
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


def register(source_id: str, items: list[dict]) -> list[Track]:
    """Stores songs a source's page asked to play and returns them with their
    `ext:` ids, in one go: a page hands over a whole album at once. The same
    audio URL always gets the same id, so playing a song twice does not leave
    two of it in the history. Nothing is stored when one of them is refused."""
    config = get_source(source_id)
    if config is None:
        raise ExternalSourceError("No such external source")
    rows = []
    tracks = []
    for item in items:
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
        tracks.append(track)
        rows.append(
            (track.id, track.title, track.artist, track.album, track.duration, audio_url, cover_url)
        )
    now = time.time()
    with _lock, _connect() as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(*row, now) for row in rows],
        )
        conn.execute("DELETE FROM items WHERE used_at < ?", (now - _ITEM_MAX_AGE_SECONDS,))
    return tracks


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


# --- a paired server ---------------------------------------------------------
#
# Only the setup travels between a desktop app and the server it is paired
# with; each side then talks to the app itself. Ids are shared, the newer
# change of a source wins, and a removal is remembered so the other side
# hears of it instead of sending the source back (docs/plans/device-link.md,
# "External sources").


def _is_loopback(base_url: str) -> bool:
    """`localhost` names a different machine on each side of a pairing."""
    host = (urlsplit(base_url).hostname or "").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _shared_fields(source: dict) -> dict:
    return {k: source[k] for k in ("id", "name", "icon", "base_url", "updated_at")}


def for_link(include_tokens: bool) -> dict:
    """What the server hands a paired desktop."""
    with _lock:
        sources, removed = _read_all()
    shared = []
    for source in sources:
        if _is_loopback(source["base_url"]):
            continue
        entry = _shared_fields(source)
        if include_tokens:
            entry["token"] = source["token"]
        shared.append(entry)
    return {"sources": shared, "removed": removed}


def outgoing() -> dict:
    """What a desktop allowed to set up the server's sources sends: all of
    its own, a token only where it was changed here."""
    with _lock:
        sources, removed = _read_all()
    sent = []
    for source in sources:
        if _is_loopback(source["base_url"]):
            continue
        entry = _shared_fields(source)
        if source["token_pending"]:
            entry["token"] = source["token"]
        sent.append(entry)
    return {"sources": sent, "removed": removed}


def _incoming(entry: dict) -> dict | None:
    """An entry from the other side, checked like one entered here."""
    try:
        name, icon, base_url = _checked(entry.get("name"), entry.get("icon"), entry.get("base_url"))
        updated_at = float(entry.get("updated_at") or 0)
    except (ExternalSourceError, TypeError, ValueError):
        return None
    source_id = str(entry.get("id") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", source_id) or _is_loopback(base_url):
        return None
    checked = {
        "id": source_id,
        "name": name,
        "icon": icon,
        "base_url": base_url,
        "updated_at": updated_at,
    }
    if isinstance(entry.get("token"), str):
        checked["token"] = entry["token"].strip()
    return checked


def _same_app(a: str, b: str) -> bool:
    return a.rstrip("/").lower() == b.rstrip("/").lower()


def merge_from_desktop(incoming: list, incoming_removed: dict, now: float | None = None) -> None:
    """On the server: what a desktop allowed to set up sources sent. A source
    whose address is already set up here is the same app under the id it has
    here; the desktop takes that id over when it reads the answer."""
    now = time.time() if now is None else now
    with _lock:
        sources, removed = _read_all()
        for source_id, stamp in _clean_removed(incoming_removed, now).items():
            source = next((s for s in sources if s["id"] == source_id), None)
            if source is not None and source["updated_at"] > stamp:
                continue
            sources = [s for s in sources if s["id"] != source_id]
            removed[source_id] = max(stamp, removed.get(source_id, 0))
        for entry in filter(None, map(_incoming, incoming if isinstance(incoming, list) else [])):
            if removed.get(entry["id"], 0) >= entry["updated_at"]:
                continue
            source = next((s for s in sources if s["id"] == entry["id"]), None) or next(
                (s for s in sources if _same_app(s["base_url"], entry["base_url"])), None
            )
            if source is None:
                if len(sources) >= MAX_SOURCES:
                    continue
                source = {**entry, "token": entry.get("token", "")}
                source.update(synced=False, token_lent=False, token_pending=False)
                sources.append(source)
                continue
            if entry["updated_at"] > source["updated_at"]:
                source.update({k: entry[k] for k in ("name", "icon", "base_url", "updated_at")})
            if "token" in entry:
                source["token"] = entry["token"]
        _write(sources, removed)


def adopt_from_server(remote: dict) -> None:
    """On a desktop: the server's sources after a sync. What only this
    desktop has stays as it is; a source that came from the server and is no
    longer there goes."""
    entries = remote.get("sources") if isinstance(remote, dict) else None
    theirs = [e for e in map(_incoming, entries if isinstance(entries, list) else []) if e]
    their_removed = _clean_removed(
        remote.get("removed") if isinstance(remote, dict) else None, time.time()
    )
    with _lock:
        sources, removed = _read_all()
        kept: list[dict] = []
        matched: set[str] = set()
        for source in sources:
            entry = next((e for e in theirs if e["id"] == source["id"]), None)
            if entry is None and not source["synced"]:
                entry = next(
                    (
                        e
                        for e in theirs
                        if e["id"] not in matched and _same_app(e["base_url"], source["base_url"])
                    ),
                    None,
                )
            if entry is None:
                gone = their_removed.get(source["id"], -1) >= source["updated_at"]
                if not source["synced"] and not gone:
                    kept.append(source)
                continue
            matched.add(entry["id"])
            if source["id"] != entry["id"] or entry["updated_at"] > source["updated_at"]:
                source.update({k: entry[k] for k in ("id", "name", "icon", "base_url")})
                source["updated_at"] = max(entry["updated_at"], source["updated_at"])
            source["synced"] = True
            if "token" in entry and not source["token_pending"]:
                source["token"] = entry["token"]
                source["token_lent"] = True
            kept.append(source)
        for entry in theirs:
            if entry["id"] in matched or removed.get(entry["id"], -1) >= entry["updated_at"]:
                continue
            if len(kept) >= MAX_SOURCES:
                continue
            kept.append(
                {
                    **entry,
                    "token": entry.get("token", ""),
                    "synced": True,
                    "token_lent": "token" in entry,
                    "token_pending": False,
                }
            )
        _write(kept, removed)


def tokens_sent(sent: dict) -> None:
    """The tokens in `sent` arrived; unless changed again since."""
    tokens = {e["id"]: e["token"] for e in sent.get("sources", []) if "token" in e}
    with _lock:
        sources, removed = _read_all()
        for source in sources:
            if tokens.get(source["id"]) == source["token"]:
                source["token_pending"] = False
        _write(sources, removed)


def forget_pairing() -> None:
    """Disconnected or refused: lent tokens go back, the sources stay, as
    the settings do, now as this desktop's own."""
    with _lock:
        sources, removed = _read_all()
        for source in sources:
            if source["token_lent"]:
                source["token"] = ""
            source.update(synced=False, token_lent=False)
        _write(sources, removed)
