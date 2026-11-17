"""media/jellyfin_bridge.py — translates Subsonic-shaped /rest/*.view
requests into real Jellyfin API calls, for a session whose SessionState.media
is a JellyfinClient (see routes/proxy.py's proxy_subsonic).

The frontend's entire library-browsing surface (services/subsonic/client.ts)
only ever speaks Subsonic — this module lets a Jellyfin-backed session answer
that exact same request shape without any frontend changes: every JSON
handler below returns a plain dict that handle() wraps in the standard
Subsonic envelope ({"subsonic-response": {"status": "ok", ...}}), which
SubsonicClient.get() already unwraps identically regardless of which real
server actually answered it. getCoverArt.view/stream.view are the one
exception — those are fetched as raw <img>/<audio> src URLs by the browser,
so they're bridged as binary passthroughs instead (see media/bridge.py).

Internet radio stations are the one exception to "translates real Jellyfin
API calls": Jellyfin has no concept of user-managed stations at all, so
those four endpoints are instead backed by connect's own local station list
(see media/base.py, which is where they actually live — shared with
plex_bridge.py, since the logic is identical regardless of backend).

Endpoints with no sensible Jellyfin (or self-hosted) equivalent —
Navidrome's startScan/getScanStatus, personal 1-5 star ratings — are
deliberately absent from _HANDLERS — see services/capabilities.ts on the
frontend, which hides the UI for these before they'd ever be called; the
"unsupported" envelope handle() falls back to for an unmatched path is a
safety net, not the primary mechanism.
"""

import logging
import time
from collections.abc import Awaitable, Callable
from urllib.parse import quote

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import bridge
from .base import (
    artwork_id,
    create_internet_radio_station,
    delete_internet_radio_station,
    get_internet_radio_stations,
    split_artwork_id,
    update_internet_radio_station,
)
from .bridge import PlaylistEditor, map_all, quote_id, set_field, set_playlist_songs
from .jellyfin import TICKS_PER_SECOND, JellyfinClient, replay_gain_of

logger = logging.getLogger("connect.jellyfin_bridge")

# Shared across every bridged request — same reasoning as routes/proxy.py's
# own _client (see that module's comment): reuse the connection pool instead
# of paying a fresh TCP/TLS handshake per call.
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(follow_redirects=True, timeout=60)
    return _client


