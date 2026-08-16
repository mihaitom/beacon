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
so they're bridged as binary passthroughs instead (see _handle_binary).

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

from .base import (
    create_internet_radio_station,
    delete_internet_radio_station,
    get_internet_radio_stations,
    subsonic_envelope,
    subsonic_error,
    update_internet_radio_station,
)
from .jellyfin import TICKS_PER_SECOND, JellyfinClient

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


def _is_favorite(item: dict) -> bool:
    return bool((item.get("UserData") or {}).get("IsFavorite"))


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
        # Cover art id IS the item id for Jellyfin (see JellyfinClient.get_track).
        "coverArt": item["Id"],
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
    if source.get("Container"):
        song["suffix"] = source["Container"]
    if source.get("Bitrate"):
        song["bitRate"] = int(source["Bitrate"] / 1000)
    # Presence, not value, is mappers.ts's whole signal (raw.starred != null)
    # — omitted entirely when not favorited, never sent as false.
    if _is_favorite(item):
        song["starred"] = "true"
    replay_gain = _map_replay_gain(item)
    if replay_gain:
        song["replayGain"] = replay_gain
    return song


def _map_replay_gain(item: dict) -> dict | None:
    """Jellyfin exposes loudness-normalization data directly on the item
    (NormalizationGain/AlbumNormalizationGain, dB — populated from the
    file's own embedded ReplayGain tags when present) rather than nesting it
    the way OpenSubsonic's `replayGain` object does — reshaped into that
    same {trackGain, albumGain} shape here so the frontend only ever deals
    with one format. LUFS is Jellyfin's own loudness-scan fallback for files
    with no embedded ReplayGain tag, converted to a dB gain against
    ReplayGain's -18 LUFS reference target."""
    track_gain = item.get("NormalizationGain")
    if track_gain is None and item.get("LUFS") is not None:
        track_gain = -18 - item["LUFS"]
    album_gain = item.get("AlbumNormalizationGain")
    if track_gain is None and album_gain is None:
        return None
    gain: dict = {}
    if track_gain is not None:
        gain["trackGain"] = track_gain
    if album_gain is not None:
        gain["albumGain"] = album_gain
    return gain


def _map_album(item: dict) -> dict:
    artist_items = item.get("AlbumArtists") or item.get("ArtistItems") or []
    artists = item.get("Artists") or []
    album = {
        "id": item["Id"],
        "name": item.get("Name", "Unknown"),
        "artist": item.get("AlbumArtist") or (", ".join(artists) if artists else "Unknown"),
        "coverArt": item["Id"],
        "songCount": item.get("ChildCount") or 0,
        "duration": int((item.get("RunTimeTicks") or 0) / TICKS_PER_SECOND),
    }
    if artist_items:
        album["artistId"] = artist_items[0]["Id"]
    if item.get("ProductionYear") is not None:
        album["year"] = item["ProductionYear"]
    genres = item.get("Genres") or []
    if genres:
        album["genre"] = genres[0]
    if _is_favorite(item):
        album["starred"] = "true"
    return album


def _map_artist(item: dict) -> dict:
    artist = {
        "id": item["Id"],
        "name": item.get("Name", "Unknown"),
        "coverArt": item["Id"],
        "albumCount": item.get("ChildCount") or 0,
    }
    if _is_favorite(item):
        artist["starred"] = "true"
    return artist


def _map_playlist(item: dict) -> dict:
    # Jellyfin's own playlist sharing model (OwnerUserId + per-user access
    # grants) doesn't map cleanly onto Subsonic's single public/owner pair —
    # left at safe defaults (private, no owner shown) rather than guessing;
    # renaming/visibility changes are correspondingly not bridged either
    # (see update_playlist below).
    return {
        "id": item["Id"],
        "name": item.get("Name", "Unknown"),
        "songCount": item.get("ChildCount") or 0,
        "duration": int((item.get("RunTimeTicks") or 0) / TICKS_PER_SECOND),
        "coverArt": item["Id"],
        "public": False,
    }


