"""The index of the music folder: tracks with their tags, grouped into albums.

A scan reads tags only for files that are new or changed since the last one;
the rest comes from an SQLite index, so a restart of a large folder takes
seconds, not minutes. The index is written as the scan goes, so a long first
scan cut short by a restart carries on where it stopped."""

import hashlib
import logging
import re
import sqlite3
import threading
import time
from contextlib import closing
from dataclasses import astuple, dataclass, field, fields
from pathlib import Path

import mutagen

logger = logging.getLogger("folder_source.library")

AUDIO_EXTENSIONS = {
    ".mp3",
    ".m4a",
    ".mp4",
    ".aac",
    ".flac",
    ".ogg",
    ".oga",
    ".opus",
    ".wav",
    ".webm",
}
FOLDER_COVERS = ("cover", "folder", "front", "album", "albumart")
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")

# "01 Title", "01 - Title", "1. Title", "01_Title"
TRACK_NUMBER = re.compile(r"^(\d{1,3})[\s._-]+")
# "CD1", "CD 2", "Disc 3", "disk2": a folder per disc of one album.
DISC_FOLDER = re.compile(r"^(cd|disc|disk)\s*\d+$", re.IGNORECASE)

# Bump when Track's fields change: the index is then read afresh.
_SCHEMA_VERSION = 3

# Tracks read before the index is written: a crash loses at most this many.
_WRITE_EVERY = 200

VARIOUS = "Various Artists"


@dataclass
class Track:
    id: str
    path: str  # relative to the music folder, with "/"
    title: str
    artist: str
    album: str
    album_artist: str
    track: int | None
    disc: int | None
    year: int | None
    genre: str
    duration: float
    embedded_cover: bool
    mtime: float
    size: int


@dataclass
class Album:
    id: str
    title: str
    artist: str
    year: int | None
    genre: str
    folder: str
    added: float
    tracks: list[Track] = field(default_factory=list)
    # ("file", relative path) or ("embedded", relative path of a track)
    cover: tuple[str, str] | None = None

    @property
    def duration(self) -> float:
        return sum(t.duration for t in self.tracks)


def _id(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:16]


def _first(tags, key: str) -> str:
    try:
        values = tags.get(key) if tags else None
    except (KeyError, ValueError):
        return ""
    if not values:
        return ""
    return str(values[0]).strip()


def _number(text: str) -> int | None:
    match = re.match(r"\s*(\d+)", text or "")
    return int(match.group(1)) if match else None


def _has_embedded_cover(path: Path) -> bool:
    try:
        audio = mutagen.File(path)
    except Exception:
        return False
    if audio is None:
        return False
    if getattr(audio, "pictures", None):  # FLAC
        return True
    tags = audio.tags
    if tags is None:
        return False
    if hasattr(tags, "getall"):  # ID3
        return bool(tags.getall("APIC"))
    try:
        return "covr" in tags or "metadata_block_picture" in tags  # MP4, Ogg
    except TypeError:
        return False


def read_track(root: Path, path: Path) -> Track:
    """A track from its tags, falling back to its file and folder names:
    `Artist/Album/01 Title.mp3` is a track with all of those set."""
    relative = path.relative_to(root).as_posix()
    stat = path.stat()
    try:
        audio = mutagen.File(path, easy=True)
    except Exception as e:
        logger.warning(f"Could not read tags of {relative}: {e}")
        audio = None
    tags = audio.tags if audio is not None else None

    stem = path.stem
    number = TRACK_NUMBER.match(stem)
    folders = [p for p in Path(relative).parent.parts if not DISC_FOLDER.match(p)]
    title = _first(tags, "title") or (TRACK_NUMBER.sub("", stem) or stem)
    artist = _first(tags, "artist") or (folders[-2] if len(folders) > 1 else "")
    return Track(
        id=_id(relative),
        path=relative,
        title=title,
        artist=artist,
        album=_first(tags, "album") or (folders[-1] if folders else ""),
        album_artist=_first(tags, "albumartist"),
        track=_number(_first(tags, "tracknumber")) or (int(number.group(1)) if number else None),
        disc=_number(_first(tags, "discnumber")),
        year=_number(_first(tags, "date")),
        genre=_first(tags, "genre"),
        duration=round(float(getattr(getattr(audio, "info", None), "length", 0) or 0), 2),
        embedded_cover=_has_embedded_cover(path),
        mtime=stat.st_mtime,
        size=stat.st_size,
    )