async def close() -> None:
    """Closes the shared client — called once from main.py's lifespan on
    app shutdown, alongside routes/proxy.py's close()."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


# ── Jellyfin field mapping ───────────────────────────────────────────────────
# Subsonic-shaped dicts built from a Jellyfin BaseItemDto — mirrors
# services/subsonic/mappers.ts's raw-Subsonic-JSON → canonical-Track/Album/
# Artist mapping, just in the opposite direction (Jellyfin JSON → raw-
# Subsonic-shaped JSON), since the frontend's own mappers.ts then does its
# usual job on top of whatever this produces.


# What every song *list* asks Jellyfin for on top of its default response.
# Explicit and minimal, for two reasons: (1) without it, ArtistItems (needed
# for _map_song's artistId) and Genres are excluded from the default
# response entirely, silently dropping those fields from every listed track;
# (2) measured directly against a real library (curl, Limit=100 vs. 3000):
# response time scales linearly with item count rather than a fixed
# per-request cost, meaning Jellyfin is doing real per-item work - asking
# for less should do less of it. The slope is the server's and moves with
# its version: ~9ms/item on 10.11.11, ~1.2ms on 12.0.0.
#
# DateCreated is a scalar the server already has. MediaSources is not cheap:
# measured on 12.0.0 (20151 tracks), 3000 items took 4.15s with it against
# 2.89s without, and Jellyfin's answer grew from 4.5MB to 10.8MB. It is asked
# for anyway, because it is the only place Jellyfin reports a file's bitrate,
# and without one the local quality setting left every lossy Jellyfin track
# untouched (see plan() in services/streamQuality.ts) - and because it also
# fills the size, sample rate and path columns. Overview, People and the like
# stay out. Last played needs nothing at all: UserData comes with every
# user-scoped item response anyway.
_SONG_LIST_FIELDS = "Genres,ArtistItems,DateCreated,MediaSources"


def _is_favorite(item: dict) -> bool:
    return bool((item.get("UserData") or {}).get("IsFavorite"))


def _cover_art_id(item: dict) -> str:
    """The item's id with its Primary image tag attached, so that replacing
    the image in Jellyfin produces a different cover art id rather than the
    same one pointing at a new picture — see media/base.py's artwork_id for
    why every cache in the path depends on that. Jellyfin sends ImageTags on
    every item response that has artwork at all; an item without one keeps
    the bare id."""
    return artwork_id(item["Id"], (item.get("ImageTags") or {}).get("Primary"))


def _map_song(item: dict) -> dict:
    artists = item.get("Artists") or []
    media_sources = item.get("MediaSources") or []
    source = media_sources[0] if media_sources else {}
    song = {
        "id": item["Id"],
        "title": item.get("Name", "Unknown"),
        "artist": ", ".join(artists) if artists else item.get("AlbumArtist", "Unknown"),
        "album": item.get("Album", ""),
        "duration": int((item.get("RunTimeTicks") or 0) / TICKS_PER_SECOND),
        # Cover art id IS the item id for Jellyfin (see
        # JellyfinClient.get_track), plus the image's own tag — see
        # _cover_art_id.
        "coverArt": _cover_art_id(item),
        "playCount": (item.get("UserData") or {}).get("PlayCount", 0),
    }
    if item.get("IndexNumber") is not None:
        song["track"] = item["IndexNumber"]
    if item.get("ParentIndexNumber") is not None:
        song["discNumber"] = item["ParentIndexNumber"]
    if item.get("ProductionYear") is not None:
        song["year"] = item["ProductionYear"]
    genres = item.get("Genres") or []
    if genres:
        song["genre"] = genres[0]
    album_id = item.get("AlbumId")
    if album_id:
        song["albumId"] = album_id
    artist_items = item.get("ArtistItems") or []
    if artist_items:
        song["artistId"] = artist_items[0]["Id"]
    # MediaSources only comes back when it was asked for (see
    # _SONG_LIST_FIELDS); the container is on the item itself as well, so a
    # response without it still keeps the track's format.
    container = source.get("Container") or item.get("Container")
    if container:
        song["suffix"] = container
    if source.get("Bitrate"):
        song["bitRate"] = int(source["Bitrate"] / 1000)
    streams = source.get("MediaStreams") or item.get("MediaStreams") or []
    audio = next((stream for stream in streams if stream.get("Type") == "Audio"), {})
    set_field(song, "path", source.get("Path") or item.get("Path"))
    set_field(song, "size", source.get("Size"))
    set_field(song, "bitDepth", audio.get("BitDepth"))
    set_field(song, "samplingRate", audio.get("SampleRate"))
    # Both back a song-table column (see services/library/songColumns.ts)
    # and both are already in hand: DateCreated is one scalar field asked
    # for with the list, LastPlayedDate rides along in UserData.
    user_data = item.get("UserData") or {}
    set_field(song, "created", item.get("DateCreated"))
    set_field(song, "played", user_data.get("LastPlayedDate"))
    # Presence, not value, is mappers.ts's whole signal (raw.starred != null)
    # — omitted entirely when not favorited, never sent as false.
    if _is_favorite(item):
        song["starred"] = "true"
    replay_gain = replay_gain_of(item)
    if replay_gain:
        song["replayGain"] = replay_gain
    return song


def _map_song_detail(item: dict) -> dict:
    """Everything Jellyfin holds about one track, on top of what the lists
    need.

    Built only by get_song(), never by the list handlers: the channel count,
    the artist objects and the rest are bytes on every entry of a
    20000-track response for fields only the track-info sheet reads.

    Field names follow OpenSubsonic's own Child schema, so the frontend
    reads one shape whichever server answered (see subsonic/types.ts's
    RawSongDetail). Nothing is derived or guessed: a figure Jellyfin does
    not report is simply absent here."""
    song = _map_song(item)
    sources = item.get("MediaSources") or []
    source = sources[0] if sources else {}
    streams = source.get("MediaStreams") or item.get("MediaStreams") or []
    audio = next((stream for stream in streams if stream.get("Type") == "Audio"), {})

    # The file's own figures, added and last played are already on the list
    # mapping above.
    set_field(song, "channelCount", audio.get("Channels"))
    set_field(song, "sortName", item.get("SortName"))
    set_field(song, "musicBrainzId", (item.get("ProviderIds") or {}).get("MusicBrainzTrack"))
    set_field(song, "genres", [{"name": genre} for genre in (item.get("Genres") or [])])
    set_field(
        song,
        "artists",
        [
            {"id": artist["Id"], "name": artist.get("Name", "")}
            for artist in (item.get("ArtistItems") or [])
            if artist.get("Id")
        ],
    )
    set_field(
        song,
        "albumArtists",
        [
            {"id": artist["Id"], "name": artist.get("Name", "")}
            for artist in (item.get("AlbumArtists") or [])
            if artist.get("Id")
        ],
    )
    # The tag as written, which the Artists list above has already split on
    # its separators.
    set_field(song, "displayArtist", ", ".join(item.get("Artists") or []))
    set_field(song, "displayAlbumArtist", item.get("AlbumArtist"))
    return song


def _map_album(item: dict) -> dict:
    artist_items = item.get("AlbumArtists") or item.get("ArtistItems") or []
    artists = item.get("Artists") or []
    album = {
        "id": item["Id"],
        "name": item.get("Name", "Unknown"),
        "artist": item.get("AlbumArtist") or (", ".join(artists) if artists else "Unknown"),
        "coverArt": _cover_art_id(item),
        "songCount": item.get("ChildCount") or 0,
        "duration": int((item.get("RunTimeTicks") or 0) / TICKS_PER_SECOND),
    }
    # The key get_album_list2 sorts by, so the frontend's A-Z jump bar can
    # file the album where it actually sits (see indexLetterFor).
    set_field(album, "sortName", item.get("SortName"))
    # When it entered the library, for the album list's "recently added"
    # order. get_album_list2 already asks for the field to sort "newest".
    set_field(album, "created", item.get("DateCreated"))
    if artist_items:
        album["artistId"] = artist_items[0]["Id"]
    if item.get("ProductionYear") is not None:
        album["year"] = item["ProductionYear"]
    genres = item.get("Genres") or []
    if genres:
        album["genre"] = genres[0]
    # OpenSubsonic's album extras, for the album page's header. Jellyfin
    # keeps a record label among an album's Studios (rarely filled), and
    # the MusicBrainz release as the MusicBrainzAlbum provider id - the
    # same thing Navidrome sends as musicBrainzId.
    # A tag written as one "Trance;Dance;Pop" string reaches Jellyfin
    # unsplit on some libraries, which would make one giant genre.
    split = [g.strip() for genre in genres for g in genre.split(";") if g.strip()]
    set_field(album, "genres", [{"name": g} for g in split])
    set_field(
        album,
        "recordLabels",
        [{"name": s["Name"]} for s in item.get("Studios") or [] if s.get("Name")],
    )
    set_field(album, "musicBrainzId", (item.get("ProviderIds") or {}).get("MusicBrainzAlbum"))
    if _is_favorite(item):
        album["starred"] = "true"
    return album


def _map_artist(item: dict) -> dict:
    artist = {
        "id": item["Id"],
        "name": item.get("Name", "Unknown"),
        "coverArt": _cover_art_id(item),
    }
    if _is_favorite(item):
        artist["starred"] = "true"
    return artist


async def _map_artists(
    media: JellyfinClient, items: list[dict], *, every: bool = False
) -> list[dict]:
    """Artists with a real albumCount. An artist's own ChildCount can't give
    one: on the item itself it counts albums *and* songs, and in a listing it
    is only there when asked for and still misses albums the artist is a
    track artist on. Counting the albums instead, by the same rule as
    get_artist()'s ArtistIds lookup, keeps a card and its page in agreement.
    `every` tallies the whole library in one listing instead of naming the
    artists, for getArtists, where the id list would be the library."""
    artists = _map_all(_map_artist, items)
    if not artists:
        return artists
    scope = {} if every else {"ArtistIds": ",".join(a["id"] for a in artists)}
    albums = await _jf_get_items(
        media,
        IncludeItemTypes="MusicAlbum",
        Recursive="true",
        EnableImages="false",
        EnableUserData="false",
        **scope,
    )
    counts: dict[str, int] = {}
    for album in albums.get("Items", []):
        credited = (album.get("ArtistItems") or []) + (album.get("AlbumArtists") or [])
        for artist_id in {a.get("Id") for a in credited}:
            counts[artist_id] = counts.get(artist_id, 0) + 1
    for artist in artists:
        artist["albumCount"] = counts.get(artist["id"], 0)
    return artists


def _map_playlist(item: dict) -> dict:
    # Jellyfin names no owner, and its sharing model (per-user grants plus
    # OpenAccess) doesn't map onto Subsonic's owner/public pair, so public
    # stays false. Whether the playlist is the user's own comes from
    # CanDelete instead, which Jellyfin grants the owner - and an admin,
    # who is thereby treated as owning a playlist shared with them.
    playlist = {
        "id": item["Id"],
        "name": item.get("Name", "Unknown"),
        "songCount": item.get("ChildCount") or 0,
        "duration": int((item.get("RunTimeTicks") or 0) / TICKS_PER_SECOND),
        "coverArt": _cover_art_id(item),
        "public": False,
    }
    # Jellyfin has no "modified" date for a playlist; the last time a song
    # was added is the closest. Both are ISO with the same 7-digit
    # fraction, so the later one is also the larger string.
    dates = [d for d in (item.get("DateLastMediaAdded"), item.get("DateCreated")) if d]
    set_field(playlist, "changed", max(dates) if dates else None)
    can_delete = item.get("CanDelete")
    if can_delete is not None:
        playlist["owned"] = can_delete
        # Someone else's: Jellyfin only lets its owner, or a share granted
        # editing, change the songs - and which shares grant that takes a
        # request per playlist to find out.
        if not can_delete:
            playlist["readonly"] = True
    return playlist


def _map_all(mapper: Callable[[dict], dict], items: list[dict]) -> list[dict]:
    return map_all(mapper, items, id_field="Id", log=logger, label="jellyfin-bridge")


# ── Jellyfin HTTP helper ─────────────────────────────────────────────────────


async def _jf_request(
    method: str,
    media: JellyfinClient,
    path: str,
    params: dict | None = None,
    json_body: dict | None = None,
) -> dict:
    client = _get_client()
    url = f"{media.internal_url}{path}"
    started = time.monotonic()
    try:
        response = await client.request(
            method,
            url,
            headers=media.auth_headers(),
            params={k: v for k, v in (params or {}).items() if v is not None},
            json=json_body,
        )
        response.raise_for_status()
    except Exception:
        # Always logged (not just the >1s case below) — this is the one
        # place that knows the real Jellyfin-facing URL/params for a failed
        # call; handle()'s own catch-all only sees whatever exception
        # message bubbles up to it, without this request-shape context.
        elapsed = time.monotonic() - started
        logger.warning(
            f"[jellyfin-bridge] {method} {url} failed after {elapsed:.2f}s (params={params})"
        )
        raise
    elapsed = time.monotonic() - started
    if elapsed > 1:
        # Not every request — just the ones worth knowing about when
        # something "feels slow" without actually erroring.
        logger.info(f"[jellyfin-bridge] {method} {url} took {elapsed:.2f}s")
    # Favorite/playlist-mutation endpoints (POST/DELETE) commonly answer
    # with an empty 204 body — nothing for handlers to parse, and none of
    # them need to (see e.g. star()/_add_to_playlist() below, which both
    # discard this return value).
    return response.json() if response.content else {}


async def _jf_get(media: JellyfinClient, path: str, **params: str) -> dict:
    return await _jf_request("GET", media, path, params=params)


async def _jf_get_items(media: JellyfinClient, item_id: str = "", **params: str) -> dict:
    """The user-scoped item endpoints, in the only shape both Jellyfin
    generations answer: 10.9 moved these off /Users/{userId}/Items to
    /Items?userId= and marked the old form obsolete, and 12 dropped it from
    the API altogether. `item_id` must already be quote_id()'d."""
    path = f"/Items/{item_id}" if item_id else "/Items"
    return await _jf_get(media, path, userId=media.user_id, **params)


