"""core/session.py — Per-user Connect session state.

Replaces the old single global Context/AppState (still in core/state.py, now
shrunk to just the operator-configured fixed targets) with one SessionState
per logged-in user, identified by the X-Connect-Session header/query param
the frontend derives from their media-server login (see
connect-session-id.ts). Callers with no session id fall back to
DEFAULT_SESSION_ID, reproducing the old single-session behavior unchanged.
"""

import asyncio
import logging
import os
import time

from fastapi import Header, HTTPException, Query

from delivery import BaseDelivery, DeliveryManager
from media import MediaClient, SubsonicClient

from . import icy_metadata
from .claims import claims
from .loop_health import peak_lag
from .radio_position import RadioPositionTracker
from .radio_relay import RadioRelay
from .state import AppState, EventBus, delivery_class_for, list_target_pairs, stream_url
from .visualizer_feed import ASSUMED_DEVICE_LEAD_SECONDS, VisualizerFeed

logger = logging.getLogger("connect.session")

DEFAULT_SESSION_ID = "default"


class SessionState:
    def __init__(self, session_id: str):
        self.session_id = session_id
        # Set by /config's `username` field — shown to other sessions as
        # "in use by {display_name}" for claimed devices.
        self.display_name: str = ""
        self.state = AppState()
        # Serializes /play, /play-url, /pause, /resume, /seek, /stop for this
        # session — without it, two concurrent dispatches (e.g. rapid
        # next/next, or a click while a previous switch is still in flight)
        # can run their `await target.play(...)` calls interleaved, and
        # whichever's device I/O happens to finish last "wins" regardless of
        # which the user actually issued last, leaving the wrong track
        # audibly playing while session.state.current_track/the UI show the
        # one the user actually asked for (or vice versa). See play_seq
        # below for the other half of the fix (dropping a request that's
        # already been superseded, instead of just serializing execution
        # order).
        self.play_lock = asyncio.Lock()
        # Highest PlayRequest/PlayUrlRequest.seq accepted so far — see
        # play_lock's comment. The frontend hands out a strictly increasing
        # seq per dispatch (services/connect/playback.ts); a request whose
        # seq is lower than this has already been superseded by one that
        # (from the user's perspective) came after it, so it's dropped
        # before ever reaching the target device, not just before
        # overwriting session state. seq=0 (the default for any caller that
        # doesn't send one, e.g. tests) opts out of the check entirely.
        self.play_seq: int = 0
        # The same "stale response overwrites a newer one" race as play_seq
        # above, for /config instead of /play — two concurrent /config calls
        # for this session (a UI double-submit, a retry racing the original
        # request) each await media.ping() (a real network round trip)
        # before applying their result; without this, whichever ping()
        # happens to resolve *last* wins regardless of which request was
        # actually issued last, and the session can end up authenticated
        # against the wrong/older server credentials. Bumped at the start of
        # every /config call (routes/devices.py's configure()); a call whose
        # own value no longer matches this by the time its ping() resolves
        # has been superseded and discards its result instead of applying it.
        self.config_seq: int = 0
        # Default is an unconfigured Subsonic client — overwritten by /config
        # with either a Subsonic or Jellyfin client.
        self.media: MediaClient = SubsonicClient("")
        self.event_bus = EventBus()
        # Runs the fullscreen visualizer's frequency analysis, but only
        # while a GET /visualizer subscriber is actually watching it — see
        # core/visualizer_feed.py.
        self.visualizer = VisualizerFeed(self)
        self.last_seen: float = time.time()
        # Set only once /config has verified the supplied credential actually
        # authenticates against the (optionally locked) media server — see
        # routes/devices.py's configure() and require_authenticated_session
        # below. Everything that reveals or controls LAN devices depends on
        # this instead of just require_token, since nginx attaches
        # X-Connect-Token to every same-origin request itself (see
        # ng.conf.template) — it identifies "a request from this deployment's
        # frontend", not "a logged-in media-server user".
        self.authenticated: bool = False
        # This session's radio "now playing" tag (ICY StreamTitle) and the
        # background task reading it off the stream - see
        # start_radio_metadata_watch()/stop_radio_metadata_watch() below.
        self.radio_title: str | None = None
        self._radio_metadata_url: str | None = None
        self._radio_metadata_task: asyncio.Task | None = None
        # The shared relay a radio station routed through Beacon's own
        # backend runs on (core/radio_relay.py) — None whenever radio isn't
        # playing, or is playing "direct to device" (the opt-in exception,
        # see routes/playback.py's PlayUrlRequest.cast_directly). Mutually
        # exclusive with _radio_metadata_task above: a relayed station
        # reports its own title changes (via the same _set_radio_title
        # callback) instead of a second, independent ICY watch.
        self.radio_relay: RadioRelay | None = None
        # Polls a Chromecast/DLNA target's own reported position while
        # radio is casting to it — see core/radio_position.py's module
        # docstring for why only those two protocols, and why one tracker
        # serves both the radio visualizer's clock and the "still
        # buffering" status flag. None whenever radio isn't casting to a
        # target that qualifies (including Sonos/AirPlay, and not casting
        # at all) — routes/playback.py's /play-url is the only place this
        # gets set to something else, replacing whatever was here before.
        self.radio_position_tracker: RadioPositionTracker | None = None
        # ICY StreamTitle round-trip measurement — the live position signal
        # a relayed Sonos gets *instead* of RadioPositionTracker (see that
        # module's own docstring for why x-rincon-mp3radio:// dispatch,
        # delivery/sonos.py's own _dispatch_uri(), leaves it without one).
        # (title, time.monotonic() it was actually injected) for whatever
        # titled ICY block core/icy_metadata.py's IcyMuxer most recently
        # sent this device — routes/upnp.py's AVTransport NOTIFY handler
        # consumes (clears) this the moment a matching echo arrives, so one
        # injection is only ever measured once. Shares the small,
        # accepted cross-talk risk of any single session-scoped field: a
        # multi-target cast where more than one device asks for ICY could
        # have one device's injection matched against another's echo — not
        # currently reachable in practice (only Sonos, over this one
        # dispatch, has ever been observed asking for it at all — see
        # scripts/icy_sync_probe.py), and the failure mode if it ever
        # happens is a stale/never-updated lag estimate, not a wrong
        # *audio* moment.
        self.radio_icy_pending_injection: tuple[str, float] | None = None
        # The title most recently recorded into radio_icy_pending_injection
        # above, session-wide rather than per connection. IcyMuxer's own
        # `_last_sent` cannot answer this: there is one muxer per device
        # connection, each starting from None, so every *new* connection
        # re-sends whatever title is currently playing as though it had just
        # changed. A Sonos opens several connections per cast (six, in one
        # scripts/icy_sync_probe.py run), and each of those re-armed the
        # pending measurement at "now" while the device had been playing
        # that same title for a while already — the next routine NOTIFY
        # carrying it then measured an arbitrary interval that has nothing
        # to do with any buffer. Only a title that is new to the *session*
        # marks a real "this became audible just now" moment worth timing.
        self.radio_icy_last_injected: str | None = None
        # The *smallest* plausible round-trip lag measured so far, in
        # seconds — what core/visualizer_feed.py's _FirstByteClock reads
        # once at least one has landed; None (falls back to that class's own
        # fixed guess) until then.
        #
        # Smallest, not most recent: an echo says "the device is currently
        # reporting this title", not "the device started playing it just
        # now". Sonos moderates its own AVTransport eventing heavily and
        # will happily go half a minute without sending anything, so an
        # individual measurement can only ever come out *too large* — never
        # too small, since the device cannot report a title before playing
        # it. That makes the minimum the estimator, and every later sample
        # only able to improve it. scripts/icy_sync_probe.py reached the
        # same conclusion against real hardware and says so in its own
        # output ("min delta ... <- the estimator would use this", "spread
        # -> event moderation. The plan's min-estimator eats it"); only the
        # min part never made it into this side. Measured live 2026-09-05
        # without it: a single routine state=PLAYING NOTIFY, 26s after the
        # previous event, produced a "lag" of 16.63s for a device whose real
        # buffer is under five.
        self.radio_icy_measured_lag: float | None = None
        # time.monotonic() of the last recovery redispatch of a relayed
        # station — see routes/upnp.py's _redispatch_relayed_station(),
        # which rate-limits itself off this. Zeroed whenever the relay
        # itself changes, so a fresh station starts with a fresh allowance
        # rather than inheriting the previous one's cooldown.
        self.last_radio_redispatch: float = 0.0

    def touch(self) -> None:
        self.last_seen = time.time()

    def start_radio_metadata_watch(self, url: str) -> None:
        """Called from routes/radio.py's own /radio-metadata/start (local
        playback - see core/icy_metadata.py's own docstring for why that
        needs an explicit call at all) and from /play-url (casting radio -
        already knows the URL there). Idempotent for the same URL, so a
        casting client's periodic /play-url retries (see PlayUrlRequest's
        own force/seq handling) don't restart the watch, and each dropping
        the previous one, every time. Not idempotent against a task that
        has already finished, though — a station with no ICY support at
        all returns for good on its own (see icy_metadata.watch()'s own
        docstring), and a done task is exactly what a still-current URL
        looks like right after that, correctly never restarted; a task
        that instead died from an unexpected exception is retried the
        same way, rather than silently staying dead forever."""
        if (
            self._radio_metadata_url == url
            and self._radio_metadata_task is not None
            and not self._radio_metadata_task.done()
        ):
            return
        self.stop_radio_metadata_watch()
        self._radio_metadata_url = url
        self._radio_metadata_task = asyncio.create_task(
            icy_metadata.watch(url, self._set_radio_title)
        )

    def stop_radio_metadata_watch(self) -> None:
        if self._radio_metadata_task is not None:
            self._radio_metadata_task.cancel()
            self._radio_metadata_task = None
        self._radio_metadata_url = None
        self.radio_title = None

    def _set_radio_title(self, title: str) -> None:
        self.radio_title = title

    async def start_radio_relay(self, url: str, content_type: str) -> RadioRelay:
        """Starts (or, for a different station, restarts) the shared relay
        — see core/radio_relay.py. Idempotent for the same URL, same
        reasoning as start_radio_metadata_watch()."""
        if self.radio_relay is not None and self.radio_relay.url == url:
            return self.radio_relay
        await self.stop_radio_relay()
        relay = RadioRelay(url, content_type, self._set_radio_title)
        await relay.start()
        self.radio_relay = relay
        self.last_radio_redispatch = 0.0
        return relay

    async def stop_radio_relay(self) -> None:
        # radio_position_tracker (core/radio_position.py) shares this exact
        # lifetime boundary — both represent "radio is currently casting"
        # and tear down together, at every call site this already has.
        # Unconditional, not nested in the guard below: the tracker doesn't
        # need a relay to exist (it polls the device directly), so it can
        # be set even in cast_directly mode, where radio_relay itself never
        # is.
        self.radio_position_tracker = None
        self.radio_icy_pending_injection = None
        self.radio_icy_last_injected = None
        self.radio_icy_measured_lag = None
        if self.radio_relay is not None:
            relay, self.radio_relay = self.radio_relay, None
            self.last_radio_redispatch = 0.0
            await relay.stop()


