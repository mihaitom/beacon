"""core/listenbrainz.py — ListenBrainz track lists and personalized
recommendations, for the playlist builder and Home's recommendation shelf.

Two kinds of query live here, both read-only and both keyed on a plain
public ListenBrainz username:

1. **Track lists** — sitewide top recordings, one artist's most-listened
   recordings, and a person's own top recordings. These are the same five
   queries core/lastfm.py offers, minus the two ListenBrainz has no
   equivalent for (country charts, genre tags). Turning the returned names
   into songs this library owns happens in the renderer, exactly as it does
   for Last.fm — see services/library/lastfmMatcher.ts, which neither knows
   nor cares which service a name came from.

2. **Collaborative-filtering recommendations** — the listener's own
   ListenBrainz history, fed through ListenBrainz's recommendation model.
   This is the one thing Last.fm cannot offer. The endpoint returns only
   recording MBIDs, so a second call resolves them into something worth
   showing (title, artist, release, cover art) via /1/metadata/recording.

No API key and no token are needed for either: the stats, popularity and
CF endpoints are public, and a username is passed as a plain parameter the
same way Last.fm's user.getTopTracks takes one. A ListenBrainz *user token*
would be a different thing entirely — it is a write credential (it can
submit and delete listens), which is why it is deliberately not part of
this module; see docs/listenbrainz.md.

ListenBrainz asks clients for at most one request per second and a real
User-Agent (lyrics.shared.USER_AGENT). _throttle() enforces the first; the
recommendation path is two calls, so the second waits its turn.
"""

import asyncio
import logging
import time

import httpx

from core.recommendations import resolve_mbid
from lyrics.shared import USER_AGENT

logger = logging.getLogger("connect.listenbrainz")

_BASE_URL = "https://api.listenbrainz.org"
_TIMEOUT = 15.0
# LB Radio generates its list on the fly (Troi), which routinely takes
# 10-15s and can run longer — measured live 2026-09-20. The stats and
# metadata endpoints answer instantly, so only the LB Radio calls get this.
_RADIO_TIMEOUT = 45.0

# A page ceiling, not the builder's own limit — same role as
# core/lastfm.py's _MAX_LIMIT, stopping a hand-crafted request from asking
# for a page the API would reject.
_MAX_LIMIT = 1000

# How many recordings a sitewide chart may contribute per artist. Measured
# live (2026-09-20): the sitewide top 50 was 39 tracks by one act, because
# the chart is what the whole userbase is mass-listening to right now, not a
# balanced selection. A cap is the only thing that makes it usable as a
# playlist source; a larger pool is fetched and capped down to `limit`.
_MAX_PER_ARTIST = 2

# ListenBrainz's documented client etiquette: never more than one call per
# second. The recommendation path (CF, then the metadata resolve) is two,
# so the second is held back rather than fired immediately behind the first.
_MIN_INTERVAL = 1.1
_throttle_lock = asyncio.Lock()
_last_call = 0.0

_client = httpx.AsyncClient(timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT})


class ListenbrainzError(Exception):
    """A failure the caller can report on. `not_found` separates "no such
    user or artist" (worth showing the listener) from an upstream problem
    they can do nothing about — same split as core/lastfm.py's LastfmError."""

    def __init__(self, message: str, not_found: bool = False) -> None:
        super().__init__(message)
        self.not_found = not_found


def _clamp(limit: int) -> int:
    return max(1, min(int(limit), _MAX_LIMIT))


def _cover_art_url(caa_id: object, caa_release_mbid: object) -> str:
    """The Cover Art Archive image for a release, or '' when ListenBrainz
    has no cover on file for it. The two fields together are what CAA keys
    on — the release MBID in the path, the image id in the filename."""
    if not caa_id or not caa_release_mbid:
        return ""
    return f"https://coverartarchive.org/release/{caa_release_mbid}/{caa_id}-250.jpg"


def _track(
    title: str,
    artist: str,
    mbid: str = "",
    album: str = "",
    cover_art_url: str = "",
    duration: int = 0,
) -> dict:
    """One normalized result. The playlist builder only ever reads
    title/artist/mbid (the same shape core/lastfm.py returns); the display
    fields are what Home's recommendation shelf needs and are simply empty
    where a query has no way to know them."""
    return {
        "title": title,
        "artist": artist,
        "mbid": mbid,
        "album": album,
        "coverArtUrl": cover_art_url,
        "duration": duration,
    }