def _album_folder(relative: str) -> str:
    """The folder an album lives in: the parent of a CD1/CD2 folder."""
    parent = Path(relative).parent
    if DISC_FOLDER.match(parent.name):
        parent = parent.parent
    return parent.as_posix() if parent.as_posix() != "." else ""


def _folder_cover(root: Path, folder: str) -> str | None:
    directory = root / folder
    try:
        names = {p.name.lower(): p.name for p in directory.iterdir() if p.is_file()}
    except OSError:
        return None
    for stem in FOLDER_COVERS:
        for extension in IMAGE_EXTENSIONS:
            name = names.get(stem + extension)
            if name:
                return (Path(folder) / name).as_posix() if folder else name
    return None


def group_albums(root: Path, tracks: list[Track]) -> dict[str, Album]:
    """One album per folder and album tag. Grouping by folder keeps two
    albums of the same name apart, and keeps a compilation together even
    when every track names another artist."""
    groups: dict[tuple[str, str], list[Track]] = {}
    for track in tracks:
        key = (_album_folder(track.path), track.album.casefold())
        groups.setdefault(key, []).append(track)

    albums: dict[str, Album] = {}
    for (folder, _), members in groups.items():
        members.sort(key=lambda t: (t.disc or 1, t.track or 9999, t.path))
        album_artists = {t.album_artist for t in members if t.album_artist}
        artists = {t.artist for t in members if t.artist}
        if len(album_artists) == 1:
            artist = album_artists.pop()
        elif len(artists) == 1:
            artist = next(iter(artists))
        elif len(artists) > 1:
            artist = VARIOUS
        else:
            artist = ""
        title = members[0].album or Path(folder).name or "Loose songs"
        cover_file = _folder_cover(root, folder)
        embedded = next((t for t in members if t.embedded_cover), None)
        album = Album(
            id=_id(f"{folder}\n{members[0].album.casefold()}"),
            title=title,
            artist=artist,
            year=next((t.year for t in members if t.year), None),
            genre=next((t.genre for t in members if t.genre), ""),
            folder=folder,
            added=max(t.mtime for t in members),
            tracks=members,
            cover=("file", cover_file)
            if cover_file
            else ("embedded", embedded.path)
            if embedded
            else None,
        )
        albums[album.id] = album
    return albums


_COLUMNS = [f.name for f in fields(Track)]


@dataclass
class ScanProgress:
    """How far a running scan is, for the page to show. Written by the scan's
    thread, read by the server's; plain numbers, so no lock is needed."""

    # "looking" for files, "reading" the tags of new and changed ones, or ""
    phase: str = ""
    found: int = 0
    to_read: int = 0
    read: int = 0