class SessionRegistry:
    def __init__(self):
        self._sessions: dict[str, SessionState] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(self, session_id: str) -> SessionState:
        async with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                session = SessionState(session_id)
                self._sessions[session_id] = session
            session.touch()
            return session

    def get(self, session_id: str) -> SessionState | None:
        """Read-only lookup — unlike get_or_create, does not create a session
        or touch last_seen. For displaying another session's info (e.g. the
        display_name behind a device claim) without side effects."""
        return self._sessions.get(session_id)

    def all(self) -> list[SessionState]:
        return list(self._sessions.values())

    async def remove(self, session_id: str) -> SessionState | None:
        async with self._lock:
            return self._sessions.pop(session_id, None)


registry = SessionRegistry()


async def get_session(
    x_connect_session: str | None = Header(default=None),
    session: str | None = Query(default=None),
) -> SessionState:
    return await registry.get_or_create(x_connect_session or session or DEFAULT_SESSION_ID)


async def require_authenticated_session(
    x_connect_session: str | None = Header(default=None),
    session: str | None = Query(default=None),
) -> SessionState:
    """Like get_session, but 401s until /config has verified real media-server
    credentials for this session (see SessionState.authenticated) — and,
    unlike get_session, never creates a session just to reject it. An
    unauthenticated caller (anyone with just the shared CONNECT_TOKEN, which
    nginx attaches automatically — see SessionState.authenticated's comment)
    could otherwise grow the registry unbounded by spamming arbitrary
    X-Connect-Session values, each surviving until the idle reaper runs.
    Use this instead of get_session for anything that reveals or controls
    LAN devices."""
    session_id = x_connect_session or session or DEFAULT_SESSION_ID
    existing = registry.get(session_id)
    if existing is None or not existing.authenticated:
        raise HTTPException(
            status_code=401,
            detail="Session not authenticated — call /config with valid media-server "
            "credentials first",
        )
    existing.touch()
    return existing


