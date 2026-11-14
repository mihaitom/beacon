"""archive.org's side: searching the Live Music Archive, a show's files, the
pictures, and the audio itself.

Only shows that may be downloaded. A band can allow its shows to be streamed
on archive.org but not downloaded; the archive keeps those in a collection of
their own (`stream_only`) and marks them access-restricted, and this app
leaves them out entirely, in every search and on every request."""

import logging
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from urllib.parse import quote

import httpx

from . import __version__

logger = logging.getLogger("live_music_archive")

ARCHIVE = "https://archive.org"

# archive.org asks every automated client to say what it is.
USER_AGENT = (
    f"beacon-live-music-archive/{__version__} "
    "(+https://github.com/mihaitom/beacon/tree/main/docs/examples/live-music-archive)"
)

# The copies archive.org makes of every show, in the order tried. The MP3s
# are a fifth of the original's size and play everywhere; the original
# FLAC is the last resort for a show that has nothing else.
AUDIO_FORMATS = ("VBR MP3", "128Kbps MP3", "Ogg Vorbis", "64Kbps MP3", "Flac")

# What an archive.org identifier may look like; anything else is never sent on.
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

# Everything a search may list: a show of the Live Music Archive, open for download.
_PLAYABLE_SHOWS = "collection:etree AND mediatype:etree AND -collection:stream_only"
_ARTISTS = "collection:etree AND mediatype:collection"
_SHOW_FIELDS = [
    "identifier",
    "title",
    "creator",
    "date",
    "venue",
    "coverage",
    "collection",
    "source",
    "avg_rating",
    "num_reviews",
]
_ARTIST_FIELDS = ["identifier", "title", "item_count"]
_NOT_ARTISTS = {"etree", "stream_only"}

# How the shows of an artist can be listed.
SHOW_SORTS = {
    "newest": "date desc",
    "oldest": "date asc",
    "popular": "downloads desc",
}

# Solr syntax a search term must not bring in.
_SOLR_SPECIAL = re.compile(r'([+\-&|!(){}\[\]^"~*?:\\/])')


class ArchiveError(Exception):
    """Something the page can show as it is."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Track:
    name: str  # The file's name in the show, which is also what is fetched
    title: str
    duration: float | None


@dataclass(frozen=True)
class Show:
    id: str
    title: str
    artist: str
    artist_id: str
    date: str
    venue: str
    location: str
    tracks: tuple[Track, ...]

    @property
    def cover_id(self) -> str:
        """Whose picture stands for the show: the artist's. A show's own is
        often only a spectrogram of its first song."""
        return self.artist_id or self.id

    @property
    def album(self) -> str:
        """The album Beacon shows: one per show, as archive.org names them."""
        return " - ".join(part for part in (self.date, self.venue) if part) or self.title


class _Cache:
    """A small cache that forgets the oldest entries and anything too old.
    archive.org asks clients to cache rather than ask again."""

    def __init__(self, size: int, seconds: float):
        self.size = size
        self.seconds = seconds
        self.entries: OrderedDict = OrderedDict()

    def get(self, key):
        entry = self.entries.get(key)
        if entry is None or entry[0] < time.monotonic():
            return None
        self.entries.move_to_end(key)
        return entry[1]

    def put(self, key, value):
        self.entries[key] = (time.monotonic() + self.seconds, value)
        self.entries.move_to_end(key)
        while len(self.entries) > self.size:
            self.entries.popitem(last=False)
        return value


# Where a typed word may match a show. Not everywhere: taper notes and set
# lists mention half the venues in the country.
_SHOW_SEARCH_FIELDS = ("title", "venue", "coverage", "creator")


def _terms(text: str, fields: tuple[str, ...] = ()) -> str:
    """What someone typed as a Solr query: every word must match, in one of
    `fields` if given, and none of them can change the query around it."""
    words = [_SOLR_SPECIAL.sub(r"\\\1", word) for word in text.split()][:8]
    if fields:
        words = ["(" + " OR ".join(f"{field}:{word}" for field in fields) + ")" for word in words]
    return " AND ".join(words)


def _duration(value: object) -> float | None:
    """archive.org writes a length as seconds ("451.23") or as "7:31"."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        seconds = 0.0
        for part in text.split(":"):
            seconds = seconds * 60 + float(part)
        return seconds or None
    except ValueError:
        return None