# ── JSON handlers ─────────────────────────────────────────────────────────────
# Each takes the raw query params (as a plain dict) + the session's
# JellyfinClient, and returns a dict merged into the standard envelope.

_ALBUM_SORT_PARAMS: dict[str, dict[str, str]] = {
    "alphabeticalByName": {"SortBy": "SortName", "SortOrder": "Ascending"},
    "newest": {"SortBy": "DateCreated", "SortOrder": "Descending"},
    "random": {"SortBy": "Random"},
    # Best-effort match, not exact — Subsonic's own "recent"/"frequent"
    # semantics are already a Navidrome-specific interpretation of play
    # history, not a base Subsonic API guarantee.
    "recent": {"SortBy": "DatePlayed", "SortOrder": "Descending", "Filters": "IsPlayed"},
    "frequent": {"SortBy": "PlayCount", "SortOrder": "Descending"},
}


async def get_album_list2(params: dict, media: JellyfinClient) -> dict:
    sort_type = params.get("type", "alphabeticalByName")
    sort_params = _ALBUM_SORT_PARAMS.get(sort_type, _ALBUM_SORT_PARAMS["alphabeticalByName"])
    data = await _jf_get_items(
        media,
        IncludeItemTypes="MusicAlbum",
        Recursive="true",
        StartIndex=params.get("offset", "0"),
        Limit=params.get("size", "100"),
        Fields="Genres,DateCreated,ChildCount",
        **sort_params,
    )
    return {"albumList2": {"album": _map_all(_map_album, data.get("Items", []))}}