def _map_all(mapper: Callable[[dict], dict], items: list[dict]) -> list[dict]:
    """Applies `mapper` to each item, skipping (and logging) any single item
    that fails to map instead of letting one malformed record fail the
    entire request — a page with 999 of 1000 albums showing is still
    useful; an empty page because item #500 was missing a field isn't."""
    result = []
    for item in items:
        try:
            result.append(mapper(item))
        except Exception as e:
            logger.warning(f"[jellyfin-bridge] Skipping malformed item {item.get('Id', '?')}: {e}")
    return result


# ── Jellyfin HTTP helper ─────────────────────────────────────────────────────


def _quote_id(value: str) -> str:
    """Percent-encodes an id (song/album/artist/playlist id, or any other
    client-supplied value) before it's spliced into a Jellyfin URL *path*
    segment via an f-string below. Every id handled here ultimately comes
    from the incoming Subsonic-shaped request (params["id"] and friends),
    unvalidated — without this, a value like "../Users" would let a caller
    holding only the shared CONNECT_TOKEN reach arbitrary Jellyfin API paths
    outside the _HANDLERS whitelist this module exists to enforce. `params`
    passed separately to _jf_request()/_jf_get() don't need this — httpx
    encodes those itself."""
    return quote(str(value), safe="")


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
        logger.warning(f"[jellyfin-bridge] {method} {url} failed after {elapsed:.2f}s (params={params})")
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
    data = await _jf_get(
        media,
        f"/Users/{media.user_id}/Items",
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
    item = await _jf_get(media, f"/Users/{media.user_id}/Items/{_quote_id(album_id)}")
    songs = await _jf_get(
        media,
        f"/Users/{media.user_id}/Items",
        ParentId=album_id,
        IncludeItemTypes="Audio",
        Recursive="true",
        SortBy="IndexNumber",
    )
    album = _map_album(item)
    album["song"] = _map_all(_map_song, songs.get("Items", []))
    return {"album": album}


async def get_song(params: dict, media: JellyfinClient) -> dict:
    item = await _jf_get(media, f"/Users/{media.user_id}/Items/{_quote_id(params['id'])}")
    return {"song": _map_song(item)}


async def get_artists(_params: dict, media: JellyfinClient) -> dict:
    data = await _jf_get(
        media,
        f"/Users/{media.user_id}/Items",
        IncludeItemTypes="MusicArtist",
        Recursive="true",
        SortBy="SortName",
    )
    # Jellyfin has no native indexed-by-letter grouping (unlike Subsonic's
    # own getArtists.view shape) — bucket client(python)-side.
    buckets: dict[str, list[dict]] = {}
    for item in data.get("Items", []):
        name = item.get("Name") or ""
        letter = name[0].upper() if name else "#"
        buckets.setdefault(letter, []).append(_map_artist(item))
    index = [{"name": letter, "artist": artists} for letter, artists in sorted(buckets.items())]
    return {"artists": {"index": index}}


async def get_artist(params: dict, media: JellyfinClient) -> dict:
    artist_id = params["id"]
    item = await _jf_get(media, f"/Users/{media.user_id}/Items/{_quote_id(artist_id)}")
    albums = await _jf_get(
        media,
        f"/Users/{media.user_id}/Items",
        ArtistIds=artist_id,
        IncludeItemTypes="MusicAlbum",
        Recursive="true",
    )
    artist = _map_artist(item)
    artist["album"] = [_map_album(a) for a in albums.get("Items", [])]
    return {"artist": artist}


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
        # songOffset is the only offset stores/library.ts's search3() ever
        # sends (see its signature) — without mapping it to StartIndex, every
        # "page" of a paginated bulk load re-fetched the exact same items.
        "StartIndex": params.get("songOffset", "0"),
        # Explicit, minimal Fields — two reasons: (1) without this,
        # ArtistItems (needed for _map_song's artistId) is excluded from
        # Jellyfin's default response entirely, silently dropping that field
        # from every bulk-loaded track; (2) measured directly against a real
        # library (curl, Limit=100 vs. 3000): response time scales linearly
        # with item count (~9ms/item) rather than a fixed per-request cost,
        # meaning Jellyfin is doing real per-item work — asking for less
        # should do less of it. Deliberately excludes heavier optional
        # fields this bulk load doesn't need (MediaSources, Overview,
        # People, ...).
        "Fields": "Genres,ArtistItems",
    }
    if query:
        jf_params["searchTerm"] = query

    data = await _jf_get(media, f"/Users/{media.user_id}/Items", **jf_params)
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
            "artist": _map_all(_map_artist, by_type["MusicArtist"]),
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
    songs = await _jf_get(
        media, f"/Users/{media.user_id}/Items", IncludeItemTypes="Audio",
        Filters="IsFavorite", Recursive="true",
    )
    albums = await _jf_get(
        media, f"/Users/{media.user_id}/Items", IncludeItemTypes="MusicAlbum",
        Filters="IsFavorite", Recursive="true",
    )
    artists = await _jf_get(
        media, f"/Users/{media.user_id}/Items", IncludeItemTypes="MusicArtist",
        Filters="IsFavorite", Recursive="true",
    )
    return {
        "starred2": {
            "song": _map_all(_map_song, songs.get("Items", [])),
            "album": _map_all(_map_album, albums.get("Items", [])),
            "artist": _map_all(_map_artist, artists.get("Items", [])),
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
        f"/Users/{media.user_id}/FavoriteItems/{_quote_id(_favorite_item_id(params))}",
    )
    return {}


async def unstar(params: dict, media: JellyfinClient) -> dict:
    await _jf_request(
        "DELETE",
        media,
        f"/Users/{media.user_id}/FavoriteItems/{_quote_id(_favorite_item_id(params))}",
    )
    return {}


# ── Playlists ─────────────────────────────────────────────────────────────────


async def get_playlists(_params: dict, media: JellyfinClient) -> dict:
    data = await _jf_get(
        media, f"/Users/{media.user_id}/Items", IncludeItemTypes="Playlist", Recursive="true"
    )
    return {"playlists": {"playlist": _map_all(_map_playlist, data.get("Items", []))}}


async def get_playlist(params: dict, media: JellyfinClient) -> dict:
    playlist_id = params["id"]
    item = await _jf_get(media, f"/Users/{media.user_id}/Items/{_quote_id(playlist_id)}")
    songs = await _jf_get(
        media, f"/Playlists/{_quote_id(playlist_id)}/Items", userId=media.user_id
    )
    playlist = _map_playlist(item)
    playlist["entry"] = _map_all(_map_song, songs.get("Items", []))
    return {"playlist": playlist}


async def create_playlist(params, media: JellyfinClient) -> dict:
    body: dict = {"Name": params.get("name", "New Playlist"), "UserId": media.user_id}
    song_ids = params.getlist("songId")
    if song_ids:
        body["Ids"] = song_ids
    await _jf_request("POST", media, "/Playlists", json_body=body)
    return {}


async def _add_to_playlist(playlist_id: str, song_ids: list[str], media: JellyfinClient) -> None:
    await _jf_request(
        "POST",
        media,
        f"/Playlists/{_quote_id(playlist_id)}/Items",
        params={"Ids": ",".join(song_ids), "UserId": media.user_id},
    )


async def _remove_from_playlist(
    playlist_id: str, indexes: list[int], media: JellyfinClient
) -> None:
    # Subsonic addresses playlist entries by position; Jellyfin needs the
    # per-entry PlaylistItemId (distinct from the underlying song id),
    # obtainable only by listing the playlist first — a narrow race window
    # exists if the playlist changes between this list and the delete below,
    # same as any read-then-act sequence without a lock.
    items = await _jf_get(
        media, f"/Playlists/{_quote_id(playlist_id)}/Items", userId=media.user_id
    )
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
            f"/Playlists/{_quote_id(playlist_id)}/Items",
            params={"EntryIds": ",".join(entry_ids)},
        )