def _natural(name: str) -> list:
    """d1t02 before d1t10, and d1t10 before d2t01."""
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", name)]


def _track_number(value: object) -> int | None:
    match = re.match(r"\s*(\d+)", str(value or ""))
    return int(match.group(1)) if match else None


def _ordered(files: list[dict]) -> list[dict]:
    """By track number when every file has its own, by name otherwise: a show
    on two discs often numbers both from 1, and then only the names keep
    the order."""
    numbers = [_track_number(f.get("track")) for f in files]
    if None not in numbers and len(set(numbers)) == len(numbers):
        return [f for _, f in sorted(zip(numbers, files, strict=True), key=lambda p: p[0])]
    return sorted(files, key=lambda f: _natural(f["name"]))


# A night often has several recordings; how each was taped is what tells
# them apart. Tapers write it in `source` ("SBD -> DAT", "Schoeps MK4 >
# ..."); without it, the identifier often says it in a word.
_RECORDINGS = (("sbd", "Soundboard"), ("mtx", "Matrix"), ("matrix", "Matrix"), ("aud", "Audience"))


def recording(identifier: str, source: object = "") -> str:
    text = re.sub(r"\s+", " ", _first(source))
    text = re.sub(r"^(source|src)\s*:\s*", "", text, flags=re.IGNORECASE)
    if text and text != "?":
        return text[:80]
    words = set(re.split(r"[^a-z]+", identifier.lower()))
    return next((label for word, label in _RECORDINGS if word in words), "")


def _first(value: object) -> str:
    if isinstance(value, list):
        value = value[0] if value else ""
    return str(value or "").strip()


def _artist_id(collections: object) -> str:
    if isinstance(collections, str):
        collections = [collections]
    for name in collections or []:
        if name not in _NOT_ARTISTS and not name.startswith("fav-"):
            return name
    return ""


def _number(value: object) -> float | None:
    try:
        return float(_first(value)) if _first(value) else None
    except ValueError:
        return None


def show_summary(doc: dict) -> dict:
    artist_id = _artist_id(doc.get("collection"))
    return {
        "id": doc["identifier"],
        "title": _first(doc.get("title")),
        "artist": _first(doc.get("creator")),
        "artistId": artist_id,
        "coverId": artist_id or doc["identifier"],
        "date": _first(doc.get("date"))[:10],
        "venue": _first(doc.get("venue")),
        "location": _first(doc.get("coverage")),
        "recording": recording(doc["identifier"], doc.get("source")),
        "rating": _number(doc.get("avg_rating")),
        "reviews": int(_number(doc.get("num_reviews")) or 0),
    }


def varied(shows: list[dict], per_artist: int) -> list[dict]:
    """One recording per night and only so many shows per artist, so a list
    is not one band's tapes of one evening."""
    nights: set[tuple] = set()
    counts: dict[str, int] = {}
    kept = []
    for show in shows:
        artist = show["artistId"] or show["artist"]
        night = (artist, show["date"])
        if night in nights or counts.get(artist, 0) >= per_artist:
            continue
        nights.add(night)
        counts[artist] = counts.get(artist, 0) + 1
        kept.append(show)
    return kept


def artist_summary(doc: dict) -> dict:
    return {
        "id": doc["identifier"],
        "name": _first(doc.get("title")) or doc["identifier"],
        "shows": int(doc.get("item_count") or 0),
    }


def _restricted(metadata: dict) -> bool:
    collections = metadata.get("collection") or []
    if isinstance(collections, str):
        collections = [collections]
    return (
        "stream_only" in collections
        or str(metadata.get("access-restricted-item", "")).lower() == "true"
        or "etree" not in collections
        or metadata.get("mediatype") != "etree"
    )


