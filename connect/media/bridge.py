"""media/bridge.py — what jellyfin_bridge.py and plex_bridge.py share.

Both answer the same Subsonic request shapes from a server that speaks
something else, so everything that is about the *Subsonic* side lives here
once: the request dispatch and its error envelope, the binary passthrough
for cover art and streams, and how a playlist is brought to an exact list of
songs. What stays in each bridge is what the server itself decides — its
URLs, its calls, its field mapping.
"""

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import quote

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import apply_image_cache_control
from .base import match_entries_to_song_ids, reorder_moves, subsonic_envelope, subsonic_error

Handler = Callable[[dict, object], Awaitable[dict]]


def quote_id(value: str) -> str:
    """Percent-encodes an id (song/album/artist/playlist id, or any other
    client-supplied value) before it's spliced into a server URL *path*
    segment via an f-string. Every id a bridge handles ultimately comes from
    the incoming Subsonic-shaped request (params["id"] and friends),
    unvalidated — without this, a value like "../Users" would let a caller
    holding only the shared CONNECT_TOKEN reach arbitrary server API paths
    outside the handler whitelist a bridge exists to enforce. Query `params`
    passed separately to httpx don't need this — httpx encodes those
    itself."""
    return quote(str(value), safe="")


def set_field(target: dict, key: str, value) -> None:
    """Omit rather than send an empty field. mappers.ts and
    services/library/songDetails.ts both read presence, not value: a key
    that is there with None in it becomes a row saying nothing."""
    if value not in (None, "", [], {}):
        target[key] = value


def map_all(
    mapper: Callable[[dict], dict],
    items: list[dict],
    *,
    id_field: str,
    log: logging.Logger,
    label: str,
) -> list[dict]:
    """Applies `mapper` to each item, skipping (and logging) any single item
    that fails to map instead of letting one malformed record fail the
    entire request — a page with 999 of 1000 albums showing is still
    useful; an empty page because item #500 was missing a field isn't."""
    mapped = []
    for item in items:
        try:
            mapped.append(mapper(item))
        except Exception as e:
            log.warning(f"[{label}] Skipping malformed item {item.get(id_field, '?')}: {e}")
    return mapped


# ── Playlists ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PlaylistEditor:
    """One playlist's entries as the server addresses them. `entries` lists
    (per-entry id, song id) in playlist order: only the per-entry id
    addresses one specific copy of a song that appears twice."""

    entries: Callable[[], Awaitable[list[tuple[str, str]]]]
    remove: Callable[[list[str]], Awaitable[None]]
    add: Callable[[list[str]], Awaitable[None]]
    # (entry id, target index, entry it should follow or None for the front)
    # — Jellyfin moves by index, Plex by naming the entry before it.
    move: Callable[[str, int, str | None], Awaitable[None]]


async def set_playlist_songs(editor: PlaylistEditor, song_ids: list[str]) -> None:
    """Makes the playlist hold exactly `song_ids`, in that order.

    Neither server has a replace-the-list call, so this removes what's no
    longer wanted, appends what's missing, and then moves entries into place
    one at a time. A plain reorder — the only thing Beacon's own UI sends —
    needs neither of the first two steps and costs one listing plus one move
    per row that actually shifted. Not atomic: a failure partway leaves the
    playlist between the two orders, which is why the client keeps the
    complete list on its side and can send it again."""
    entries = await editor.entries()
    matched = match_entries_to_song_ids([song_id for _, song_id in entries], song_ids)

    keep = {entries[position][0] for position in matched if position is not None}
    stale = [entry_id for entry_id, _ in entries if entry_id not in keep]
    missing = [
        song_id for song_id, position in zip(song_ids, matched, strict=True) if position is None
    ]
    if stale:
        await editor.remove(stale)
    if missing:
        await editor.add(missing)
    if stale or missing:
        # Re-listed rather than predicted: an appended song gets a fresh
        # per-entry id only the server knows.
        entries = await editor.entries()
        matched = match_entries_to_song_ids([song_id for _, song_id in entries], song_ids)

    current = [entry_id for entry_id, _ in entries]
    # Anything still unmatched here is a song the server refused to add
    # (deleted since the client last looked, say) — the rest is still put in
    # the requested order rather than failing the whole call over it.
    target = [entries[position][0] for position in matched if position is not None]
    for entry_id, index, after in reorder_moves(current, target):
        await editor.move(entry_id, index, after)


async def update_playlist(
    params,
    *,
    add: Callable[[str, list[str]], Awaitable[None]],
    remove: Callable[[str, list[int]], Awaitable[None]],
    rename: Callable[[str, str], Awaitable[None]],
) -> dict:
    """updatePlaylist.view: one of adding songs, removing entries by
    position, or — the only remaining reason client.ts calls it — a rename.
    Subsonic's `public` is never passed on; see each bridge's `rename`."""
    playlist_id = params.get("playlistId") or params["id"]
    song_ids_to_add = params.getlist("songIdToAdd")
    indexes_to_remove = params.getlist("songIndexToRemove")
    if song_ids_to_add:
        await add(playlist_id, song_ids_to_add)
        return {}
    if indexes_to_remove:
        await remove(playlist_id, [int(i) for i in indexes_to_remove])
        return {}
    name = params.get("name")
    if name is not None:
        await rename(playlist_id, name)
        return {}
    raise ValueError("updatePlaylist.view requires songIdToAdd, songIndexToRemove, or name")


