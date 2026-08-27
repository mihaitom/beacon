"""Live bridge tests — the Jellyfin and Plex bridges against real servers.

Everything else covering these bridges tests them against mocks written from
the same understanding of the foreign API that the bridge itself was written
from, so a wrong assumption is simply agreed upon twice. That is exactly how
the lyrics handlers shipped broken in three separate ways until they were
first run against real servers (2026-08-27): Plex answers a lyric stream
with structured JSON rather than the raw .lrc whenever the caller asks for
JSON, which every bridge call does; Jellyfin appends a line consisting of a
single NUL byte when it reads lyrics out of an ID3 tag; and Jellyfin
reported no metadata at all for a fully timed lyric sheet, so its own
IsSynced flag could not be relied on.

Skipped unless the servers are configured, and excluded from the default run
either way (`-m 'not live'` in pyproject.toml) — run them deliberately:

    JELLYFIN_TEST_URL=http://host:8096 JELLYFIN_TEST_TOKEN=... \\
    JELLYFIN_TEST_USER_ID=... PLEX_TEST_URL=http://host:32400 \\
    PLEX_TEST_TOKEN=... SUBSONIC_TEST_URL=http://host:4533 \\
    SUBSONIC_TEST_USER=... SUBSONIC_TEST_PASSWORD=... uv run pytest -m live

Credentials come from the environment (connect/.env is loaded by main.py and
is gitignored) and never from this file.

JELLYFIN_TEST_TOKEN has to be a *user* access token, the kind Jellyfin
hands out for a login (/Users/AuthenticateByName, or Quick Connect — which
is what the app itself uses, see routes/jellyfin_auth.py). An admin API key
from the dashboard is not equivalent and fails in ways that look like bugs
in this code: /Playlists/{id}/Items/{id}/Move/{n} resolves the playlist
through the *calling user* (PlaylistManager.GetPlaylistForUser), so a key
bound to no user answers 400 "Error processing request" before the move is
even attempted. Verified 2026-08-27 from the server's own log — the same
call succeeds immediately with a user token.

The playlist tests write to the real library. Each one creates a playlist
named with a random suffix, works on that one alone, and deletes it again in
a fixture teardown that runs even when the test fails — nothing existing is
ever touched.
"""

import hashlib
import os
import uuid

import httpx
import pytest

from media.jellyfin import JellyfinClient
from media.plex import PlexClient

pytestmark = pytest.mark.live


@pytest.fixture(autouse=True)
async def _fresh_bridge_clients():
    """Both bridges keep one httpx client for the whole process, which is
    right in production (a single long-lived event loop) and wrong here:
    pytest-asyncio gives each test its own loop, so the second test inherits
    connections bound to the first one's closed loop and dies in teardown
    with "Event loop is closed". Closing between tests costs one handshake
    and keeps each test standing on its own."""
    from media import jellyfin_bridge, plex_bridge

    yield
    await jellyfin_bridge.close()
    await plex_bridge.close()


def _env(*names: str) -> tuple[str, ...] | None:
    values = tuple(os.environ.get(name, "") for name in names)
    return values if all(values) else None


@pytest.fixture
def jellyfin() -> JellyfinClient:
    config = _env("JELLYFIN_TEST_URL", "JELLYFIN_TEST_TOKEN", "JELLYFIN_TEST_USER_ID")
    if not config:
        pytest.skip("JELLYFIN_TEST_URL/_TOKEN/_USER_ID not set")
    url, token, user_id = config
    return JellyfinClient(url, token=token, user_id=user_id)


@pytest.fixture
def plex() -> PlexClient:
    config = _env("PLEX_TEST_URL", "PLEX_TEST_TOKEN")
    if not config:
        pytest.skip("PLEX_TEST_URL/_TOKEN not set")
    url, token = config
    return PlexClient(url, token=token)


def _params(**kwargs) -> dict:
    """The handlers take Starlette QueryParams, which a plain dict stands in
    for everywhere except the repeated-key access create_playlist() and
    update_playlist() need — those get a MultiParams below."""
    return dict(kwargs)