async def _throttle() -> None:
    global _last_call
    async with _throttle_lock:
        wait = _MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_call = time.monotonic()


async def _request(method: str, path: str, *, timeout: float = _TIMEOUT, **kwargs) -> object:
    await _throttle()
    try:
        resp = await _client.request(method, f"{_BASE_URL}{path}", timeout=timeout, **kwargs)
    except httpx.HTTPError as e:
        logger.warning(f"[listenbrainz] {path} failed: {e}")
        raise ListenbrainzError(f"ListenBrainz request failed: {e}") from e

    # 204 is a normal answer, not a failure: a user with no statistics yet,
    # or a profile the recommendation model has nothing for.
    if resp.status_code == 204:
        return None
    if resp.status_code == 404:
        logger.info(f"[listenbrainz] {path} -> 404")
        raise ListenbrainzError("ListenBrainz has no such user or artist", not_found=True)
    if resp.status_code == 401:
        # ListenBrainz keeps moving endpoints behind a login token to fend
        # off scrapers (the documented /1/explore/lb-radio and, measured
        # live 2026-09-20, /1/popularity/top-recordings-for-artist). Beacon
        # deliberately holds no token, so this is named for what it is
        # rather than shown as a generic unreachable.
        logger.warning(f"[listenbrainz] {path} -> 401 (endpoint now needs a token)")
        raise ListenbrainzError("ListenBrainz now requires a login for that request")
    if resp.status_code >= 400:
        logger.warning(f"[listenbrainz] {path} -> HTTP {resp.status_code}")
        raise ListenbrainzError(f"ListenBrainz returned HTTP {resp.status_code}")

    try:
        return resp.json()
    except ValueError as e:  # non-JSON body
        logger.warning(f"[listenbrainz] {path} returned an unparseable body: {e}")
        raise ListenbrainzError("ListenBrainz returned an unreadable response") from e


def _recordings_from_stats(data: object, max_per_artist: int | None = None) -> list[dict]:
    """The `recordings` array of a /1/stats/... response. Entries carry
    `track_name`, `artist_name`, and `recording_mbid` where known (the MBID
    is explicitly optional in the API), plus `release_name`.

    The same recording routinely appears more than once in the response —
    measured live at 16 of 50 sitewide entries — so duplicates are dropped
    here rather than left for the matcher to look up twice. `max_per_artist`
    caps how many entries one artist may contribute, which is what keeps a
    chart from being one act's album; None leaves it uncapped (a listener's
    own history is allowed to be one artist)."""
    if not isinstance(data, dict):
        return []
    recordings = (data.get("payload") or {}).get("recordings")
    if not isinstance(recordings, list):
        return []
    tracks: list[dict] = []
    seen: set[str] = set()
    per_artist: dict[str, int] = {}
    for entry in recordings:
        if not isinstance(entry, dict):
            continue
        title = (entry.get("track_name") or "").strip()
        artist = (entry.get("artist_name") or "").strip()
        if not title or not artist:
            continue
        mbid = entry.get("recording_mbid") or ""
        key = mbid or f"{title.lower()}\x00{artist.lower()}"
        if key in seen:
            continue
        if max_per_artist is not None and per_artist.get(artist, 0) >= max_per_artist:
            continue
        seen.add(key)
        per_artist[artist] = per_artist.get(artist, 0) + 1
        tracks.append(
            _track(
                title,
                artist,
                mbid=mbid,
                album=(entry.get("release_name") or "").strip(),
            )
        )
    return tracks


async def get_sitewide_top_recordings(period: str, limit: int) -> list[dict]:
    """A larger pool than `limit` is fetched because the per-artist cap
    (_MAX_PER_ARTIST) drops most of what a fandom-dominated chart returns:
    the sitewide list is what the whole userbase is mass-listening to right
    now, and a comeback week can be one act's whole album."""
    wanted = _clamp(limit)
    data = await _request(
        "GET",
        "/1/stats/sitewide/recordings",
        params={"range": period, "count": _clamp(wanted * 10)},
    )
    return _recordings_from_stats(data, max_per_artist=_MAX_PER_ARTIST)[:wanted]