def compute_position(session: SessionState) -> float:
    """Return elapsed seconds into the current track, clamped to track duration.

    See PlaybackClock.elapsed() for the buffering-delay correction — this just
    adds the duration clamp, since the clock itself doesn't know about tracks.
    """
    st = session.state
    if not st.is_streaming or not st.clock.play_start_time:
        return 0.0
    elapsed = st.clock.elapsed()
    if st.current_track:
        return min(elapsed, float(st.current_track.duration))
    return elapsed


def radio_is_buffering(session: SessionState) -> bool:
    """Whether a cast device is still filling its own startup buffer for the
    station currently playing — build_status_dict()'s `radio_buffering`,
    which SeekBar.vue swaps in for its live-elapsed readout.

    Two ways of knowing, because only some devices tell us. A
    RadioPositionTracker (core/radio_position.py) is the real answer where
    one exists: it watches the device's own reported position and latches
    `ready` the moment it actually starts moving.

    Where none exists, this falls back to elapsed time against the expected
    device lead. That case used to just report False, which read as "done
    buffering" — and since 2026-09-04 it is the *normal* case for a relayed
    Sonos, the device with the largest measured buffer of the three
    (4.7-5.0s, see core/visualizer_feed.py's ASSUMED_DEVICE_LEAD_SECONDS):
    core/state.py's first_radio_position_delivery() excludes it from
    position tracking entirely, because over x-rincon-mp3radio:// it reports
    a flat 0.00s. So the seek bar went straight to counting up from 0:00
    while the speaker was still silent — the indicator was missing on
    exactly the cast that needs it most. AirPlay lands here too, having no
    radio position to poll at all.

    radio_icy_measured_lag first if one exists, the fixed guess otherwise —
    but as of core/icy_metadata.py's ICY_ROUND_TRIP_ENV that measurement is
    no longer armed by default, so this now normally means the fixed guess
    every time. Not a loss: core/visualizer_feed.py's _FirstByteClock
    docstring has the measurement itself (noisy, and biased low in a way
    that gets *worse* with more samples) tried and rejected for the exact
    same "how long is this device's own startup buffer" question, in favor
    of that same fixed guess. Re-enabling the env var brings this back too,
    for whoever next wants the real device data over the guess.

    Local playback is never "buffering" here: there is no cast device in
    the picture, and the browser's own <audio> element handles its own."""
    st = session.state
    if not st.radio_info or not st.is_streaming or st.clock.is_paused:
        return False
    tracker = session.radio_position_tracker
    if tracker is not None:
        return not tracker.ready
    if st.active_delivery is None:
        return False
    lead = session.radio_icy_measured_lag
    if lead is None:
        lead = ASSUMED_DEVICE_LEAD_SECONDS
    # elapsed_since_stream_start(), not elapsed(): this is wall time since
    # the device was last (re)dispatched, which is what the device's own
    # buffer fills against. It re-zeroes on /resume and /seek, correctly —
    # a device that reconnects re-incurs that same startup buffer, and a
    # Sonos auto-pause/resume seconds into its own dispatch is routine (see
    # core/radio_position.py).
    return st.clock.elapsed_since_stream_start() < lead