class MultiParams(dict):
    """Minimal stand-in for Starlette's QueryParams: dict access plus
    getlist(), which is how the Subsonic convention of repeating a key
    (songId=a&songId=b) reaches the playlist handlers."""

    def __init__(self, lists: dict[str, list[str]] | None = None, **single: str):
        super().__init__({k: v for k, v in single.items()})
        self._lists = lists or {}
        for key, values in self._lists.items():
            if values:
                self[key] = values[0]

    def getlist(self, key: str) -> list[str]:
        return self._lists.get(key, [])


# ── Plex ─────────────────────────────────────────────────────────────────────


async def _plex_song_ids(plex: PlexClient, count: int) -> list[str]:
    """A few real track ids to build a playlist from."""
    from media.plex_bridge import _music_section, _px_get

    section = await _music_section(plex)
    data = await _px_get(plex, f"/library/sections/{section}/all", type="10", limit=str(count))
    tracks = data.get("MediaContainer", {}).get("Metadata", [])
    assert len(tracks) >= count, f"library has fewer than {count} tracks"
    return [str(track["ratingKey"]) for track in tracks[:count]]


@pytest.fixture
async def plex_playlist(plex: PlexClient):
    """Creates a throwaway playlist and hands back (id, song_ids). Deleted
    again afterwards whatever the test does, including failing."""
    # Plex needs the *server's* own identifier to address items by URI, and
    # a session normally receives it through /config — resolved here the
    # same way the login flow does.
    from media.plex_bridge import (
        _px_get,
        create_playlist,
        delete_playlist,
        get_playlists,
    )

    identity = await _px_get(plex, "/identity")
    plex.machine_identifier = identity.get("MediaContainer", {}).get("machineIdentifier", "")
    assert plex.machine_identifier, "server did not report a machineIdentifier"

    song_ids = await _plex_song_ids(plex, 3)
    name = f"Beacon live test {uuid.uuid4().hex[:8]}"
    await create_playlist(MultiParams({"songId": song_ids}, name=name), plex)

    playlists = (await get_playlists(_params(), plex))["playlists"]["playlist"]
    created = next((p for p in playlists if p["name"] == name), None)
    assert created is not None, "playlist was not created"
    try:
        yield created["id"], song_ids
    finally:
        await delete_playlist({"id": created["id"]}, plex)


async def test_plex_creates_a_playlist_with_the_songs_it_was_given(plex, plex_playlist):
    from media.plex_bridge import get_playlist

    playlist_id, song_ids = plex_playlist

    entries = (await get_playlist({"id": playlist_id}, plex))["playlist"]["entry"]

    assert [e["id"] for e in entries] == song_ids


async def test_plex_reorders_a_playlist_in_place(plex, plex_playlist):
    """The path added 2026-08-27 and never run against a real server until
    now: Subsonic expresses a reorder as createPlaylist with a playlistId
    and the full song list, which this bridge has to turn into Plex's own
    per-entry move calls."""
    from media.plex_bridge import create_playlist, get_playlist

    playlist_id, song_ids = plex_playlist
    reordered = [song_ids[2], song_ids[0], song_ids[1]]

    await create_playlist(MultiParams({"songId": reordered}, playlistId=playlist_id), plex)

    entries = (await get_playlist({"id": playlist_id}, plex))["playlist"]["entry"]
    assert [e["id"] for e in entries] == reordered


async def test_plex_adds_and_removes_playlist_entries(plex, plex_playlist):
    from media.plex_bridge import get_playlist, update_playlist

    playlist_id, song_ids = plex_playlist
    extra = (await _plex_song_ids(plex, 4))[3]

    await update_playlist(MultiParams({"songIdToAdd": [extra]}, playlistId=playlist_id), plex)
    entries = (await get_playlist({"id": playlist_id}, plex))["playlist"]["entry"]
    assert [e["id"] for e in entries] == [*song_ids, extra]

    # Subsonic removes by position, Plex by per-entry id — the translation
    # in between is what this checks.
    await update_playlist(
        MultiParams({"songIndexToRemove": ["1"]}, playlistId=playlist_id), plex
    )
    entries = (await get_playlist({"id": playlist_id}, plex))["playlist"]["entry"]
    assert [e["id"] for e in entries] == [song_ids[0], song_ids[2], extra]