async def get_user_top_recordings(username: str, period: str, limit: int) -> list[dict]:
    """A slightly larger pool than `limit` so dropping the API's duplicate
    entries still leaves `limit` tracks. No per-artist cap: this is the
    listener's own history, and if they really played one artist most, that
    is the honest answer."""
    wanted = _clamp(limit)
    data = await _request(
        "GET",
        f"/1/stats/user/{username}/recordings",
        params={"range": period, "count": _clamp(wanted * 2)},
    )
    if data is None:
        # A 204 here means ListenBrainz has not computed this account's
        # statistics yet — routine for a freshly created account, and worth
        # saying rather than showing as "returned nothing".
        raise ListenbrainzError("ListenBrainz has not computed statistics for that account yet")
    return _recordings_from_stats(data)[:wanted]


async def get_tag_recordings(tag: str, limit: int) -> list[dict]:
    """Recordings the community tagged with `tag`, via ListenBrainz's own LB
    Radio (Troi). The sitewide chart takes no genre filter and is
    fandom-dominated, so this is the genre equivalent.

    LB Radio's own /1/lb-radio/tags endpoint is public; the documented
    /1/explore/lb-radio wrapper around it now demands a token ("bad actors
    and AI scrapers"), which Beacon deliberately does not hold. pop_begin and
    pop_end are required, and the full 0-100 range is what a genre playlist
    wants; mode "easy" leans familiar rather than adventurous, which suits
    filling a playlist from a genre rather than a discovery dig. The result
    is recording MBIDs, resolved through the same metadata call the
    recommendations use."""
    wanted = _clamp(limit)
    # MusicBrainz tags are lower-case, and LB Radio matches them literally:
    # measured live, "Rock" returns nothing where "rock" returns a full
    # list. The builder's suggestions are capitalised, so the case has to go.
    tag = tag.strip().lower()
    data = await _request(
        "GET",
        "/1/lb-radio/tags",
        params={
            "tag": tag,
            "mode": "easy",
            "pop_begin": 0,
            "pop_end": 100,
            "count": wanted,
        },
        timeout=_RADIO_TIMEOUT,
    )
    if not isinstance(data, list):
        return []
    mbids: list[str] = []
    seen: set[str] = set()
    for entry in data:
        mbid = entry.get("recording_mbid") if isinstance(entry, dict) else None
        if mbid and mbid not in seen:
            seen.add(mbid)
            mbids.append(mbid)
    return await resolve_recordings(mbids)


async def get_artist_top_recordings(artist: str, limit: int) -> list[dict]:
    """One artist's most-listened recordings, by *name*. The name is resolved
    through the same MusicBrainz lookup core/recommendations.py already uses
    for artist pages; a name that resolves to nothing is reported as
    not-found rather than searched for as an empty string.

    The obvious endpoint, /1/popularity/top-recordings-for-artist, is now
    token-gated (401 without one, measured live 2026-09-20), so this uses LB
    Radio's public /1/lb-radio/artist instead. That returns the artist's
    recordings — including the occasional remix or collaboration — in no
    particular order, but each carries total_listen_count, so sorting by
    that gives back the "most listened" ranking. max_similar_artists=0 keeps
    it to this artist rather than a radio around them, and
    max_recordings_per_artist=limit is what lets more than a couple through
    (at the default of 2, a 50-track request returned 2)."""
    mbid = await resolve_mbid(artist)
    if not mbid:
        raise ListenbrainzError(f"No ListenBrainz artist matches {artist!r}", not_found=True)
    wanted = _clamp(limit)
    data = await _request(
        "GET",
        f"/1/lb-radio/artist/{mbid}",
        params={
            "mode": "easy",
            "pop_begin": 0,
            "pop_end": 100,
            "count": wanted,
            "max_similar_artists": 0,
            "max_recordings_per_artist": wanted,
        },
        timeout=_RADIO_TIMEOUT,
    )
    if not isinstance(data, dict):
        return []
    entries = [
        entry
        for recordings in data.values()
        if isinstance(recordings, list)
        for entry in recordings
        if isinstance(entry, dict)
    ]
    entries.sort(key=lambda entry: entry.get("total_listen_count") or 0, reverse=True)
    mbids: list[str] = []
    seen: set[str] = set()
    for entry in entries:
        recording_mbid = entry.get("recording_mbid")
        if recording_mbid and recording_mbid not in seen:
            seen.add(recording_mbid)
            mbids.append(recording_mbid)
    return await resolve_recordings(mbids[:wanted])