def build_status_dict(
    session: SessionState,
    displaced: bool = False,
    interrupted: bool = False,
    delivery_error: dict | None = None,
) -> dict:
    """Build the full status payload shared by /status and SSE /events.

    `displaced` is only ever True for the single broadcast displace_target()
    fires right after a takeover steals this session's device — it tells the
    frontend this particular streaming->false transition was a takeover, not
    the user stopping playback themselves, so it should just go quiet
    instead of picking playback back up over local speakers (see
    playback.ts's connect.$subscribe handler).

    `interrupted` is the same shape for a different event: the single
    broadcast fired when a cast device dropped its connection and never came
    back. It says "this stopped and nobody asked for it" - the frontend turns
    that into a toast offering to pick playback back up. A one-shot flag on
    the payload rather than state on the session, deliberately: there is
    nothing to clear afterwards, and a client connecting later should not be
    told about an interruption it never witnessed.

    `delivery_error` is a third one of the same shape, for the one failure
    that has no request to answer: a device that accepted what it was
    given and then reported on its own event channel that it isn't playing
    it (see routes/upnp.py). Same body delivery/errors.py builds for a
    failed dispatch, so the frontend has one thing to understand rather
    than two."""
    elapsed = compute_position(session)
    st = session.state

    current_track = None
    if st.current_track:
        t = st.current_track
        current_track = {
            "id": t.id,
            "artist": t.artist,
            "album": t.album,
            "cover_art_url": session.media.get_cover_art_url(t.cover_art_id),
            "duration": t.duration,
            "title": t.title,
        }

    targets = []
    for target_type, name in list_target_pairs(st.active_delivery):
        volume, muted = st.device_volumes.get(f"{target_type}:{name}", (None, None))
        targets.append({"name": name, "type": target_type, "volume": volume, "muted": muted})

    fmt = st.current_output_format
    stream_info = {
        # "transcoding" is derived rather than a stored flag: every copy-tier
        # label ends in "(copy)" (see core/streamer.py's resolve_output_format())
        # and nothing else ever does, so this can't drift out of sync with the
        # label text the way a second, hand-set boolean could.
        "label": fmt.label,
        "content_type": fmt.content_type,
        "transcoding": "copy" not in fmt.label,
        "source_codec": fmt.source_codec,
        "source_sample_rate": fmt.source_sample_rate,
        "source_bit_depth": fmt.source_bit_depth,
        "source_bitrate_kbps": fmt.source_bitrate_kbps,
        # Only set where the output is actually forced away from the
        # source's own numbers, and why this track is being transcoded at
        # all — see OutputFormat's own comment on both.
        "target_sample_rate": fmt.target_sample_rate,
        "target_bit_depth": fmt.target_bit_depth,
        "target_bitrate_kbps": fmt.target_bitrate_kbps,
        "transcode_reason": fmt.transcode_reason,
        "active_connections": st.active_stream_connections,
        # Process-wide, not session-scoped — see core/loop_health.py. A short
        # window (30s) rather than the module's full 120s history: this is
        # meant to answer "is anything wrong *right now*", not carry a stall
        # from ten minutes ago forward on every status tick after it.
        "loop_lag": peak_lag(30.0),
    }

    return {
        "current_song": current_track,
        "stream_info": stream_info,
        # The full queue (history included) and where current_track sits in
        # it — see AppState.queue's comment. Lets every client sharing this
        # session (not just whichever one dispatched it) mirror the same
        # queue/now-playing in its own UI, see stores/playback.ts's
        # queue-adoption logic.
        "queue": st.queue,
        "current_song_index": st.queue_index,
        # Standing shuffle/repeat preferences — see AppState.shuffle/
        # repeat_mode's comment. original_queue matters together with
        # shuffle: it's what stores/playback.ts's toggleShuffle() reverts
        # `queue` to when switching shuffle off, so every client needs the
        # same one, not just the same on/off flag.
        "original_queue": st.original_queue,
        "shuffle": st.shuffle,
        "repeat_mode": st.repeat_mode,
        # Reported for the same reason as the two above: it is a standing
        # preference of the *session*, and every client sharing it has to be
        # able to show the truth rather than whatever its own storage
        # happens to remember. Left out until 2026-08-28, which made the
        # backend's own top-up (_maybe_autoplay_topup in routes/stream.py)
        # look like it ignored the setting: this value only ever changes on
        # /play and /queue, so a phone that had Autoplay off but only ever
        # sent transport commands never corrected it, watched the queue grow
        # anyway, and had no way to find out why.
        "autoplay_enabled": st.autoplay_enabled,
        "elapsed": elapsed,
        "ended": st.track_ended,
        "paused": st.clock.is_paused,
        "radio": st.radio_info,
        # True while a cast device is still filling its own startup buffer
        # for the current station — see radio_is_buffering() for the two
        # ways of knowing that, and why the second one had to be added.
        "radio_buffering": radio_is_buffering(session),
        "streaming": st.is_streaming,
        "targets": targets,
        "total_songs": len(st.queue),
        "displaced": displaced,
        "interrupted": interrupted,
        "delivery_error": delivery_error,
    }