async def test_plex_renames_a_playlist(plex, plex_playlist):
    from media.plex_bridge import get_playlist, update_playlist

    playlist_id, _ = plex_playlist
    renamed = f"Beacon live test renamed {uuid.uuid4().hex[:6]}"

    await update_playlist(MultiParams(playlistId=playlist_id, name=renamed), plex)

    assert (await get_playlist({"id": playlist_id}, plex))["playlist"]["name"] == renamed


async def test_plex_browsing_returns_usable_shapes(plex):
    """The field names in this bridge were written from Plex's public docs
    rather than from a real library, and its own module docstring says as
    much."""
    from media.plex_bridge import get_album, get_album_list2, get_artists, search3

    artists = (await get_artists(_params(), plex))["artists"]["index"]
    assert any(entry["artist"] for entry in artists), "no artists came back"

    albums = (await get_album_list2(_params(type="alphabeticalByName", size="5"), plex))[
        "albumList2"
    ]["album"]
    assert albums, "no albums came back"
    assert all(album.get("name") and album.get("artist") for album in albums)

    album = (await get_album({"id": albums[0]["id"]}, plex))["album"]
    assert album["song"], "album came back with no tracks"
    first = album["song"][0]
    assert first.get("title") and first.get("duration") is not None

    found = (await search3(_params(query=first["title"][:6], songCount="5"), plex))[
        "searchResult3"
    ]
    assert isinstance(found.get("song", []), list)


# ── Jellyfin ─────────────────────────────────────────────────────────────────


async def _jellyfin_song_ids(jellyfin: JellyfinClient, count: int) -> list[str]:
    from media.jellyfin_bridge import _jf_get

    data = await _jf_get(
        jellyfin,
        f"/Users/{jellyfin.user_id}/Items",
        IncludeItemTypes="Audio",
        Recursive="true",
        Limit=str(count),
    )
    items = data.get("Items", [])
    assert len(items) >= count, f"library has fewer than {count} tracks"
    return [item["Id"] for item in items[:count]]


@pytest.fixture
async def jellyfin_playlist(jellyfin: JellyfinClient):
    from media.jellyfin_bridge import create_playlist, delete_playlist, get_playlists

    song_ids = await _jellyfin_song_ids(jellyfin, 3)
    name = f"Beacon live test {uuid.uuid4().hex[:8]}"
    await create_playlist(MultiParams({"songId": song_ids}, name=name), jellyfin)

    playlists = (await get_playlists(_params(), jellyfin))["playlists"]["playlist"]
    created = next((p for p in playlists if p["name"] == name), None)
    assert created is not None, "playlist was not created"
    try:
        yield created["id"], song_ids
    finally:
        await delete_playlist({"id": created["id"]}, jellyfin)


async def test_jellyfin_creates_a_playlist_with_the_songs_it_was_given(
    jellyfin, jellyfin_playlist
):
    from media.jellyfin_bridge import get_playlist

    playlist_id, song_ids = jellyfin_playlist

    entries = (await get_playlist({"id": playlist_id}, jellyfin))["playlist"]["entry"]

    assert [e["id"] for e in entries] == song_ids


async def test_jellyfin_reorders_a_playlist_in_place(jellyfin, jellyfin_playlist):
    from media.jellyfin_bridge import create_playlist, get_playlist

    playlist_id, song_ids = jellyfin_playlist
    reordered = [song_ids[2], song_ids[0], song_ids[1]]

    await create_playlist(
        MultiParams({"songId": reordered}, playlistId=playlist_id), jellyfin
    )

    entries = (await get_playlist({"id": playlist_id}, jellyfin))["playlist"]["entry"]
    assert [e["id"] for e in entries] == reordered


