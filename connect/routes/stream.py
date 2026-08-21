"""routes/stream.py — GET /stream/{session_id}, GET /status, GET /events, GET /visualizer"""

import asyncio
import json
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import Response, StreamingResponse

from core.audio_analysis import AudioAnalyzer, should_analyze
from core.auth import require_token
from core.session import (
    DEFAULT_SESSION_ID,
    SessionState,
    build_status_dict,
    get_session,
    registry,
)
from core.state import PORT, list_target_pairs, stream_url
from core.streamer import demuxer_for, resolve_output_format, stream_tracks
from routes.debug import TEST_TONE_TRACK_ID

from .playback import (
    POSITION_RESYNC_INTERVAL,
    POSITION_RESYNC_THRESHOLD,
    _apply_position_offset,
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
    output_format = await resolve_output_format(track_url, gain=gain)
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
    except Exception as e:
        logger.error(f"[stream] Auto-advance delivery error: {e}", exc_info=True)
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
        try:
            next_track = session.media.get_track(next_track_id)
        except Exception as e:
            logger.warning(f"[stream] Auto-advance: track {next_track_id} not found: {e}")
            next_track = None
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


async def _mark_disconnected_if_not_reconnected(session: SessionState, my_generation: int) -> None:
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
    """
    await asyncio.sleep(STREAM_DISCONNECT_GRACE_SECONDS)
    st = session.state
    if (
        st.clock.play_generation == my_generation
        and st.active_stream_connections == 0
        and st.is_streaming
        and not st.clock.is_paused
    ):
        logger.warning(
            f"[stream] No reconnect within {STREAM_DISCONNECT_GRACE_SECONDS:.0f}s "
            "of a dropped connection — marking not streaming"
        )
        st.is_streaming = False
        await session.event_bus.broadcast(build_status_dict(session))


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
        # Loopback, not stream_url()'s LAN IP: ffmpeg fetches this from inside
        # the same process/container, not from the cast device.
        # to_thread: get_stream_url() is a pure, instant string builder for
        # Subsonic/Jellyfin, but Plex's needs a real network lookup first (see
        # media/plex.py's docstring) — without this, that lookup would block
        # the whole event loop, not just this one request/session.
        track_url = (
            f"http://127.0.0.1:{PORT}/debug/test-tone.wav"
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

    # TEMPORARY — chasing a report where pausing/resuming a Sonos speaker
    # from its own remote (not through Beacon's /pause and /resume) left
    # audio broken. resume_offset is only ever set by OUR OWN /play, /seek
    # and /resume handlers (see PlaybackClock) — it has no way to reflect a
    # reconnect the device itself initiated, e.g. re-requesting this URL
    # after a local pause/resume cycle. If that's what's happening, this
    # connection arrives while is_streaming is still True from the
    # *previous* connection, and `offset` (already consumed/reset to 0 by
    # that previous connection — see the comment above) has drifted far
    # from clock.elapsed(), the position our own resync loop has been
    # calibrating against the device this whole time — i.e. the device
    # would be about to receive audio from the wrong point in the track
    # while our own position display, self-correcting via a *different*
    # mechanism (position_offset, not resume_offset), keeps reporting the
    # right one. A large gap here is exactly that mismatch; remove once
    # confirmed (or ruled out) from real logs.
    #
    # Gated on the drift actually being large, not just `is_streaming`
    # being True on its own — that's true for basically the entire
    # session (only False once the queue genuinely ends), so the earlier,
    # ungated version of this fired on *every* ordinary track change too:
    # auto-advance and every explicit /play both reset the clock (offset
    # ≈ elapsed ≈ 0 for a fresh track) right before dispatching, which is
    # a legitimate reconnect this was never meant to flag. Reusing
    # POSITION_RESYNC_THRESHOLD here isn't about resync tolerance — it's
    # just already the app's own answer to "how big a gap is actually
    # worth a look", so a second magic number isn't needed for it.
    if session.state.is_streaming:
        drift = session.state.clock.elapsed() - offset
        if abs(drift) > POSITION_RESYNC_THRESHOLD:
            logger.warning(
                f"[stream] Reconnect while already streaming — offset={offset:.2f}s "
                f"(this connection's -ss) vs. clock.elapsed()={session.state.clock.elapsed():.2f}s "
                f"(calibrated position) — drift={drift:+.2f}s, "
                f"play_generation={session.state.clock.play_generation}"
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
        """
        if wait > 0.5:
            logger.info(
                f"[stream] FFmpeg done early — waiting {wait:.1f}s for playback to finish"
            )
            while (
                session.state.clock.play_generation == my_generation
                and session.state.current_track
            ):
                remaining = session.state.clock.seconds_until(
                    session.state.current_track.duration
                )
                if remaining <= 0.5:
                    break
                await asyncio.sleep(min(remaining, POSITION_RESYNC_INTERVAL))
        async with session.play_lock:
            await _advance_or_end(session, my_generation)

    async def stream_with_completion():
        my_generation = session.state.clock.play_generation
        offset_consumed = False
        # AirPlay/radio never end up here with a live-analyzable target (see
        # should_analyze()'s docstring) — stays None for them, and GET
        # /visualizer below just has nothing to send. Declared here (not
        # inside the try below) only so the finally can reach it even if
        # analyzer setup itself is what fails/gets cancelled.
        analyzer: AudioAnalyzer | None = None

        # One try/finally for this whole generator body, analyzer setup
        # included — analyzer.start()/previous.stop() below are real
        # awaits, and a client disconnect landing during either of those
        # (not just during the streaming loop further down) used to skip
        # the finally entirely, permanently leaking the connection count
        # incremented in audio_stream() above.
        try:
            target_pairs = list_target_pairs(session.state.active_delivery)
            if should_analyze(target_pairs):
                logger.debug(f"[stream] Live analysis enabled — targets={target_pairs}")
                # Paced against the same calibrated clock /status's `elapsed`
                # uses — not a fixed bitrate timeline, which can't account for
                # the device's own startup-buffering delay (see
                # AudioAnalyzer's docstring). `offset` is where in the track
                # this connection's first byte actually starts.
                analyzer = AudioAnalyzer(
                    elapsed_fn=lambda: session.state.clock.elapsed(),
                    start_offset=offset,
                    input_format=demuxer_for(output_format),
                )
                await analyzer.start()
                previous = session.audio_analyzer
                session.audio_analyzer = analyzer
                if previous:
                    await previous.stop()
            else:
                # Diagnostic for exactly this "visualizer only ever shows
                # heartbeats" symptom — tells apart "no live-analyzable target at
                # all" (targets=[], or all-AirPlay) from a case where a
                # sonos/dlna/chromecast target genuinely should have qualified.
                logger.debug(
                    f"[stream] Live analysis skipped — targets={target_pairs}, "
                    f"active_delivery={session.state.active_delivery!r}"
                )

            try:
                async for chunk in stream_tracks(
                    [track_url],
                    on_track_start=on_track_start,
                    start_offset=offset,
                    gain=session.state.current_track_gain,
                    output_format=output_format,
                ):
                    if not offset_consumed:
                        offset_consumed = True
                        # Only apply either of these once THIS connection has
                        # actually started producing audio — and only if no
                        # newer /play, /seek or /resume has since set a
                        # different one.
                        if session.state.clock.play_generation == my_generation:
                            session.state.clock.resume_offset = 0.0
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
                                session.state.is_streaming = True
                                await session.event_bus.broadcast(build_status_dict(session))
                    if analyzer:
                        analyzer.feed(chunk)
                    yield chunk
            except asyncio.CancelledError:
                # client disconnected mid-stream — not a natural end, and
                # often just a brief reconnect blip a fresh connection is
                # about to pick right back up. See
                # _mark_disconnected_if_not_reconnected()'s own docstring
                # for what happens if it doesn't.
                asyncio.create_task(_mark_disconnected_if_not_reconnected(session, my_generation))
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
                    wait = st.clock.seconds_until(st.current_track.duration)
                asyncio.create_task(_fire_track_end(my_generation, wait))
        finally:
            # Mirrors the increment in audio_stream() above — this specific
            # connection is done, one way or another (normal completion,
            # ffmpeg failure, or a client disconnect/cancellation, including
            # one during analyzer setup itself).
            session.state.active_stream_connections -= 1
            # finish_feeding(), not stop() — ffmpeg finishing early (well
            # before the track's actual duration, since it's CPU-bound
            # transcoding rather than real-time-throttled) just means this
            # generator itself is done; the analyzer keeps draining
            # whatever it's already buffered at the normal real-time pace
            # and exits on its own once that's genuinely exhausted. session.
            # audio_analyzer deliberately stays pointed at it — GET
            # /visualizer needs to keep reading from it while it drains.
            # See routes/playback.py's /stop for the actual hard teardown.
            if analyzer:
                analyzer.finish_feeding()

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
    (AudioVisualizer.vue) — see core/audio_analysis.py. session.audio_analyzer
    is re-read every iteration (not captured once) since stream_with_completion()
    above replaces it on every track change, and is None whenever nothing
    live-analyzable is currently playing (nothing streaming at all, or
    streaming to AirPlay/radio) — those periods just heartbeat with no data,
    same as this producing nothing is the frontend's own signal to render
    nothing rather than a fake idle animation."""

    async def generator():
        try:
            while True:
                analyzer = session.audio_analyzer
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

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