def _open_index(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    if conn.execute("PRAGMA user_version").fetchone()[0] != _SCHEMA_VERSION:
        conn.execute("DROP TABLE IF EXISTS tracks")
        conn.execute(f"CREATE TABLE tracks ({', '.join(_COLUMNS)}, PRIMARY KEY (path))")
        conn.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
        conn.commit()
    return conn


def _stored(conn: sqlite3.Connection) -> dict[str, Track]:
    rows = conn.execute(f"SELECT {', '.join(_COLUMNS)} FROM tracks")
    tracks = (Track(**dict(zip(_COLUMNS, row, strict=True))) for row in rows)
    return {t.path: t for t in tracks}


def _write(conn: sqlite3.Connection, tracks: list[Track]) -> None:
    marks = ", ".join("?" * len(_COLUMNS))
    conn.executemany(f"INSERT OR REPLACE INTO tracks VALUES ({marks})", map(astuple, tracks))
    conn.commit()


class Library:
    def __init__(self, root: Path, index_path: Path):
        self.root = root
        self.index_path = index_path
        # The JSON cache of version 1.0.0; the index replaces it.
        index_path.with_name("library.json").unlink(missing_ok=True)
        self.albums: dict[str, Album] = {}
        self.tracks: dict[str, Track] = {}
        self.track_album: dict[str, str] = {}
        self.scanning = False
        self.last_scan: float | None = None
        self.last_scan_seconds: float | None = None
        self.progress = ScanProgress()
        self._scan_lock = threading.Lock()

    # --- scanning --------------------------------------------------------------

    def _files(self):
        for path in sorted(self.root.rglob("*")):
            if path.suffix.lower() not in AUDIO_EXTENSIONS or not path.is_file():
                continue
            # Symlinks are followed only when they stay inside the folder.
            try:
                path.resolve().relative_to(self.root)
            except ValueError:
                continue
            yield path

    def scan(self) -> None:
        """Re-reads the folder. Only one scan runs at a time; a second call
        while one runs returns at once."""
        if not self._scan_lock.acquire(blocking=False):
            return
        self.scanning = True
        started = time.monotonic()
        try:
            progress = self.progress = ScanProgress(phase="looking")
            with closing(_open_index(self.index_path)) as conn:
                stored = _stored(conn)
                tracks: list[Track] = []
                pending: list[Path] = []
                for path in self._files():
                    progress.found += 1
                    stat = path.stat()
                    known = stored.get(path.relative_to(self.root).as_posix())
                    if known and known.mtime == stat.st_mtime and known.size == stat.st_size:
                        tracks.append(known)
                    else:
                        pending.append(path)

                progress.to_read = len(pending)
                progress.phase = "reading"
                fresh: list[Track] = []
                for path in pending:
                    track = read_track(self.root, path)
                    tracks.append(track)
                    fresh.append(track)
                    progress.read += 1
                    if len(fresh) >= _WRITE_EVERY:
                        _write(conn, fresh)
                        fresh = []
                _write(conn, fresh)
                gone = stored.keys() - {t.path for t in tracks}
                conn.executemany("DELETE FROM tracks WHERE path = ?", ((p,) for p in gone))
                conn.commit()
            # Found in folder order, read afterwards: back into folder order.
            tracks.sort(key=lambda t: t.path)
            albums = group_albums(self.root, tracks)
            self.albums = albums
            self.tracks = {t.id: t for t in tracks}
            self.track_album = {t.id: a.id for a in albums.values() for t in a.tracks}
            self.last_scan = time.time()
            self.last_scan_seconds = round(time.monotonic() - started, 2)
            logger.info(
                f"Scanned {len(tracks)} tracks in {len(albums)} albums "
                f"({len(pending)} read, {len(tracks) - len(pending)} unchanged, "
                f"{len(gone)} gone) "
                f"in {self.last_scan_seconds}s"
            )
        finally:
            self.progress.phase = ""
            self.scanning = False
            self._scan_lock.release()

    # --- lookups ---------------------------------------------------------------

    def file(self, relative: str) -> Path | None:
        """An indexed file's absolute path, or None if it left the folder."""
        path = (self.root / relative).resolve()
        try:
            path.relative_to(self.root)
        except ValueError:
            return None
        return path if path.is_file() else None

    def album_of(self, track_id: str) -> Album | None:
        album_id = self.track_album.get(track_id)
        return self.albums.get(album_id) if album_id else None

    def search(self, query: str, album_limit: int = 24, track_limit: int = 100):
        words = [w for w in query.casefold().split() if w]
        if not words:
            return [], []

        def matches(*texts: str) -> bool:
            haystack = " ".join(texts).casefold()
            return all(w in haystack for w in words)

        albums = [
            a
            for a in self.albums.values()
            if matches(a.title, a.artist, str(a.year or ""), a.genre)
        ]
        albums.sort(key=lambda a: (a.artist.casefold(), a.title.casefold()))
        tracks = [
            t for t in self.tracks.values() if matches(t.title, t.artist, t.album, t.album_artist)
        ]
        tracks.sort(key=lambda t: (t.artist.casefold(), t.album.casefold(), t.track or 0))
        return albums[:album_limit], tracks[:track_limit]
