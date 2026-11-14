"""The HTTP side: what Beacon asks for (/v1, /ui/, signed audio and covers)
and the page's own API under /ui/api/.

See Beacon's help page "External source API" for the contract."""

import asyncio
import contextlib
import datetime
import hmac
import mimetypes
from pathlib import Path
from urllib.parse import quote

from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import __version__
from .archive import Archive, ArchiveError, Show
from .config import Config
from .signing import sign, verify

UI_DIR = Path(__file__).parent / "ui"

# A show's files never change under the same name, so the browser may keep them.
_IMMUTABLE = "private, max-age=86400"

# What it takes to be shown large on the shows tab.
_FEATURE_SONGS = 3
_FEATURE_SECONDS = 20 * 60

# What Beacon's request may carry on to archive.org, and what comes back.
_PASSED_REQUEST = ("range", "if-range")
_PASSED_RESPONSE = (
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "last-modified",
    "etag",
)


def create_app(
    config: Config,
    archive: Archive | None = None,
    today=datetime.date.today,
):
    archive = archive or Archive()

    def play_item(show: Show, name: str, title: str, duration: float | None) -> dict:
        """What the page hands to Beacon for one song. Addresses relative to
        /ui/, signed: Beacon and the speakers fetch them with no header."""
        audio_key = f"{show.id}/{name}"
        return {
            "audioUrl": f"../audio/{sign(config.secret, 'audio', audio_key)}/{show.id}/"
            + quote(name),
            "coverUrl": f"../covers/{sign(config.secret, 'cover', show.cover_id)}/{show.cover_id}",
            "title": title,
            "artist": show.artist,
            "album": show.album,
            "duration": duration,
        }

    def show_details(show: Show) -> dict:
        return {
            "id": show.id,
            "title": show.title,
            "album": show.album,
            "artist": show.artist,
            "artistId": show.artist_id,
            "coverId": show.cover_id,
            "date": show.date,
            "venue": show.venue,
            "location": show.location,
            "songs": len(show.tracks),
            "duration": round(sum(t.duration or 0 for t in show.tracks)),
            "tracks": [
                {
                    "title": t.title,
                    "duration": t.duration,
                    "item": play_item(show, t.name, t.title, t.duration),
                }
                for t in show.tracks
            ],
        }

    def failed(error: ArchiveError) -> JSONResponse:
        return JSONResponse({"error": str(error)}, status_code=error.status)

    # --- what Beacon asks for ----------------------------------------------------

    async def health(request: Request):
        return JSONResponse({"ok": True})

    async def info(request: Request):
        return JSONResponse({"name": config.name, "version": __version__, "capabilities": []})

    async def page(request: Request):
        return FileResponse(UI_DIR / "index.html", headers={"cache-control": "no-cache"})

    async def audio(request: Request):
        show_id = request.path_params["show_id"]
        name = request.path_params["name"]
        if not verify(config.secret, "audio", f"{show_id}/{name}", request.path_params["sig"]):
            return Response(status_code=404)
        headers = {k: v for k in _PASSED_REQUEST if (v := request.headers.get(k))}
        try:
            upstream = await archive.open_audio(show_id, name, request.method, headers)
        except ArchiveError as error:
            return Response(str(error), status_code=error.status)
        if upstream.status_code not in (200, 206, 416):
            await upstream.aclose()
            return Response(status_code=502)
        passed = {k: v for k in _PASSED_RESPONSE if (v := upstream.headers.get(k))}
        passed.setdefault("accept-ranges", "bytes")
        guessed = mimetypes.guess_type(name)[0]
        if guessed and not passed.get("content-type", "").startswith("audio/"):
            passed["content-type"] = guessed
        passed["cache-control"] = _IMMUTABLE
        if request.method == "HEAD":
            await upstream.aclose()
            return Response(status_code=upstream.status_code, headers=passed)
        # Passed on as it arrives, never kept: Beacon fetches again what it
        # needs. Asked for unencoded, so these are the bytes archive.org sent.
        return StreamingResponse(
            upstream.aiter_bytes(),
            status_code=upstream.status_code,
            headers=passed,
            background=BackgroundTask(upstream.aclose),
        )

    async def image_response(identifier: str) -> Response:
        try:
            found = await archive.image(identifier)
        except ArchiveError:
            found = None
        if not found:
            return Response(status_code=404)
        data, content_type = found
        return Response(data, media_type=content_type, headers={"cache-control": _IMMUTABLE})

    async def signed_cover(request: Request):
        identifier = request.path_params["identifier"]
        if not verify(config.secret, "cover", identifier, request.path_params["sig"]):
            return Response(status_code=404)
        return await image_response(identifier)

    # --- the page's own API ----------------------------------------------------

    async def page_image(request: Request):
        return await image_response(request.path_params["identifier"])

    async def status(request: Request):
        return JSONResponse({"name": config.name})

    async def feature_of(week: list[dict]) -> dict | None:
        """The most played show of the week that is a concert: the archive
        also holds the odd upload of a few seconds or a website dump."""
        for summary in week[:5]:
            try:
                show = await archive.show(summary["id"])
            except ArchiveError:
                continue
            if len(show.tracks) >= _FEATURE_SONGS and (
                sum(t.duration or 0 for t in show.tracks) >= _FEATURE_SECONDS
            ):
                return summary
        return None

    async def home(request: Request):
        day = today()
        try:
            week, on_this_day, favourites = await asyncio.gather(
                archive.popular_shows(),
                archive.on_this_day(day.month, day.day),
                archive.favourites(),
            )
        except ArchiveError as error:
            return failed(error)
        featured = await feature_of(week)
        return JSONResponse(
            {
                "today": day.isoformat(),
                "featured": featured,
                "week": [show for show in week if show is not featured],
                "onThisDay": on_this_day,
                "favourites": favourites,
            }
        )

    async def artists(request: Request):
        try:
            return JSONResponse(await archive.popular_artists())
        except ArchiveError as error:
            return failed(error)

    async def artist(request: Request):
        artist_id = request.path_params["artist_id"]
        sort = request.query_params.get("sort", "newest")
        try:
            page_number = int(request.query_params.get("page", "1"))
        except ValueError:
            page_number = 1
        try:
            found = await archive.artist(artist_id)
            total, shows = await archive.shows_of(artist_id, sort, page_number)
        except ArchiveError as error:
            return failed(error)
        return JSONResponse({**found, "total": total, "page": page_number, "shows": shows})

    async def show(request: Request):
        try:
            return JSONResponse(show_details(await archive.show(request.path_params["show_id"])))
        except ArchiveError as error:
            return failed(error)

    async def search(request: Request):
        text = request.query_params.get("q", "")
        try:
            found_artists = await archive.search_artists(text)
            found_shows = await archive.search_shows(text)
        except ArchiveError as error:
            return failed(error)
        return JSONResponse({"artists": found_artists, "shows": found_shows})

    # --- life --------------------------------------------------------------------

    @contextlib.asynccontextmanager
    async def lifespan(app):
        yield
        await archive.aclose()

    routes = [
        Route("/health", health),
        Route("/v1", info),
        Route("/ui/", page),
        Route("/ui/api/status", status),
        Route("/ui/api/home", home),
        Route("/ui/api/artists", artists),
        Route("/ui/api/artists/{artist_id}", artist),
        Route("/ui/api/shows/{show_id}", show),
        Route("/ui/api/search", search),
        Route("/ui/images/{identifier}", page_image),
        Mount("/ui", app=StaticFiles(directory=UI_DIR)),
        Route("/audio/{sig}/{show_id}/{name:path}", audio, methods=["GET", "HEAD"]),
        Route("/covers/{sig}/{identifier}", signed_cover),
    ]
    app = Starlette(routes=routes, lifespan=lifespan)
    app.state.archive = archive
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