async def get_album(params: dict, media: JellyfinClient) -> dict:
    album_id = params["id"]
    item = await _jf_get_items(media, quote_id(album_id))
    songs = await _jf_get_items(
        media,
        ParentId=album_id,
        IncludeItemTypes="Audio",
        Recursive="true",
        SortBy="IndexNumber",
        Fields=_SONG_LIST_FIELDS,
    )
    album = _map_album(item)
    album["song"] = _map_all(_map_song, songs.get("Items", []))
    return {"album": album}


async def get_song(params: dict, media: JellyfinClient) -> dict:
    item = await _jf_get_items(media, quote_id(params["id"]))
    # The detailed mapping, not the list one: this is the single-track
    # lookup, and the only caller that wants more than a row's worth of
    # fields (the track-info sheet) comes through here.
    return {"song": _map_song_detail(item)}


async def get_artists(_params: dict, media: JellyfinClient) -> dict:
    data = await _jf_get_items(
        media,
        IncludeItemTypes="MusicArtist",
        Recursive="true",
        SortBy="SortName",
    )
    # Jellyfin has no native indexed-by-letter grouping (unlike Subsonic's
    # own getArtists.view shape) — bucket client(python)-side.
    buckets: dict[str, list[dict]] = {}
    for artist in await _map_artists(media, data.get("Items", []), every=True):
        name = artist["name"]
        letter = name[0].upper() if name else "#"
        buckets.setdefault(letter, []).append(artist)
    index = [{"name": letter, "artist": artists} for letter, artists in sorted(buckets.items())]
    return {"artists": {"index": index}}


async def get_artist(params: dict, media: JellyfinClient) -> dict:
    artist_id = params["id"]
    item = await _jf_get_items(media, quote_id(artist_id))
    albums = await _jf_get_items(
        media,
        ArtistIds=artist_id,
        IncludeItemTypes="MusicAlbum",
        Recursive="true",
    )
    artist = _map_artist(item)
    artist["album"] = [_map_album(a) for a in albums.get("Items", [])]
    artist["albumCount"] = len(artist["album"])
    return {"artist": artist}


def _search_offset(params: dict, song_count: int, album_count: int, artist_count: int) -> str:
    asked = [
        name for name, count in (("album", album_count), ("artist", artist_count)) if count > 0
    ]
    if song_count <= 0 and len(asked) == 1:
        return params.get(f"{asked[0]}Offset", "0")
    return params.get("songOffset", "0")


