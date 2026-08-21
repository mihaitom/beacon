"""media/plex_bridge.py — translates Subsonic-shaped /rest/*.view requests
into real Plex API calls, for a session whose SessionState.media is a
PlexClient (see routes/proxy.py's proxy_subsonic).

Phase B (read-only browsing + direct-play streaming) — see PLEX_PLAN.md.
Artists/albums/tracks, search, cover art, and playback (direct play — the
universal transcode endpoint is its own later stretch goal, per
PLEX_PLAN.md).

Phase C, partial — ratings and playlist CRUD:
  - Personal ratings (setRating.view) map onto Plex's own `PUT /:/rate`
    (0-10 internally, 2 units per star) — the one personal-marking
    mechanism the core Plex Media Server REST API exposes for music at
    all. There is no separate boolean favorite in this API surface: the
    heart-shaped "Love" seen in Plexamp/mobile is backed by Plex Pass
    cloud sync (plex.tv Discover), a different API this bridge doesn't
    talk to. So star.view/unstar.view/getStarred2.view are deliberately
    NOT bridged here — overloading the same rating value with an invented
    second meaning would be worse than leaving favorites unsupported, and
    the frontend has no separate capability flag to hide the heart icon
    per-backend the way personalRating already does (see
    services/capabilities.ts) — revisit together if this gap is worth
    closing.
  - Playlist CRUD is bridged (create/get/list/update/delete) via Plex's
    URI-addressed playlist API — needs the *server's* machine identifier
    (see _playlist_item_uri()), not yet confirmed against a live server.
  - scrobble.view (play tracking, drives the Stats page's playCount
    numbers) maps onto Plex's own `PUT /:/scrobble` — confirmed live
    (2026-08-19); services/capabilities.ts's playHistoryStats is true for
    Plex accordingly.
  - getGenres.view — not bridged, same as Jellyfin: Beacon's Genres page
    already derives everything from the full track scan (see search3()
    below, and stores/library.ts), which works regardless of backend.
    Revisit only if /library/sections/{id}/genre turns out to carry real
    per-genre counts cheaply (PLEX_PLAN.md flagged this as worth checking,
    not yet done).
  - getSimilarSongs2.view (Song/Artist Radio, and Autoplay's frontend-side
    top-up — see stores/playback.ts's maybeAutoplay()) maps onto Plex's own
    Sonic Analysis (`/library/metadata/{id}/nearest`) — see
    get_similar_songs2()'s own comment and PlexClient.get_similar_songs2()'s
    (media/plex.py) identical one for the full story: confirmed live
    (2026-08-20) that the endpoint is real, but Sonic Analysis itself is a
    Plex Pass-gated feature server-side (confirmed against Plex's own
    support docs), not something this bridge can work around — a
    non-Pass account gets a 403, translated here into an empty result
    rather than an error. services/capabilities.ts's songRadio is true for
    Plex accordingly, same as Jellyfin, even though it silently does
    nothing for a listener without Plex Pass.

Field names below are this module's best understanding of Plex's
Metadata/MediaContainer JSON shape, not yet fully confirmed against a live
library — expect a few live-iteration fixes, same as Phase A's auth flow
needed (three rounds: wrong endpoint version, DNS, then TLS).
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from urllib.parse import quote

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import apply_image_cache_control
from .base import (
    create_internet_radio_station,
    delete_internet_radio_station,
    get_internet_radio_stations,
    subsonic_envelope,
    subsonic_error,
    update_internet_radio_station,
)
from .plex import PlexClient

logger = logging.getLogger("connect.plex_bridge")

# Shared across every bridged request — same reasoning as
# jellyfin_bridge.py's own _client.
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(follow_redirects=True, timeout=60)
    return _client


async def close() -> None:
    """Closes the shared client — called once from main.py's lifespan on
    app shutdown, alongside jellyfin_bridge.py's/routes/proxy.py's own."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _quote_id(value: str) -> str:
    return quote(str(value), safe="")


async def _px_request(
    method: str, media: PlexClient, path: str, params: dict | None = None
) -> dict:
    client = _get_client()
    url = f"{media.internal_url}{path}"
    response = await client.request(
        method,
        url,
        headers=media.auth_headers(),
        params={k: v for k, v in (params or {}).items() if v is not None},
    )
    response.raise_for_status()
    return response.json() if response.content else {}


