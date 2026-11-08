"""routes/device_link_schema.py - what /device-link/v1/ answers, and its OpenAPI.

Real models rather than dicts so that the published description cannot drift
from the routes. connect's own OpenAPI stays off (see main.py): this one is
built from the v1 routes alone.
"""

from typing import Literal

from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel, Field

from core.server_link import KEY_HEADER
from routes.play_history import Milestones

API_VERSION = 1
GUIDE_URL = "https://raw.githubusercontent.com/mihaitom/beacon/main/docs/help/faq/apps-and-api.md"


class Me(BaseModel):
    username: str
    scopes: list[str] = Field(description="What this key may read")
    beacon_version: str
    api_version: int = Field(
        description="Raised only for a change an existing app cannot cope with"
    )


class HistoryItem(BaseModel):
    id: str
    ts: int = Field(description="When it was played, UTC seconds")
    source: str = Field(description="`beacon`, or the service it was imported from")
    song_id: str
    title: str
    artist: str
    artist_id: str
    album: str
    album_id: str
    genre: str
    duration: float


class HistoryPage(BaseModel):
    items: list[HistoryItem]
    next_cursor: str = Field(description="Ask with this later to get only what is new")
    more: bool = Field(description="More is available right now")


class TopSong(BaseModel):
    title: str
    artist: str
    album_id: str
    plays: int


class TopAlbum(BaseModel):
    title: str
    artist: str
    album_id: str
    plays: int


class TopArtist(BaseModel):
    name: str
    artist_id: str
    plays: int


class TopGenre(BaseModel):
    name: str
    plays: int


class Top(BaseModel):
    songs: list[TopSong]
    artists: list[TopArtist]
    albums: list[TopAlbum]
    genres: list[TopGenre]


class Stats(BaseModel):
    total: int
    live_since: int | None = Field(description="When Beacon's own record began, UTC seconds")
    top: Top
    milestones: Milestones | None = Field(
        description="As of the last visit to the Stats page; null before it and after an import"
    )
    timestamps: list[int] = Field(description="Every play, UTC seconds, oldest first")


class PlayingSong(BaseModel):
    id: str
    title: str
    artist: str
    album: str
    duration: float


class PlayingRadio(BaseModel):
    station: str
    title: str | None = Field(description='What the station sends, usually "Artist - Title"')


class NothingPlaying(BaseModel):
    playing: Literal[False]


class Playing(BaseModel):
    playing: Literal[True]
    paused: bool
    kind: Literal["song", "radio"]
    source: Literal["cast", "local"] = Field(
        description="`cast` on a speaker, `local` on the browser, phone or desktop app itself"
    )
    devices: list[str] = Field(description="The speakers, for a cast")
    song: PlayingSong | None
    radio: PlayingRadio | None
    position: float | None = Field(
        description="Seconds into the song, correct at `at`. Carry it forward while not paused"
    )
    at: float = Field(description="UTC seconds")


NowPlaying = Playing | NothingPlaying


class LyricLine(BaseModel):
    time: float = Field(description="Seconds into the song. Always 0 when not synced")
    text: str


class Lyrics(BaseModel):
    song_id: str
    synced: bool
    lines: list[LyricLine] = Field(description="Empty when no lyrics were found")
    offset: float = Field(
        description="The listener's correction. A line is reached at position - offset >= time"
    )


_DESCRIPTION = f"""Read access to one Beacon account, for apps of your own.

A key is made in Beacon's Settings > Account > Apps and devices and is sent as
the `{KEY_HEADER}` header. Never put it in source code.

Any origin may call this from a browser. Limits per key: 120 requests a minute
and 3 open event streams; a 429 says how long to wait in `Retry-After`.

Fields keep their meaning within v1, and new ones may appear: ignore what you
do not know.

A guide with examples and ideas: {GUIDE_URL}
"""


def document(routes: list) -> dict:
    schema = get_openapi(
        title="Beacon app API",
        version=f"{API_VERSION}.0",
        description=_DESCRIPTION,
        routes=routes,
    )
    schema["components"]["securitySchemes"] = {
        "deviceKey": {"type": "apiKey", "in": "header", "name": KEY_HEADER}
    }
    schema["security"] = [{"deviceKey": []}]
    for path in schema["paths"].values():
        for operation in path.values():
            # The dependency that reads the key shows up as a parameter too.
            operation["parameters"] = [
                parameter
                for parameter in operation.get("parameters", [])
                if parameter["name"].lower() != KEY_HEADER.lower()
            ]
    return schema
