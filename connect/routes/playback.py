"""routes/playback.py — /play, /play-url, /pause, /resume, /stop"""

import asyncio
import logging
import time

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.auth import require_token
from core.claims import claims
from core.session import (
    SessionState,
    build_status_dict,
    check_claims,
    compute_position,
    displace_target,
    registry,
    require_authenticated_session,
)
from core.state import AppState, list_target_pairs, resolve_target, stream_url
from core.streamer import FALLBACK_FORMAT, resolve_output_format

logger = logging.getLogger("connect.playback")
router = APIRouter(dependencies=[Depends(require_token)])


# Backend safety net for /play and /play-url: an identical dispatch to the
# same target arriving faster than this is treated as a duplicate and not
# re-sent to the delivery target. The frontend has its own idempotency guard
# (use-connect-playback.ts), but this doesn't rely on it holding — a buggy
# effect, a stray extra client, or a future regression re-issuing
# SetAVTransportURI/Play in a loop stops and restarts the device before it
# can buffer any audio. Well above a realistic manual double-click, well
# below "the frontend is actually starting something new".
DUPLICATE_DISPATCH_COOLDOWN = 1.0


def _is_duplicate_dispatch(st: AppState, key: str) -> bool:
    """True if `key` matches the last dispatch and it happened within
    DUPLICATE_DISPATCH_COOLDOWN — and leaves state untouched. Otherwise
    records `key` as the new last dispatch and returns False."""
    now = time.time()
    if key == st.last_dispatch_key and now - st.last_dispatch_at < DUPLICATE_DISPATCH_COOLDOWN:
        return True
    st.last_dispatch_key = key
    st.last_dispatch_at = now
    return False


async def _claim_or_takeover(target, session: SessionState, force: bool) -> dict | None:
    """Wraps check_claims()+displace_target(): returns a device_in_use error
    dict on refusal (force=False), otherwise None after stopping delivery for
    any target a force=True takeover just displaced."""
    error, displaced = await check_claims(target, session, force=force)
    if error:
        return error
    for target_type, name, owner in displaced:
        owner_session = registry.get(owner)
        if owner_session:
            await displace_target(owner_session, target_type, name)
    return None


async def _release_claims(target, session: SessionState) -> None:
    """Release every (type, name) claim `target` holds for `session` — used
    when a delivery's play() raises right after _claim_or_takeover() granted
    the claim, so a failed dispatch doesn't leave the device locked to this
    session (device_in_use for everyone else) with nothing actually playing
    on it."""
    for target_type, name in list_target_pairs(target):
        await claims.release(target_type, name, session.session_id)


# A device reporting itself this far *ahead* of the wall clock this early
# into a stream is a stale/bogus reading, not real startup-buffering lag —
# see _apply_position_offset().
MAX_PLAUSIBLE_POSITION_LEAD = 15.0

# Rough guess applied immediately for devices with real position feedback
# (Sonos/Chromecast/DLNA), before the actual per-device measurement below
# has had a chance to complete — that can take a couple of seconds (the
# polling loop only checks every 0.5s), and starting from "no delay" for
# that whole gap is almost always more wrong than a reasonable guess, since
# practically every cast protocol has *some* startup buffering. Splitting
# the difference between "no delay" and AirPlay's own permanent fixed
# estimate (2.0s, the one case with no better option than a guess like
# this at all) — overwritten the moment a real measurement lands.
PROVISIONAL_STARTUP_DELAY = 1.0