async def _px_get(media: PlexClient, path: str, **params: str) -> dict:
    return await _px_request("GET", media, path, params=params)


async def _music_section(media: PlexClient) -> str:
    """Resolves (and caches on `media`) this server's music library
    section key — every /library/sections/{key}/... call below needs it,
    and a server can mix music in with other, non-music sections (movies,
    TV, ...). Cached for the session's lifetime since the set of sections
    essentially never changes mid-session."""
    if media.music_section_key:
        return media.music_section_key
    data = await _px_get(media, "/library/sections")
    for section in data.get("MediaContainer", {}).get("Directory", []):
        if section.get("type") == "artist":
            media.music_section_key = str(section["key"])
            return media.music_section_key
    raise ValueError("No music library section found on this Plex server")


# ── Plex field mapping ───────────────────────────────────────────────────────
# Subsonic-shaped dicts built from a Plex Metadata item — mirrors
# jellyfin_bridge.py's own _map_song/_map_album/_map_artist, same idea, just
# against Plex's field names instead of Jellyfin's.


def _tags(item: dict, field: str) -> list[str]:
    """Plex's tag-like fields (Genre, Style, Mood, Country, Collection, ...)
    are each a list of {"tag": "..."} objects, not plain strings."""
    return [t["tag"] for t in (item.get(field) or []) if t.get("tag")]


def _map_user_rating(item: dict) -> int | None:
    """Plex's userRating is 0-10 (2 units/star); Subsonic's userRating is a
    plain 1-5 int, mappers.ts reads it straight off `raw.userRating`. None
    (omitted) rather than 0 when unset — mirrors every other optional field
    in this module."""
    rating = item.get("userRating")
    if not rating:
        return None
    return round(rating / 2)


def _map_song(item: dict) -> dict:
    media_list = item.get("Media") or []
    media0 = media_list[0] if media_list else {}
    song = {
        "id": str(item["ratingKey"]),
        "title": item.get("title", "Unknown"),
        "artist": item.get("grandparentTitle") or "Unknown",
        "album": item.get("parentTitle", ""),
        "duration": int((item.get("duration") or 0) / 1000),
        # Tracks rarely carry their own art — the album's usually does,
        # same fallback as PlexClient.get_track().
        "coverArt": str(item.get("parentRatingKey") or item["ratingKey"]),
        "playCount": item.get("viewCount", 0),
    }
    if item.get("index") is not None:
        song["track"] = item["index"]
    if item.get("parentIndex") is not None:
        song["discNumber"] = item["parentIndex"]
    year = item.get("parentYear") or item.get("year")
    if year is not None:
        song["year"] = year
    genres = _tags(item, "Genre")
    if genres:
        song["genre"] = genres[0]
    if item.get("parentRatingKey"):
        song["albumId"] = str(item["parentRatingKey"])
    if item.get("grandparentRatingKey"):
        song["artistId"] = str(item["grandparentRatingKey"])
    if media0.get("container"):
        song["suffix"] = media0["container"]
    if media0.get("bitrate"):
        song["bitRate"] = media0["bitrate"]
    user_rating = _map_user_rating(item)
    if user_rating is not None:
        song["userRating"] = user_rating
    return song


def _map_album(item: dict) -> dict:
    album = {
        "id": str(item["ratingKey"]),
        "name": item.get("title", "Unknown"),
        "artist": item.get("parentTitle", "Unknown"),
        "coverArt": str(item["ratingKey"]),
        "songCount": item.get("leafCount") or 0,
        "duration": int((item.get("duration") or 0) / 1000),
    }
    if item.get("parentRatingKey"):
        album["artistId"] = str(item["parentRatingKey"])
    if item.get("year") is not None:
        album["year"] = item["year"]
    genres = _tags(item, "Genre")
    if genres:
        album["genre"] = genres[0]
    user_rating = _map_user_rating(item)
    if user_rating is not None:
        album["userRating"] = user_rating
    return album


def _map_artist(item: dict) -> dict:
    artist = {
        "id": str(item["ratingKey"]),
        "name": item.get("title", "Unknown"),
        "coverArt": str(item["ratingKey"]),
        "albumCount": item.get("childCount") or 0,
    }
    user_rating = _map_user_rating(item)
    if user_rating is not None:
        artist["userRating"] = user_rating
    return artist