async def search3(params: dict, media: JellyfinClient) -> dict:
    # An empty query is a well-known Subsonic trick meaning "match
    # everything" — stores/library.ts's fetchAllTracks() relies on exactly
    # this to bulk-load the whole track catalog page by page (songCount=3000,
    # albumCount=artistCount=0). Jellyfin has no such convention: an empty
    # searchTerm returns nothing, so it must be omitted entirely rather than
    # sent as "". GenresView derives its list from that same bulk load, so
    # this bug took Genres down with it.
    query = params.get("query", "")
    song_count = int(params.get("songCount", 25))
    album_count = int(params.get("albumCount", 25))
    artist_count = int(params.get("artistCount", 25))

    # Only ask Jellyfin for types actually wanted — fetchAllTracks()'s bulk
    # load sets albumCount=artistCount=0, and previously this still asked
    # for all three types anyway, letting unwanted albums/artists crowd out
    # real tracks within the one shared Limit below.
    item_types = []
    if song_count > 0:
        item_types.append("Audio")
    if album_count > 0:
        item_types.append("MusicAlbum")
    if artist_count > 0:
        item_types.append("MusicArtist")
    if not item_types:
        return {"searchResult3": {"song": [], "album": [], "artist": []}}

    jf_params: dict[str, str] = {
        "IncludeItemTypes": ",".join(item_types),
        "Recursive": "true",
        # Jellyfin has one shared Limit/StartIndex for the combined query,
        # not three independent ones like Subsonic's songCount/albumCount/
        # artistCount — a reasonable approximation for a real search (modest,
        # roughly balanced counts) and exactly right for the common
        # single-type bulk-fetch case (the other two counts are 0 here).
        "Limit": str(max(song_count, album_count, artist_count)),
        # Without mapping the offset to StartIndex, every "page" of a
        # paginated load re-fetched the exact same items. The one shared
        # StartIndex takes the offset of the one type asked for (the app
        # API pages albums alone); a mixed search keeps songOffset.
        "StartIndex": _search_offset(params, song_count, album_count, artist_count),
        # See _SONG_LIST_FIELDS for why this list is as short as it is -
        # it matters most here, where a bulk load asks for thousands of
        # items at once.
        "Fields": _SONG_LIST_FIELDS,
    }
    if query:
        jf_params["searchTerm"] = query

    data = await _jf_get_items(media, **jf_params)
    items = data.get("Items", [])
    logger.info(
        f"[jellyfin-bridge] search3 query={query!r} StartIndex={jf_params['StartIndex']} "
        f"IncludeItemTypes={jf_params['IncludeItemTypes']} -> {len(items)} item(s) "
        f"(TotalRecordCount={data.get('TotalRecordCount')})"
    )
    by_type: dict[str, list[dict]] = {"Audio": [], "MusicAlbum": [], "MusicArtist": []}
    for item in items:
        bucket = by_type.get(item.get("Type", ""))
        if bucket is not None:
            bucket.append(item)
    return {
        "searchResult3": {
            "song": _map_all(_map_song, by_type["Audio"]),
            "album": _map_all(_map_album, by_type["MusicAlbum"]),
            "artist": await _map_artists(media, by_type["MusicArtist"]),
            # Not part of the base Subsonic API (a real Subsonic/Navidrome
            # server never sends this) — an additive extra field so
            # stores/library.ts's paginated bulk-load can show real
            # progress ("6000 / 20147") for a slow Jellyfin scan instead of
            # an indeterminate spinner. Ignored by anything that doesn't
            # know to look for it.
            "totalRecordCount": data.get("TotalRecordCount"),
        }
    }


# ── Favorites ─────────────────────────────────────────────────────────────────


async def get_starred2(_params: dict, media: JellyfinClient) -> dict:
    # Three separate calls rather than one combined IncludeItemTypes=Audio,
    # MusicAlbum,MusicArtist&Filters=IsFavorite request — unverified whether
    # a given Jellyfin version actually combines Filters with a multi-type
    # IncludeItemTypes in one call; three guaranteed-correct calls beat one
    # call that might silently only filter the first type.
    songs = await _jf_get_items(
        media,
        IncludeItemTypes="Audio",
        Filters="IsFavorite",
        Recursive="true",
        Fields=_SONG_LIST_FIELDS,
    )
    albums = await _jf_get_items(
        media,
        IncludeItemTypes="MusicAlbum",
        Filters="IsFavorite",
        Recursive="true",
    )
    artists = await _jf_get_items(
        media,
        IncludeItemTypes="MusicArtist",
        Filters="IsFavorite",
        Recursive="true",
    )
    return {
        "starred2": {
            "song": _map_all(_map_song, songs.get("Items", [])),
            "album": _map_all(_map_album, albums.get("Items", [])),
            "artist": await _map_artists(media, artists.get("Items", [])),
        }
    }


def _favorite_item_id(params: dict) -> str:
    item_id = params.get("id") or params.get("albumId") or params.get("artistId")
    if not item_id:
        raise ValueError("star/unstar requires id, albumId, or artistId")
    return item_id


async def star(params: dict, media: JellyfinClient) -> dict:
    await _jf_request(
        "POST",
        media,
        f"/UserFavoriteItems/{quote_id(_favorite_item_id(params))}",
        params={"userId": media.user_id},
    )
    return {}


async def unstar(params: dict, media: JellyfinClient) -> dict:
    await _jf_request(
        "DELETE",
        media,
        f"/UserFavoriteItems/{quote_id(_favorite_item_id(params))}",
        params={"userId": media.user_id},
    )
    return {}


# ── Playlists ─────────────────────────────────────────────────────────────────


async def get_playlists(_params: dict, media: JellyfinClient) -> dict:
    data = await _jf_get_items(
        media,
        IncludeItemTypes="Playlist",
        Recursive="true",
        Fields="DateCreated,DateLastMediaAdded,CanDelete",
    )
    return {"playlists": {"playlist": _map_all(_map_playlist, data.get("Items", []))}}


async def get_playlist(params: dict, media: JellyfinClient) -> dict:
    playlist_id = params["id"]
    item = await _jf_get_items(media, quote_id(playlist_id))
    songs = await _jf_get(
        media,
        f"/Playlists/{quote_id(playlist_id)}/Items",
        userId=media.user_id,
        Fields=_SONG_LIST_FIELDS,
    )
    playlist = _map_playlist(item)
    playlist["entry"] = _map_all(_map_song, songs.get("Items", []))
    return {"playlist": playlist}


