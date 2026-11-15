"""The HTTP side: what Beacon asks for (/v1, /ui/, signed audio and covers)
and the page's own API under /ui/api/, one set of it per music folder.

See Beacon's help page "External source API" for the contract."""

import asyncio
import contextlib
import hmac
import logging
import mimetypes
import threading
from pathlib import Path

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import __version__
from .config import Config
from .covers import read_cover, read_thumbnail
from .library import Album, Library, Track, sort_text
from .signing import sign, verify

logger = logging.getLogger("folder_source")

UI_DIR = Path(__file__).parent / "ui"

# The cache headers for covers and audio: they never change under the same
# address (a new file is a new track id), so the browser may keep them.
_IMMUTABLE = "private, max-age=86400"


# Songs in one answer at most: a page of the songs list.
_MAX_SONGS = 500


def _number(text: str | None, low: int, high: int, default: int | None = None) -> int:
    try:
        value = int(text) if text is not None else (low if default is None else default)
    except ValueError:
        value = low if default is None else default
    return max(low, min(high, value))


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


def create_app(
    config: Config, libraries: dict[str, Library] | None = None, scan_on_start: bool = True
):
    """`libraries`: by folder key, for tests that scanned them already."""
    libraries = libraries or {
        f.key: Library(f.path, config.data_dir / f"library-{f.key}.sqlite") for f in config.folders
    }

    def play_item(key: str, library: Library, track: Track) -> dict:
        """What the page hands to Beacon for this track. Addresses relative
        to /ui/, signed: Beacon and the speakers fetch them with no header.
        Track and album ids are only unique within their folder, so the
        folder is part of what is signed."""
        album = library.album_of(track.id)
        extension = Path(track.path).suffix.lower()
        signature = sign(config.secret, "audio", f"{key}/{track.id}")
        item = {
            "audioUrl": f"../audio/{key}/{track.id}/{signature}{extension}",
            "title": track.title,
            "artist": track.artist or (album.artist if album else ""),
            "album": album.title if album else track.album,
            "duration": track.duration or None,
        }
        if album and album.cover:
            signature = sign(config.secret, "cover", f"{key}/{album.id}")
            item["coverUrl"] = f"../covers/{key}/{album.id}/{signature}"
        return item

    def track_row(key: str, library: Library, track: Track) -> dict:
        album = library.album_of(track.id)
        return {
            "id": track.id,
            "title": track.title,
            "artist": track.artist,
            "album": track.album,
            "albumId": album.id if album else None,
            "cover": bool(album and album.cover),
            "track": track.track,
            "disc": track.disc,
            "year": track.year,
            "genre": track.genre,
            "duration": track.duration,
            "format": track.format,
            "bitrate": track.bitrate,
            "sampleRate": track.sample_rate,
            "bitDepth": track.bit_depth,
            "item": play_item(key, library, track),
        }

    def folder_of(request: Request) -> tuple[str, Library]:
        key = request.path_params["folder"]
        if key not in libraries:
            raise HTTPException(404)
        return key, libraries[key]

    # --- what Beacon asks for ----------------------------------------------------

    async def health(request: Request):
        return JSONResponse({"ok": True})

    async def info(request: Request):
        return JSONResponse({"name": config.name, "version": __version__, "capabilities": []})

    async def page(request: Request):
        return FileResponse(UI_DIR / "index.html", headers={"cache-control": "no-cache"})

    async def audio(request: Request):
        key, library = folder_of(request)
        track_id = request.path_params["track_id"]
        signature = Path(request.path_params["signature"]).stem
        track = library.tracks.get(track_id)
        if not track or not verify(config.secret, "audio", f"{key}/{track_id}", signature):
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

    def cover_response(library: Library, album_id: str, thumb: bool = False) -> Response:
        album = library.albums.get(album_id)
        if not album or not album.cover:
            return Response(status_code=404)
        kind, relative = album.cover
        path = library.file(relative)
        found = (read_thumbnail if thumb else read_cover)(kind, path) if path else None
        if not found:
            return Response(status_code=404)
        data, content_type = found
        return Response(data, media_type=content_type, headers={"cache-control": _IMMUTABLE})

    async def signed_cover(request: Request):
        key, library = folder_of(request)
        album_id = request.path_params["album_id"]
        signature = request.path_params["signature"]
        if not verify(config.secret, "cover", f"{key}/{album_id}", signature):
            return Response(status_code=404)
        return await asyncio.to_thread(cover_response, library, album_id)

    # --- the page's own API ----------------------------------------------------

    async def page_cover(request: Request):
        _, library = folder_of(request)
        thumb = request.query_params.get("size") == "thumb"
        album_id = request.path_params["album_id"]
        return await asyncio.to_thread(cover_response, library, album_id, thumb)

    def folder_status(folder) -> dict:
        library = libraries[folder.key]
        return {
            "key": folder.key,
            "name": folder.name,
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

    async def status(request: Request):
        folders = [folder_status(f) for f in config.folders]
        return JSONResponse(
            {
                "name": config.name,
                # Folders are scanned one after the other: one that is done
                # may still be waiting for the next round.
                "scanning": any(f["scanning"] for f in folders) or scan_all_lock.locked(),
                "folders": folders,
            }
        )

    async def albums(request: Request):
        _, library = folder_of(request)
        return JSONResponse([_album_summary(a) for a in library.albums.values()])

    async def album(request: Request):
        key, library = folder_of(request)
        found = library.albums.get(request.path_params["album_id"])
        if not found:
            return JSONResponse({"error": "not found"}, status_code=404)
        tracks = [track_row(key, library, t) for t in found.tracks]
        return JSONResponse({**_album_summary(found), "tracks": tracks})

    async def artists(request: Request):
        _, library = folder_of(request)
        counts: dict[str, dict] = {}
        for a in library.albums.values():
            name = a.artist or "Unknown artist"
            entry = counts.setdefault(name, {"name": name, "albums": 0, "cover": None})
            entry["albums"] += 1
            if entry["cover"] is None and a.cover:
                entry["cover"] = a.id
        return JSONResponse(sorted(counts.values(), key=lambda e: sort_text(e["name"])))

    async def songs(request: Request):
        key, library = folder_of(request)
        sort = request.query_params.get("sort", "title")
        listed = library.songs(sort)
        offset = _number(request.query_params.get("offset"), 0, len(listed))
        limit = _number(request.query_params.get("limit"), 1, _MAX_SONGS, default=_MAX_SONGS)
        rows = [track_row(key, library, t) for t in listed[offset : offset + limit]]
        # The index only with the first page: it does not change from page to page.
        letters = await asyncio.to_thread(library.song_letters, sort) if offset == 0 else None
        return JSONResponse({"total": len(listed), "rows": rows, "letters": letters})

    async def search(request: Request):
        key, library = folder_of(request)
        found_albums, found_tracks = library.search(request.query_params.get("q", ""))
        return JSONResponse(
            {
                "albums": [_album_summary(a) for a in found_albums],
                "tracks": [track_row(key, library, t) for t in found_tracks],
            }
        )

    async def rescan(request: Request):
        if not scan_all_lock.locked():
            asyncio.get_running_loop().run_in_executor(None, scan_all)
            await asyncio.sleep(0.05)
        return await status(request)

    # --- life --------------------------------------------------------------------

    scan_all_lock = threading.Lock()

    def scan_all() -> None:
        """One folder after the other: at once, they would fight over the disk.
        A second call while a round runs returns at once."""
        if not scan_all_lock.acquire(blocking=False):
            return
        try:
            for library in libraries.values():
                library.scan()
        finally:
            scan_all_lock.release()

    async def rescan_every_so_often():
        while True:
            await asyncio.to_thread(scan_all)
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
        Route("/ui/api/rescan", rescan, methods=["POST"]),
        Route("/ui/api/{folder}/albums", albums),
        Route("/ui/api/{folder}/albums/{album_id}", album),
        Route("/ui/api/{folder}/artists", artists),
        Route("/ui/api/{folder}/songs", songs),
        Route("/ui/api/{folder}/search", search),
        Route("/ui/covers/{folder}/{album_id}", page_cover),
        Mount("/ui", app=StaticFiles(directory=UI_DIR)),
        Route("/audio/{folder}/{track_id}/{signature}", audio),
        Route("/covers/{folder}/{album_id}/{signature}", signed_cover),
    ]
    app = Starlette(routes=routes, lifespan=lifespan)
    app.state.libraries = libraries
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
