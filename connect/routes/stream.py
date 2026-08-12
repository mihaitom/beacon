"""routes/stream.py — GET /stream/{session_id}, GET /status, GET /events, GET /visualizer"""

import asyncio
import json
import logging
import time

from fastapi import APIRouter, Depends
from fastapi.responses import Response, StreamingResponse

from core.audio_analysis import AudioAnalyzer, should_analyze
from core.auth import require_token
from core.session import DEFAULT_SESSION_ID, SessionState, build_status_dict, get_session, registry
from core.state import PORT, list_target_pairs
from core.streamer import stream_tracks
from routes.debug import TEST_TONE_TRACK_ID

logger = logging.getLogger("connect.stream")
router = APIRouter()


@router.head("/stream")
@router.head("/stream/{session_id}")
async def audio_stream_head(session_id: str = DEFAULT_SESSION_ID):
    """ffmpeg probes the URL with HEAD before streaming — answer without starting ffmpeg."""
    return Response(
        media_type="audio/mpeg",
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
        return StreamingResponse(iter([b""]), media_type="audio/mpeg", status_code=204)

    track = session.state.current_track
    # Debug-only special case (see routes/debug.py) — the test tone isn't a
    # real library track, so there's nothing for session.media to resolve.
    # Loopback, not stream_url()'s LAN IP: ffmpeg fetches this from inside
    # the same process/container, not from the cast device.
    track_url = (
        f"http://127.0.0.1:{PORT}/debug/test-tone.wav"
        if track.id == TEST_TONE_TRACK_ID
        else session.media.get_stream_url(track.id)
    )

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

    logger.info(
        f"[stream] Client connected — {track.artist} — {track.title}"
        + (f" (seek {offset:.1f}s)" if offset > 0.5 else "")
    )

    def on_track_start(_: int) -> None:
        gain = session.state.current_track_gain
        gain_str = f", gain={gain:.2f}" if gain != 1.0 else ""
        logger.info(
            f"[stream] ▶ {track.artist} — {track.title} ({track.duration}s{gain_str})"
        )

    async def _fire_track_end(my_generation: int, wait: float) -> None:
        """Fires track-end signal after waiting for Sonos to finish playback.

        Runs as an independent task so Sonos closing the HTTP connection cannot
        cancel it (that CancelledError would only affect stream_with_completion).
        """
        if wait > 0.5:
            logger.info(
                f"[stream] FFmpeg done early — waiting {wait:.1f}s for playback to finish"
            )
            await asyncio.sleep(wait)
        st = session.state
        if (
            st.is_streaming
            and not st.clock.is_paused
            and st.clock.play_generation == my_generation
        ):
            logger.info("[stream] Track finished — marking stream complete")
            st.is_streaming = False
            st.track_ended = True
            await session.event_bus.broadcast(build_status_dict(session))

    async def stream_with_completion():
        my_generation = session.state.clock.play_generation
        offset_consumed = False

        # AirPlay/radio never end up here with a live-analyzable target (see
        # should_analyze()'s docstring) — analyzer stays None for them, and
        # GET /visualizer below just has nothing to send.
        analyzer: AudioAnalyzer | None = None
        if should_analyze(list_target_pairs(session.state.active_delivery)):
            # Paced against the same calibrated clock /status's `elapsed`
            # uses — not a fixed bitrate timeline, which can't account for
            # the device's own startup-buffering delay (see
            # AudioAnalyzer's docstring). `offset` is where in the track
            # this connection's first byte actually starts.
            analyzer = AudioAnalyzer(
                elapsed_fn=lambda: session.state.clock.elapsed(), start_offset=offset
            )
            await analyzer.start()
            previous = session.audio_analyzer
            session.audio_analyzer = analyzer
            if previous:
                await previous.stop()

        try:
            try:
                async for chunk in stream_tracks(
                    [track_url],
                    on_track_start=on_track_start,
                    start_offset=offset,
                    gain=session.state.current_track_gain,
                ):
                    if not offset_consumed:
                        offset_consumed = True
                        # Only clear resume_offset once THIS connection has
                        # actually started producing audio — and only if no newer
                        # /play, /seek or /resume has since set a different one.
                        if session.state.clock.play_generation == my_generation:
                            session.state.clock.resume_offset = 0.0
                    if analyzer:
                        analyzer.feed(chunk)
                    yield chunk
            except asyncio.CancelledError:
                raise  # client disconnected mid-stream — not a natural end
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
                    wait = max(
                        0.0,
                        (st.clock.play_start_time + st.current_track.duration)
                        - time.time(),
                    )
                asyncio.create_task(_fire_track_end(my_generation, wait))
        finally:
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
        media_type="audio/mpeg",
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
                except asyncio.TimeoutError:
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
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
