"""A stand-in for archive.org, answering the way the real one does (shapes
taken from its answers), so the tests run without the internet."""

import mimetypes
from dataclasses import dataclass, field, replace

import httpx
import pytest
from starlette.testclient import TestClient

from live_music_archive.app import create_app
from live_music_archive.archive import Archive
from live_music_archive.config import Config

AUDIO = bytes(range(256)) * 40  # 10 240 bytes of "MP3"
TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)


def _file(name, fmt, track=None, length=None, private=None, title=None):
    entry = {"name": name, "format": fmt, "source": "derivative"}
    if track is not None:
        entry["track"] = track
    if length is not None:
        entry["length"] = length
    if private:
        entry["private"] = "true"
    if title:
        entry["title"] = title
    return entry


SHOWS = {
    # Two discs, both numbered from 1: only the names keep the order.
    "band1977-05-08.aud": {
        "metadata": {
            "identifier": "band1977-05-08.aud",
            "mediatype": "etree",
            "collection": ["TheBand", "etree"],
            "title": "The Band Live at Barton Hall on 1977-05-08",
            "creator": "The Band",
            "date": "1977-05-08",
            "venue": "Barton Hall",
            "coverage": "Ithaca, NY",
        },
        "files": [
            _file("band77d1t01.flac", "Flac", "01", "301.2"),
            _file("band77d2t01.mp3", "VBR MP3", "01", "05:00", title="Encore"),
            _file("band77d1t02.mp3", "VBR MP3", "02", "1:02:03", title="Long Jam"),
            _file("band77d1t01.mp3", "VBR MP3", "01", "301.2", title="Opener"),
            _file("band77d1t01.ogg", "Ogg Vorbis", "01", "301.2"),
            _file("band1977-05-08.aud_archive.torrent", "Archive BitTorrent"),
        ],
    },
    # The band allows streaming on archive.org only.
    "band1978-01-01.sbd": {
        "metadata": {
            "identifier": "band1978-01-01.sbd",
            "mediatype": "etree",
            "collection": ["TheBand", "etree", "stream_only"],
            "access-restricted-item": "true",
            "creator": "The Band",
            "date": "1978-01-01",
        },
        "files": [_file("band78t01.mp3", "VBR MP3", "01", "200")],
    },
    # Only FLAC that may be fetched; the MP3s are private.
    "band1979-02-02.flac": {
        "metadata": {
            "identifier": "band1979-02-02.flac",
            "mediatype": "etree",
            "collection": ["TheBand", "etree"],
            "creator": "The Band",
            "date": "1979-02-02",
            "venue": "Club",
        },
        "files": [
            _file("one.mp3", "VBR MP3", "1", "100", private=True),
            _file("sub dir/one two.flac", "Flac", "1", "100", title="Only Song"),
        ],
    },
    # Not part of the Live Music Archive at all.
    "some-audiobook": {
        "metadata": {"identifier": "some-audiobook", "mediatype": "audio", "collection": ["x"]},
        "files": [_file("a.mp3", "VBR MP3", "1", "10")],
    },
}

SEARCH_DOCS = {
    "shows": [
        {
            "identifier": "band1977-05-08.aud",
            "title": "The Band Live at Barton Hall on 1977-05-08",
            "creator": "The Band",
            "date": "1977-05-08T00:00:00Z",
            "venue": "Barton Hall",
            "coverage": "Ithaca, NY",
            "collection": ["TheBand", "etree"],
        }
    ],
    "artists": [{"identifier": "TheBand", "title": "The Band", "item_count": 3}],
}


def _doc(identifier, artist_id, date, title=""):
    return {
        "identifier": identifier,
        "title": title or f"{artist_id} Live on {date}",
        "creator": artist_id,
        "date": f"{date}T00:00:00Z",
        "collection": [artist_id, "etree"],
    }


# What a search for "05-08" in titles brings, most played first.
ON_THIS_DAY_DOCS = [
    _doc("band1977-05-08.aud", "TheBand", "1977-05-08"),
    _doc("band1977-05-08.sbd", "TheBand", "1977-05-08"),  # the same night again
    _doc("other1990-05-08", "Other", "1990-05-08"),
    # Matches the title, but was played on another day.
    _doc("other2005-08-01", "Other", "2005-08-01", "Other Live at Club 05-08 on 2005-08-01"),
    _doc("band1980-05-08", "TheBand", "1980-05-08"),
    _doc("band1985-05-08", "TheBand", "1985-05-08"),  # a third of the same band
]


@dataclass
class FakeArchive:
    """Every request it got, and what it should answer instead next time."""

    requests: list[httpx.Request] = field(default_factory=list)
    busy: bool = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.busy:
            return httpx.Response(429, headers={"retry-after": "30"})
        path = request.url.path
        if request.url.host == "ia800.example.org":
            return self._audio(request)
        if path == "/advancedsearch.php":
            query = request.url.params["q"]
            if "mediatype:collection" in query:
                docs = SEARCH_DOCS["artists"]
            elif 'title:"' in query:
                docs = ON_THIS_DAY_DOCS
            else:
                docs = SEARCH_DOCS["shows"]
            body = {"response": {"numFound": len(docs), "start": 0, "docs": docs}}
            return httpx.Response(200, json=body)
        if path.startswith("/metadata/"):
            return httpx.Response(200, json=SHOWS.get(path.removeprefix("/metadata/"), {}))
        if path.startswith("/services/img/"):
            if path.endswith("TheBand") or path.endswith(".aud"):
                return httpx.Response(200, content=TINY_PNG, headers={"content-type": "image/png"})
            return httpx.Response(404)
        if path.startswith("/download/"):
            # The real archive answers with a redirect to the server holding the file.
            return httpx.Response(302, headers={"location": f"https://ia800.example.org{path}"})
        return httpx.Response(404)

    def _audio(self, request: httpx.Request) -> httpx.Response:
        content_type = mimetypes.guess_type(request.url.path)[0] or "audio/mpeg"
        headers = {"content-type": content_type, "accept-ranges": "bytes"}
        wanted = request.headers.get("range", "")
        if wanted.startswith("bytes="):
            start, _, end = wanted[6:].partition("-")
            start, end = int(start), int(end or len(AUDIO) - 1)
            part = AUDIO[start : end + 1]
            headers["content-range"] = f"bytes {start}-{end}/{len(AUDIO)}"
            body = b"" if request.method == "HEAD" else part
            return httpx.Response(
                206, headers=headers | {"content-length": str(len(part))}, content=body
            )
        body = b"" if request.method == "HEAD" else AUDIO
        return httpx.Response(
            200, headers=headers | {"content-length": str(len(AUDIO))}, content=body
        )


@pytest.fixture
def fake() -> FakeArchive:
    return FakeArchive()


@pytest.fixture
def config(tmp_path) -> Config:
    return Config(
        data_dir=tmp_path,
        name="Test archive",
        token="",
        secret=b"test-secret",
        host="127.0.0.1",
        port=0,
    )


@pytest.fixture
def make_client(config, fake):
    clients = []

    def make(today=None, **changes):
        extra = {"today": today} if today else {}
        app = create_app(replace(config, **changes), Archive(httpx.MockTransport(fake)), **extra)
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield make
    for client in clients:
        client.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


def queries(fake: FakeArchive) -> list[str]:
    return [r.url.params["q"] for r in fake.requests if r.url.path == "/advancedsearch.php"]