# ── Binary passthrough (getCoverArt.view, stream.view) ───────────────────────
# Fetched by the browser as raw <img>/<audio> src URLs, not through
# SubsonicClient.get()'s JSON envelope — see services/subsonic/client.ts's
# coverArtUrl()/streamUrl(). Streamed through connect the same way
# routes/proxy.py's own _proxy() streams Subsonic responses, just targeting
# the bridged server's URL.

BINARY_PATHS = {"getCoverArt.view", "stream.view"}
# content-length included: blindly forwarding the upstream value crashes
# uvicorn ("Response content longer than Content-Length") whenever the
# actual streamed byte count doesn't match it exactly — confirmed live
# (2026-08-17) against Plex's thumb endpoint, which apparently doesn't
# always keep the two in sync for on-the-fly-generated images. Dropping it
# lets Starlette's StreamingResponse fall back to chunked transfer
# encoding, which makes no such promise to violate.
# date included for the same reason as in routes/proxy.py: uvicorn writes
# its own, and a second one makes a reverse proxy in front of this log a
# warning per request.
SKIP_RESP_HEADERS = {
    "transfer-encoding",
    "connection",
    "content-encoding",
    "content-length",
    "date",
}


async def stream_binary(
    client: httpx.AsyncClient,
    request: Request,
    url: str,
    headers: dict,
    keep_length: bool = False,
) -> StreamingResponse:
    """`keep_length` forwards the upstream Content-Length after all, for a
    track's original file: Safari only plays a media response through when it
    knows the length
    (docs/investigations/phone-and-browser/safari-transcode-jumps-to-start.md). Never
    for a compressed body, which httpx decompresses and so makes longer than
    the header says."""
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header
    req = client.build_request(request.method, url, headers=headers)
    response = await client.send(req, stream=True)

    async def streamed():
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()

    skip = set(SKIP_RESP_HEADERS)
    if keep_length and "content-encoding" not in response.headers:
        skip.discard("content-length")
    resp_headers = {k: v for k, v in response.headers.items() if k.lower() not in skip}
    content_type = response.headers.get("content-type")
    apply_image_cache_control(resp_headers, content_type)
    return StreamingResponse(
        streamed(),
        status_code=response.status_code,
        headers=resp_headers,
        media_type=content_type,
    )


# ── Entry point ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Bridge:
    """What one server's bridge plugs into the shared dispatch."""

    # "[label]" on every log line, and the end of the answer to a path
    # that isn't bridged ("getFoo.view is not supported on ...").
    label: str
    unsupported: str
    handlers: dict[str, Handler]
    log: logging.Logger
    # A callable rather than the client itself: each bridge's _get_client()
    # creates it lazily, and tests swap that function out.
    client: Callable[[], httpx.AsyncClient]
    # The server URL for a cover (None: the item has none) and for a track.
    cover_url: Callable[[str, dict, object], Awaitable[str | None]]
    stream_url: Callable[[str, object], Awaitable[str]]


async def call(bridge: Bridge, endpoint: str, params: dict, media) -> dict:
    """One Subsonic endpoint answered from inside connect rather than for a
    request - core/party_library.py asks this while the party's host
    window sleeps. Same answer handle() wraps in the Subsonic envelope."""
    handler = bridge.handlers.get(endpoint)
    if handler is None:
        raise ValueError(f"{endpoint} is not bridged")
    return await handler(params, media)


async def _handle_binary(
    bridge: Bridge, path: str, request: Request, media
) -> StreamingResponse | JSONResponse:
    params = dict(request.query_params)
    item_id = params.get("id", "")
    if path == "getCoverArt.view":
        if not item_id:
            return subsonic_error(70, "No cover art id supplied")
        url = await bridge.cover_url(item_id, params, media)
        if not url:
            return subsonic_error(70, "No cover art available")
    else:  # stream.view
        if not item_id:
            return subsonic_error(70, "No track id supplied")
        url = await bridge.stream_url(item_id, media)
    return await stream_binary(
        bridge.client(), request, url, media.auth_headers(), keep_length=path == "stream.view"
    )


async def handle(
    bridge: Bridge, path: str, request: Request, media
) -> JSONResponse | StreamingResponse:
    if path in BINARY_PATHS:
        try:
            return await _handle_binary(bridge, path, request, media)
        except Exception as e:
            # A connectivity blip (server restart, timeout) mid cover-art-load
            # or mid-stream degrades like every JSON endpoint below, rather
            # than reaching the client as a raw FastAPI 500.
            bridge.log.warning(f"[{bridge.label}] {path} failed: {e}")
            return subsonic_error(0, str(e))

    handler = bridge.handlers.get(path)
    if handler is None:
        # Also the fallback for endpoints deliberately never bridged (see
        # each bridge's module docstring) — the frontend hides the UI for
        # those before they'd ever be called, this is just the safety net.
        return subsonic_error(70, f"{path} {bridge.unsupported}")
    try:
        # request.query_params (not dict(...)) — a plain dict() conversion
        # collapses repeated keys (songId=1&songId=2&...), which
        # createPlaylist/updatePlaylist need via .getlist(). Starlette's
        # QueryParams otherwise behaves like a dict for the .get()/[] access
        # every other handler uses.
        result = await handler(request.query_params, media)
    except Exception as e:
        bridge.log.warning(f"[{bridge.label}] {path} failed: {e}")
        return subsonic_error(0, str(e))
    return subsonic_envelope(result)