class Archive:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None):
        self.client = httpx.AsyncClient(
            base_url=ARCHIVE,
            transport=transport,
            follow_redirects=True,
            timeout=httpx.Timeout(20, read=60),
            headers={"user-agent": USER_AGENT},
        )
        self._searches = _Cache(size=200, seconds=600)
        self._shows = _Cache(size=300, seconds=3600)
        self._images = _Cache(size=300, seconds=86400)
        # Set by a 429: until then nothing is asked, as archive.org wants.
        self._quiet_until = 0.0

    async def aclose(self) -> None:
        await self.client.aclose()

    def _check_quiet(self) -> None:
        if time.monotonic() < self._quiet_until:
            raise ArchiveError("archive.org asked to slow down. Try again in a minute.", 503)

    def _note_busy(self, response: httpx.Response) -> None:
        try:
            wait = float(response.headers.get("retry-after", ""))
        except ValueError:
            wait = 60
        self._quiet_until = time.monotonic() + min(max(wait, 1), 600)
        logger.warning(f"archive.org answered 429; waiting {wait:.0f} s")
        raise ArchiveError("archive.org asked to slow down. Try again in a minute.", 503)

    async def _get(self, path: str, params: dict | None = None) -> httpx.Response:
        self._check_quiet()
        try:
            response = await self.client.get(path, params=params)
        except httpx.HTTPError as error:
            logger.warning(f"archive.org: {type(error).__name__}: {error}")
            raise ArchiveError("archive.org is not reachable right now.") from error
        if response.status_code == 429:
            self._note_busy(response)
        return response

    async def _search(
        self, query: str, fields: list[str], sort: str | tuple[str, ...], rows: int, page: int = 1
    ) -> tuple[int, list[dict]]:
        key = (query, sort, rows, page)
        cached = self._searches.get(key)
        if cached is not None:
            return cached
        response = await self._get(
            "/advancedsearch.php",
            {
                "q": query,
                "fl[]": fields,
                "sort[]": list(sort) if isinstance(sort, tuple) else sort,
                "rows": rows,
                "page": page,
                "output": "json",
            },
        )
        if response.status_code != 200:
            raise ArchiveError(f"archive.org's search answered {response.status_code}.")
        try:
            found = response.json()["response"]
            result = (int(found["numFound"]), list(found["docs"]))
        except (ValueError, KeyError, TypeError) as error:
            raise ArchiveError("archive.org's search answered something unexpected.") from error
        return self._searches.put(key, result)

    # --- browsing ---------------------------------------------------------------

    async def popular_artists(self, rows: int = 60) -> list[dict]:
        _, docs = await self._search(_ARTISTS, _ARTIST_FIELDS, "downloads desc", rows)
        return [artist_summary(d) for d in docs]

    async def search_artists(self, text: str, rows: int = 20) -> list[dict]:
        terms = _terms(text)
        if not terms:
            return []
        query = f"{_ARTISTS} AND title:({terms})"
        _, docs = await self._search(query, _ARTIST_FIELDS, "downloads desc", rows)
        return [artist_summary(d) for d in docs]

    async def artist(self, artist_id: str) -> dict:
        if not IDENTIFIER.match(artist_id):
            raise ArchiveError("No such artist.", 404)
        _, docs = await self._search(
            f'{_ARTISTS} AND identifier:"{artist_id}"', _ARTIST_FIELDS, "downloads desc", 1
        )
        if not docs:
            raise ArchiveError("No such artist in the Live Music Archive.", 404)
        return artist_summary(docs[0])

    async def popular_shows(self, rows: int = 60) -> list[dict]:
        _, docs = await self._search(_PLAYABLE_SHOWS, _SHOW_FIELDS, "week desc", rows)
        return varied([show_summary(d) for d in docs], per_artist=4)[:30]

    async def on_this_day(self, month: int, day: int) -> list[dict]:
        """Shows played on this day in any year. The date field cannot be
        asked by month and day, but every show's title ends in its date."""
        month_day = f"{month:02}-{day:02}"
        query = f'{_PLAYABLE_SHOWS} AND title:"{month_day}"'
        _, docs = await self._search(query, _SHOW_FIELDS, "downloads desc", 60)
        shows = [show_summary(d) for d in docs]
        return varied([s for s in shows if s["date"][5:] == month_day], per_artist=2)[:16]

    async def favourites(self) -> list[dict]:
        """The best rated shows, among those enough listeners rated."""
        query = f"{_PLAYABLE_SHOWS} AND num_reviews:[15 TO *]"
        sort = ("avg_rating desc", "num_reviews desc")
        _, docs = await self._search(query, _SHOW_FIELDS, sort, 60)
        return varied([show_summary(d) for d in docs], per_artist=2)[:16]

    async def search_shows(self, text: str, rows: int = 30) -> list[dict]:
        terms = _terms(text, _SHOW_SEARCH_FIELDS)
        if not terms:
            return []
        query = f"{_PLAYABLE_SHOWS} AND {terms}"
        _, docs = await self._search(query, _SHOW_FIELDS, "downloads desc", rows)
        return [show_summary(d) for d in docs]

    async def shows_of(
        self, artist_id: str, sort: str = "newest", page: int = 1, rows: int = 50
    ) -> tuple[int, list[dict]]:
        if not IDENTIFIER.match(artist_id):
            raise ArchiveError("No such artist.", 404)
        query = f'{_PLAYABLE_SHOWS} AND collection:"{artist_id}"'
        total, docs = await self._search(
            query, _SHOW_FIELDS, SHOW_SORTS.get(sort, SHOW_SORTS["newest"]), rows, max(page, 1)
        )
        return total, [show_summary(d) for d in docs]

    # --- one show -----------------------------------------------------------------

    async def show(self, show_id: str) -> Show:
        if not IDENTIFIER.match(show_id):
            raise ArchiveError("No such show.", 404)
        cached = self._shows.get(show_id)
        if cached is not None:
            return cached
        response = await self._get(f"/metadata/{show_id}")
        if response.status_code != 200:
            raise ArchiveError(f"archive.org answered {response.status_code}.")
        try:
            data = response.json()
        except ValueError as error:
            raise ArchiveError("archive.org answered something unexpected.") from error
        metadata = data.get("metadata") or {}
        if not metadata or data.get("is_dark") or _restricted(metadata):
            raise ArchiveError("This show cannot be played here.", 404)
        files = [f for f in data.get("files") or [] if isinstance(f, dict) and f.get("name")]
        for audio_format in AUDIO_FORMATS:
            chosen = [
                f
                for f in files
                if f.get("format") == audio_format and str(f.get("private", "")).lower() != "true"
            ]
            if chosen:
                break
        else:
            raise ArchiveError("This show has no audio that can be played here.", 404)
        tracks = tuple(
            Track(
                name=f["name"],
                title=_first(f.get("title")) or f["name"].rsplit("/", 1)[-1].rsplit(".", 1)[0],
                duration=_duration(f.get("length")),
            )
            for f in _ordered(chosen)
        )
        show = Show(
            id=show_id,
            title=_first(metadata.get("title")),
            artist=_first(metadata.get("creator")),
            artist_id=_artist_id(metadata.get("collection")),
            date=_first(metadata.get("date"))[:10],
            venue=_first(metadata.get("venue")),
            location=_first(metadata.get("coverage")),
            tracks=tracks,
        )
        return self._shows.put(show_id, show)

    async def image(self, identifier: str) -> tuple[bytes, str] | None:
        """The picture archive.org shows for a show or an artist."""
        if not IDENTIFIER.match(identifier):
            return None
        cached = self._images.get(identifier)
        if cached is not None:
            return cached or None
        response = await self._get(f"/services/img/{identifier}")
        content_type = response.headers.get("content-type", "").split(";")[0].strip()
        if response.status_code != 200 or not content_type.startswith("image/"):
            self._images.put(identifier, ())
            return None
        return self._images.put(identifier, (response.content, content_type))

    async def open_audio(
        self, show_id: str, name: str, method: str, headers: dict[str, str]
    ) -> httpx.Response:
        """The audio file as archive.org sends it, still streaming: the caller
        passes it on and closes it. Only a file the show offers for playing."""
        show = await self.show(show_id)
        if name not in {t.name for t in show.tracks}:
            raise ArchiveError("No such song in this show.", 404)
        self._check_quiet()
        request = self.client.build_request(
            method,
            f"/download/{show_id}/{quote(name)}",
            # Unencoded, so the length archive.org sends is the length passed on.
            headers={**headers, "accept-encoding": "identity"},
        )
        try:
            response = await self.client.send(request, stream=True)
        except httpx.HTTPError as error:
            logger.warning(f"archive.org audio: {type(error).__name__}: {error}")
            raise ArchiveError("archive.org is not reachable right now.") from error
        if response.status_code == 429:
            await response.aclose()
            self._note_busy(response)
        return response