async def create_playlist(params, media: JellyfinClient) -> dict:
    song_ids = params.getlist("songId")
    # With a playlistId this is Subsonic's own "update" form of the call:
    # the playlist's songs become exactly this list, in this order — how
    # client.ts saves a reordered playlist (see setPlaylistSongs).
    playlist_id = params.get("playlistId")
    if playlist_id:
        await _set_playlist_songs(playlist_id, song_ids, media)
        return {}
    body: dict = {"Name": params.get("name", "New Playlist"), "UserId": media.user_id}
    if song_ids:
        body["Ids"] = song_ids
    await _jf_request("POST", media, "/Playlists", json_body=body)
    return {}


async def _playlist_entries(playlist_id: str, media: JellyfinClient) -> list[tuple[str, str]]:
    """(PlaylistItemId, song id) per entry, in playlist order.

    The two are meant to be distinct, so that the same song added twice is
    two entries telling themselves apart by the per-entry id. Jellyfin 10.9
    does that but refuses to hold a duplicate in the first place; Jellyfin 12
    accepts one and reports both ids as the same value, offering nothing else
    per entry, which makes the two copies indistinguishable here — see
    docs/investigations/media-servers/playlist-duplicate-not-addressable.md for what that costs."""
    items = await _jf_get(media, f"/Playlists/{quote_id(playlist_id)}/Items", userId=media.user_id)
    return [
        (entry["PlaylistItemId"], str(entry.get("Id", "")))
        for entry in items.get("Items", [])
        if entry.get("PlaylistItemId")
    ]


async def _set_playlist_songs(playlist_id: str, song_ids: list[str], media: JellyfinClient) -> None:
    """See bridge.py's set_playlist_songs(). Jellyfin removes any number of
    entries in one call and moves an entry by its target index."""
    items_path = f"/Playlists/{quote_id(playlist_id)}/Items"

    async def remove(entry_ids: list[str]) -> None:
        await _jf_request("DELETE", media, items_path, params={"EntryIds": ",".join(entry_ids)})

    async def add(ids: list[str]) -> None:
        await _add_to_playlist(playlist_id, ids, media)

    async def move(entry_id: str, index: int, _after: str | None) -> None:
        await _jf_request("POST", media, f"{items_path}/{quote_id(entry_id)}/Move/{index}")

    editor = PlaylistEditor(
        entries=lambda: _playlist_entries(playlist_id, media), remove=remove, add=add, move=move
    )
    await set_playlist_songs(editor, song_ids)


async def _add_to_playlist(playlist_id: str, song_ids: list[str], media: JellyfinClient) -> None:
    await _jf_request(
        "POST",
        media,
        f"/Playlists/{quote_id(playlist_id)}/Items",
        params={"Ids": ",".join(song_ids), "UserId": media.user_id},
    )


async def _remove_from_playlist(
    playlist_id: str, indexes: list[int], media: JellyfinClient
) -> None:
    # Subsonic addresses playlist entries by position; Jellyfin needs the
    # per-entry PlaylistItemId, obtainable only by listing the playlist
    # first — a narrow race window exists if the playlist changes between
    # this list and the delete below, same as any read-then-act sequence
    # without a lock. On v12 that id is not per-entry at all (see
    # _playlist_entries), so a song listed twice loses both copies here.
    items = await _jf_get(media, f"/Playlists/{quote_id(playlist_id)}/Items", userId=media.user_id)
    entries = items.get("Items", [])
    entry_ids = [
        entries[i]["PlaylistItemId"]
        for i in indexes
        if 0 <= i < len(entries) and entries[i].get("PlaylistItemId")
    ]
    if entry_ids:
        await _jf_request(
            "DELETE",
            media,
            f"/Playlists/{quote_id(playlist_id)}/Items",
            params={"EntryIds": ",".join(entry_ids)},
        )


async def update_playlist(params, media: JellyfinClient) -> dict:
    async def rename(playlist_id: str, name: str) -> None:
        # `public` is left alone: the playlist always reads as private here
        # (see _map_playlist), so passing it on would quietly withdraw
        # OpenAccess from one shared in Jellyfin itself.
        await _jf_request(
            "POST", media, f"/Playlists/{quote_id(playlist_id)}", json_body={"Name": name}
        )

    return await bridge.update_playlist(
        params,
        add=lambda playlist_id, ids: _add_to_playlist(playlist_id, ids, media),
        remove=lambda playlist_id, indexes: _remove_from_playlist(playlist_id, indexes, media),
        rename=rename,
    )


async def delete_playlist(params: dict, media: JellyfinClient) -> dict:
    await _jf_request("DELETE", media, f"/Items/{quote_id(params['id'])}")
    return {}


# ── Library scan + who is asking ─────────────────────────────────────────────


async def get_user(params: dict, media: JellyfinClient) -> dict:
    """Subsonic's getUser.view, bridged for the one thing Beacon asks it:
    whether this account may run a library scan (see capabilities.ts's
    libraryScan). Jellyfin keeps that in the user's policy rather than as a
    role of its own.

    /Users/Me rather than /Users/{id}: it answers for whoever the token
    belongs to, which is exactly who is asking, and unlike the by-id form
    it needs no elevation to call."""
    me = await _jf_get(media, "/Users/Me")
    policy = me.get("Policy") or {}
    return {
        "user": {
            "username": params.get("username") or me.get("Name", ""),
            "adminRole": bool(policy.get("IsAdministrator")),
        }
    }


async def get_users(_params: dict, media: JellyfinClient) -> dict:
    """Subsonic's getUsers.view, bridged so the admin UI can offer the
    server's real accounts instead of free-typed names (see
    docs/plans/cast-permissions.md). /Users is admin-only (RequiresElevation), so
    a non-admin gets Jellyfin's own refusal — which is the correct answer
    for a list only an admin may see."""
    users = await _jf_request("GET", media, "/Users")
    return {
        "users": {
            "user": [
                {
                    "username": user.get("Name", ""),
                    "adminRole": bool((user.get("Policy") or {}).get("IsAdministrator")),
                }
                for user in users
            ]
        }
    }