def _map_all(mapper: Callable[[dict], dict], items: list[dict]) -> list[dict]:
    """Same "skip one bad item, keep the rest" reasoning as
    jellyfin_bridge.py's own _map_all."""
    result = []
    for item in items:
        try:
            result.append(mapper(item))
        except Exception as e:
            logger.warning(f"[plex-bridge] Skipping malformed item {item.get('ratingKey', '?')}: {e}")
    return result


# ── JSON handlers ─────────────────────────────────────────────────────────────

_ALBUM_SORT_PARAMS: dict[str, str] = {
    "alphabeticalByName": "titleSort",
    "newest": "addedAt:desc",
    "random": "random",
    "recent": "lastViewedAt:desc",
    "frequent": "viewCount:desc",
}


async def get_album_list2(params: dict, media: PlexClient) -> dict:
    section = await _music_section(media)
    sort_type = params.get("type", "alphabeticalByName")
    data = await _px_get(
        media,
        f"/library/sections/{section}/all",
        type="9",
        sort=_ALBUM_SORT_PARAMS.get(sort_type, "titleSort"),
        **{
            "X-Plex-Container-Start": params.get("offset", "0"),
            "X-Plex-Container-Size": params.get("size", "100"),
        },
    )
    items = data.get("MediaContainer", {}).get("Metadata", [])
    return {"albumList2": {"album": _map_all(_map_album, items)}}


async def get_album(params: dict, media: PlexClient) -> dict:
    album_id = params["id"]
    item_data = await _px_get(media, f"/library/metadata/{_quote_id(album_id)}")
    items = item_data.get("MediaContainer", {}).get("Metadata", [])
    if not items:
        raise ValueError(f"Album {album_id} not found")
    album = _map_album(items[0])
    children = await _px_get(media, f"/library/metadata/{_quote_id(album_id)}/children")
    songs = children.get("MediaContainer", {}).get("Metadata", [])
    mapped_songs = _map_all(_map_song, songs)
    # Confirmed live (2026-08-17): /children's per-track Metadata entries
    # don't reliably carry parentRatingKey the way a flat library-wide
    # listing does — _map_song()'s own fallback then lands on the track's
    # *own* ratingKey, which has no thumb of its own (tracks essentially
    # never do), so covers silently went missing for exactly this call
    # path. The album id is already known here regardless of what the
    # response included, so just use it directly rather than trusting
    # _map_song()'s guess.
    for song in mapped_songs:
        song["coverArt"] = str(album_id)
        song.setdefault("albumId", str(album_id))
    album["song"] = mapped_songs
    return {"album": album}


async def get_song(params: dict, media: PlexClient) -> dict:
    data = await _px_get(media, f"/library/metadata/{_quote_id(params['id'])}")
    items = data.get("MediaContainer", {}).get("Metadata", [])
    if not items:
        raise ValueError(f"Song {params['id']} not found")
    return {"song": _map_song(items[0])}


async def get_similar_songs2(params: dict, media: PlexClient) -> dict:
    """Song/Artist Radio + Autoplay's frontend-facing counterpart to
    PlexClient.get_similar_songs2() (media/plex.py) — same endpoint, same
    Plex-Pass caveat and unverified-response-shape note, see that method's
    own comment for the full explanation. Duplicated rather than shared
    because that one's synchronous (for connect's own internal Autoplay
    fallback, see routes/stream.py) and this one's async (this module's
    handlers all are, see _HANDLERS below) — same split as get_song() above
    vs. PlexClient.get_track().

    Unlike that one, a 403 here surfaces as `plexPassRequired: true` in the
    response rather than silently coming back empty — this is the path an
    actual listener's own request takes (a Song/Artist Radio click, or
    stores/playback.ts's maybeAutoplay() running for a client that's
    actually online), so there's someone to actually tell. PlexClient's own
    version has no equivalent because it's connect's own background
    fallback for when nobody's around to tell in the first place (see
    routes/stream.py's _maybe_autoplay_topup())."""
    item_id = params.get("id", "")
    if not item_id:
        raise ValueError("getSimilarSongs2.view requires id")
    count = params.get("count", "50")
    try:
        data = await _px_get(
            media,
            f"/library/metadata/{_quote_id(item_id)}/nearest",
            excludeFields="summary",
            limit=count,
            maxDistance="0.25",
        )
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 403:
            logger.debug(f"[Plex] Sonic Analysis unavailable (no Plex Pass?) for {item_id}: {e}")
            return {"similarSongs2": {"song": [], "plexPassRequired": True}}
        raise
    songs = data.get("MediaContainer", {}).get("Metadata", [])
    return {"similarSongs2": {"song": _map_all(_map_song, songs)}}