async def _apply_position_offset(
    session: SessionState, target, generation: int
) -> None:
    """Set `position_offset` for the track that just started playing.

    `compute_position()` returns `wall_elapsed + position_offset`. A device
    that's buffering lags behind the wall clock, so `position_offset` is
    normally negative (e.g. -2s for AirPlay's startup buffer). This is what
    keeps the lyrics view in sync with what's actually audible.

    AirPlay has no position feedback, so it gets a fixed startup-buffering
    estimate (FIXED_OFFSET, a positive "delay" magnitude). Sonos/Chromecast
    expose real device position — poll briefly once to measure the actual
    delay, then keep it constant for the rest of the track (re-buffering
    mid-track is not accounted for).
    """
    st = session.state
    deliveries = getattr(target, "deliveries", [target])

    fixed = max((d.FIXED_OFFSET for d in deliveries), default=0.0)
    if fixed:
        st.clock.set_fixed_offset(-fixed)
        logger.info(
            f"[lyrics-sync] fixed position_offset={st.clock.position_offset:.2f}s"
        )
        await session.event_bus.broadcast(build_status_dict(session))
        return

    candidate = next((d for d in deliveries if d.SUPPORTS_POSITION), None)
    if candidate is None:
        return

    # Same guard the polling loop below uses — without it, a stale task
    # (this generation already superseded by a newer /play or /seek before
    # this task got to run at all) would stomp the *current* track's clock
    # with a provisional guess meant for a track that isn't playing anymore.
    if st.clock.play_generation != generation or not st.is_streaming:
        return

    st.clock.set_fixed_offset(-PROVISIONAL_STARTUP_DELAY)
    logger.info(
        f"[lyrics-sync] {candidate.target}: provisional position_offset="
        f"{st.clock.position_offset:.2f}s (measuring...)"
    )
    await session.event_bus.broadcast(build_status_dict(session))

    deadline = time.time() + 10.0
    while time.time() < deadline:
        await asyncio.sleep(0.5)
        if st.clock.play_generation != generation or not st.is_streaming:
            return
        try:
            device_pos = await candidate.get_position()
        except Exception:
            continue
        if not device_pos:
            continue
        wall_elapsed = st.clock.elapsed_since_stream_start()
        # A genuine startup-buffering delay makes the device *lag* the wall
        # clock by a few seconds at most. A device reporting a position well
        # *ahead* of the wall clock this early is a stale/bogus reading, not
        # real lag — observed with a DLNA renderer reporting a fixed ~56s
        # position mere seconds into a brand new stream (seemingly left over
        # from before it caught up to the new URI). Trusting it would show
        # the track as "starting" tens of seconds in even though it's audible
        # from 0:00. Keep polling instead — most devices settle within the
        # deadline; if none do, no calibration is applied at all, which is
        # still far closer to correct than a wildly wrong one.
        if device_pos - wall_elapsed > MAX_PLAUSIBLE_POSITION_LEAD:
            logger.warning(
                f"[lyrics-sync] {candidate.target}: ignoring implausible "
                f"device position {device_pos:.2f}s vs. wall {wall_elapsed:.2f}s"
            )
            continue
        offset = st.clock.calibrate(device_pos)
        logger.info(
            f"[lyrics-sync] {candidate.target}: calibrated position_offset="
            f"{offset:.2f}s (device {device_pos:.2f}s vs. wall {wall_elapsed:.2f}s)"
        )
        await session.event_bus.broadcast(build_status_dict(session))
        return


def _current_track_play_args(
    session: SessionState,
) -> tuple[str, str, str | None, float | None, str]:
    """Return (title, artist, album_art_url, duration, album) for the current
    track, used when restarting the stream (resume/seek) so Now-Playing
    metadata isn't lost. album_art_url uses internal=True — it's fetched
    directly by the cast device (Sonos/Chromecast/AirPlay/DLNA), not the
    browser, so it must use a LAN-reachable address (see MediaClient.
    get_cover_art_url's docstring)."""
    track = session.state.current_track
    if not track:
        return "Connect", "", None, None, ""
    return (
        track.title,
        track.artist,
        session.media.get_cover_art_url(track.cover_art_id, internal=True),
        float(track.duration),
        track.album,
    )