async def mark_interrupted(session: SessionState) -> None:
    """Record that playback stopped without anyone asking, and tell every
    client watching this session.

    Lives here rather than next to either of its callers because it has
    two: routes/stream.py's _mark_disconnected_if_not_reconnected(), for a
    device that closed its GET /stream connection and never came back, and
    delivery/airplay.py, whose push to the device failed outright. The two
    arrive at the same conclusion by very different routes — one after a
    grace period spent waiting for a reconnect that never happened, the
    other immediately, because a failed push leaves nothing ambiguous.

    The order below is load-bearing and was arrived at by two separate
    live bugs, so it is worth stating rather than rediscovering:

    - The position is read *before* is_streaming flips. compute_position()
      reads that flag itself and returns 0.0 once it is False, so reading
      it afterwards makes every interruption look like it happened at
      0:00, wherever the device actually was.
    - The clock is then paused at that position rather than left running.
      PlaybackClock.elapsed() has no notion of is_streaming and keeps
      advancing with the wall clock whether or not anything is playing.
      Without this, a resume minutes later seeks FFmpeg to wherever the
      clock got to — past the track's own end on anything but an immediate
      one, which FFmpeg answers with silence and no error. Observed live
      2026-08-24: a drop ~10s into a 222s track, resumed ~10 minutes
      later, produced a 200 response and no audio at all.

    `interrupted=True` marks this particular streaming->false transition as
    "nobody asked for this", which is what lets the frontend offer to pick
    playback back up instead of just going quiet. Beacon deliberately does
    not resume on its own for the pull-based targets: a device stopping by
    itself and a person pressing stop on the speaker are indistinguishable
    from here. AirPlay's failed push *is* distinguishable, but it reports
    through this same function anyway, so the interruption looks identical
    to the user whichever target it came from.
    """
    st = session.state
    position = compute_position(session)
    st.is_streaming = False
    st.clock.pause(position)
    await session.event_bus.broadcast(build_status_dict(session, interrupted=True))