async def get_artists(_params: dict, media: PlexClient) -> dict:
    section = await _music_section(media)
    data = await _px_get(media, f"/library/sections/{section}/all", type="8", sort="titleSort")
    items = data.get("MediaContainer", {}).get("Metadata", [])
    # childCount turned out unreliable on this server's artist Directory
    # items (see get_artist()'s identical fix, confirmed live 2026-08-17 —
    # every artist card showed "0 albums"). One extra bulk album listing
    # here (not one call per artist — that wouldn't be affordable across
    # an entire library's worth of artists) gives a real per-artist album
    # tally instead, at a fixed cost regardless of how many artists there
    # are.
    album_data = await _px_get(media, f"/library/sections/{section}/all", type="9")
    album_counts: dict[str, int] = {}
    for album in album_data.get("MediaContainer", {}).get("Metadata", []):
        artist_id = str(album.get("parentRatingKey") or "")
        if artist_id:
            album_counts[artist_id] = album_counts.get(artist_id, 0) + 1
    # Plex has no native indexed-by-letter grouping either (same situation
    # as Jellyfin) — bucket client(python)-side.
    buckets: dict[str, list[dict]] = {}
    for item in items:
        artist = _map_artist(item)
        artist["albumCount"] = album_counts.get(artist["id"], 0)
        name = item.get("title") or ""
        letter = name[0].upper() if name else "#"
        buckets.setdefault(letter, []).append(artist)
    index = [{"name": letter, "artist": artists} for letter, artists in sorted(buckets.items())]
    return {"artists": {"index": index}}


async def get_artist(params: dict, media: PlexClient) -> dict:
    artist_id = params["id"]
    item_data = await _px_get(media, f"/library/metadata/{_quote_id(artist_id)}")
    items = item_data.get("MediaContainer", {}).get("Metadata", [])
    if not items:
        raise ValueError(f"Artist {artist_id} not found")
    artist = _map_artist(items[0])
    children = await _px_get(media, f"/library/metadata/{_quote_id(artist_id)}/children")
    albums = _map_all(_map_album, children.get("MediaContainer", {}).get("Metadata", []))
    # childCount (artist["albumCount"], from _map_artist above) and
    # leafCount (each album's songCount, from _map_album above) turned out
    # unreliable on this server's Directory items in practice — every
    # artist showed "0 albums · 0 tracks" on ArtistDetailView despite a
    # real library (confirmed live 2026-08-17). Neither is trusted here:
    # album count comes from the children list actually fetched above, and
    # each album's song count is a real per-parentRatingKey tally over
    # allLeaves (every track under this artist, in one call) — sidesteps
    # needing either summary field to be populated at all.
    artist["albumCount"] = len(albums)
    leaves_data = await _px_get(media, f"/library/metadata/{_quote_id(artist_id)}/allLeaves")
    leaves = leaves_data.get("MediaContainer", {}).get("Metadata", [])
    track_counts: dict[str, int] = {}
    for leaf in leaves:
        album_id = str(leaf.get("parentRatingKey") or "")
        if album_id:
            track_counts[album_id] = track_counts.get(album_id, 0) + 1
    for album in albums:
        if album["id"] in track_counts:
            album["songCount"] = track_counts[album["id"]]
    artist["album"] = albums
    return {"artist": artist}