def _current_reconnect_args(
    session: SessionState,
) -> tuple[str, str, str, str | None, float | None, str, str]:
    """Return (url, title, artist, album_art_url, duration, album,
    content_type) to hand back to target.play() when reconnecting to
    whatever's currently loaded — used by /resume and /seek. A queued track
    goes back through the FFmpeg /stream proxy; radio has no track loaded
    (session.state.current_track is None for it — see /play-url) and must
    reconnect to its own raw URL instead, or the device gets a 204 from
    /stream and silently stops. content_type reuses whatever /play already
    resolved for current_track (see core/streamer.py's resolve_output_format())
    — the track hasn't changed, so there's no need to probe again."""
    st = session.state
    if st.radio_info:
        return st.radio_info["url"], st.radio_info["title"], "", None, None, "", "audio/mpeg"
    title, artist, album_art_url, duration, album = _current_track_play_args(session)
    return (
        stream_url(session.session_id),
        title,
        artist,
        album_art_url,
        duration,
        album,
        st.current_output_format.content_type,
    )


class PlayRequest(BaseModel):
    track_ids: list[str]
    targets: list[dict] | None = None
    target_name: str | None = None
    target_type: str | None = None
    # Linear amplitude multiplier from the frontend's ReplayGain settings (1 = no
    # change). Passed straight to ffmpeg's `volume` filter, which uses the same
    # convention. See core/streamer.py.
    gain: float = 1.0
    # Seconds into the track to start at (e.g. the position local playback had
    # reached when the user connected mid-track). 0 starts from the beginning.
    start_position: float = 0.0
    # Take over any target already claimed by another session instead of
    # refusing (Phase 2 — the user confirmed a takeover dialog).
    force: bool = False
    # Strictly increasing per-session dispatch counter — see SessionState.
    # play_seq's comment. 0 (the default) opts out of the staleness check.
    seq: int = 0


def _is_stale_seq(session: SessionState, seq: int) -> bool:
    """True if `seq` has already been superseded by a later dispatch this
    session accepted — see SessionState.play_seq's comment. seq=0 (no
    ordering info supplied) never counts as stale. Must only be called while
    holding session.play_lock."""
    return seq != 0 and seq < session.play_seq


@router.post("/play")
async def play_tracks(
    req: PlayRequest, session: SessionState = Depends(require_authenticated_session)
):
    if not session.media.base_url:
        logger.warning(
            "[play] Rejected: media server not configured (waiting for /config)"
        )
        return {
            "error": "Media server not configured — waiting for /config"
        }
    if not req.track_ids:
        return {"error": "No track ID provided"}

    async with session.play_lock:
        # Checked (and, on acceptance, recorded) inside the lock so a
        # slower-to-arrive-but-actually-older request can never sneak its
        # target.play() dispatch in between a newer request's own check and
        # its device call — see SessionState.play_lock's comment.
        if _is_stale_seq(session, req.seq):
            logger.info(
                f"[play] Ignoring superseded request (seq={req.seq} < {session.play_seq})"
            )
            return {"status": "superseded"}
        if req.seq:
            session.play_seq = req.seq

        track_id = req.track_ids[0]
        try:
            track = session.media.get_track(track_id)
        except Exception as e:
            logger.warning(f"[play] Track {track_id} not found: {e}")
            return {"error": f"Track not found: {e}"}

        target = resolve_target(
            req.targets, req.target_name, req.target_type, previous=session.state.active_delivery
        )
        url = stream_url(session.session_id)
        start_position = max(0.0, min(req.start_position, float(track.duration)))
        logger.info(
            f"[play] {track.artist} — {track.title} ({track.duration}s) → target={target}"
            + (f" (start {start_position:.1f}s)" if start_position > 0.5 else "")
        )

        # Resolved once here and cached on session.state — /stream reads it
        # for its own Content-Type header instead of probing again (see
        # core/streamer.py's resolve_output_format()). to_thread: get_stream_url()
        # is instant for Subsonic/Jellyfin but Plex's needs a real network
        # lookup first (see media/plex.py's docstring); resolve_output_format()
        # itself shells out to ffmpeg, also blocking.
        track_url = await asyncio.to_thread(session.media.get_stream_url, track.id)
        output_format = await resolve_output_format(track_url)

        if target:
            conflict = await _claim_or_takeover(target, session, req.force)
            if conflict:
                return conflict

        st = session.state

        if target:
            # internal=True: fetched directly by the cast device, not the browser —
            # see MediaClient.get_cover_art_url's docstring.
            album_art_url = session.media.get_cover_art_url(track.cover_art_id, internal=True)
            if not _is_duplicate_dispatch(st, f"play:{target}:{track_id}"):
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
                    logger.error(f"[play] Delivery error: {e}", exc_info=True)
                    # Dispatch never actually reached the device — release the
                    # claim just granted above instead of leaving it locked to
                    # this session (device_in_use for everyone else) with
                    # nothing actually playing on it.
                    await _release_claims(target, session)
                    return {"error": str(e)}

        st.current_track = track
        st.current_track_gain = req.gain
        st.current_output_format = output_format
        st.is_streaming = True
        st.radio_info = None
        st.clock.start(start_position)
        st.track_ended = False
        st.active_delivery = target

        if not target:
            logger.info(f"[play] No target — stream available at {url}")
            await session.event_bus.broadcast(build_status_dict(session))
            return {"status": "playing", "stream_url": url}

        asyncio.create_task(
            _apply_position_offset(session, target, st.clock.play_generation)
        )
        await session.event_bus.broadcast(build_status_dict(session))
        return {"status": "playing", "stream_url": url}


