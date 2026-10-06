"""core/party.py - Party mode: guests on a link or QR code see the queue,
search the library and wish for tracks, without any control over playback.

Built to be reachable without anything in front of it (routes/party.py is
the only thing under /party/, so a reverse proxy can let exactly that past
its own login). Hence the shape of the credentials:
- `invite_token` travels in the link's #fragment, which browsers never send,
  and is only ever accepted by POST /party/api/join.
- Join hands out a session id as an HttpOnly cookie; every other guest call
  is authenticated by that alone, so no secret ever sits in a URL or a log.
Ending the party or renewing the link drops every session at once.

Like core/remote.py, a single global state: the renderer that owns the
queue is the one Beacon window, whatever account is logged in.
"""

import asyncio
import hashlib
import logging
import math
import re
import secrets
import time
import unicodedata
from collections import deque
from dataclasses import dataclass, field
from urllib.parse import quote

from .remote import KEEPALIVE_TIMEOUT, REAP_INTERVAL, remote
from .state import EventBus

logger = logging.getLogger("connect.party")

DEFAULT_DURATION_HOURS = 12
MAX_DURATION_HOURS = 48
MAX_GUESTS = 100
MAX_STREAMS_PER_IP = 4
MAX_STREAMS_TOTAL = 200
NAME_MAX_LENGTH = 24
# What a guest may see of the queue. A party queue longer than this is the
# host's business, and a cap keeps every snapshot small for a phone on
# mobile data.
UPCOMING_LIMIT = 100
# Cover ids handed to guests, remembered so /party/api/cover only answers for
# artwork a guest has actually been shown.
COVER_MEMORY = 5000
# Songs the host's queue has shown, by id: while the host casts, the queue
# connect follows is song ids only, and this is where their titles come from
# (see _cast_playback). A few parties' worth of queue.
SONG_MEMORY = 5000
# The renderer pushes a snapshot several times a second while a song plays,
# mostly because the position moved. Guests work the position out
# themselves from the last one they got, so a push only goes out to them
# when something else changed or the position stopped matching that guess
# (a seek) by more than this.
POSITION_DRIFT_SECONDS = 1.5
# How often the cast follower looks again for the host's session when it has
# none, or has heard nothing from it (see _follow_cast).
CAST_RECHECK_SECONDS = 5.0
# What the host may hand over as lyrics: a long song's worth, not a book.
LYRICS_MAX_LINES = 2000
# Fanart.tv's own per-artist count is far below this; it only bounds what
# the host may hand over.
MAX_BACKDROPS = 30
LYRICS_MAX_LINE_LENGTH = 500

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def clean_name(raw: str) -> str | None:
    """A guest's nickname as shown to the host and the other guests, or
    None if nothing usable is left. Normalised so two names that look the
    same are the same, and stripped of control and formatting characters
    (bidi overrides would let one name rewrite the row it sits in)."""
    name = unicodedata.normalize("NFKC", raw or "")
    name = _CONTROL_CHARS.sub("", name)
    name = "".join(ch for ch in name if unicodedata.category(ch) != "Cf")
    name = " ".join(name.split())[:NAME_MAX_LENGTH].strip()
    return name or None


@dataclass
class Settings:
    max_pending_per_guest: int = 3
    # Share of the guests currently connected that have to vote to skip,
    # rounded up and at least one; 0 switches skipping off.
    skip_ratio: float = 0.5


@dataclass
class Guest:
    guest_id: str
    name: str
    ip: str
    joined_at: float = field(default_factory=time.time)


class RateLimiter:
    """Sliding-window counters keyed by whatever the caller chooses
    ("wish:<guest>", "join-fail:<ip>", ...)."""

    def __init__(self):
        self._hits: dict[str, deque[float]] = {}

    def _window(self, key: str, window: float) -> deque[float]:
        hits = self._hits.setdefault(key, deque())
        cutoff = time.monotonic() - window
        while hits and hits[0] <= cutoff:
            hits.popleft()
        return hits

    def exceeded(self, key: str, limit: int, window: float) -> bool:
        return len(self._window(key, window)) >= limit

    def hit(self, key: str, limit: int, window: float) -> bool:
        """Counts one hit; False if the key was already at its limit."""
        hits = self._window(key, window)
        if len(hits) >= limit:
            return False
        hits.append(time.monotonic())
        return True

    def clear(self) -> None:
        self._hits.clear()

    def prune(self, window: float) -> None:
        for key in list(self._hits):
            if not self._window(key, window):
                del self._hits[key]