async def update_playlist(params, media: JellyfinClient) -> dict:
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
    # rename/visibility change (see _map_playlist's comment on why that's
    # not bridged) — fail clearly rather than silently no-op "succeeding".
    raise ValueError("Renaming or changing visibility is not supported for Jellyfin playlists")


async def delete_playlist(params: dict, media: JellyfinClient) -> dict:
    await _jf_request("DELETE", media, f"/Items/{_quote_id(params['id'])}")
    return {}


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
        media, f"/Items/{_quote_id(item_id)}/InstantMix", userId=media.user_id, Limit=count
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
    item = await _jf_get(media, f"/Users/{media.user_id}/Items/{_quote_id(track_id)}")
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


# ── Binary handlers (getCoverArt.view, stream.view) ──────────────────────────
# Fetched by the browser as raw <img>/<audio> src URLs, not through
# SubsonicClient.get()'s JSON envelope — see services/subsonic/client.ts's
# coverArtUrl()/streamUrl(). Streamed through connect the same way
# routes/proxy.py's own _proxy() streams Subsonic responses, just targeting
# a Jellyfin URL instead of a fixed NAVIDROME_INTERNAL_URL base.

_BINARY_PATHS = {"getCoverArt.view", "stream.view"}
# content-length included: blindly forwarding the upstream value can crash
# uvicorn ("Response content longer than Content-Length") if the actual
# streamed byte count doesn't match it exactly — found live (2026-08-17)
# against Plex's thumb endpoint (see plex_bridge.py's identical fix);
# applied here too since this is the same latent risk, not something
# proven safe for Jellyfin specifically, just not yet hit. Dropping it lets
# StreamingResponse fall back to chunked transfer encoding, which makes no
# such promise to violate.
_SKIP_RESP_HEADERS = {"transfer-encoding", "connection", "content-encoding", "content-length"}