async def test_jellyfin_adds_and_removes_playlist_entries(jellyfin, jellyfin_playlist):
    from media.jellyfin_bridge import get_playlist, update_playlist

    playlist_id, song_ids = jellyfin_playlist
    extra = (await _jellyfin_song_ids(jellyfin, 4))[3]

    await update_playlist(
        MultiParams({"songIdToAdd": [extra]}, playlistId=playlist_id), jellyfin
    )
    entries = (await get_playlist({"id": playlist_id}, jellyfin))["playlist"]["entry"]
    assert [e["id"] for e in entries] == [*song_ids, extra]

    # Subsonic removes by position; Jellyfin needs each entry's own
    # PlaylistItemId, which is not the song id and can only be learned by
    # listing the playlist first.
    await update_playlist(
        MultiParams({"songIndexToRemove": ["1"]}, playlistId=playlist_id), jellyfin
    )
    entries = (await get_playlist({"id": playlist_id}, jellyfin))["playlist"]["entry"]
    assert [e["id"] for e in entries] == [song_ids[0], song_ids[2], extra]


async def test_jellyfin_favorites_round_trip(jellyfin):
    """getStarred2 makes three separate calls because it was never verified
    whether Filters=IsFavorite combines with several IncludeItemTypes in one
    request — this checks the answer actually comes back in the shape the
    frontend reads, and that starring is visible in it.

    Restores the track's original state afterwards, including on failure."""
    from media.jellyfin_bridge import get_starred2, star, unstar

    song_id = (await _jellyfin_song_ids(jellyfin, 1))[0]
    before = (await get_starred2(_params(), jellyfin))["starred2"]
    assert {"song", "album", "artist"} <= set(before), "unexpected starred2 shape"
    already_starred = any(entry["id"] == song_id for entry in before["song"])

    try:
        await star({"id": song_id}, jellyfin)
        starred = (await get_starred2(_params(), jellyfin))["starred2"]["song"]
        assert any(entry["id"] == song_id for entry in starred), "starring did not stick"

        await unstar({"id": song_id}, jellyfin)
        after = (await get_starred2(_params(), jellyfin))["starred2"]["song"]
        assert not any(entry["id"] == song_id for entry in after), "unstarring did not stick"
    finally:
        if already_starred:
            await star({"id": song_id}, jellyfin)


async def test_jellyfin_browsing_returns_usable_shapes(jellyfin):
    from media.jellyfin_bridge import get_album, get_album_list2, get_artists, search3

    artists = (await get_artists(_params(), jellyfin))["artists"]["index"]
    assert any(entry["artist"] for entry in artists), "no artists came back"

    albums = (await get_album_list2(_params(type="alphabeticalByName", size="5"), jellyfin))[
        "albumList2"
    ]["album"]
    assert albums, "no albums came back"
    assert all(album.get("name") and album.get("artist") for album in albums)

    album = (await get_album({"id": albums[0]["id"]}, jellyfin))["album"]
    assert album["song"], "album came back with no tracks"
    first = album["song"][0]
    assert first.get("title") and first.get("duration") is not None

    found = (await search3(_params(query=first["title"][:6], songCount="5"), jellyfin))[
        "searchResult3"
    ]
    assert isinstance(found.get("song", []), list)


# ── Lyrics from the file itself ──────────────────────────────────────────────
# Both handlers were written from documentation and were wrong against real
# servers in three separate ways (see this module's own docstring). These
# need a track that actually has lyrics, which no library is guaranteed to
# have — hence an explicit id rather than a search.


async def test_jellyfin_reads_the_files_own_lyrics(jellyfin):
    item_id = os.environ.get("JELLYFIN_TEST_LYRICS_ITEM_ID", "")
    if not item_id:
        pytest.skip("JELLYFIN_TEST_LYRICS_ITEM_ID not set")
    from media.jellyfin_bridge import get_lyrics_by_song_id

    entry = (await get_lyrics_by_song_id({"id": item_id}, jellyfin))["lyricsList"][
        "structuredLyrics"
    ][0]

    assert entry["line"], "no lyric lines came back"
    # Timings in milliseconds, ascending, and no line left blank — the NUL
    # byte Jellyfin appends when reading from an ID3 tag would show up here.
    starts = [line["start"] for line in entry["line"] if "start" in line]
    assert starts == sorted(starts)
    assert all(line["value"].strip() for line in entry["line"])
    if starts:
        assert entry["synced"] is True, "timed lines must be reported as synced"