class PlayUrlRequest(BaseModel):
    url: str
    title: str = "Radio"
    targets: list[dict] | None = None
    target_name: str | None = None
    target_type: str | None = None
    # See PlayRequest.force.
    force: bool = False
    # See PlayRequest.seq.
    seq: int = 0


@router.post("/play-url")
async def play_url(
    req: PlayUrlRequest, session: SessionState = Depends(require_authenticated_session)
):
    # For AirPlay, this URL is fetched server-side (pyatv.stream.stream_file —
    # see delivery/airplay.py), not just handed to the device — restricting
    # to http(s) blocks e.g. file:// local-file reads without breaking
    # legitimate LAN-hosted radio streams, which are otherwise indistinguishable
    # from any other http(s) URL.
    if not req.url.lower().startswith(("http://", "https://")):
        return {"error": "Only http:// and https:// radio URLs are supported"}

    target = resolve_target(
        req.targets, req.target_name, req.target_type, previous=session.state.active_delivery
    )
    if not target:
        return {"error": "No target configured"}

    async with session.play_lock:
        # See /play's identical guard — shares the same seq counter/lock
        # since play-url and play both decide "what's current" for a session.
        if _is_stale_seq(session, req.seq):
            logger.info(
                f"[play-url] Ignoring superseded request (seq={req.seq} < {session.play_seq})"
            )
            return {"status": "superseded"}
        if req.seq:
            session.play_seq = req.seq

        # Logged before the claim check, like /play — so a radio start attempt
        # that gets refused with device_in_use still shows up, instead of only
        # logging on success.
        logger.info(f"[play-url] Radio '{req.title}' → {req.url[:80]}, target={target}")

        conflict = await _claim_or_takeover(target, session, req.force)
        if conflict:
            logger.info(f"[play-url] Refused: {conflict}")
            return conflict

        st = session.state

        if not _is_duplicate_dispatch(st, f"play-url:{target}:{req.url}"):
            try:
                await target.play(req.url, req.title)
            except Exception as e:
                logger.error(f"[play-url] Delivery error: {e}", exc_info=True)
                # See /play's identical comment — don't leave the device locked
                # to this session when nothing actually started playing on it.
                await _release_claims(target, session)
                return {"error": str(e)}

        st.current_track = None
        st.current_output_format = FALLBACK_FORMAT
        st.is_streaming = True
        st.radio_info = {"title": req.title, "url": req.url}
        st.clock.start()
        st.track_ended = False
        st.active_delivery = target

        asyncio.create_task(
            _apply_position_offset(session, target, st.clock.play_generation)
        )
        await session.event_bus.broadcast(build_status_dict(session))
        return {"status": "playing", "url": req.url}