async def get_recommendation_mbids(username: str, limit: int) -> list[str]:
    """The listener's collaborative-filtering recommendation MBIDs, in the
    model's own order. The payload carries scores too, but the order already
    reflects them and the raw score is not comparable across listeners."""
    data = await _request(
        "GET",
        f"/1/cf/recommendation/user/{username}/recording",
        params={"count": _clamp(limit)},
    )
    if not isinstance(data, dict):
        return []
    mbids = (data.get("payload") or {}).get("mbids")
    if not isinstance(mbids, list):
        return []
    result = []
    seen: set[str] = set()
    for entry in mbids:
        mbid = entry.get("recording_mbid") if isinstance(entry, dict) else None
        if mbid and mbid not in seen:
            seen.add(mbid)
            result.append(mbid)
    return result


async def resolve_recordings(mbids: list[str]) -> list[dict]:
    """Recording MBIDs -> displayable tracks, in the order given. One
    batched metadata call, not one per MBID. MBIDs ListenBrainz cannot
    resolve are dropped rather than returned as nameless rows — a
    recommendation with no title is nothing to show."""
    if not mbids:
        return []
    data = await _request(
        "POST",
        "/1/metadata/recording/",
        json={"recording_mbids": mbids, "inc": "artist release"},
    )
    if not isinstance(data, dict):
        return []

    tracks = []
    for mbid in mbids:
        entry = data.get(mbid)
        if not isinstance(entry, dict):
            continue
        recording = entry.get("recording") or {}
        artist = (entry.get("artist") or {}).get("name") or ""
        release = entry.get("release") or {}
        title = (recording.get("name") or "").strip()
        if not title or not artist:
            continue
        length = recording.get("length")
        tracks.append(
            _track(
                title,
                artist.strip(),
                mbid=mbid,
                album=(release.get("name") or "").strip(),
                cover_art_url=_cover_art_url(
                    release.get("caa_id"), release.get("caa_release_mbid")
                ),
                duration=round(length / 1000) if isinstance(length, (int, float)) else 0,
            )
        )
    return tracks


async def get_recommendations(username: str, limit: int) -> list[dict]:
    """Personalized recommendations as displayable tracks: the CF feed, then
    one metadata call to resolve its MBIDs."""
    mbids = await get_recommendation_mbids(username, limit)
    return await resolve_recordings(mbids)


async def get_recommended_artists(username: str, limit: int) -> list[dict]:
    """The artists behind the listener's recommended recordings, most
    recommended first.

    The CF feed is recordings, and Home's shelf shows artists, so each
    recording's credited artist is counted and the artists are ranked by how
    many recommended recordings they account for — an act with several
    tracks in the feed is a stronger signal than one with a single track.
    The metadata response credits the artist both by name and, where known,
    by MBID; the MBID is preferred as the identity so a name spelled two
    ways does not become two entries, falling back to the lowercased name
    when ListenBrainz has no MBID for it.

    A wider recording pool than `limit` is pulled, since one artist can
    account for many of the top recordings and the shelf wants `limit`
    *distinct* artists out of it."""
    pool = _clamp(limit * 5)
    mbids = await get_recommendation_mbids(username, pool)
    if not mbids:
        return []
    data = await _request(
        "POST",
        "/1/metadata/recording/",
        json={"recording_mbids": mbids, "inc": "artist"},
    )
    if not isinstance(data, dict):
        return []

    counts: dict[str, dict] = {}
    for mbid in mbids:
        entry = data.get(mbid)
        if not isinstance(entry, dict):
            continue
        artist = entry.get("artist") or {}
        # ListenBrainz credits a collaboration as one string ("David Guetta &
        # Bebe Rexha", "Post Malone feat. Morgan Wallen") *and* lists the
        # artists actually on it. The individuals are what everything
        # downstream wants - each has its own photo, its own MusicBrainz
        # page, and matches a library artist by the name it is filed under -
        # where the combined string has none of that. So they are counted,
        # not the string; a recording with no artist list falls back to it.
        credited = artist.get("artists")
        credits = credited if isinstance(credited, list) and credited else [artist]
        for credit in credits:
            if not isinstance(credit, dict):
                continue
            name = (credit.get("name") or "").strip()
            if not name:
                continue
            artist_mbid = credit.get("artist_mbid") or ""
            key = artist_mbid or name.lower()
            item = counts.setdefault(key, {"name": name, "mbid": artist_mbid, "score": 0})
            item["score"] += 1

    ranked = sorted(counts.values(), key=lambda artist: artist["score"], reverse=True)
    return ranked[: max(1, int(limit))]