def track_label(session: SessionState) -> str | None:
    """Short "what's playing" label for a session — used to annotate a
    claimed device in /discover (e.g. "in use by X, playing Y") so another
    session can see what they'd be taking over before doing so."""
    st = session.state
    if st.current_track:
        t = st.current_track
        return f"{t.artist} - {t.title}" if t.artist else t.title
    if st.radio_info:
        return st.radio_info.get("title")
    return None


# ── Claim enforcement / takeover ─────────────────────────────────────────────


async def check_claims(
    target: BaseDelivery | DeliveryManager, session: SessionState, force: bool = False
) -> tuple[dict | None, list[tuple[str, str, str]]]:
    """Claim every (type, name) pair the resolved delivery touches — including
    Sonos multiroom followers pulled in by grouping, since list_target_pairs()
    reflects the *resolved* delivery, not just the request's explicit targets.

    force=False (Phase 1 default): refuses on any conflict — returns a
    device_in_use error dict and an empty displaced list.

    force=True (Phase 2 takeover): always succeeds — returns None and the
    list of (type, name, previous_owner) pairs that got displaced, for the
    caller to pass to displace_target() so the previous owner's delivery
    actually stops and its SSE reflects the loss.
    """
    pairs = list_target_pairs(target)
    if force:
        displaced = await claims.force_claim_many(pairs, session.session_id)
        return None, displaced

    conflict = await claims.claim_many(pairs, session.session_id)
    if conflict is None:
        return None, []
    target_type, name, owner = conflict
    owner_session = registry.get(owner)
    return {
        "device": {"name": name, "type": target_type},
        "error": "device_in_use",
        "owner": owner_session.display_name if owner_session else "another session",
    }, []


