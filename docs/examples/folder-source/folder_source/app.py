"""The HTTP side: what Beacon asks for (/v1, /ui/, signed audio and covers)
and the page's own API under /ui/api/.

See Beacon's help page "External source API" for the contract."""

import asyncio
import contextlib
import hmac
import logging
import mimetypes
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import __version__
from .config import Config
from .covers import read_cover
from .library import Album, Library, Track
from .signing import sign, verify

logger = logging.getLogger("folder_source")

UI_DIR = Path(__file__).parent / "ui"

# The cache headers for covers and audio: they never change under the same
# address (a new file is a new track id), so the browser may keep them.
_IMMUTABLE = "private, max-age=86400"


def _album_summary(album: Album) -> dict:
    return {
        "id": album.id,
        "title": album.title,
        "artist": album.artist,
        "year": album.year,
        "genre": album.genre,
        "songs": len(album.tracks),
        "duration": round(album.duration),
        "cover": album.cover is not None,
        "added": album.added,
    }


def create_app(config: Config, library: Library | None = None, scan_on_start: bool = True):
    library = library or Library(config.music_dir, config.data_dir / "library.sqlite")

    def play_item(track: Track) -> dict:
        """What the page hands to Beacon for this track. Addresses relative
        to /ui/, signed: Beacon and the speakers fetch them with no header."""
        album = library.album_of(track.id)
        extension = Path(track.path).suffix.lower()
        item = {
            "audioUrl": f"../audio/{track.id}/{sign(config.secret, 'audio', track.id)}{extension}",
            "title": track.title,
            "artist": track.artist or (album.artist if album else ""),
            "album": album.title if album else track.album,
            "duration": track.duration or None,
        }
        if album and album.cover:
            item["coverUrl"] = f"../covers/{album.id}/{sign(config.secret, 'cover', album.id)}"
        return item

    def track_row(track: Track) -> dict:
        return {
            "id": track.id,
            "title": track.title,
            "artist": track.artist,
            "album": track.album,
            "albumId": library.track_album.get(track.id),
            "track": track.track,
            "disc": track.disc,
            "duration": track.duration,
            "item": play_item(track),
        }

    # --- what Beacon asks for ----------------------------------------------------

    async def health(request: Request):
        return JSONResponse({"ok": True})

    async def info(request: Request):
        return JSONResponse({"name": config.name, "version": __version__, "capabilities": []})

    async def page(request: Request):
        return FileResponse(UI_DIR / "index.html", headers={"cache-control": "no-cache"})

    async def audio(request: Request):
        track_id = request.path_params["track_id"]
        signature = Path(request.path_params["signature"]).stem
        track = library.tracks.get(track_id)
        if not track or not verify(config.secret, "audio", track_id, signature):
            return Response(status_code=404)
        path = library.file(track.path)
        if path is None:
            return Response(status_code=404)
        # FileResponse answers Range requests: Beacon can seek, draw the
        # waveform and mix transitions.
        return FileResponse(
            path,
            media_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            headers={"cache-control": _IMMUTABLE},
        )

    def cover_response(album_id: str) -> Response:
        album = library.albums.get(album_id)
        if not album or not album.cover:
            return Response(status_code=404)
        kind, relative = album.cover
        path = library.file(relative)
        found = read_cover(kind, path) if path else None
        if not found:
            return Response(status_code=404)
        data, content_type = found
        return Response(data, media_type=content_type, headers={"cache-control": _IMMUTABLE})

    async def signed_cover(request: Request):
        album_id = request.path_params["album_id"]
        if not verify(config.secret, "cover", album_id, request.path_params["signature"]):
            return Response(status_code=404)
        return await asyncio.to_thread(cover_response, album_id)

    # --- the page's own API ----------------------------------------------------

    async def page_cover(request: Request):
        return await asyncio.to_thread(cover_response, request.path_params["album_id"])

    async def status(request: Request):
        return JSONResponse(
            {
                "name": config.name,
                "albums": len(library.albums),
                "songs": len(library.tracks),
                "scanning": library.scanning,
                "progress": {
                    "phase": library.progress.phase,
                    "found": library.progress.found,
                    "toRead": library.progress.to_read,
                    "read": library.progress.read,
                },
                "lastScan": library.last_scan,
                "lastScanSeconds": library.last_scan_seconds,
            }
        )

    async def albums(request: Request):
        listed = [_album_summary(a) for a in library.albums.values()]
        return JSONResponse(listed)

    async def album(request: Request):
        found = library.albums.get(request.path_params["album_id"])
        if not found:
            return JSONResponse({"error": "not found"}, status_code=404)
        return JSONResponse(
            {**_album_summary(found), "tracks": [track_row(t) for t in found.tracks]}
        )

    async def artists(request: Request):
        counts: dict[str, dict] = {}
        for a in library.albums.values():
            name = a.artist or "Unknown artist"
            entry = counts.setdefault(name, {"name": name, "albums": 0, "cover": None})
            entry["albums"] += 1
            if entry["cover"] is None and a.cover:
                entry["cover"] = a.id
        return JSONResponse(sorted(counts.values(), key=lambda e: e["name"].casefold()))

    async def search(request: Request):
        found_albums, found_tracks = library.search(request.query_params.get("q", ""))
        return JSONResponse(
            {
                "albums": [_album_summary(a) for a in found_albums],
                "tracks": [track_row(t) for t in found_tracks],
            }
        )

    async def rescan(request: Request):
        if not library.scanning:
            asyncio.get_running_loop().run_in_executor(None, library.scan)
            await asyncio.sleep(0.05)
        return await status(request)

    # --- life --------------------------------------------------------------------

    async def rescan_every_so_often():
        while True:
            await asyncio.to_thread(library.scan)
            if config.rescan_minutes <= 0:
                return
            await asyncio.sleep(config.rescan_minutes * 60)

    @contextlib.asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(rescan_every_so_often()) if scan_on_start else None
        yield
        if task:
            task.cancel()

    routes = [
        Route("/health", health),
        Route("/v1", info),
        Route("/ui/", page),
        Route("/ui/api/status", status),
        Route("/ui/api/albums", albums),
        Route("/ui/api/albums/{album_id}", album),
        Route("/ui/api/artists", artists),
        Route("/ui/api/search", search),
        Route("/ui/api/rescan", rescan, methods=["POST"]),
        Route("/ui/covers/{album_id}", page_cover),
        Mount("/ui", app=StaticFiles(directory=UI_DIR)),
        Route("/audio/{track_id}/{signature}", audio),
        Route("/covers/{album_id}/{signature}", signed_cover),
    ]
    app = Starlette(routes=routes, lifespan=lifespan)
    app.state.library = library
    return TokenCheck(app, config.token)


class TokenCheck:
    """With a token set, /v1 and /ui/ answer only a request that carries it
    (Beacon adds it when it passes the page through). Audio and covers stand
    on their signature instead, /health on nothing."""

    def __init__(self, app, token: str):
        self.app = app
        self.token = token
        self.state = app.state

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and self.token:
            path = scope["path"]
            if path == "/v1" or path.startswith("/ui"):
                headers = dict(scope.get("headers") or [])
                given = headers.get(b"authorization", b"")
                if not hmac.compare_digest(given, f"Bearer {self.token}".encode()):
                    await Response("Token required", status_code=401)(scope, receive, send)
                    return
        await self.app(scope, receive, send)