class PartyState:
    def __init__(self):
        self.enabled = False
        self.invite_token: str | None = None
        self.expires_at = 0.0
        self.settings = Settings()
        self.sessions: dict[str, Guest] = {}
        self.event_bus = EventBus()
        self.streams: dict[str, int] = {}  # guest_id -> open SSE streams
        self.streams_per_ip: dict[str, int] = {}
        self.limiter = RateLimiter()
        self.snapshot: dict = {}
        self.host_session_id: str | None = None
        self.current_song_id: str | None = None
        self.skip_votes: set[str] = set()
        self.covers: dict[str, None] = {}  # insertion-ordered set
        # The Fanart.tv background the host shows for the current artist.
        self.backdrop_url: str | None = None
        self.backdrop_urls: list[str] = []
        # What the playing station's logo is resolved from (homepage, hint),
        # never handed to a guest - see /party/api/radio-logo.
        self.radio_logo: tuple[str, str] | None = None
        # The current song's lyrics as the host has them (match, offset).
        self.lyrics: dict | None = None
        # Guests watching the visualizer, and the task feeding them.
        self.visualizer_queues: list[asyncio.Queue] = []
        self._visualizer_task: asyncio.Task | None = None
        # The host's last snapshot as it came, and the songs it named.
        self.tab_snapshot: dict = {}
        self.songs: dict[str, dict] = {}  # insertion-ordered, see SONG_MEMORY
        # Follows the host's cast session (see _follow_cast).
        self._cast_task: asyncio.Task | None = None
        # Which of the host's windows answers guests: a random id each tab
        # makes up for itself. Another tab taking the party over replaces
        # it, and the one that had it sees so in /party-host/status.
        self.host_tab: str | None = None
        # Wishes while the host casts, kept here rather than by the host's
        # window (core/party_queue.py): whether connect holds them right
        # now, and the cast queue their positions describe.
        self.cast_requests: list = []
        self.cast_owned = False
        self.cast_queue_seen: list[str] | None = None
        # Queue songs being looked up on the media server, and ones it could
        # not find - not asked about again on every status tick.
        self._fetching: set[str] = set()
        self._unfetchable: set[str] = set()
        # Fallback lyrics and background for the cast's current song, looked
        # up by connect when the host's window - asleep, or not yet showing
        # it - has not named them (docs/plans/party-mode-server-side.md,
        # step 6). A song/artist asked for once is not asked for again.
        self._fallback_lyrics: dict | None = None
        self._lyrics_fetching: set[str] = set()
        self._lyrics_looked_up: set[str] = set()
        self._backdrop_artist: str | None = None
        self._backdrop_url: str | None = None
        self._backdrop_urls: list[str] = []
        self._backdrop_fetching: set[str] = set()
        self._backdrop_looked_up: set[str] = set()

    # ── Lifecycle ────────────────────────────────────────────────────────

    def enable(self, duration_hours: float = DEFAULT_DURATION_HOURS) -> str:
        hours = min(max(duration_hours, 0.5), MAX_DURATION_HOURS)
        self.invite_token = secrets.token_urlsafe(24)
        self.enabled = True
        self.expires_at = time.time() + hours * 3600
        self.sessions.clear()
        self.skip_votes.clear()
        self.limiter.clear()
        # The relay's keepalive is what keeps the party alive (see
        # is_stale), and a fresh party should not be reaped before the
        # renderer's first ping lands.
        remote.touch_keepalive()
        return self.invite_token

    def rotate(self) -> str:
        """New link; everyone who joined with the old one is out."""
        self.invite_token = secrets.token_urlsafe(24)
        self.sessions.clear()
        self.skip_votes.clear()
        return self.invite_token

    def disable(self) -> None:
        self.enabled = False
        self.invite_token = None
        self.expires_at = 0.0
        self.sessions.clear()
        self.skip_votes.clear()
        self.snapshot = {}
        self.covers.clear()
        self.limiter.clear()
        self.backdrop_url = None
        self.backdrop_urls = []
        self.radio_logo = None
        self.lyrics = None
        self.tab_snapshot = {}
        self.songs.clear()
        self._fetching.clear()
        self._unfetchable.clear()
        self.cast_requests = []
        self.cast_owned = False
        self.cast_queue_seen = None
        self._fallback_lyrics = None
        self._lyrics_fetching.clear()
        self._lyrics_looked_up.clear()
        self._backdrop_artist = None
        self._backdrop_url = None
        self._backdrop_urls = []
        self._backdrop_fetching.clear()
        self._backdrop_looked_up.clear()
        self.host_tab = None
        if self._cast_task is not None:
            self._cast_task.cancel()
            self._cast_task = None

    def is_active(self) -> bool:
        if self.enabled and time.time() >= self.expires_at:
            self.disable()
        return self.enabled

    def is_stale(self) -> bool:
        """The host's window has gone quiet and nothing else carries the
        party. While the host casts, connect plays the queue on its own, so
        a window that sleeps - a locked phone - does not end it."""
        return (
            self.enabled
            and time.time() - remote.last_keepalive > KEEPALIVE_TIMEOUT
            and self.host_cast() is None
        )

    # ── Guests ───────────────────────────────────────────────────────────

    def token_matches(self, provided: str) -> bool:
        if not self.is_active() or not self.invite_token or not provided:
            return False
        return secrets.compare_digest(provided.encode(), self.invite_token.encode())

    def join(self, name: str, ip: str) -> tuple[str, Guest] | None:
        if len(self.sessions) >= MAX_GUESTS:
            return None
        sid = secrets.token_urlsafe(32)
        guest = Guest(guest_id=secrets.token_urlsafe(9), name=name, ip=ip)
        self.sessions[sid] = guest
        return sid, guest

    def guest(self, sid: str | None) -> Guest | None:
        if not sid or not self.is_active():
            return None
        return self.sessions.get(sid)

    def guest_alive(self, guest: Guest) -> bool:
        """Still at this party: not removed, the link not renewed, the
        party not over."""
        return self.is_active() and any(g is guest for g in self.sessions.values())

    def kick(self, guest_id: str) -> bool:
        for sid, guest in list(self.sessions.items()):
            if guest.guest_id == guest_id:
                del self.sessions[sid]
                self.skip_votes.discard(guest_id)
                return True
        return False

    def guest_list(self) -> list[dict]:
        return [
            {
                "guest_id": g.guest_id,
                "name": g.name,
                "joined_at": g.joined_at,
                "connected": self.streams.get(g.guest_id, 0) > 0,
            }
            for g in self.sessions.values()
        ]

    @property
    def connected_guests(self) -> int:
        live = {g.guest_id for g in self.sessions.values()}
        return sum(1 for gid, n in self.streams.items() if n > 0 and gid in live)

    # ── Snapshot ─────────────────────────────────────────────────────────

    def remember_cover(self, cover_id: str | None) -> str | None:
        """The guest-facing URL for a cover, recorded so the cover endpoint
        will answer for it."""
        if not cover_id:
            return None
        self.covers.pop(cover_id, None)
        self.covers[cover_id] = None
        while len(self.covers) > COVER_MEMORY:
            self.covers.pop(next(iter(self.covers)))
        return f"/party/api/cover?id={quote(cover_id, safe='')}"

    def guest_song(self, song: dict | None) -> dict | None:
        if not song:
            return None
        return {
            "id": song.get("id"),
            "title": song.get("title"),
            "artist": song.get("artist"),
            "album": song.get("album"),
            "duration": song.get("duration"),
            "cover": self.remember_cover(song.get("cover_art_id")),
        }

    def guest_album(self, album: dict) -> dict:
        return {
            "id": album.get("id"),
            "name": album.get("name"),
            "artist": album.get("artist"),
            "year": album.get("year"),
            "cover": self.remember_cover(album.get("cover_art_id")),
        }

    def guest_radio(self, radio: dict) -> dict:
        """The station as a guest sees it: name, ICY title and a logo URL
        that names no third-party address - the homepage and hint stay here
        (radio_logo) and /party/api/radio-logo resolves them."""
        homepage, hint = radio.get("home_page_url"), radio.get("favicon_hint")
        source = (
            homepage if isinstance(homepage, str) else "",
            hint if isinstance(hint, str) else "",
        )
        self.radio_logo = source if any(source) else None
        now_playing = radio.get("now_playing")
        logo = None
        if self.radio_logo:
            # A new station is a new URL, so a guest's browser never keeps
            # showing the previous station's cached logo.
            key = hashlib.sha256("\0".join(self.radio_logo).encode()).hexdigest()[:16]
            logo = f"/party/api/radio-logo?k={key}"
        return {
            "name": radio.get("name"),
            "now_playing": now_playing if isinstance(now_playing, str) and now_playing else None,
            "logo": logo,
        }

    def remember_song(self, song: dict | None) -> None:
        song_id = song.get("id") if isinstance(song, dict) else None
        if not song_id:
            return
        self.songs.pop(song_id, None)
        self.songs[song_id] = {
            key: song.get(key)
            for key in ("id", "title", "artist", "album", "duration", "cover_art_id")
        }
        while len(self.songs) > SONG_MEMORY:
            self.songs.pop(next(iter(self.songs)))

    def host_cast(self):
        """The host's cast session while it plays a queue to a device, else
        None. A station is left to the host's window (nothing to wish for
        there, and connect does not know its name)."""
        from .session import registry

        session = registry.get(self.host_session_id) if self.host_session_id else None
        if session is None:
            return None
        st = session.state
        if not st.active_delivery or st.radio_info or st.current_track is None:
            return None
        return session

    def _tab_playback(self, raw: dict) -> dict:
        return {
            "current": raw.get("current_song"),
            "queue": raw.get("queue") or [],
            "index": raw.get("queue_index", -1),
            "playing": bool(raw.get("playing")),
            "position": float(raw.get("position") or 0),
            "duration": float(raw.get("duration") or 0),
            "casting": bool(raw.get("casting")),
            "radio": raw.get("radio") if isinstance(raw.get("radio"), dict) else None,
        }

    def _cast_playback(self, session) -> dict:
        """What is playing according to the cast session itself, which keeps
        going while the host's window sleeps. Its queue is song ids; the
        titles come from what the host's window has shown (self.songs), and
        a song it never saw - an autoplay top-up made while it slept - is
        looked up on the media server (see _look_up) and left out until
        then."""
        from .session import compute_position

        st = session.state
        track = st.current_track
        current = {
            "id": track.id,
            "title": track.title,
            "artist": track.artist,
            "album": track.album,
            "duration": track.duration,
            "cover_art_id": track.cover_art_id,
        }
        self.remember_song(current)
        return {
            "current": current,
            "queue": [self.songs.get(song_id) for song_id in st.queue],
            "index": st.queue_index,
            "playing": st.is_streaming and not st.clock.is_paused,
            "position": compute_position(session),
            "duration": float(track.duration or 0),
            "casting": True,
            "radio": None,
        }

    def _look_up(self, session, song_ids: list[str]) -> None:
        """Starts looking up the queue songs guests would see that nothing
        has named yet. Only from inside the event loop - rebuild() is also
        called where there is none, and then nothing is looked up."""
        missing = [
            song_id
            for song_id in dict.fromkeys(song_ids)
            if song_id not in self.songs
            and song_id not in self._fetching
            and song_id not in self._unfetchable
        ]
        if not missing:
            return
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        self._fetching.update(missing)
        asyncio.create_task(self._fetch_songs(session, missing))

    async def _fetch_songs(self, session, song_ids: list[str]) -> None:
        from .party_library import get_song

        try:
            for song_id in song_ids:
                try:
                    self.remember_song(await get_song(session.media, song_id))
                except Exception as e:
                    logger.info(f"[party] Could not look up queue song {song_id}: {e}")
                    self._unfetchable.add(song_id)
        finally:
            self._fetching.difference_update(song_ids)
        if not self.enabled:
            return
        previous = self.snapshot
        self.rebuild()
        if self._worth_telling(previous, self.snapshot):
            await self.broadcast()

    def _maybe_fetch_lyrics(self, song: dict) -> None:
        """Starts connect's own lyrics lookup for the cast's current song,
        when the host's window has not named its lyrics. Only from inside
        the event loop - rebuild() is also called where there is none."""
        song_id = song.get("id")
        if not song_id:
            return
        if self.lyrics and self.lyrics["song_id"] == song_id:
            return
        if song_id in self._lyrics_fetching or song_id in self._lyrics_looked_up:
            return
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        self._lyrics_fetching.add(song_id)
        asyncio.create_task(self._fetch_fallback_lyrics(song))

    async def _fetch_fallback_lyrics(self, song: dict) -> None:
        from routes.lyrics import auto_for_party

        song_id = song["id"]
        try:
            result = await auto_for_party(song)
        except Exception as e:
            logger.info(f"[party] Could not look up lyrics for {song_id}: {e}")
            result = None
        finally:
            self._lyrics_fetching.discard(song_id)
        self._lyrics_looked_up.add(song_id)
        if not self.enabled:
            return
        if result is not None:
            self._fallback_lyrics = {
                "song_id": song_id,
                "synced": result["synced"],
                "offset": 0.0,
                "lines": [
                    {
                        "time": float(line.get("time") or 0),
                        "text": str(line.get("text") or "")[:LYRICS_MAX_LINE_LENGTH],
                    }
                    for line in result["lines"][:LYRICS_MAX_LINES]
                ],
            }
        previous = self.snapshot
        self.rebuild()
        if self._worth_telling(previous, self.snapshot):
            await self.broadcast()

    def _maybe_fetch_backdrop(self, artist: str | None) -> None:
        """Starts connect's own Fanart.tv lookup for the cast's current
        artist, when the host's window has not named a background."""
        if not artist:
            return
        if artist in self._backdrop_fetching or artist in self._backdrop_looked_up:
            return
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        self._backdrop_fetching.add(artist)
        asyncio.create_task(self._fetch_fallback_backdrop(artist))

    async def _fetch_fallback_backdrop(self, artist: str) -> None:
        from . import fanart

        try:
            art = await fanart.get_artist_art(artist)
        except Exception as e:
            logger.info(f"[party] Could not look up the background for {artist!r}: {e}")
            art = None
        finally:
            self._backdrop_fetching.discard(artist)
        self._backdrop_looked_up.add(artist)
        if not self.enabled:
            return
        shown = (art or {}).get("background")
        backgrounds = [
            url for url in ((art or {}).get("backgrounds") or []) if isinstance(url, str)
        ][:MAX_BACKDROPS]
        self._backdrop_artist = artist
        self._backdrop_url = shown if isinstance(shown, str) else None
        self._backdrop_urls = backgrounds
        previous = self.snapshot
        self.rebuild()
        if self._worth_telling(previous, self.snapshot):
            await self.broadcast()

    def _fallback_lyrics_key(self) -> str | None:
        lyrics = self._fallback_lyrics
        if lyrics and lyrics["song_id"] == self.current_song_id:
            return f"{self.current_song_id}:connect"
        return None

    def _requests(self, session, raw: dict) -> dict:
        """Who wished for what, by queue position. While the host casts,
        connect holds the wishes (core/party_queue.py) - the ones the
        window took before the cast began are taken over when it does.
        Otherwise they are the window's."""
        from . import party_queue

        if session is None:
            if self.cast_owned:
                # The cast ended: the window takes them back from the last
                # status that carried them (stores/party.ts).
                self.cast_owned = False
                self.cast_requests = []
                self.cast_queue_seen = None
                # Its fallback lyrics and background are the last thing
                # connect looked up, and the window is awake again to push
                # its own.
                self._fallback_lyrics = None
                self._lyrics_looked_up.clear()
                self._backdrop_artist = None
                self._backdrop_url = None
                self._backdrop_urls = []
                self._backdrop_looked_up.clear()
            return raw.get("party_requests") or {}
        self.own_cast_requests(session)
        party_queue.sync_requests(self, session.state)
        return party_queue.requests_by_position(self)

    def own_cast_requests(self, session) -> None:
        """connect takes the wishes over from the host's window as the cast
        begins - before the first one it takes itself, which the window's
        snapshot does not know about yet."""
        from . import party_queue

        if self.cast_owned:
            return
        raw = self.tab_snapshot
        tab_queue = [(song or {}).get("id") for song in raw.get("queue") or []]
        if tab_queue == list(session.state.queue):
            party_queue.adopt_from_window(self, raw)
        else:
            self.cast_requests = []
        self.cast_queue_seen = list(session.state.queue)
        self.cast_owned = True

    def update_snapshot(self, raw: dict) -> None:
        """The host's window pushed a snapshot (see receive_snapshot)."""
        self.host_session_id = raw.get("session_id") or self.host_session_id
        self.tab_snapshot = raw
        self.remember_song(raw.get("current_song"))
        for song in raw.get("queue") or []:
            self.remember_song(song)
        self.rebuild()

    def rebuild(self) -> None:
        """Reduces what is playing to what a guest may see. Nothing about
        devices, volume, sessions or other guests' ids survives; requests
        keep only the wisher's name, plus an owner id that personalise()
        strips again before anything is sent.

        While the host casts, what plays comes from the cast session, so
        guests keep up while the host's window sleeps. What only that window
        knows - who wished for what, the artist background, the lyrics key -
        is taken from its last snapshot where that still describes the same
        queue and song."""
        raw = self.tab_snapshot
        session = self.host_cast()
        playback = self._cast_playback(session) if session else self._tab_playback(raw)
        tab = self._tab_playback(raw)

        current = playback["current"]
        current_id = current.get("id") if current else None
        if current_id != self.current_song_id:
            self.current_song_id = current_id
            self.skip_votes.clear()
        same_song = bool(current_id) and current_id == ((tab["current"] or {}).get("id"))

        queue = playback["queue"]
        index = playback["index"]
        requests = self._requests(session, raw)
        upcoming = []
        start = index + 1 if isinstance(index, int) and index >= 0 else 0
        for position in range(start, min(start + UPCOMING_LIMIT, len(queue))):
            entry = self.guest_song(queue[position])
            if entry is None:
                continue
            request = requests.get(str(position))
            if request:
                entry["request"] = {
                    "id": request.get("id"),
                    "name": request.get("guest_name"),
                    "_guest_id": request.get("guest_id"),
                }
            upcoming.append(entry)

        radio = playback["radio"]
        current_song = self.guest_song(current) if not radio else None
        current_request = requests.get(str(index)) if current_song else None
        if current_request:
            current_song["wished_by"] = current_request.get("guest_name")
        extras = current_song is not None and same_song
        if session is not None:
            self._look_up(session, session.state.queue[start : start + UPCOMING_LIMIT])
            # Lyrics and background the host's window has not named are
            # looked up by connect itself, so guests keep them while it
            # sleeps (see _fetch_fallback_lyrics/_fetch_fallback_backdrop).
            if current_song is not None:
                self._maybe_fetch_lyrics(current_song)
                self._maybe_fetch_backdrop(current_song.get("artist"))
        self._set_backdrop(raw, session, current_song, extras)
        if radio is None:
            self.radio_logo = None
        self.snapshot = {
            "playing": playback["playing"],
            # Seconds, as of position_at (this server's clock, which the
            # page lines its own clock up with).
            "position": playback["position"],
            "duration": playback["duration"],
            "position_at": time.time(),
            # Only whether - which speakers is none of a guest's business.
            "casting": playback["casting"],
            "backdrop": self.backdrop_url is not None,
            # Which of them the host shows, and how many there are to step
            # through (GET /party/api/backdrop?index=).
            "backdrop_index": (
                self.backdrop_urls.index(self.backdrop_url) if self.backdrop_url else 0
            ),
            "backdrop_count": len(self.backdrop_urls),
            "lyrics_key": self._lyrics_key(raw, extras),
            "current_song": current_song,
            "radio": self.guest_radio(radio) if radio else None,
            "upcoming": upcoming,
        }

    def _set_backdrop(self, raw: dict, session, current_song, extras: bool) -> None:
        """The Fanart.tv background(s) guests see: the host's own pick while
        its window knows the song, else connect's fallback lookup for the
        cast's current artist (see _fetch_fallback_backdrop)."""
        backdrop = raw.get("party_backdrop")
        if isinstance(backdrop, str) and extras:
            self.backdrop_url = backdrop
            backdrops = raw.get("party_backdrops")
            self.backdrop_urls = [
                url
                for url in (backdrops if isinstance(backdrops, list) else [])
                if isinstance(url, str)
            ][:MAX_BACKDROPS]
        elif (
            session is not None
            and current_song is not None
            and self._backdrop_artist == current_song.get("artist")
        ):
            self.backdrop_url = self._backdrop_url
            self.backdrop_urls = self._backdrop_urls[:]
        else:
            self.backdrop_url = None
            self.backdrop_urls = []
        if self.backdrop_url and self.backdrop_url not in self.backdrop_urls:
            self.backdrop_urls.insert(0, self.backdrop_url)

    def _lyrics_key(self, raw: dict, extras: bool) -> str | None:
        """The lyrics key guests fetch under: the host's own while its
        window knows the song, else connect's fallback match (see
        _fallback_lyrics_key)."""
        if extras:
            key = raw.get("party_lyrics_key")
            if key:
                return key
        return self._fallback_lyrics_key()

    def skip_needed(self) -> int:
        if self.settings.skip_ratio <= 0:
            return 0
        return max(1, math.ceil(self.settings.skip_ratio * self.connected_guests))

    def can_skip(self) -> bool:
        # A station has no "next" a vote could move on to.
        return (
            self.skip_needed() > 0
            and self.current_song_id is not None
            and not self.snapshot.get("radio")
        )

    def personalise(self, guest: Guest) -> dict:
        """The snapshot as one guest sees it: which requests are their own
        and how many more they may make - without telling anyone whose the
        others are beyond a name."""
        upcoming = []
        mine_pending = 0
        for entry in self.snapshot.get("upcoming", []):
            entry = dict(entry)
            request = entry.get("request")
            if request:
                mine = request.get("_guest_id") == guest.guest_id
                mine_pending += mine
                entry["request"] = {
                    "name": request.get("name"),
                    "mine": mine,
                    **({"id": request.get("id")} if mine else {}),
                }
            upcoming.append(entry)
        return {
            **self.snapshot,
            "upcoming": upcoming,
            "me": {"name": guest.name},
            "limits": {
                "max_pending": self.settings.max_pending_per_guest,
                "pending": mine_pending,
            },
            "skip": {
                "enabled": self.can_skip(),
                "votes": len(self.skip_votes),
                "needed": self.skip_needed(),
                "mine": guest.guest_id in self.skip_votes,
            },
        }

    async def receive_snapshot(self, raw: dict) -> None:
        """Every snapshot the renderer pushes to /remote/state comes
        through here as well - but only the host window's count. Another
        window on the same account pushes its own, and guests would flip
        between the two (its song, its lyrics) with every push."""
        if not self.enabled:
            return
        if self.host_tab and raw.get("party_tab") != self.host_tab:
            return
        previous = self.snapshot
        self.update_snapshot(raw)
        if self._cast_task is None or self._cast_task.done():
            self._cast_task = asyncio.create_task(self._follow_cast())
        if self._worth_telling(previous, self.snapshot):
            await self.broadcast()

    async def _follow_cast(self) -> None:
        """For as long as the party runs: listens to the host's cast session
        and tells guests about what it does on its own - the next track, a
        pause from the speaker - which the host's window may be asleep for.
        Re-subscribes when the host's session changes."""
        from .session import registry

        session = None
        queue: asyncio.Queue | None = None
        try:
            while self.enabled:
                wanted = registry.get(self.host_session_id) if self.host_session_id else None
                if wanted is not session:
                    if session is not None and queue is not None:
                        session.event_bus.unsubscribe(queue)
                    session = wanted
                    queue = session.event_bus.subscribe() if session is not None else None
                if queue is None:
                    await asyncio.sleep(CAST_RECHECK_SECONDS)
                    continue
                try:
                    await asyncio.wait_for(queue.get(), timeout=CAST_RECHECK_SECONDS)
                except TimeoutError:
                    continue
                if self.host_cast() is None:
                    continue
                previous = self.snapshot
                self.rebuild()
                if self._worth_telling(previous, self.snapshot):
                    await self.broadcast()
        finally:
            if session is not None and queue is not None:
                session.event_bus.unsubscribe(queue)

    @staticmethod
    def _worth_telling(before: dict, after: dict) -> bool:
        """Whether guests need this snapshot - see POSITION_DRIFT_SECONDS."""
        timing = ("position", "position_at")
        if {k: v for k, v in before.items() if k not in timing} != {
            k: v for k, v in after.items() if k not in timing
        }:
            return True
        expected = before.get("position", 0.0)
        if before.get("playing"):
            expected += after["position_at"] - before.get("position_at", after["position_at"])
        return abs(after["position"] - expected) > POSITION_DRIFT_SECONDS

    def set_lyrics(self, song_id: str, synced: bool, offset: float, lines: list[dict]) -> None:
        """The host's lyrics for one song, kept until the next."""
        self.lyrics = {
            "song_id": song_id,
            "synced": synced,
            "offset": offset,
            "lines": [
                {
                    "time": float(line.get("time") or 0),
                    "text": str(line.get("text") or "")[:LYRICS_MAX_LINE_LENGTH],
                }
                for line in lines[:LYRICS_MAX_LINES]
            ],
        }

    def current_lyrics(self) -> dict | None:
        """The stored lyrics if they belong to what is playing now: the
        host's own (with its match and offset) when it named them, else
        connect's fallback match (no offset - see _fetch_fallback_lyrics)."""
        if self.lyrics and self.lyrics["song_id"] == self.current_song_id:
            return self.lyrics
        if self._fallback_lyrics and self._fallback_lyrics["song_id"] == self.current_song_id:
            return self._fallback_lyrics
        return None

    # ── Visualizer ───────────────────────────────────────────────────────

    def watch_visualizer(self) -> asyncio.Queue:
        """A guest starts watching the bars. They only ever come from a
        cast, where connect analyses what the speakers play anyway; local
        playback has its analyser in the host's browser."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=4)
        self.visualizer_queues.append(queue)
        if self._visualizer_task is None or self._visualizer_task.done():
            self._visualizer_task = asyncio.create_task(self._feed_visualizer())
        return queue

    def unwatch_visualizer(self, queue: asyncio.Queue) -> None:
        if queue in self.visualizer_queues:
            self.visualizer_queues.remove(queue)

    def _on_frame(self, bands: list[float]) -> None:
        for queue in self.visualizer_queues:
            if queue.full():
                queue.get_nowait()  # drop the oldest - show the freshest
            queue.put_nowait(bands)

    def _host_feed(self):
        from .session import registry

        if not (self.enabled and self.snapshot.get("casting") and self.snapshot.get("playing")):
            return None
        session = registry.get(self.host_session_id) if self.host_session_id else None
        return session.visualizer if session else None

    async def _feed_visualizer(self) -> None:
        """While anyone watches: subscribed to the host's cast analysis (an
        open subscription is what keeps it running at all, see
        core/visualizer_feed.py) and listening to whichever analyzer is
        current - a new one starts with every track and seek."""
        feed = None
        analyzer = None
        try:
            while self.visualizer_queues:
                wanted = self._host_feed()
                if wanted is not feed:
                    if feed is not None:
                        feed.unsubscribe()
                    feed = wanted
                    if feed is not None:
                        feed.subscribe()
                current = feed.analyzer if feed is not None else None
                if current is not analyzer:
                    if analyzer is not None and self._on_frame in analyzer.listeners:
                        analyzer.listeners.remove(self._on_frame)
                    analyzer = current
                    if analyzer is not None:
                        analyzer.listeners.append(self._on_frame)
                await asyncio.sleep(0.25)
        finally:
            if analyzer is not None and self._on_frame in analyzer.listeners:
                analyzer.listeners.remove(self._on_frame)
            if feed is not None:
                feed.unsubscribe()

    async def broadcast(self) -> None:
        await self.event_bus.broadcast({"kind": "update"})

    # ── Skip votes ───────────────────────────────────────────────────────

    def vote(self, guest_id: str) -> bool:
        """Adds a vote; True if that reached the threshold (and the votes
        are spent)."""
        if not self.can_skip():
            return False
        self.skip_votes.add(guest_id)
        if len(self.skip_votes) >= self.skip_needed():
            self.skip_votes.clear()
            return True
        return False

    def unvote(self, guest_id: str) -> None:
        self.skip_votes.discard(guest_id)


party = PartyState()


async def reap_stale_party() -> None:
    """Ends the party once its time is up or the renderer behind it is gone
    - nothing could answer a guest's wish without one."""
    while True:
        await asyncio.sleep(REAP_INTERVAL)
        if party.is_stale():
            party.disable()
            await party.broadcast()
        elif party.enabled:
            party.is_active()
            party.limiter.prune(3600)