@router.post("/pause")
async def pause_playback(session: SessionState = Depends(require_authenticated_session)):
    if not session.media.base_url:
        # Same "session forgot everything" case /play guards against — a
        # reaped-then-recreated session has no active_delivery to actually
        # pause, but would otherwise silently report success anyway (see
        # git history for the incident this fixes). Surfacing an error here
        # lets the frontend detect the loss and reset to disconnected
        # instead of leaving the play/pause button toggling a phantom
        # session forever with no visible effect.
        logger.warning(
            "[pause] Rejected: media server not configured (waiting for /config)"
        )
        return {
            "error": "Media server not configured — waiting for /config"
        }
    async with session.play_lock:
        st = session.state
        if st.active_delivery:
            await st.active_delivery.pause()
        elapsed = compute_position(session)
        st.clock.pause(elapsed)
        logger.info(f"[pause] ⏸ {elapsed:.1f}s into track")
        await session.event_bus.broadcast(build_status_dict(session))
        return {"paused": True}


@router.post("/resume")
async def resume_playback(session: SessionState = Depends(require_authenticated_session)):
    if not session.media.base_url:
        # See /pause's identical guard above for why this matters.
        logger.warning(
            "[resume] Rejected: media server not configured (waiting for /config)"
        )
        return {
            "error": "Media server not configured — waiting for /config"
        }
    async with session.play_lock:
        st = session.state
        st.clock.resume()

        logger.info(f"[resume] ▶ Seeking to {st.clock.resume_offset:.1f}s")

        if st.active_delivery:
            # Force a fresh /stream connection so FFmpeg applies the seek offset
            # (radio reconnects to its own URL instead — see _current_reconnect_args).
            try:
                await st.active_delivery.play(*_current_reconnect_args(session))
            except Exception as e:
                # Match /play's contract: a JSON {"error": ...} body, not an
                # unhandled exception surfacing as a 500 (the device may have
                # gone unreachable while paused).
                logger.error(f"[resume] Delivery error: {e}", exc_info=True)
                return {"error": str(e)}

        await session.event_bus.broadcast(build_status_dict(session))
        return {"paused": False}


class SeekRequest(BaseModel):
    position: float


@router.post("/seek")
async def seek_playback(
    body: SeekRequest, session: SessionState = Depends(require_authenticated_session)
):
    async with session.play_lock:
        st = session.state
        position = max(0.0, body.position)
        if st.current_track:
            position = min(position, st.current_track.duration)

        st.clock.seek_to(position)

        if not st.clock.is_paused and st.active_delivery:
            try:
                await st.active_delivery.play(*_current_reconnect_args(session))
            except Exception as e:
                # See /resume's identical comment.
                logger.error(f"[seek] Delivery error: {e}", exc_info=True)
                return {"error": str(e)}
            # The reconnect above starts a *fresh* stream (FFmpeg output restarts
            # near 0 again), which re-incurs the device's startup-buffering delay
            # — same as a brand new /play. Without recalibrating here,
            # position_offset keeps whatever value was measured for the *previous*
            # stream (or 0.0 right after a fresh /play), so elapsed() runs ahead
            # of what's actually audible until the track ends. See
            # _apply_position_offset()'s docstring and the identical calls from
            # /play and /play-url above.
            asyncio.create_task(
                _apply_position_offset(session, st.active_delivery, st.clock.play_generation)
            )

        logger.info(f"[seek] ⏩ {position:.1f}s")
        await session.event_bus.broadcast(build_status_dict(session))
        return {"position": position}


@router.post("/stop")
async def stop_playback(session: SessionState = Depends(require_authenticated_session)):
    async with session.play_lock:
        st = session.state
        if st.active_delivery:
            await st.active_delivery.stop()
        # Playback is genuinely ending here (unlike a track just finishing
        # normally, see routes/stream.py's finish_feeding()) — no reason to let
        # a still-draining analyzer keep running for content that was stopped.
        if session.audio_analyzer:
            await session.audio_analyzer.stop()
            session.audio_analyzer = None
        st.is_streaming = False
        st.clock.is_paused = False
        st.track_ended = False
        st.current_track = None
        st.current_output_format = FALLBACK_FORMAT
        st.radio_info = None
        st.active_delivery = None
        st.last_dispatch_key = None
        await claims.release_all_for_session(session.session_id)
        logger.info("[stop] ⏹ Playback stopped")
        await session.event_bus.broadcast(build_status_dict(session))
        return {"status": "stopped"}