async def search3(params: dict, media: PlexClient) -> dict:
    # An empty query means "match everything" here for free — unlike
    # Jellyfin, which needed a special case (see jellyfin_bridge.py's
    # search3() comment): Plex's /all endpoint already returns the whole
    # type when no `title` filter is given, which is exactly
    # stores/library.ts's fetchAllTracks() bulk-load trick.
    #
    # Uses the section-scoped /all + `title` filter rather than Plex's
    # /hubs/search — that endpoint groups results into type-keyed "Hub"
    # objects whose exact shape PLEX_PLAN.md flagged as unverified; /all
    # already has a known, predictable Metadata-list shape (used by every
    # other handler here too), so reusing it avoids a second unverified
    # response format on top of the rest of this file's guesses.
    query = params.get("query", "")
    song_count = int(params.get("songCount", 25))
    album_count = int(params.get("albumCount", 25))
    artist_count = int(params.get("artistCount", 25))
    section = await _music_section(media)

    async def fetch(item_type: str, limit: int, offset: str) -> list[dict]:
        if limit <= 0:
            return []
        px_params = {
            "type": item_type,
            "X-Plex-Container-Size": str(limit),
            "X-Plex-Container-Start": offset,
        }
        if query:
            px_params["title"] = query
        data = await _px_get(media, f"/library/sections/{section}/all", **px_params)
        return data.get("MediaContainer", {}).get("Metadata", [])

    songs = await fetch("10", song_count, params.get("songOffset", "0"))
    albums = await fetch("9", album_count, "0")
    artists = await fetch("8", artist_count, "0")
    logger.info(
        f"[plex-bridge] search3 query={query!r} -> {len(songs)} song(s), "
        f"{len(albums)} album(s), {len(artists)} artist(s)"
    )
    return {
        "searchResult3": {
            "song": _map_all(_map_song, songs),
            "album": _map_all(_map_album, albums),
            "artist": _map_all(_map_artist, artists),
        }
    }


# ── Ratings ───────────────────────────────────────────────────────────────────


async def set_rating(params: dict, media: PlexClient) -> dict:
    item_id = params.get("id", "")
    if not item_id:
        raise ValueError("setRating.view requires id")
    rating = int(params.get("rating", "0"))
    if not 0 <= rating <= 5:
        raise ValueError("rating must be between 0 and 5")
    # 0 means "clear the rating" on both sides of this bridge, but Plex's
    # own clear value is -1, not 0 (0 there means "explicitly rated
    # zero stars", a distinct state Beacon's UI has no way to set anyway).
    plex_rating = rating * 2 if rating > 0 else -1
    await _px_request(
        "PUT",
        media,
        "/:/rate",
        params={
            "key": item_id,
            "identifier": "com.plexapp.plugins.library",
            "rating": str(plex_rating),
        },
    )
    return {}


# ── Play tracking ────────────────────────────────────────────────────────────


async def scrobble(params: dict, media: PlexClient) -> dict:
    track_id = params.get("id", "")
    if not track_id:
        raise ValueError("scrobble.view requires id")
    if params.get("submission", "false").lower() != "true":
        # submission=false: Subsonic's "now playing" notification. Unlike
        # Jellyfin (see jellyfin_bridge.py's scrobble() — its /:/rate
        # equivalent needs a preceding "now playing" call to seed session
        # state before a later "stopped" call registers), Plex's own
        # /:/scrobble is a standalone "mark as played" call with nothing to
        # seed first — there's no Plex-side equivalent action needed here.
        return {}
    # submission=true: fired once the frontend's own scrobble threshold
    # (checkScrobbleThreshold() in stores/playback.ts) has been crossed.
    # /:/scrobble increments the track's viewCount and updates
    # lastViewedAt — the same mechanism Plex's own official clients use to
    # mark an item played. Confirmed live (2026-08-19).
    await _px_request(
        "PUT",
        media,
        "/:/scrobble",
        params={
            "key": track_id,
            "identifier": "com.plexapp.plugins.library",
        },
    )
    return {}


# ── Playlists ─────────────────────────────────────────────────────────────────


def _map_playlist(item: dict) -> dict:
    return {
        "id": str(item["ratingKey"]),
        "name": item.get("title", "Unknown"),
        "songCount": item.get("leafCount") or 0,
        "duration": int((item.get("duration") or 0) / 1000),
        "coverArt": str(item["ratingKey"]),
        "public": False,
    }


async def get_playlists(_params: dict, media: PlexClient) -> dict:
    data = await _px_get(media, "/playlists", playlistType="audio")
    items = data.get("MediaContainer", {}).get("Metadata", [])
    return {"playlists": {"playlist": _map_all(_map_playlist, items)}}


