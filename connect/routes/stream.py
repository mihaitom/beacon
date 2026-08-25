"""routes/stream.py — GET /stream/{session_id}, GET /status, GET /events, GET /visualizer"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass

from fastapi import APIRouter, Depends
from fastapi.responses import Response, StreamingResponse

from core.auth import require_token
from core.loop_health import peak_lag
from core.session import (
    DEFAULT_SESSION_ID,
    SessionState,
    build_status_dict,
    compute_position,
    get_session,
    registry,
)
from core.state import (
    TEST_TONE_TRACK_ID,
    audio_capability_limits,
    stream_url,
    test_tone_url,
)
from core.streamer import resolve_output_format, stream_tracks

from .playback import (
    POSITION_RESYNC_INTERVAL,
    _apply_position_offset,
    _current_reconnect_args,
    _resync_position_periodically,
)

logger = logging.getLogger("connect.stream")
router = APIRouter()


async def _dispatch_queued_track(session: SessionState, target, track, gain: float) -> bool:
    """Server-side track dispatch for _advance_or_end()'s queue auto-advance
    below — the same device-call + state/background-task bookkeeping
    routes/playback.py's /play handler does, minus the claim/target-
    resolution logic that doesn't apply here: `target` is already owned by
    this session, continuing the exact cast /play started (see
    AppState.queue's comment). Reuses `gain` as-is rather than recomputing
    ReplayGain for `track` specifically — connect only has track ids here,
    not the frontend's per-track gain values; a cosmetic volume mismatch
    at worst, self-corrects next time the frontend dispatches a real /play.

    Returns False (leaving session.state.is_streaming off) on delivery
    failure, so the caller falls back to the normal "nothing more to play"
    broadcast instead of leaving state stuck mid-transition."""
    st = session.state
    track_url = await asyncio.to_thread(session.media.get_stream_url, track.id)
    max_rate, max_depth = audio_capability_limits(target)
    output_format = await resolve_output_format(
        track_url, gain=gain, max_sample_rate=max_rate, max_bit_depth=max_depth
    )
    url = stream_url(session.session_id)

    st.current_track = track
    st.current_output_format = output_format
    st.is_streaming = True
    st.clock.start(0.0)
    st.track_ended = False

    # internal=True: fetched directly by the cast device, not the browser —
    # see MediaClient.get_cover_art_url's docstring.
    album_art_url = session.media.get_cover_art_url(track.cover_art_id, internal=True)
    try:
        await target.play(
            url,
            track.title,
            track.artist,
            album_art_url,
            float(track.duration),
            track.album,
            output_format.content_type,
        )
    except Exception:
        logger.exception("[stream] Auto-advance delivery error")
        st.is_streaming = False
        return False

    asyncio.create_task(_apply_position_offset(session, target, st.clock.play_generation))
    asyncio.create_task(_resync_position_periodically(session, target, st.clock.play_generation))
    await session.event_bus.broadcast(build_status_dict(session))
    return True


async def _maybe_autoplay_topup(session: SessionState) -> None:
    """Backend-side fallback for Autoplay — appends similar songs straight
    onto session.state.queue/original_queue, the same way stores/
    playback.ts's own maybeAutoplay() (the *primary* implementation) does
    on the frontend via addToQueue(). This one only matters when no
    frontend client is around to run that: the frontend's own top-up fires
    proactively on every song change and normally keeps the queue topped
    up well before _advance_or_end() below ever finds it actually empty —
    exactly why AppState.queue exists server-side at all (see its own
    comment: casting has to keep going even with the renderer that
    dispatched it asleep/suspended, e.g. a locked phone screen).

    Silent no-op, not an error, whenever: the setting's off; repeat is
    already keeping the queue from running out on its own (repeat-all
    wraparound/repeat-one replay still need the renderer awake regardless
    — see _advance_or_end()'s own docstring, this doesn't change that);
    or the connected media server has no similar-songs capability (Plex —
    see SubsonicClient.get_similar_songs2's comment on why that's a
    hasattr() duck-type check here rather than a Protocol method every
    adapter must implement)."""
    st = session.state
    if not st.autoplay_enabled or st.repeat_mode != "off":
        return
    if not hasattr(session.media, "get_similar_songs2") or not st.queue:
        return
    seed_id = st.queue[-1]
    try:
        similar = await asyncio.to_thread(
            session.media.get_similar_songs2, seed_id, st.autoplay_batch_size
        )
    except Exception as e:
        logger.warning(f"[stream] Autoplay top-up failed: {e}")
        return
    # By id, not just "new objects" — a small library's similar-songs pool
    # otherwise keeps circling back to whatever's already just been
    # played, same reasoning as stores/playback.ts's maybeAutoplay().
    existing_ids = set(st.queue)
    fresh_ids = [t.id for t in similar if t.id not in existing_ids]
    if not fresh_ids:
        return
    st.queue.extend(fresh_ids)
    st.original_queue.extend(fresh_ids)
    logger.info(f"[stream] Autoplay topped up the queue with {len(fresh_ids)} song(s)")


async def _resolve_track(session: SessionState, track_id: str, context: str):
    """Look a queued track up, tolerating a brief media-server hiccup.

    Auto-advance used to give up on the first failure, which meant a
    transient error — a DNS lookup for the media server failing for a
    moment, observed on beacon-dev 2026-08-22 — ended playback outright
    with a full queue still waiting. "The next track cannot be resolved
    right now" and "there is nothing left to play" are very different
    things, and only the second one should stop the music.

    Deliberately a small, bounded number of attempts: this runs while
    holding session.play_lock, and a genuinely unavailable media server
    must not stall every other playback handler behind it.
    """
    for attempt in range(_TRACK_LOOKUP_ATTEMPTS):
        try:
            return await asyncio.to_thread(session.media.get_track, track_id)
        except Exception as e:
            last = attempt == _TRACK_LOOKUP_ATTEMPTS - 1
            logger.warning(
                f"[stream] {context}: track {track_id} not found "
                f"(attempt {attempt + 1}/{_TRACK_LOOKUP_ATTEMPTS}): {e}"
            )
            if not last:
                await asyncio.sleep(_TRACK_LOOKUP_RETRY_SECONDS)
    return None


# How close to the end of a track the wait loop below gets before it calls
# the track finished. Not a comfort margin: every millisecond of it is audio
# the device is still playing when the queue advances over it, so this is
# only as large as it takes for the loop to terminate rather than spin on
# sub-millisecond sleeps.
_TRACK_END_TOLERANCE = 0.05

# How far the probed length may differ from the music server's own before it
# is treated as measuring something else entirely (a redirect to a different
# file, a live stream) and ignored. Generous: the two legitimately disagree
# by up to a second from whole-second rounding alone, and by a bit more for
# formats whose metadata duration is derived from a bitrate estimate.
_DURATION_SANITY_WINDOW = 5.0


def _playback_duration(st) -> float:
    """How long the current track actually plays for, in seconds.

    Prefers the length ffmpeg measured off the file itself (hundredths of a
    second — see core/streamer.py's _DURATION_RE) over the music server's
    metadata, which is whole seconds and, for Jellyfin/Plex, truncated
    rather than rounded. Scheduling the end of a track off the metadata
    figure ends it early by that rounding error, which is audible on tracks
    that stop abruptly: the queue advances, the device gets a new URI, and
    the tail is simply gone.

    Falls back to the metadata duration whenever nothing was probed (the
    forced/probe-failed fallback tiers, radio) or the probed value disagrees
    with it wildly enough to look like it measured something else — see
    _DURATION_SANITY_WINDOW."""
    metadata = float(st.current_track.duration) if st.current_track else 0.0
    probed = st.current_output_format.source_duration
    if probed is None or metadata <= 0:
        return metadata
    if abs(probed - metadata) > _DURATION_SANITY_WINDOW:
        return metadata
    return probed


async def _advance_or_end(session: SessionState, my_generation: int) -> None:
    """What happens when a track finishes — split out from _fire_track_end()
    below purely so it's directly testable, same reasoning as
    routes/playback.py's _resync_position_once(). Must be called while
    holding session.play_lock (see _fire_track_end()), same as every other
    handler that mutates this state (/play, /stop, /seek, ...).

    Auto-advances to session.state.queue[queue_index + 1] when there is one
    and a cast target is still active — see AppState.queue's comment — so
    casting keeps going even if the renderer that originally dispatched
    this session is asleep/suspended. Tries _maybe_autoplay_topup() first
    when that "when there is one" would otherwise fail, so Autoplay keeps
    the queue going server-side too, not just while a frontend client is
    around to react — see that function's own docstring. Falls back to the
    original "mark ended" broadcast once the queue (topped up or not) is
    still exhausted, the next track can't be resolved, or dispatch fails —
    repeat-all wraparound and repeat-one replay past the end of the given
    list still need the renderer awake to react to that broadcast, same as
    before this existed.
    """
    st = session.state
    if not (
        st.is_streaming
        and not st.clock.is_paused
        and st.clock.play_generation == my_generation
    ):
        return

    next_index = st.queue_index + 1
    if next_index >= len(st.queue) and st.active_delivery:
        await _maybe_autoplay_topup(session)
        next_index = st.queue_index + 1  # re-check — the top-up may have extended it

    if next_index < len(st.queue) and st.active_delivery:
        next_track_id = st.queue[next_index]
        # to_thread, like every other session.media call around here: these
        # adapters are synchronous HTTP clients, so calling one directly
        # blocks the whole event loop — and with it every open /stream
        # socket — for as long as the request takes. Usually milliseconds
        # and invisible; measured on beacon-dev 2026-08-22 at 4.71s when
        # DNS for the media server went sour, which is well into "the
        # device runs out of buffered audio" territory.
        next_track = await _resolve_track(session, next_track_id, "Auto-advance")
        if next_track is not None:
            dispatched = await _dispatch_queued_track(
                session, st.active_delivery, next_track, st.current_track_gain
            )
            if dispatched:
                st.queue_index = next_index
                logger.info(
                    f"[stream] Auto-advanced to {next_track.artist} — {next_track.title}"
                )
                return

    logger.info("[stream] Track finished — marking stream complete")
    st.is_streaming = False
    st.track_ended = True
    await session.event_bus.broadcast(build_status_dict(session))


# How long to wait, after a device closes its GET /stream connection mid-
# track, for a fresh connection to pick the same track back up before
# concluding it isn't going to — see
# _mark_disconnected_if_not_reconnected()'s own docstring. Long enough that
# an ordinary quick reconnect blip (buffer management, a momentary WiFi
# hiccup, a Sonos re-doing SSDP discovery before it re-requests the stream —
# "easily a second or more" on its own per _resync_position_once()'s
# comment) doesn't falsely trip this; short enough that a genuinely dead
# stream doesn't sit is_streaming=True for long once nothing's actually
# flowing. 5s (the original value) turned out too tight in practice —
# observed live 2026-08-22 firing on reconnects that either hadn't finished
# yet or would have landed a few seconds later. A false trip is no longer
# the permanent, self-worsening problem it used to be (see offset_consumed's
# own comment above on reviving is_streaming once real audio actually
# resumes), so erring wide here costs a few extra seconds of "not
# streaming" being displayed at worst, not a stuck session.
STREAM_DISCONNECT_GRACE_SECONDS = 10.0


# How hard to try resolving the next queued track before concluding there
# is nothing to play — see _resolve_track(). Short and few: this runs under
# play_lock, so the total is bounded well below the buffer a casting device
# is holding at that point.
_TRACK_LOOKUP_ATTEMPTS = 3
_TRACK_LOOKUP_RETRY_SECONDS = 1.0


@dataclass(frozen=True)
class DisconnectSnapshot:
    """What one /stream connection looked like the instant it was cancelled.

    Diagnostic instrumentation for the recurring, non-reproducible cast
    drops (beacon-dev 2026-08-22 02:06 — one log line and no way to tell
    what had actually gone wrong; the same track replayed cleanly hours
    later). Every field separates one candidate explanation from another,
    so the *next* occurrence is evidence rather than another guess:

    - `blocked_for` — how long the connection sat inside a single handoff.
      A large value means the device had stopped reading well before it
      dropped (its buffer was full, i.e. TCP backpressure was doing the
      throttling), rather than the connection dying while audio flowed.
    - `bytes_delivered` over `wall` — this connection's real production
      rate. With pacing working (core/streamer.py's _READRATE_ARGS) wall
      time tracks the played position closely; a large gap means pacing
      has regressed again.
    - `loop_lag_*` — worst event-loop stall recently (core/loop_health.py).
      Non-trivial values mean *this process* starved the socket and the
      device dropped as a consequence, which is an entirely different bug
      from a flaky speaker or network.

    Captured at cancellation but deliberately *not* logged there — see
    capture_disconnect_snapshot() for why.
    """

    label: str
    duration: int
    position: float
    blocked_for: float
    bytes_delivered: int
    wall: float
    loop_lag_30s: float
    loop_lag_120s: float

    def describe(self) -> str:
        return (
            f"{self.label} ({self.duration}s) | position={self.position:.1f}s "
            f"blocked_for={self.blocked_for:.2f}s "
            f"delivered={self.bytes_delivered}B over wall={self.wall:.1f}s "
            f"loop_lag_30s={self.loop_lag_30s:.2f}s "
            f"loop_lag_120s={self.loop_lag_120s:.2f}s"
        )


def capture_disconnect_snapshot(
    session: SessionState,
    track,
    *,
    first_byte_at: float | None,
    last_handoff: float,
    bytes_delivered: int,
) -> DisconnectSnapshot:
    """Freeze the numbers above at the moment of cancellation.

    They have to be read here rather than after the grace period, because
    every one of them is about the instant the connection died — but they
    must not be *logged* here: at this point it is genuinely unknowable
    whether this was a device dropping out or one of our own /pause,
    /stop, /seek or /play handlers closing the connection on purpose. The
    connection count still includes this connection (its `finally` hasn't
    run yet) and clock.is_paused may not be set yet either, so an
    immediate log line reads "device dropped" for an ordinary pause —
    observed doing exactly that on beacon-dev 2026-08-22 09:31, which
    would bury the rare real event this exists to catch.

    _mark_disconnected_if_not_reconnected() already answers that question
    correctly, just ten seconds later, so the snapshot rides along and is
    logged only once that call has concluded it really was a drop.
    """
    now = time.monotonic()
    return DisconnectSnapshot(
        label=f"{track.artist} — {track.title}",
        duration=track.duration,
        position=session.state.clock.elapsed(),
        blocked_for=now - last_handoff,
        bytes_delivered=bytes_delivered,
        wall=now - first_byte_at if first_byte_at is not None else 0.0,
        loop_lag_30s=peak_lag(30.0),
        loop_lag_120s=peak_lag(120.0),
    )


async def _mark_disconnected_if_not_reconnected(
    session: SessionState,
    my_generation: int,
    snapshot: DisconnectSnapshot | None = None,
) -> None:
    """A device closing its GET /stream connection mid-track is usually just
    a brief reconnect blip — it typically reopens the same URL again within
    a second or two, and is_streaming should stay True through that gap so
    the position-resync loop and every client watching this session don't
    flicker to "stopped" for a connection that's about to resume completely
    normally. That's the whole reason stream_with_completion()'s
    CancelledError handler doesn't clear is_streaming itself.

    But if nothing reopens it at all — observed live 2026-08-21: a Sonos
    speaker dropping mid-track (13 minutes into a 76-minute compilation)
    and never reconnecting — is_streaming stayed True forever, and the
    position-resync loop (routes/playback.py) kept polling the now-silent
    device, which correctly reports position 0 once its transport has
    nothing left to play. Nothing told the resync loop that "streaming"
    wasn't actually true anymore, so it misread that persisting, ever-
    growing gap as one genuine external rewind after another (the same
    ambiguity _resync_position_once()'s own near-track-end guard already
    covers, just from a different cause — a stream that plain died instead
    of one that finished on schedule): position_offset ratcheted more
    negative every single 8s resync tick, indefinitely, while the frontend
    looped near 0:00 with no audio.

    Runs as an independent task (see stream_with_completion()'s call site)
    so the CancelledError that spawned it doesn't get to cancel this too.
    Checks active_stream_connections (a *live count*, not a single "most
    recent connection" marker) rather than anything identifying this one
    connection specifically — multi-target casting can have more than one
    GET /stream connection open for the same session at once (e.g.
    Chromecast + DLNA), each dropping and reconnecting independently, so
    "did *a* connection reappear" is the wrong question; "is *anything*
    still connected" is what actually matters for a session-wide flag like
    is_streaming. A no-op once another connection is (still or again) open,
    a new /play/seek/resume has superseded this track, the track finished
    normally, or the track is legitimately paused — a device that drops its
    HTTP connection on pause rather than idling the open socket (some DLNA
    renderers do this) isn't dead, it's just paused, and isn't expected to
    reconnect until /resume asks it to.

    `snapshot` is the caller's frozen view of the connection at the instant
    it was cancelled (see capture_disconnect_snapshot()). It is logged only
    on the branch below that has actually concluded this was a real drop,
    which is the whole reason it is carried here instead of being logged at
    the cancellation site.
    """
    await asyncio.sleep(STREAM_DISCONNECT_GRACE_SECONDS)
    st = session.state
    if (
        st.clock.play_generation == my_generation
        and st.active_stream_connections == 0
        and st.is_streaming
        and not st.clock.is_paused
    ):
        detail = f" | {snapshot.describe()}" if snapshot else ""
        # error, not warning: playback the user asked for has stopped and
        # nothing about it was requested. Recovery below may well paper over
        # it, which is exactly why the log must still say plainly that it
        # happened - a silent auto-recovery would hide the one event worth
        # investigating.
        logger.error(
            f"[stream] Cast device dropped its connection and did not come back "
            f"within {STREAM_DISCONNECT_GRACE_SECONDS:.0f}s{detail}"
        )
        # Captured before the flag flips below — compute_position() reads
        # is_streaming itself and returns 0.0 once it's False (see its own
        # docstring), which would make every interruption look like it
        # happened at 0:00 regardless of where the device actually was.
        position = compute_position(session)
        st.is_streaming = False
        # Freezes elapsed() at `position` the same way /pause does, rather
        # than leaving it tied to the wall clock — PlaybackClock.elapsed()
        # has no notion of is_streaming and keeps advancing with real time
        # whether or not anything is actually playing. Without this,
        # _resume_after_interruption() (routes/stream.py) reads elapsed() at
        # whatever moment someone eventually taps "Resume" — sometimes
        # minutes later — and seeks the reconnect there: past the track's
        # own end on anything but an immediate resume, which FFmpeg's -ss
        # answers with silence and no error. Observed live 2026-08-24: a
        # drop ~10s into a 222s track, resumed ~10 minutes later, produced a
        # 200 response and no audio at all.
        st.clock.pause(position)
        # interrupted=True marks this particular streaming->false transition
        # as "nobody asked for this", which is what lets the frontend offer
        # to pick playback back up instead of just going quiet. Beacon
        # deliberately does not resume on its own: a device stopping by
        # itself and a person pressing stop on the speaker are
        # indistinguishable from here (both end in a clean FIN with
        # TransportState=STOPPED and TransportStatus unchanged), so guessing
        # would sometimes restart music somebody had just silenced.
        await session.event_bus.broadcast(build_status_dict(session, interrupted=True))


async def _resume_after_interruption(session: SessionState) -> bool:
    """Re-dispatch the current track to the same target, from where the
    clock got to.

    The device stopped without anything asking it to, and beacon's only
    reaction so far was to mark the session not-streaming and go quiet - the
    music simply ended and stayed ended. Whatever makes these speakers stop
    has resisted a full day of investigation (see
    docs/playback-bugs/mid-track-drop-symptom.md; the cause is outside this
    codebase), so the useful thing left to do is to
    stop letting it end the session.

    Called only when someone asks for it - the toast the interrupted
    broadcast raises in the frontend. Returns True if a fresh stream was
    dispatched.

    Resumes from the position the clock was frozen at when the drop was
    declared (_mark_disconnected_if_not_reconnected() pauses it there, the
    same way /pause does) rather than wherever elapsed() has drifted to by
    now - elapsed() has no notion of is_streaming and keeps advancing with
    real time regardless, so reading it fresh here would seek an interruption
    resumed minutes later past the track's own end, same class of bug
    seek_to()'s and resume()'s own comments describe for a fresh stream's
    start_position. clock.resume() is the same path a real /resume takes:
    it un-pauses, bumps play_generation (which is what retires the resync
    task belonging to the connection that just died), and re-zeroes
    track_start_position - all three needed for the reconnect below to
    calibrate correctly, not just the position number itself.
    """
    st = session.state
    if not st.active_delivery or st.current_track is None:
        return False

    if st.clock.is_paused:
        st.clock.resume()
    else:
        # Defensive fallback - shouldn't be reachable since the only path
        # that sets interrupted=True (above) always pauses the clock first,
        # but a duration clamp here costs nothing and keeps this function
        # safe to call against whatever state it's actually handed.
        position = min(st.clock.elapsed(), float(st.current_track.duration))
        st.clock.seek_to(position)
    position = st.clock.resume_offset
    logger.info(f"[stream] Resuming after an interruption from {position:.1f}s")
    try:
        await st.active_delivery.play(*_current_reconnect_args(session))
    except Exception:
        logger.exception("[stream] Resume-after-interruption failed")
        return False

    asyncio.create_task(
        _apply_position_offset(session, st.active_delivery, st.clock.play_generation)
    )
    asyncio.create_task(
        _resync_position_periodically(session, st.active_delivery, st.clock.play_generation)
    )
    st.is_streaming = True
    await session.event_bus.broadcast(build_status_dict(session))
    return True


@router.post("/resume-interrupted", dependencies=[Depends(require_token)])
async def resume_interrupted(session: SessionState = Depends(get_session)):
    """Pick playback back up after a device dropped out on its own.

    Raised by the toast the `interrupted` broadcast produces, so this is an
    explicit "yes, carry on" from a person - which is exactly the signal
    beacon cannot derive for itself (see _mark_disconnected_if_not_reconnected).

    Serialized on play_lock like every other handler that re-dispatches
    playback, so a resume landing at the same moment as a /play or /stop
    cannot interleave with it.
    """
    async with session.play_lock:
        if session.state.is_streaming:
            # Something already picked it back up - the device reconnected on
            # its own, or another client resumed first. Not an error.
            return {"resumed": False, "reason": "already streaming"}
        if not await _resume_after_interruption(session):
            return {"resumed": False, "reason": "nothing to resume"}
    return {"resumed": True}


@router.head("/stream")
@router.head("/stream/{session_id}")
async def audio_stream_head(session_id: str = DEFAULT_SESSION_ID):
    """ffmpeg probes the URL with HEAD before streaming — answer without starting ffmpeg."""
    session = await registry.get_or_create(session_id)
    return Response(
        media_type=session.state.current_output_format.content_type,
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/stream")
@router.get("/stream/{session_id}")
async def audio_stream(session_id: str = DEFAULT_SESSION_ID):
    # Cast devices call this URL back with no way to send custom headers, so
    # the session id lives in the path itself (bare /stream is a compat alias
    # for DEFAULT_SESSION_ID — same reasoning as why this route has never had
    # token auth: the device dialing back in can't send one either).
    session = await registry.get_or_create(session_id)

    if not session.state.current_track:
        logger.warning("[stream] No track loaded — returning 204")
        return StreamingResponse(
            iter([b""]), media_type=session.state.current_output_format.content_type,
            status_code=204,
        )

    # Counted from here — as soon as this is known to be a real connection
    # attempt, not only once its own setup below has finished (in
    # particular get_stream_url()'s network round-trip for Plex, just
    # below) — see active_stream_connections' own comment in core/state.py.
    # A reconnect that's already reached the server but is still resolving
    # its stream URL must count as "connected" immediately, or
    # _mark_disconnected_if_not_reconnected's grace-period check can read 0
    # connections even though a real reconnect is already in flight.
    # Matched by the except below (setup failing before the connection
    # ever actually starts streaming) and by stream_with_completion()'s own
    # finally (once it does).
    session.state.active_stream_connections += 1
    try:
        track = session.state.current_track
        output_format = session.state.current_output_format
        # Debug-only special case (see routes/debug.py) — the test tone isn't a
        # real library track, so there's nothing for session.media to resolve.
        # to_thread: get_stream_url() is a pure, instant string builder for
        # Subsonic/Jellyfin, but Plex's needs a real network lookup first (see
        # media/plex.py's docstring) — without this, that lookup would block
        # the whole event loop, not just this one request/session.
        track_url = (
            test_tone_url()
            if track.id == TEST_TONE_TRACK_ID
            else await asyncio.to_thread(session.media.get_stream_url, track.id)
        )
    except Exception:
        session.state.active_stream_connections -= 1
        raise

    # Captured now (for this connection's -ss), but *not* cleared yet — see
    # stream_with_completion(), which only clears it once this connection has
    # actually started producing audio. A device can open (and abandon) a
    # connection to /stream before ever reading data — most commonly the very
    # first connection of a session, while e.g. a Sonos coordinator is still
    # settling — and clearing eagerly here would let that abandoned attempt
    # silently discard the seek offset before the real connection arrives,
    # making the device audibly restart from 0:00 while our own state (and
    # thus the displayed position) still reports the correct position.
    offset = session.state.clock.resume_offset

    # A connection for a generation that has already been served audio is
    # the device reopening the stream by itself — no /play, /seek or /resume
    # was involved, so resume_offset (which only those set) has long been
    # consumed and reads 0. Serving that 0 hands the device the track from
    # the beginning while this session's clock is minutes in, which is worse
    # than it sounds: the device then reports ~0 as its position, the resync
    # loop reads that as a deliberate seek on the speaker and drags
    # position_offset by the full track position, and everything downstream
    # of elapsed() goes with it — displayed position, lyrics sync, the cast
    # visualizer's pacing, auto-advance scheduling. Observed live 2026-08-23
    # after an event-loop stall made a Sonos give up and reconnect: the
    # track restarted audibly, position_offset went to -60.35s, and the only
    # way out from the UI was a reload plus skipping the track.
    #
    # Gated on is_streaming as well, so this never applies to a session
    # whose playback genuinely ended and whose device is only now getting
    # round to re-requesting the URL.
    reconnecting = (
        session.state.is_streaming
        and session.state.streamed_generation == session.state.clock.play_generation
    )
    if reconnecting:
        offset = session.state.clock.stream_restart_position()
        logger.info(
            f"[stream] Device reopened the stream on its own — resuming at "
            f"{offset:.1f}s instead of 0:00 "
            f"(play_generation={session.state.clock.play_generation})"
        )

    # Debug, not info — routes/playback.py's own "[play] ..." line already
    # announced this same track+device at the user-action level; this is
    # just the HTTP layer underneath it catching up a beat later.
    logger.debug(
        f"[stream] Client connected — {track.artist} — {track.title}"
        + (f" (seek {offset:.1f}s)" if offset > 0.5 else "")
    )

    def on_track_start(_: int) -> None:
        gain = session.state.current_track_gain
        gain_str = f", gain={gain:.2f}" if gain != 1.0 else ""
        logger.debug(
            f"[stream] ▶ {track.artist} — {track.title} ({track.duration}s{gain_str})"
        )

    async def _fire_track_end(my_generation: int, wait: float) -> None:
        """Fires once ffmpeg (and, for Sonos, the device's own buffered
        playback) is actually done — see _advance_or_end() above for what
        actually happens: auto-advance to the next queued track, or mark
        the stream complete once there isn't one.

        Runs as an independent task so Sonos closing the HTTP connection cannot
        cancel it (that CancelledError would only affect stream_with_completion).
        Acquires play_lock like every other handler that mutates this session's
        playback state (/play, /stop, /seek, ...) — without it, a track ending
        in the same instant as a user-issued skip/stop could interleave state
        updates between the two.

        `wait` is only the *initial* estimate, from whatever position_offset
        was in effect the moment ffmpeg finished — not slept in one go
        anymore (an earlier version did exactly that). The position-resync
        loop (routes/playback.py) can recalibrate position_offset at any
        point during this wait — a real correction, e.g. the device having
        been paused/reconnected externally — and a single up-front sleep
        had no way to notice that, firing on the original stale schedule
        instead: observed live auto-advancing several seconds early,
        cutting off the tail of the still-playing track, after exactly such
        a mid-wait correction. Re-measuring against the live clock on each
        poll (same cadence as the resync loop itself, so this never sleeps
        past a point where a correction could already have landed without
        reacting to it for a whole extra cycle) is what actually fixes
        that — a real edit stays picked up within one more poll instead of
        never at all.

        The loop runs down to _TRACK_END_TOLERANCE rather than to a
        comfortable-looking fraction of a second: whatever is left when it
        breaks is time the *device* is still playing, and advancing the
        queue hands that device a new URI, which cuts the current track off
        mid-note. This used to stop at 0.5s, i.e. clipped the last half
        second off every single track — inaudible on anything that fades or
        ends in silence, obvious on one that stops abruptly. Sleeping the
        remainder costs nothing: the sleep below is already
        min(remaining, ...), so a short remainder is slept exactly, not
        rounded up to a poll interval.
        """
        if wait > _TRACK_END_TOLERANCE:
            logger.info(
                f"[stream] FFmpeg done early — waiting {wait:.1f}s for playback to finish"
            )
            while (
                session.state.clock.play_generation == my_generation
                and session.state.current_track
            ):
                remaining = session.state.clock.seconds_until(_playback_duration(session.state))
                if remaining <= _TRACK_END_TOLERANCE:
                    break
                await asyncio.sleep(min(remaining, POSITION_RESYNC_INTERVAL))
        async with session.play_lock:
            await _advance_or_end(session, my_generation)

    async def stream_with_completion():
        my_generation = session.state.clock.play_generation
        offset_consumed = False

        # One try/finally for this whole generator body — a client
        # disconnect can land anywhere in it, and skipping the finally would
        # permanently leak the connection count incremented in
        # audio_stream() above.
        try:
            # Diagnostic bookkeeping for the cancellation snapshot below —
            # see DisconnectSnapshot for what each of these is meant to
            # distinguish. `last_handoff` is updated *after* each yield
            # returns, so at cancellation time "now - last_handoff" is how
            # long this connection has been blocked handing the current
            # chunk to the device.
            first_byte_at: float | None = None
            last_handoff = time.monotonic()
            bytes_delivered = 0
            try:
                async for chunk in stream_tracks(
                    [track_url],
                    on_track_start=on_track_start,
                    start_offset=offset,
                    gain=session.state.current_track_gain,
                    output_format=output_format,
                ):
                    if first_byte_at is None:
                        first_byte_at = time.monotonic()
                    if not offset_consumed:
                        offset_consumed = True
                        # Only apply either of these once THIS connection has
                        # actually started producing audio — and only if no
                        # newer /play, /seek or /resume has since set a
                        # different one.
                        if session.state.clock.play_generation == my_generation:
                            session.state.clock.resume_offset = 0.0
                            # Marks this generation as "has had audio", which
                            # is what makes the *next* connection for it
                            # recognisable as a reconnect (see `reconnecting`
                            # above). Set here rather than at connection time
                            # because a device can open a connection and
                            # never read from it.
                            session.state.streamed_generation = my_generation
                            if reconnecting:
                                # The device's own position restarts with
                                # this stream, so the frame the resync loop
                                # compares it against has to restart too —
                                # see PlaybackClock.restream_from().
                                session.state.clock.restream_from(offset)
                            # A bare device-initiated reconnect (no /play,
                            # /seek, or /resume involved — the device just
                            # re-requested this URL on its own) never goes
                            # through any of the handlers that otherwise set
                            # is_streaming back to True. Without this, a
                            # false-positive (or even a genuine, since-
                            # recovered) _mark_disconnected_if_not_reconnected
                            # trip leaves is_streaming stuck False for the
                            # rest of the track even once audio is audibly
                            # flowing again — which then also permanently
                            # disables position resync (routes/playback.py's
                            # own is_streaming guard) and auto-advance
                            # (_advance_or_end's), and makes /join reject
                            # with "No active stream" for a session that's
                            # very much still playing.
                            if not session.state.is_streaming:
                                logger.info(
                                    "[stream] is_streaming revived on reconnect "
                                    f"(generation={my_generation}) — audio is "
                                    "flowing again after a disconnect/grace trip"
                                )
                                session.state.is_streaming = True
                                await session.event_bus.broadcast(build_status_dict(session))
                    yield chunk
                    bytes_delivered += len(chunk)
                    last_handoff = time.monotonic()
            except asyncio.CancelledError:
                # client disconnected mid-stream — not a natural end, and
                # often just a brief reconnect blip a fresh connection is
                # about to pick right back up. See
                # _mark_disconnected_if_not_reconnected()'s own docstring
                # for what happens if it doesn't.
                asyncio.create_task(
                    _mark_disconnected_if_not_reconnected(
                        session,
                        my_generation,
                        capture_disconnect_snapshot(
                            session,
                            track,
                            first_byte_at=first_byte_at,
                            last_handoff=last_handoff,
                            bytes_delivered=bytes_delivered,
                        ),
                    )
                )
                raise
            except Exception:
                # ffmpeg itself failed (missing binary, crash, decode error —
                # already logged by stream_tracks()). Not a natural end either:
                # falling through to the track-end broadcast below would make
                # the frontend think this track finished playing and advance the
                # queue, when actually nothing (or only a partial track) played.
                if session.state.clock.play_generation == my_generation:
                    session.state.is_streaming = False
                    await session.event_bus.broadcast(build_status_dict(session))
                return

            # FFmpeg may stream faster than real-time because Sonos buffers aggressively.
            # Schedule completion in an independent task so Sonos closing the connection
            # after receiving all data doesn't cancel the track-end signal.
            st = session.state
            if (
                st.is_streaming
                and not st.clock.is_paused
                and st.clock.play_generation == my_generation
            ):
                wait = 0.0
                if st.current_track and st.clock.play_start_time:
                    wait = st.clock.seconds_until(_playback_duration(st))
                asyncio.create_task(_fire_track_end(my_generation, wait))
        finally:
            # Mirrors the increment in audio_stream() above — this specific
            # connection is done, one way or another (normal completion,
            # ffmpeg failure, or a client disconnect/cancellation).
            session.state.active_stream_connections -= 1

    return StreamingResponse(
        stream_with_completion(),
        media_type=output_format.content_type,
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/status", dependencies=[Depends(require_token)])
async def status(session: SessionState = Depends(get_session)):
    return build_status_dict(session)


@router.get("/events", dependencies=[Depends(require_token)])
async def status_events(session: SessionState = Depends(get_session)):
    queue = session.event_bus.subscribe()

    async def generator():
        try:
            yield "retry: 2000\n\n"
            yield f"data: {json.dumps(build_status_dict(session))}\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=2.0)
                    yield f"data: {json.dumps(payload)}\n\n"
                except TimeoutError:
                    session.touch()
                    if session.state.is_streaming and not session.state.clock.is_paused:
                        yield f"data: {json.dumps(build_status_dict(session))}\n\n"
                    else:
                        yield ": heartbeat\n\n"
        finally:
            session.event_bus.unsubscribe(queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/visualizer", dependencies=[Depends(require_token)])
async def visualizer_events(session: SessionState = Depends(get_session)):
    """Frequency-band frames for the fullscreen visualizer's 'cast' mode
    (AudioVisualizer.vue) — see core/audio_analysis.py.

    An open connection here is also what *causes* the analysis to happen at
    all: the analyzer runs only while at least one client is subscribed (see
    core/visualizer_feed.py), so subscribe()/unsubscribe() around this
    generator aren't bookkeeping, they're the on/off switch. The feed's
    analyzer is re-read every iteration (not captured once) since it's
    replaced on every track change and seek, and is None whenever nothing
    analyzable is playing (nothing streaming at all, or streaming to
    AirPlay/radio) — those periods just heartbeat with no data, same as this
    producing nothing is the frontend's own signal to render nothing rather
    than a fake idle animation."""
    feed = session.visualizer

    async def generator():
        feed.subscribe()
        try:
            while True:
                analyzer = feed.analyzer
                if analyzer is None:
                    await asyncio.sleep(0.5)
                    yield ": idle\n\n"
                    continue
                try:
                    bands = await asyncio.wait_for(analyzer.frames.get(), timeout=1.0)
                    yield f"data: {json.dumps({'bands': bands})}\n\n"
                except TimeoutError:
                    yield ": heartbeat\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            feed.unsubscribe()

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