async def _stream_binary(request: Request, url: str, media: JellyfinClient) -> StreamingResponse:
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
    return StreamingResponse(
        streamed(),
        status_code=response.status_code,
        headers=resp_headers,
        media_type=response.headers.get("content-type"),
    )


async def _handle_binary(
    path: str, request: Request, media: JellyfinClient
) -> StreamingResponse | JSONResponse:
    params = dict(request.query_params)
    if path == "getCoverArt.view":
        cover_id = params.get("id", "")
        if not cover_id:
            return subsonic_error(70, "No cover art id supplied")
        size = params.get("size", "300")
        url = (
            f"{media.internal_url}/Items/{_quote_id(cover_id)}/Images/Primary"
            f"?maxHeight={quote(size, safe='')}"
        )
    else:  # stream.view
        track_id = params.get("id", "")
        if not track_id:
            return subsonic_error(70, "No track id supplied")
        url = media.get_stream_url(track_id)
    return await _stream_binary(request, url, media)


# ── Entry point ────────────────────────────────────────────────────────────


async def handle(
    path: str, request: Request, media: JellyfinClient
) -> JSONResponse | StreamingResponse:
    if path in _BINARY_PATHS:
        try:
            return await _handle_binary(path, request, media)
        except Exception as e:
            # Unlike every JSON handler below, _handle_binary()/_stream_binary()
            # had no try/except of their own — a Jellyfin connectivity blip
            # (server restart, timeout) mid cover-art-load or mid-stream used
            # to propagate as a raw FastAPI 500 with a stack trace instead of
            # degrading like every other endpoint here.
            logger.warning(f"[jellyfin-bridge] {path} failed: {e}")
            return subsonic_error(0, str(e))

    handler = _HANDLERS.get(path)
    if handler is None:
        # Also the fallback for endpoints deliberately never bridged (see
        # module docstring) — the frontend hides the UI for those before
        # they'd ever be called, this is just the safety net.
        return subsonic_error(70, f"{path} is not supported on Jellyfin")
    try:
        # request.query_params (not dict(...)) — a plain dict() conversion
        # collapses repeated keys (songId=1&songId=2&...), which
        # create_playlist()/update_playlist() below need via .getlist().
        # Starlette's QueryParams otherwise behaves like a dict for the
        # .get()/[] access every other handler uses.
        result = await handler(request.query_params, media)
    except Exception as e:
        logger.warning(f"[jellyfin-bridge] {path} failed: {e}")
        return subsonic_error(0, str(e))
    return subsonic_envelope(result)