async def get_playlist(params: dict, media: PlexClient) -> dict:
    playlist_id = params["id"]
    item_data = await _px_get(media, f"/playlists/{_quote_id(playlist_id)}")
    items = item_data.get("MediaContainer", {}).get("Metadata", [])
    if not items:
        raise ValueError(f"Playlist {playlist_id} not found")
    playlist = _map_playlist(items[0])
    songs = await _px_get(media, f"/playlists/{_quote_id(playlist_id)}/items")
    playlist["entry"] = _map_all(_map_song, songs.get("MediaContainer", {}).get("Metadata", []))
    return {"playlist": playlist}


def _playlist_item_uri(media: PlexClient, song_ids: list[str]) -> str:
    """Plex addresses playlist items via a `server://{machineIdentifier}/...`
    URI listing one or more metadata ids, not a plain id array like
    Jellyfin's `{"Ids": [...]}` body — needs the *server's* machine
    identifier (distinct from PlexClient's own client_identifier(), which
    identifies Beacon as an app), plumbed through from the server picker at
    login since nothing else on this call path knows it (see
    routes/devices.py's ConfigRequest.machine_identifier)."""
    if not media.machine_identifier:
        raise ValueError("Plex server identifier missing — try logging in again")
    ids = ",".join(str(i) for i in song_ids)
    return f"server://{media.machine_identifier}/com.plexapp.plugins.library/library/metadata/{ids}"


async def create_playlist(params, media: PlexClient) -> dict:
    song_ids = params.getlist("songId")
    if not song_ids:
        # Unlike Jellyfin, Plex's playlist-creation endpoint has no
        # "empty playlist" form — it always needs a starting uri of at
        # least one item.
        raise ValueError("Plex requires at least one song to create a playlist")
    await _px_request(
        "POST",
        media,
        "/playlists",
        params={
            "type": "audio",
            "title": params.get("name", "New Playlist"),
            "smart": "0",
            "uri": _playlist_item_uri(media, song_ids),
        },
    )
    return {}


async def _add_to_playlist(playlist_id: str, song_ids: list[str], media: PlexClient) -> None:
    await _px_request(
        "PUT",
        media,
        f"/playlists/{_quote_id(playlist_id)}/items",
        params={"uri": _playlist_item_uri(media, song_ids)},
    )


async def _remove_from_playlist(playlist_id: str, indexes: list[int], media: PlexClient) -> None:
    # Same position -> id resolution problem as jellyfin_bridge.py's own
    # _remove_from_playlist: Subsonic addresses playlist entries by
    # position, Plex needs each entry's own playlistItemID, obtainable only
    # by listing the playlist first. Unlike Jellyfin, Plex has no
    # bulk-delete-by-ids call, so this is one DELETE per removed entry.
    items = await _px_get(media, f"/playlists/{_quote_id(playlist_id)}/items")
    entries = items.get("MediaContainer", {}).get("Metadata", [])
    entry_ids = [
        entries[i]["playlistItemID"]
        for i in indexes
        if 0 <= i < len(entries) and entries[i].get("playlistItemID") is not None
    ]
    for entry_id in entry_ids:
        await _px_request(
            "DELETE",
            media,
            f"/playlists/{_quote_id(playlist_id)}/items/{_quote_id(str(entry_id))}",
        )


async def update_playlist(params, media: PlexClient) -> dict:
    playlist_id = params.get("playlistId") or params["id"]
    song_ids_to_add = params.getlist("songIdToAdd")
    indexes_to_remove = params.getlist("songIndexToRemove")
    if song_ids_to_add:
        await _add_to_playlist(playlist_id, song_ids_to_add, media)
        return {}
    if indexes_to_remove:
        await _remove_from_playlist(playlist_id, [int(i) for i in indexes_to_remove], media)
        return {}
    # The only remaining reason client.ts calls updatePlaylist.view is a
    # rename/visibility change — unlike Jellyfin (see jellyfin_bridge.py's
    # own update_playlist), Plex's playlist endpoint does support renaming
    # directly; visibility (public/private) has no Plex equivalent and is
    # silently ignored, same as it's silently unused for Subsonic's own
    # `public` param in practice (Beacon has no sharing UI).
    name = params.get("name")
    if name is not None:
        await _px_request(
            "PUT", media, f"/playlists/{_quote_id(playlist_id)}", params={"title": name}
        )
        return {}
    raise ValueError("updatePlaylist.view requires songIdToAdd, songIndexToRemove, or name")