async def test_plex_reads_the_files_own_lyrics(plex):
    item_id = os.environ.get("PLEX_TEST_LYRICS_ITEM_ID", "")
    if not item_id:
        pytest.skip("PLEX_TEST_LYRICS_ITEM_ID not set")
    from media.plex_bridge import get_lyrics_by_song_id

    entry = (await get_lyrics_by_song_id({"id": item_id}, plex))["lyricsList"][
        "structuredLyrics"
    ][0]

    assert entry["line"], "no lyric lines came back"
    starts = [line["start"] for line in entry["line"] if "start" in line]
    assert starts == sorted(starts)
    assert all(line["value"].strip() for line in entry["line"])


# ── Library scan + who is asking ─────────────────────────────────────────────
# Reading is safe; actually starting a scan is not something to do to
# somebody's server by accident, so that one test needs its own opt-in.

_SCAN_OPT_IN = os.environ.get("LIVE_ALLOW_LIBRARY_SCAN") == "1"
_needs_scan_opt_in = pytest.mark.skipif(
    not _SCAN_OPT_IN,
    reason="starts a real library scan — set LIVE_ALLOW_LIBRARY_SCAN=1 to allow",
)


async def test_jellyfin_reports_the_accounts_admin_rights(jellyfin):
    from media.jellyfin_bridge import get_user

    user = (await get_user({"username": "whoever"}, jellyfin))["user"]

    assert isinstance(user["adminRole"], bool)
    assert user["username"], "no username came back"


async def test_plex_reports_the_accounts_admin_rights(plex):
    from media.plex_bridge import get_user

    user = (await get_user({"username": "whoever"}, plex))["user"]

    assert isinstance(user["adminRole"], bool)


async def test_jellyfin_scan_status_is_readable(jellyfin):
    """Shape only — whether a scan happens to be running is up to the
    server. The percentage must never accompany a finished scan, since the
    UI would then show progress for something that isn't happening."""
    from media.jellyfin_bridge import get_scan_status

    status = (await get_scan_status({}, jellyfin))["scanStatus"]

    assert isinstance(status["scanning"], bool)
    assert "count" not in status, "Jellyfin has no item count to report"
    if not status["scanning"]:
        assert "progress" not in status


async def test_plex_scan_status_is_readable(plex):
    from media.plex_bridge import get_scan_status

    status = (await get_scan_status({}, plex))["scanStatus"]

    assert isinstance(status["scanning"], bool)
    assert "count" not in status
    if "progress" in status:
        assert 0 <= status["progress"] <= 100


@_needs_scan_opt_in
async def test_jellyfin_starts_a_real_library_scan(jellyfin):
    from media.jellyfin_bridge import get_scan_status, start_scan

    assert (await start_scan({}, jellyfin))["scanStatus"]["scanning"] is True
    # The task is started asynchronously, so this only checks that asking
    # right afterwards still answers cleanly — not that it caught it
    # running, which is a race on a small library.
    assert isinstance((await get_scan_status({}, jellyfin))["scanStatus"]["scanning"], bool)


@_needs_scan_opt_in
async def test_plex_starts_a_real_library_scan(plex):
    from media.plex_bridge import get_scan_status, start_scan

    assert (await start_scan({}, plex))["scanStatus"]["scanning"] is True
    assert isinstance((await get_scan_status({}, plex))["scanStatus"]["scanning"], bool)


# ── Navidrome / Subsonic ─────────────────────────────────────────────────────
# No bridge here — those requests are passed straight through
# (routes/proxy.py), so what is under test is the set of assumptions Beacon
# makes about the server itself. Two of them were only ever read out of
# Navidrome's source: that createPlaylist with a playlistId replaces the
# track list in the order given (which is how reordering a playlist works,
# see client.ts's setPlaylistSongs) and that getUser.view reports
# adminRole (which decides whether Settings offers a library scan at all).