async def _music_libraries(media: JellyfinClient) -> list[dict]:
    """The server's music libraries, as Jellyfin's own library list reports
    them. A server almost always holds films and series as well, and
    scanning those on Beacon's behalf would be both slow and none of its
    business."""
    folders = await _jf_request("GET", media, "/Library/VirtualFolders")
    return [folder for folder in folders if folder.get("CollectionType") == "music"]


async def start_scan(_params: dict, media: JellyfinClient) -> dict:
    """Kicks off a scan of the music libraries, one refresh per library.

    Deliberately not /Library/Refresh, which is what Jellyfin's own
    "scan all libraries" does: that would drag every film and series on the
    server through a scan because someone pressed a button in a music app.

    Server-admin only (Jellyfin marks these endpoints RequiresElevation),
    which is why the button leading here is hidden for everyone else rather
    than failing when pressed — see capabilities.ts's libraryScan and
    authStore.resolveAdminRole().

    Reports `scanning: true` without waiting for the refresh to be picked
    up: it has been accepted, and the frontend's own polling
    (SettingsView.vue) takes it from there."""
    libraries = await _music_libraries(media)
    if not libraries:
        raise ValueError("This Jellyfin server has no music library to scan")
    for library in libraries:
        await _jf_request("POST", media, f"/Items/{quote_id(library['ItemId'])}/Refresh")
    return {"scanStatus": {"scanning": True}}


async def get_scan_status(_params: dict, media: JellyfinClient) -> dict:
    """Whether that scan is still running, and how far along it is — both
    read from the library list itself, which carries a per-library
    RefreshStatus and RefreshProgress (verified live 2026-08-27: "Active"
    with a percentage while scanning, "Idle" with none when not).

    No count of processed items, unlike Navidrome's own extension —
    Jellyfin only knows a percentage, so `count` is left out entirely
    rather than filled with a number that would be wrong (see the
    frontend's own handling of a missing count)."""
    libraries = await _music_libraries(media)
    scanning = any(library.get("RefreshStatus") == "Active" for library in libraries)
    status: dict = {"scanning": scanning}
    # Averaged across libraries: a server with two music libraries is
    # halfway done when one has finished, not 100% done.
    progresses = [
        library["RefreshProgress"]
        for library in libraries
        if library.get("RefreshProgress") is not None
    ]
    if scanning and progresses:
        status["progress"] = round(sum(progresses) / len(progresses))
    return {"scanStatus": status}


# ── Lyrics ───────────────────────────────────────────────────────────────────


async def get_lyrics_by_song_id(params: dict, media: JellyfinClient) -> dict:
    """The lyrics stored with this exact file — Jellyfin's own
    /Audio/{id}/Lyrics, which reads the tags embedded in the audio file or
    a .lrc sitting next to it, nothing looked up on the internet. That
    distinction is the whole reason the frontend asks for these before
    falling back to connect's third-party providers (see
    stores/lyrics.ts's fetchFileLyrics()): they belong to this recording
    rather than to some other edit of a song with the same name.

    Ordinary user permission, unlike Jellyfin's admin-gated endpoints
    (verified against a live 10.11.11 server's own OpenAPI: the policy is
    DefaultAuthorization) — so this works for whoever is logged in, not
    only for a server owner."""
    item_id = params.get("id", "")
    if not item_id:
        raise ValueError("getLyricsBySongId.view requires id")
    try:
        data = await _jf_get(media, f"/Audio/{quote_id(item_id)}/Lyrics")
    except httpx.HTTPStatusError as e:
        # 404 is Jellyfin's answer for "this track has no lyrics", which is
        # a normal, extremely common result rather than a failure — the
        # empty list below is what the Subsonic extension says for it.
        if e.response.status_code == 404:
            return {"lyricsList": {}}
        raise

    lines = data.get("Lyrics") or []
    metadata = data.get("Metadata") or {}
    structured_lines = []
    for line in lines:
        # Reading lyrics out of an ID3 tag leaves Jellyfin's own last line
        # as a lone NUL byte (the frame's terminator, seen live
        # 2026-08-27). The byte itself has no business reaching a client;
        # the now-empty line stays, because a timed line with no text is
        # how LRC ends the previous line's highlight, and dropping those
        # would leave the last sung line lit through every instrumental
        # break (see the frontend's own cleanLyricText()).
        value = (line.get("Text") or "").replace("\x00", "").strip()
        # Jellyfin times each line in ticks (100ns) from the track's start;
        # the Subsonic extension wants milliseconds.
        start = line.get("Start")
        structured_lines.append(
            {"start": int(start / 10_000), "value": value}
            if start is not None
            else {"value": value}
        )
    # Nothing but blanks is not a lyric sheet — answering with those would
    # stop the frontend from falling back to its third-party providers.
    if not any(line["value"] for line in structured_lines):
        return {"lyricsList": {}}
    return {
        "lyricsList": {
            "structuredLyrics": [
                {
                    # Jellyfin records no language for lyrics at all, and
                    # the extension's own placeholder for that is "xxx".
                    "lang": "xxx",
                    # IsSynced is Jellyfin's own verdict, but it doesn't
                    # always reach one: a real server answered with an
                    # empty Metadata object for a fully timed lyric sheet
                    # (2026-08-27), so the line-level timings decide it
                    # whenever the flag is missing.
                    "synced": bool(metadata.get("IsSynced"))
                    or any(line.get("Start") for line in lines),
                    "line": structured_lines,
                }
            ]
        }
    }