async def delete_playlist(params: dict, media: PlexClient) -> dict:
    await _px_request("DELETE", media, f"/playlists/{_quote_id(params['id'])}")
    return {}


_HANDLERS: dict[str, Callable[[dict, PlexClient], Awaitable[dict]]] = {
    "getAlbumList2.view": get_album_list2,
    "getAlbum.view": get_album,
    "getSong.view": get_song,
    "getSimilarSongs2.view": get_similar_songs2,
    "getArtists.view": get_artists,
    "getArtist.view": get_artist,
    "search3.view": search3,
    "setRating.view": set_rating,
    "scrobble.view": scrobble,
    "getPlaylists.view": get_playlists,
    "getPlaylist.view": get_playlist,
    "createPlaylist.view": create_playlist,
    "updatePlaylist.view": update_playlist,
    "deletePlaylist.view": delete_playlist,
    "getInternetRadioStations.view": get_internet_radio_stations,
    "createInternetRadioStation.view": create_internet_radio_station,
    "updateInternetRadioStation.view": update_internet_radio_station,
    "deleteInternetRadioStation.view": delete_internet_radio_station,
}


# ── Binary handlers (getCoverArt.view, stream.view) ──────────────────────────

_BINARY_PATHS = {"getCoverArt.view", "stream.view"}
# content-length included: blindly forwarding the upstream value crashes
# uvicorn ("Response content longer than Content-Length") whenever the
# actual streamed byte count doesn't match it exactly — confirmed live
# (2026-08-17) against Plex's thumb endpoint, which apparently doesn't
# always keep the two in sync for on-the-fly-generated images. Dropping it
# lets Starlette's StreamingResponse fall back to chunked transfer
# encoding, which makes no such promise to violate.
_SKIP_RESP_HEADERS = {"transfer-encoding", "connection", "content-encoding", "content-length"}


async def _stream_binary(request: Request, url: str, media: PlexClient) -> StreamingResponse:
    client = _get_client()
    headers = media.auth_headers()
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

    resp_headers = {
        k: v for k, v in response.headers.items() if k.lower() not in _SKIP_RESP_HEADERS
    }
    content_type = response.headers.get("content-type")
    apply_image_cache_control(resp_headers, content_type)
    return StreamingResponse(
        streamed(),
        status_code=response.status_code,
        headers=resp_headers,
        media_type=content_type,
    )


async def _handle_binary(
    path: str, request: Request, media: PlexClient
) -> StreamingResponse | JSONResponse:
    params = dict(request.query_params)
    if path == "getCoverArt.view":
        cover_id = params.get("id", "")
        if not cover_id:
            return subsonic_error(70, "No cover art id supplied")
        url = media.get_cover_art_url(cover_id, internal=True)
        if not url:
            return subsonic_error(70, "No cover art available")
    else:  # stream.view
        track_id = params.get("id", "")
        if not track_id:
            return subsonic_error(70, "No track id supplied")
        # to_thread: get_stream_url() needs a real network lookup for Plex
        # (see media/plex.py's docstring) — without this it would block
        # the whole event loop, not just this one request.
        url = await asyncio.to_thread(media.get_stream_url, track_id)
    return await _stream_binary(request, url, media)


# ── Entry point ────────────────────────────────────────────────────────────


async def handle(path: str, request: Request, media: PlexClient) -> JSONResponse | StreamingResponse:
    if path in _BINARY_PATHS:
        try:
            return await _handle_binary(path, request, media)
        except Exception as e:
            logger.warning(f"[plex-bridge] {path} failed: {e}")
            return subsonic_error(0, str(e))

    handler = _HANDLERS.get(path)
    if handler is None:
        return subsonic_error(70, f"{path} is not supported on Plex yet")
    try:
        result = await handler(request.query_params, media)
    except Exception as e:
        logger.warning(f"[plex-bridge] {path} failed: {e}")
        return subsonic_error(0, str(e))
    return subsonic_envelope(result)