class SubsonicLive:
    """The Subsonic API as services/subsonic/client.ts speaks it: token
    auth built per request, list arguments as repeated keys."""

    def __init__(self, base_url: str, username: str, password: str):
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password

    async def call(self, endpoint: str, **params) -> dict:
        salt = uuid.uuid4().hex[:12]
        token = hashlib.md5(f"{self.password}{salt}".encode()).hexdigest()
        query: list[tuple[str, str]] = [
            ("u", self.username),
            ("t", token),
            ("s", salt),
            ("v", "1.16.1"),
            ("c", "beacon-live-tests"),
            ("f", "json"),
        ]
        for key, value in params.items():
            if isinstance(value, list):
                query.extend((key, item) for item in value)
            else:
                query.append((key, value))
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(f"{self.base_url}/rest/{endpoint}", params=query)
        response.raise_for_status()
        return response.json()["subsonic-response"]


@pytest.fixture
def subsonic() -> SubsonicLive:
    config = _env("SUBSONIC_TEST_URL", "SUBSONIC_TEST_USER", "SUBSONIC_TEST_PASSWORD")
    if not config:
        pytest.skip("SUBSONIC_TEST_URL/_USER/_PASSWORD not set")
    url, username, password = config
    return SubsonicLive(url, username, password)


async def test_subsonic_reports_the_accounts_admin_rights(subsonic):
    user = (await subsonic.call("getUser.view", username=subsonic.username))["user"]

    assert user["username"].lower() == subsonic.username.lower()
    assert isinstance(user["adminRole"], bool)


async def test_subsonic_refuses_a_scan_from_a_non_admin(subsonic):
    """Why the scan button is gated at all. Skipped when the configured
    account happens to be an administrator, for whom the call succeeds and
    would start a real scan."""
    user = (await subsonic.call("getUser.view", username=subsonic.username))["user"]
    if user["adminRole"]:
        pytest.skip("configured account is an admin — this checks the refusal")

    result = await subsonic.call("startScan.view")

    assert result["status"] == "failed"
    # 50 is Subsonic's "not authorized for the given operation".
    assert result["error"]["code"] == 50


async def test_subsonic_replaces_a_playlists_songs_in_the_order_given(subsonic):
    """How reordering a playlist reaches the server: createPlaylist with a
    playlistId. Navidrome does this in one transaction, so a failure cannot
    leave the playlist half-emptied — verified here end to end, including
    that the name and length survive."""
    songs = [s["id"] for s in (await subsonic.call("getRandomSongs.view", size="3"))["randomSongs"]["song"]]
    name = f"Beacon live test {uuid.uuid4().hex[:8]}"
    await subsonic.call("createPlaylist.view", name=name, songId=songs)
    playlists = (await subsonic.call("getPlaylists.view"))["playlists"]["playlist"]
    created = next(p for p in playlists if p["name"] == name)

    try:
        entries = (await subsonic.call("getPlaylist.view", id=created["id"]))["playlist"]["entry"]
        assert [e["id"] for e in entries] == songs

        reordered = [songs[2], songs[0], songs[1]]
        await subsonic.call("createPlaylist.view", playlistId=created["id"], songId=reordered)

        playlist = (await subsonic.call("getPlaylist.view", id=created["id"]))["playlist"]
        assert [e["id"] for e in playlist["entry"]] == reordered
        # Reordering must not rename the playlist or lose tracks.
        assert playlist["name"] == name
        assert len(playlist["entry"]) == len(songs)
    finally:
        await subsonic.call("deletePlaylist.view", id=created["id"])


async def test_subsonic_serves_the_files_own_lyrics(subsonic):
    song_id = os.environ.get("SUBSONIC_TEST_LYRICS_SONG_ID", "")
    if not song_id:
        pytest.skip("SUBSONIC_TEST_LYRICS_SONG_ID not set")

    result = await subsonic.call("getLyricsBySongId.view", id=song_id)
    entry = result["lyricsList"]["structuredLyrics"][0]

    assert entry["line"], "no lyric lines came back"
    starts = [line["start"] for line in entry["line"] if "start" in line]
    assert starts == sorted(starts)