# ── Track/Artist Radio + play tracking ───────────────────────────────────────


async def get_similar_songs2(params: dict, media: JellyfinClient) -> dict:
    # Jellyfin's InstantMix accepts a song/album/*or* artist id exactly like
    # Subsonic's getSimilarSongs2.view does — verified directly against a
    # real server (curl): all three id kinds return a real, fast (<0.5s)
    # mix regardless of library size, unlike the Recursive=true bulk-scan
    # endpoints elsewhere in this file.
    item_id = params.get("id", "")
    if not item_id:
        raise ValueError("getSimilarSongs2.view requires id")
    count = params.get("count", "50")
    data = await _jf_get(
        media,
        f"/Items/{quote_id(item_id)}/InstantMix",
        userId=media.user_id,
        Limit=count,
        Fields=_SONG_LIST_FIELDS,
    )
    return {"similarSongs2": {"song": _map_all(_map_song, data.get("Items", []))}}


async def scrobble(params: dict, media: JellyfinClient) -> dict:
    track_id = params.get("id", "")
    if not track_id:
        raise ValueError("scrobble.view requires id")

    # Real per-play PlayCount increments out of Jellyfin need this exact
    # two-call shape. The earlier attempt here only ever POSTed
    # /Sessions/Playing/Stopped in isolation, with no preceding
    # /Sessions/Playing to seed the session's NowPlayingItem — that's
    # almost certainly why it looked like a silent no-op. Subsonic's own
    # submission=false/true pair lines up with Jellyfin's start/stop pair
    # directly, so no artificial "now playing" phase needs inventing.
    if params.get("submission", "false").lower() != "true":
        # submission=false: Subsonic's "now playing" notification, fired
        # once at playback start. POST /Sessions/Playing sets
        # NowPlayingItem on this device's session so the later Stopped
        # call below has something to transition from.
        await _jf_request(
            "POST",
            media,
            "/Sessions/Playing",
            json_body={"ItemId": track_id},
        )
        return {}

    # submission=true: fired once the frontend's own scrobble threshold
    # (checkScrobbleThreshold() in stores/playback.ts — 50% of duration,
    # capped at 240s) has been crossed. Subsonic gives no real playback
    # position, so PositionTicks is set to the track's full duration —
    # from Jellyfin's perspective this reads the same as a listen that
    # ran to completion, which is enough to cross its own play/no-play
    # ratio check and bump UserData.PlayCount + LastPlayedDate.
    item = await _jf_get_items(media, quote_id(track_id))
    position_ticks = item.get("RunTimeTicks") or 0
    await _jf_request(
        "POST",
        media,
        "/Sessions/Playing/Stopped",
        json_body={"ItemId": track_id, "PositionTicks": position_ticks, "IsPaused": True},
    )
    return {}


_HANDLERS: dict[str, Callable[[dict, JellyfinClient], Awaitable[dict]]] = {
    "getAlbumList2.view": get_album_list2,
    "getAlbum.view": get_album,
    "getSong.view": get_song,
    "getArtists.view": get_artists,
    "getArtist.view": get_artist,
    "search3.view": search3,
    "getStarred2.view": get_starred2,
    "star.view": star,
    "unstar.view": unstar,
    "getPlaylists.view": get_playlists,
    "getPlaylist.view": get_playlist,
    "getLyricsBySongId.view": get_lyrics_by_song_id,
    "getUser.view": get_user,
    "getUsers.view": get_users,
    "startScan.view": start_scan,
    "getScanStatus.view": get_scan_status,
    "createPlaylist.view": create_playlist,
    "updatePlaylist.view": update_playlist,
    "deletePlaylist.view": delete_playlist,
    "getSimilarSongs2.view": get_similar_songs2,
    "scrobble.view": scrobble,
    "getInternetRadioStations.view": get_internet_radio_stations,
    "createInternetRadioStation.view": create_internet_radio_station,
    "updateInternetRadioStation.view": update_internet_radio_station,
    "deleteInternetRadioStation.view": delete_internet_radio_station,
}


# ── Entry point ────────────────────────────────────────────────────────────


async def _cover_url(cover_id: str, params: dict, media: JellyfinClient) -> str:
    size = params.get("size", "300")
    item_id, version = split_artwork_id(cover_id)
    url = (
        f"{media.internal_url}/Items/{quote_id(item_id)}/Images/Primary"
        f"?maxHeight={quote(size, safe='')}"
    )
    if version:
        url += f"&tag={quote(version, safe='')}"
    return url


async def _stream_url(track_id: str, media: JellyfinClient) -> str:
    return media.get_stream_url(track_id)


_BRIDGE = bridge.Bridge(
    label="jellyfin-bridge",
    unsupported="is not supported on Jellyfin",
    handlers=_HANDLERS,
    log=logger,
    client=lambda: _get_client(),
    cover_url=_cover_url,
    stream_url=_stream_url,
)


async def call(endpoint: str, params: dict, media: JellyfinClient) -> dict:
    """See bridge.py's call()."""
    return await bridge.call(_BRIDGE, endpoint, params, media)


async def handle(
    path: str, request: Request, media: JellyfinClient
) -> JSONResponse | StreamingResponse:
    return await bridge.handle(_BRIDGE, path, request, media)