def check_ownership(target_type: str, name: str, session: SessionState) -> dict | None:
    """Read-only claim check for actions (e.g. volume) on a device that's
    already claimed elsewhere — unlike check_claims(), this never claims the
    device itself, it only rejects when a *different* session currently owns
    it. Returns the same device_in_use error shape as check_claims(), or None
    when the device is unclaimed or owned by this session."""
    owner = claims.owner_of(target_type, name)
    if owner is None or owner == session.session_id:
        return None
    owner_session = registry.get(owner)
    return {
        "device": {"name": name, "type": target_type},
        "error": "device_in_use",
        "owner": owner_session.display_name if owner_session else "another session",
    }


async def displace_target(owner_session: SessionState, target_type: str, name: str) -> None:
    """Stop delivery to a single (type, name) target within owner_session,
    without touching the rest of its active_delivery — e.g. a takeover only
    steals the one Sonos speaker/Chromecast a new session claimed, not every
    device owner_session is still legitimately streaming to.

    Broadcasts on owner_session's own event_bus afterwards, so its existing
    SSE connection naturally reflects the loss — no separate push mechanism
    needed (see use-connect-session.ts's "external stop" effect).

    Mutates active_delivery/is_streaming under owner_session's own
    play_lock, same as /play, /pause, /seek etc. (see that field's
    docstring) — otherwise one of those handlers running concurrently on
    the victim session can finish just after this function reads/writes
    that state and clobber it (e.g. overwrite the "displaced" broadcast
    below with its own default displaced=False once it resumes and
    broadcasts its own status). Bounded by a timeout rather than awaited
    unconditionally: the caller here (_claim_or_takeover) is itself
    already holding *its own* session's play_lock, so an unbounded wait
    would risk a cross-session deadlock if two sessions force-takeover
    each other's devices in the same instant. On timeout, falls back to
    the old best-effort (racy but non-blocking) behavior rather than
    hanging the request."""

    def _apply(st) -> BaseDelivery | None:
        """Re-reads st.active_delivery (rather than trusting a value
        captured before the lock) since it may have changed while this
        function was waiting to acquire the lock — e.g. the victim's own
        /stop already cleared it. Returns the stopped delivery, or None if
        there's nothing left to stop."""
        active = st.active_delivery
        cls = delivery_class_for(target_type)
        if active is None or cls is None:
            return None
        if isinstance(active, DeliveryManager):
            lost = next(
                (d for d in active.deliveries if isinstance(d, cls) and d.target == name), None
            )
            if lost is None:
                return None
            remaining = [d for d in active.deliveries if d is not lost]
        elif isinstance(active, cls) and active.target == name:
            lost = active
            remaining = []
        else:
            return None

        if not remaining:
            st.is_streaming = False
            st.active_delivery = None
        elif len(remaining) == 1:
            st.active_delivery = remaining[0]
        else:
            st.active_delivery = DeliveryManager.from_deliveries(remaining)
        # See active_delivery_seq's own comment in core/state.py — bumped
        # here regardless of which of the two call sites below reached
        # this (the locked path doesn't strictly need it, already
        # serialized against /play by play_lock itself, but there's no
        # harm in it being consistent either way).
        st.active_delivery_seq += 1
        return lost

    st = owner_session.state
    try:
        async with asyncio.timeout(2.0):
            async with owner_session.play_lock:
                lost = _apply(st)
    except TimeoutError:
        logger.warning(
            f"[displace] Timed out waiting for {owner_session.session_id}'s play_lock; "
            "applying displacement without it"
        )
        lost = _apply(st)

    if lost is None:
        return

    try:
        await lost.stop()
    except Exception as e:
        logger.debug(f"[displace] stopping displaced delivery failed: {e}")

    await owner_session.event_bus.broadcast(build_status_dict(owner_session, displaced=True))


# ── Session lifecycle ────────────────────────────────────────────────────────

SESSION_REAP_INTERVAL = 60
SESSION_IDLE_TIMEOUT = int(os.getenv("SESSION_IDLE_TIMEOUT", str(60 * 30)))


async def _device_is_still_ours(session: SessionState) -> bool:
    """Whether the device this session was casting to is still playing the
    stream *this* session handed it — see reap_once() for why that question
    exists at all.

    Compares the device's own reported URI against what was dispatched: our
    /stream URL (which carries this instance's port and this session's id,
    so a different Beacon instance's stream is distinguishable even when it
    happens to use the same session id — session ids come from the media
    server login, so two instances serving the same user genuinely share
    one) or, for radio, the station URL that went straight to the device.

    A device that can't answer, or fails to, counts as ours: unchanged
    behaviour for AirPlay and anything else with no transport to query, and
    the safer default for our own housekeeping — leaving a speaker playing
    forever is a worse outcome than a stop that was already justified when
    the session was still alive."""
    st = session.state
    if st.active_delivery is None:
        return False
    expected = st.radio_info["url"] if st.radio_info else stream_url(session.session_id)
    try:
        uri = await st.active_delivery.current_uri()
    except Exception as e:
        logger.debug(f"[reap] {session.session_id}: could not read device URI: {e}")
        return True
    if uri is None:
        return True
    if uri == expected:
        return True
    logger.info(
        f"[reap] {session.session_id}: leaving {st.active_delivery!r} alone — it plays "
        f"{uri[:80]!r}, not this session's stream"
    )
    return False


async def reap_once() -> list[str]:
    """Release claims and forget any session that's been idle past
    SESSION_IDLE_TIMEOUT, stopping its device if it's still sitting on our
    stream. Returns the session ids that were reaped, mainly so tests don't
    need to duplicate this logic to assert on it.

    "Idle" is deliberately two conditions, not one — see the loop below."""
    now = time.time()
    reaped = []
    for session in registry.all():
        if now - session.last_seen <= SESSION_IDLE_TIMEOUT:
            continue
        # last_seen alone is NOT enough to call a session idle, because
        # nothing about casting touches it once a track is under way: the
        # /events heartbeat needs a client with the app open, and each GET
        # /stream connection touches it exactly once, when the device opens
        # it — one touch per *track*, not per minute.
        #
        # So a track longer than SESSION_IDLE_TIMEOUT, played with no app
        # window anywhere, ages its own session past the timeout while it is
        # audibly playing. Observed live 2026-08-23: an 80-minute mix cast
        # to a Sonos with every tab closed was reaped 31 minutes in and its
        # speaker stopped — proven on the wire, our Stop at 00:27:50.133 UTC
        # and the device's FIN 840ms later. From the outside that is
        # indistinguishable from the unexplained drops in
        # docs/playback-bugs/mid-track-drop-symptom.md, which is how it went
        # unnoticed.
        #
        # Whatever is still streaming is by definition not abandoned, so it
        # is not reaped at all. Covers a paused cast too: somebody may well
        # come back to it, and stopping the device under them would be the
        # same rudeness one step later.
        if session.state.is_streaming:
            logger.debug(
                f"[reap] {session.session_id}: idle since "
                f"{now - session.last_seen:.0f}s but still streaming — left alone"
            )
            continue
        # Not streaming any more, but the device may still be sitting on
        # this session's stream — a false-positive drop, or a queue that
        # ended without the device letting go. Stop it only if it really is
        # still ours: a reap is the one teardown nobody asked for, and the
        # speaker is shared far more widely than this process can see.
        # Observed live 2026-08-22: a session whose cast had ended hours
        # earlier was reaped and stopped its old speaker, which by then a
        # *different* Beacon instance on the same host was streaming to —
        # that instance saw a device drop with no cause of its own.
        if session.state.active_delivery and await _device_is_still_ours(session):
            try:
                await session.state.active_delivery.stop()
            except Exception as e:
                logger.debug(f"[reap] {session.session_id}: stopping device failed: {e}")
        await session.visualizer.shutdown()
        session.stop_radio_metadata_watch()
        await session.stop_radio_relay()
        await claims.release_all_for_session(session.session_id)
        await registry.remove(session.session_id)
        reaped.append(session.session_id)
    return reaped


async def reap_stale_sessions() -> None:
    """Background task (see main.py's lifespan): calls reap_once() every
    SESSION_REAP_INTERVAL, forever."""
    while True:
        await asyncio.sleep(SESSION_REAP_INTERVAL)
        await reap_once()
