"""routes/playback.py — /play, /play-url, /pause, /resume, /stop"""

import asyncio
import copy
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any, Literal, NamedTuple

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from core import cast_permissions, equalizer
from core.auth import require_token
from core.cast_position import start_position_sync
from core.claims import claims
from core.local_mixes import SongEntry
from core.playlist_url import resolve_stream_url
from core.radio_position import RadioPositionTracker
from core.radio_relay import relay_format_for_target
from core.replay_gain import ReplayGainMode
from core.session import (
    SessionState,
    build_status_dict,
    check_claims,
    clock_position,
    current_stream_dispatch,
    displace_target,
    mark_delivery_failed,
    mark_interrupted,
    registry,
    require_authenticated_session,
    track_label,
)
from core.state import (
    AppState,
    audio_capability_limits,
    first_radio_position_delivery,
    list_target_pairs,
    playable_codecs,
    radio_stream_url,
    resolve_target,
    stream_url,
)
from core.stream_format import content_type_from_extension, probe_stream
from core.streamer import (
    FALLBACK_FORMAT,
    REASON_DEVICE_REJECTED_STREAM,
    OutputFormat,
    resolve_output_format,
)
from delivery.base import PlaybackFailure
from delivery.errors import REASON_STATION_REFUSED, delivery_error_response, device_label

from . import mix_cast
from .local_mix import MixSong
from .mix_cast import SongHint, TransitionSettings, transitions_on

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


# update_queue()'s own dedup window — wide enough to cover a real
# getSimilarSongs2() round trip to the media server (what separates two
# racing clients' /queue POSTs, see _is_duplicate_queue_topup()'s own
# docstring), unlike DUPLICATE_DISPATCH_COOLDOWN above which only needs to
# catch a tight re-issue loop.
QUEUE_TOPUP_DEDUP_WINDOW = 8.0


def _is_duplicate_queue_topup(st: AppState, prev_queue: list[str], song_ids: list[str]) -> bool:
    """True if `song_ids` doesn't extend the *current* `prev_queue` (== the
    live session.state.queue) but does extend the queue as it stood right
    before the last accepted top-up, within QUEUE_TOPUP_DEDUP_WINDOW.

    Guards specifically against two frontends sharing a cast session both
    noticing the queue running low off the same mirrored SSE status and
    independently topping it up: each does its own getSimilarSongs2() round
    trip and then POSTs its own full queue here, each extension computed
    against the *same* pre-top-up queue neither has seen the other's edit to
    yet. Without this, whichever POST takes session.play_lock second
    silently overwrites the first client's addition (update_queue() is a
    full replacement, not a merge) — and by the time it arrives, `prev_queue`
    (now already carrying the first client's addition) no longer matches
    what the second one actually extended, so comparing against it directly
    would miss the race entirely. Reported live 2026-08-29 as songs
    flickering in and out of the queue drawer.

    A tail-extension of the *current* `prev_queue` — a genuinely new top-up,
    or the very first one — is never a duplicate: it's recorded as the new
    pre-top-up base and applied normally.

    Only asked for requests the frontend marks as an Autoplay top-up
    (QueueRequest.autoplay_topup): by shape alone, a "Play next" inserted
    right after the current song extends the pre-top-up base too, and a
    removal of a just-added song can as well."""

    def extends(base: list[str]) -> bool:
        return len(song_ids) > len(base) and song_ids[: len(base)] == base

    if extends(prev_queue):
        st.last_queue_topup_base = prev_queue
        st.last_queue_topup_at = time.time()
        return False

    return (
        st.last_queue_topup_base is not None
        and time.time() - st.last_queue_topup_at < QUEUE_TOPUP_DEDUP_WINDOW
        and extends(st.last_queue_topup_base)
    )


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


def _no_longer_relayed(radio_info: dict | None) -> dict | None:
    """`radio_info` with its relay forgotten — for a rollback to a station
    whose relay has already been torn down by the switch that then failed.
    Drops the announced device type along with the flag: that described the
    relay's output, and without one this station would be dispatched
    straight to the device again (see radio_content_type())."""
    if radio_info is None:
        return None
    return {**radio_info, "relayed": False, "device_content_type": None}


async def retry_radio_via_proxy(session: SessionState, target) -> bool:
    """Point a device at Beacon's own re-encoded copy of the station it
    just refused. Returns whether it started.

    Two very different refusals reach here, and this fixes both without
    having to tell them apart: a format the device won't decode
    (ERROR_UNSUPPORTED_FORMAT for an `audio/aacp` station), and a
    transport it won't use (ERROR_ACCESS_DENIED for an https URL on
    someone else's host — seen on a plain MP3, so not a format problem at
    all). Through /stream/radio it is MP3 over http from this machine
    either way.

    Only ever a second attempt, never the first: Beacon hands a station's
    own bytes to the device by default, and pays the re-encode only for a
    station that has actually been refused. `proxied` marks that it has
    happened so a device that refuses even this doesn't loop — see the
    guard at both call sites."""
    st = session.state
    if not st.radio_info or st.radio_info.get("proxied"):
        return False

    url = radio_stream_url(session.session_id)
    logger.info(f"[play-url] {target} refused the station — retrying via {url}")
    try:
        await target.play(url, st.radio_info["title"], content_type=FALLBACK_FORMAT.content_type)
    except Exception:
        logger.exception("[play-url] Re-encoded retry failed too")
        return False

    st.radio_info = {
        **st.radio_info,
        "proxied": True,
        "content_type": FALLBACK_FORMAT.content_type,
        "device_content_type": FALLBACK_FORMAT.content_type,
    }
    # What the stream-info panel reads — the listener sees that Beacon is
    # re-encoding and why, rather than a station that silently sounds
    # different from the one they picked (see StreamInfoSection.vue and
    # core/streamer.py's REASON_DEVICE_REJECTED_STREAM).
    st.current_output_format = replace(
        FALLBACK_FORMAT, transcode_reason=REASON_DEVICE_REJECTED_STREAM
    )
    await session.event_bus.broadcast(build_status_dict(session))
    return True


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
    url, content_type = current_stream_dispatch(session)
    if st.radio_info:
        return url, st.radio_info["title"], "", None, None, "", content_type
    title, artist, album_art_url, duration, album = _current_track_play_args(session)
    if st.mix is not None:
        duration = None  # a mix goes on with the queue
    return url, title, artist, album_art_url, duration, album, content_type


class PlayRequest(BaseModel):
    # The *full* ordered queue (already-played history included, not just
    # what's left) — see AppState.queue's comment. queue_index below marks
    # which entry is the one to actually dispatch/become current.
    song_ids: list[str]
    # Where in song_ids the track to dispatch sits — defaults to 0, so a
    # caller that only ever sends `[trackId]` (today's simplest case) still
    # behaves exactly as before this field existed.
    queue_index: int = 0
    # Standing shuffle/repeat preferences — see AppState.shuffle/repeat_mode's
    # comment. Purely informational for connect itself (never read outside
    # storing + broadcasting them); shuffle in particular matters together
    # with original_queue below, since toggling shuffle off on *any* client
    # reverts to whatever original_queue that client last saw.
    original_queue: list[str] = []
    shuffle: bool = False
    repeat_mode: Literal["off", "all", "one"] = "off"
    # See AppState.autoplay_enabled/autoplay_batch_size's comment — unlike
    # shuffle/repeat_mode above, connect itself reads these back.
    autoplay_enabled: bool = False
    autoplay_batch_size: int = 10
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
    # Load the track and claim the targets, but do not start playing: the
    # listener is paused right now and picked a speaker, so the speaker
    # should be theirs and silent until they press play.
    #
    # None of these cast protocols has a "load without playing", so the
    # frontend used to /play and then immediately /pause — a burst of sound
    # on the speaker the user just picked, plus a GET /stream connection
    # and its FFmpeg run that the following /resume throws away, since
    # /resume re-dispatches active_delivery from scratch anyway. Everything
    # else this endpoint does (resolving the output format, the queue, the
    # claims, active_delivery, the clock) happens exactly as it otherwise
    # would, so /resume, /seek, /join and every client's /status see a
    # perfectly ordinary paused session. Same reservation /join makes for
    # the already-casting case, and the same trade: the device is only
    # proven reachable once playback actually starts.
    paused: bool = False
    # Strictly increasing per-session dispatch counter — see SessionState.
    # play_seq's comment. 0 (the default) opts out of the staleness check.
    seq: int = 0
    # The listener's quality ceiling for casting, from the frontend's
    # playback settings — see core/streamer.py's resolve_output_format().
    # Unlike `gain` above, which is a per-track number, this is a standing
    # preference, so it is also remembered on the session (see
    # SessionState.max_lossy_*) for auto-advance and for any other client
    # sharing this cast. None (both of them) means no ceiling, i.e. exactly
    # the behaviour every caller from before these fields had.
    max_lossy_format: Literal["mp3", "aac", "opus"] | None = None
    max_lossy_bitrate_kbps: int | None = None
    # Gapless/crossfade (routes/mix_cast.py). None, or mode "off", plays one
    # song at a time exactly as before transitions existed - which is also
    # what every client that does not send this gets.
    transitions: TransitionSettings | None = None
    # ReplayGain and album order of the songs coming up, for the mix.
    song_hints: dict[str, SongHint] = {}
    # The ReplayGain setting `gain` came from, for the songs after this one
    # (see SessionState.replay_gain_mode). None leaves what the session has.
    replay_gain_mode: ReplayGainMode | None = None
    # Each speaker's equalizer curve, keyed "type:name" (core/equalizer.py).
    # A standing preference like the quality ceiling, so it is remembered on
    # the session for auto-advance. None leaves what the session has.
    equalizers: dict[str, list[Any]] | None = None


def playback_error_reporter(session: SessionState) -> Callable[[PlaybackFailure], Awaitable[None]]:
    """The callback a delivery uses to say "this stopped and nobody asked".

    See BaseDelivery.on_playback_error for why deliveries need one at all.
    AirPlay calls it for any failure, since nothing else would notice one.
    Chromecast calls it only for a stream refused after play() stopped
    waiting for the answer. Every other failure surfaces as the device's GET
    /stream connection closing, which routes/stream.py notices on its own.

    A failure after audio reached the device is an interruption, offered to
    be picked up again. One before it is a start that never happened, and
    is reported the way a failed /play dispatch is: why, with no resume.

    Note this marks the *session* interrupted, not one device. For a
    single-target cast — which is what AirPlay is in practice — those are
    the same thing. For a multi-target one they are not, and the session
    would be marked interrupted while the other devices play on. That gap
    is the same one documented in
    docs/investigations/casting/multi-target-drop-not-surfaced.md, which
    _mark_disconnected_if_not_reconnected() has for the same reason: there
    is no per-device notion of "streaming" to flip. Reporting a real
    failure against the session beats today's alternative of not reporting
    it at all, but it is not a per-device signal and must not be read as
    one.
    """

    async def _report(failure: PlaybackFailure) -> None:
        logger.error(
            f"[playback] {failure.delivery.target} reported a playback failure: "
            f"{failure.error} | {track_label(session) or 'no track'}"
        )
        if failure.interrupted:
            await mark_interrupted(session)
        else:
            await mark_delivery_failed(
                session, delivery_error_response(failure.error, failure.delivery)
            )

    return _report


# What /play writes before dispatching, put back if the dispatch fails.
_PLAY_ROLLBACK_FIELDS = (
    "current_track",
    "current_track_gain",
    "current_output_format",
    "is_streaming",
    "radio_info",
    "track_ended",
    "active_delivery",
    "queue",
    "queue_index",
    "original_queue",
    "shuffle",
    "repeat_mode",
    "autoplay_enabled",
    "autoplay_batch_size",
    "mix",
    "preview",
)

# A force-takeover's displace_target() can change these two without this
# session's play_lock (see active_delivery_seq in core/state.py); restoring
# them over it would undo a takeover the other session was already told of.
_DISPLACEABLE_FIELDS = ("active_delivery", "is_streaming")


def _snapshot_for_play(st: AppState) -> dict[str, Any]:
    snapshot = {name: getattr(st, name) for name in _PLAY_ROLLBACK_FIELDS}
    # A flat dataclass of primitives, so a shallow copy is a full one.
    snapshot["clock"] = copy.copy(st.clock)
    return snapshot


def _restore_after_failed_play(
    st: AppState, snapshot: dict[str, Any], dispatch_delivery_seq: int
) -> None:
    displaced = st.active_delivery_seq != dispatch_delivery_seq
    for name, value in snapshot.items():
        if displaced and name in _DISPLACEABLE_FIELDS:
            continue
        setattr(st, name, value)


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
        logger.warning("[play] Rejected: media server not configured (waiting for /config)")
        return {"error": "Media server not configured — waiting for /config"}
    if not req.song_ids:
        return {"error": "No track ID provided"}

    async with session.play_lock:
        # Checked (and, on acceptance, recorded) inside the lock so a
        # slower-to-arrive-but-actually-older request can never sneak its
        # target.play() dispatch in between a newer request's own check and
        # its device call — see SessionState.play_lock's comment.
        if _is_stale_seq(session, req.seq):
            logger.info(f"[play] Ignoring superseded request (seq={req.seq} < {session.play_seq})")
            return {"status": "superseded"}
        if req.seq:
            session.play_seq = req.seq

        # Clamped rather than trusted outright — an out-of-range index from a
        # confused/outdated client shouldn't 500 or silently dispatch the
        # wrong track; falls back to "the queue starts here", same as before
        # queue_index existed.
        queue_index = req.queue_index if 0 <= req.queue_index < len(req.song_ids) else 0
        track_id = req.song_ids[queue_index]
        try:
            # to_thread: session.media is a synchronous HTTP client, and
            # calling it inline blocks the event loop — every open /stream
            # socket included — for the length of the request. Measured at
            # 4.75s on beacon-dev 2026-08-22 during a media-server DNS
            # hiccup.
            track = await asyncio.to_thread(session.media.get_track, track_id)
        except Exception as e:
            logger.warning(f"[play] Track {track_id} not found: {e}")
            return {"error": f"Track not found: {e}"}

        target = resolve_target(
            req.targets,
            req.target_name,
            req.target_type,
            previous=session.state.active_delivery,
            on_playback_error=playback_error_reporter(session),
        )
        start_position = max(0.0, min(req.start_position, float(track.duration)))
        logger.info(
            f"[play] {track.artist} — {track.title} ({track.duration}s) → target={target}"
            f" seq={req.seq}" + (f" (start {start_position:.1f}s)" if start_position > 0.5 else "")
        )

        # Resolved once here and cached on session.state — /stream reads it
        # for its own Content-Type header instead of probing again (see
        # core/streamer.py's resolve_output_format()). to_thread: get_stream_url()
        # is instant for Subsonic/Jellyfin but Plex's needs a real network
        # lookup first (see media/plex.py's docstring); resolve_output_format()
        # itself shells out to ffmpeg, also blocking.
        track_url = await asyncio.to_thread(session.media.get_stream_url, track.id)
        max_rate, max_depth, max_channels = audio_capability_limits(target)
        # Remembered before resolving, so auto-advance and the /resume and
        # /seek paths below all see the same ceiling this dispatch used.
        session.state.max_lossy_format = req.max_lossy_format
        session.state.max_lossy_bitrate_kbps = req.max_lossy_bitrate_kbps
        if req.equalizers is not None:
            session.state.equalizers = sanitize_curves(req.equalizers)
        if req.replay_gain_mode is not None:
            session.state.replay_gain_mode = req.replay_gain_mode
        output_format = await resolve_output_format(
            track_url,
            gain=req.gain,
            equalized=equalizer.any_active(session.state.equalizers, target),
            max_sample_rate=max_rate,
            max_bit_depth=max_depth,
            max_channels=max_channels,
            max_lossy_format=req.max_lossy_format,
            max_lossy_bitrate_kbps=req.max_lossy_bitrate_kbps,
            device_codecs=playable_codecs(target),
        )
        mixing = transitions_on(req.transitions)
        if req.song_hints:
            session.state.song_hints = {k: v.model_dump() for k, v in req.song_hints.items()}
        if mixing:
            output_format = mix_cast.mix_output_format(session, target, output_format)
        # After the format, not before it: the URL ends in its extension.
        url = stream_url(session.session_id, output_format.content_type)

        if target:
            # Before claiming: a refused dispatch must not leave a device
            # locked to this session. See docs/plans/cast-permissions.md.
            forbidden = await cast_permissions.authorize_async(session)
            if forbidden:
                logger.info(f"[play] Refused: {forbidden}")
                return forbidden
            conflict = await _claim_or_takeover(target, session, req.force)
            if conflict:
                return conflict

        st = session.state

        # Set *before* dispatching to the device, not after — a fast-
        # responding device (observed with Sonos) can open its own GET
        # /stream/{session_id} connection back to us before target.play()
        # below even returns, and audio_stream() 204s ("No track loaded")
        # if session.state.current_track isn't set yet at that moment,
        # which the device doesn't retry — the track then just never plays.
        # Snapshotted first so a *failed* dispatch can put everything back
        # exactly as it was, instead of leaving a track/delivery marked
        # "current" (and reflected in the next periodic /events tick) when
        # nothing actually started playing on the device.
        previous = _snapshot_for_play(st)
        previous_mix = st.mix

        st.current_track = track
        st.current_track_gain = req.gain
        st.current_output_format = output_format
        st.is_streaming = True
        # A song played ends a preview: it only stood in for the queue.
        st.preview = None
        if st.radio_info is not None:
            session.stop_radio_metadata_watch()
            await session.stop_radio_relay()
        st.radio_info = None
        mix = None
        if mixing:
            st.transitions = req.transitions
            item = replace(mix_cast.mix_item(session, track, queue_index, req.gain), gain=req.gain)
            mix = mix_cast.new_mix(session, item, start_position)
            st.mix = mix
            # A mix's clock counts stream time - see routes/mix_cast.py.
            st.clock.start(0.0)
            if req.paused:
                st.clock.pause(0.0)
        else:
            st.mix = None
            st.clock.start(start_position)
            if req.paused:
                # Frozen exactly where it was told to start. start() above has
                # just zeroed position_offset, so resume_offset comes out at
                # start_position — which is what /resume dispatches from.
                st.clock.pause(start_position)
        st.track_ended = False
        st.active_delivery = target
        # Captured right after the write above — see active_delivery_seq's
        # own comment in core/state.py for why the except branch below
        # needs this rather than unconditionally restoring active_delivery
        # on a failed dispatch.
        dispatch_delivery_seq = st.active_delivery_seq
        # The whole queue (history included), not just this one track — see
        # AppState.queue's comment. A caller that only ever sends a single id
        # (queue_index defaults to 0 either way) still falls straight through
        # to _advance_or_end()'s "mark ended" branch once this track finishes,
        # identical to before queue_index existed.
        st.queue = req.song_ids
        st.queue_index = queue_index
        st.original_queue = req.original_queue
        st.shuffle = req.shuffle
        st.repeat_mode = req.repeat_mode
        st.autoplay_enabled = req.autoplay_enabled
        st.autoplay_batch_size = req.autoplay_batch_size

        if target and not req.paused:
            # internal=True: fetched directly by the cast device, not the browser —
            # see MediaClient.get_cover_art_url's docstring.
            album_art_url = session.media.get_cover_art_url(track.cover_art_id, internal=True)
            if _is_duplicate_dispatch(st, f"play:{target}:{track_id}"):
                if mix is not None and previous_mix is not None:
                    # The device was not dispatched again, so it is still
                    # reading the mix it already has; that one stays.
                    st.mix = previous_mix
                    st.clock = previous["clock"]
                    mix = None
            else:
                if mix is not None:
                    # Before dispatching: a fast device connects before
                    # play() even returns (see current_track above).
                    mix.start()
                try:
                    await target.play(
                        url,
                        track.title,
                        track.artist,
                        album_art_url,
                        # A mix has no length; it goes on with the queue.
                        None if mix is not None else float(track.duration),
                        track.album,
                        output_format.content_type,
                    )
                except Exception as e:
                    logger.exception("[play] Delivery error")
                    if mix is not None:
                        mix.stop()
                    _restore_after_failed_play(st, previous, dispatch_delivery_seq)
                    # Dispatch never actually reached the device — release the
                    # claim just granted above instead of leaving it locked to
                    # this session (device_in_use for everyone else) with
                    # nothing actually playing on it.
                    await _release_claims(target, session)
                    return delivery_error_response(e, target)

        if previous_mix is not None and previous_mix is not st.mix:
            previous_mix.stop()
        if mix is not None:
            if not req.paused and not mix.started:
                mix.start()
            asyncio.create_task(mix_cast.follow(session, mix))

        if not target:
            logger.info(f"[play] No target — stream available at {url}")
            await session.event_bus.broadcast(build_status_dict(session))
            return {"status": "playing", "stream_url": url}

        if req.paused:
            # No dispatch happened, so there is nothing to calibrate against
            # and nothing to resync with — both tasks below poll the device
            # for a position it has no reason to have. /resume starts its
            # own pair when it actually dispatches.
            logger.info(f"[play] Paused — {target} holds the track without playing it")
            await session.event_bus.broadcast(build_status_dict(session))
            return {"status": "paused", "stream_url": url}

        start_position_sync(session, target)
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
    # The opt-in exception: False (default) routes the station through
    # Beacon's own relay (core/radio_relay.py), which is what makes casting
    # a station cost exactly one fetch of it instead of up to three (the
    # device itself, an independent ICY watch, and — only once a device has
    # refused the raw stream — retry_radio_via_proxy() re-fetching it again
    # per target). True skips the relay and hands the device the station's
    # own URL directly, same as every version before this field existed;
    # retry_radio_via_proxy() remains that mode's fallback for a device
    # that refuses it. Frontend setting: account-scoped, see
    # services/connect/accountSettings.ts's castRadioDirectly.
    cast_directly: bool = False
    # The cast-quality setting, the same pair /play takes (see
    # PlayRequest.max_lossy_*). Both halves reach a station: the bitrate as
    # a ceiling, and the format as what a re-encode comes out as — AAC
    # where it was asked for, MP3 otherwise. Picking AAC also lets an AAC
    # station through untouched, which is the point of offering it: it is
    # the better format at the same bitrate, and whether a given speaker
    # takes it is something only trying can answer. A station already below
    # the ceiling and in the chosen format is copied — see
    # core/radio_relay.py's _device_output_args(). Both are ignored for
    # cast_directly, which hands the device the station's own URL and has
    # nothing in between to convert with.
    max_lossy_format: Literal["mp3", "aac", "opus"] | None = None
    max_lossy_bitrate_kbps: int | None = None


class _StationConnection(NamedTuple):
    relayed: bool
    dispatch_url: str
    # The station's own type, and what the device is told to expect.
    content_type: str
    dispatch_content_type: str
    # Set when the station refused this listener (HTTP status or detail).
    refusal: str | None


async def _connect_station(
    session: SessionState, req: "PlayUrlRequest", target, url: str
) -> _StationConnection:
    """Where the device fetches `url` from and what it is told it is:
    through the relay, or straight from the station, decided by whichever
    connection to the station this dispatch makes anyway."""
    # Relayed (default) routes the device at Beacon's own relay
    # (core/radio_relay.py) instead of the station directly — one fetch
    # of the station feeds every cast target's audio, the visualizer,
    # and the ICY title watch below at once. The relay has to be up
    # before dispatch, unlike the direct mode's ICY watch (started only
    # after a successful dispatch, further down): dispatch itself needs
    # to know where the relay's device-audio actually is.
    relayed = not req.cast_directly
    dispatch_url = url
    # The station's own type, which is what a device connecting straight
    # to it has to be told before it connects — a `.aac` URL is
    # routinely served as `audio/aacp` (HE-AAC), and announcing the
    # extension's own `audio/aac` is what a Sonos rejects with
    # ERROR_UNSUPPORTED_FORMAT for a stream it plays fine once told the
    # truth. Seeded from the extension here and settled below by
    # whichever connection to the station this dispatch makes anyway:
    # the relay's own for a relayed station, a probe of its own only for
    # a station going directly to the device.
    content_type = content_type_from_extension(url)
    dispatch_content_type = content_type
    # What the station answered, when it answered with one of the
    # handful of codes that mean it is refusing this listener rather
    # than having a bad moment (see core/stream_format.py's
    # is_station_refusal). Reported below instead of letting the speaker
    # fail on the same answer a moment later.
    refusal: str | None = None
    if relayed:
        # A relay may already be running for this very station, started
        # by *local* playback (routes/stream.py's /stream/radio-local)
        # under the local quality ceiling rather than the cast one. That
        # is the ordinary way of it — somebody listening on this device
        # sends the station to a speaker — and reusing it as-is would
        # silently ignore the cast setting for the whole station. Casting
        # is the deliberate act, so it wins: the relay is torn down and
        # started again under its ceiling, which costs one reconnect to
        # the station, right where the sound is moving to another device
        # anyway. Local reconnects deliberately do *not* do this (see
        # /stream/radio-local), or the two would take turns restarting
        # the same relay for as long as both were listening.
        #
        # The setting is reduced to what the relay can produce and this
        # device can decode before any of that is compared — otherwise
        # a listener on Opus would restart the relay on every dispatch,
        # since what is stored on it is what it actually encodes.
        relay_format = relay_format_for_target(req.max_lossy_format, playable_codecs(target))
        existing = session.radio_relay
        if (
            existing is not None
            and existing.url == url
            and (
                existing.max_bitrate_kbps != req.max_lossy_bitrate_kbps
                or existing.preferred_format != relay_format
            )
        ):
            await session.stop_radio_relay()
        relay = await session.start_radio_relay(
            url,
            content_type,  # a guess until the relay's own connection settles it
            max_bitrate_kbps=req.max_lossy_bitrate_kbps,
            preferred_format=relay_format,
        )
        if relay.refused_status is not None and not relay.connected:
            refusal = f"HTTP {relay.refused_status}"
        elif relay.connected:
            # What the station itself announced, read off the relay's
            # own connection (see RadioRelay.source_content_type). Kept
            # in radio_info below because that is what a later direct
            # re-dispatch of this same station is told to expect —
            # retry_radio_via_proxy(), a device added mid-station.
            content_type = relay.source_content_type
            dispatch_url = radio_stream_url(session.session_id)
            dispatch_content_type = relay.device_content_type
        else:
            # The relay never got as far as a running ffmpeg: the
            # station never answered, or dropped the connection before
            # ffmpeg was up. (One that answered with a refusal is the
            # branch above, not this one.) Pointing the device at
            # /stream/radio anyway would answer 200 with a
            # body that stays silent indefinitely, which reads as a
            # broken speaker rather than a station problem. Fall back to
            # what "direct to device" does instead: hand over the
            # station's own URL, which keeps retry_radio_via_proxy()
            # available as that mode's own fallback.
            logger.warning(f"[play-url] Relay for {url[:80]} never connected — going direct")
            await session.stop_radio_relay()
            relayed = False
    else:
        await session.stop_radio_relay()

    if not relayed and refusal is None:
        # The one case the station is still worth a request of its own:
        # the device is about to fetch the station itself, and is told
        # what to expect before it connects. A relayed station never
        # reaches this — its relay has already read the same headers off
        # the connection it needs anyway, so probing again would be a
        # second fetch of the station for an answer already in hand, and
        # some stations allow exactly one connection at a time.
        probed = await probe_stream(url)
        if probed.refused:
            refusal = probed.detail or url
        else:
            content_type = probed.content_type
            dispatch_content_type = content_type
    return _StationConnection(relayed, dispatch_url, content_type, dispatch_content_type, refusal)


def _station_output_format(
    session: SessionState, relayed: bool, dispatch_content_type: str
) -> OutputFormat:
    """What the stream-info panel shows for a cast station."""
    if (
        relayed
        and session.radio_relay is not None
        and session.radio_relay.reencode_reason is not None
    ):
        # The relay is re-encoding the station, and it says why: over
        # the quality ceiling, or a codec the device would not take
        # anyway (see core/radio_relay.py's _device_output_args()).
        # Reported the same way a song's own transcode is.
        bitrate = session.radio_relay.output_bitrate_kbps
        # Named after what the relay is actually producing, not after
        # MP3: since the quality setting can ask for AAC, a hard-coded
        # "mp3-…" label was a second place claiming a format, and the
        # one the panel reads first.
        codec = "aac" if dispatch_content_type == "audio/aac" else "mp3"
        return replace(
            FALLBACK_FORMAT,
            label=f"{codec}-{bitrate}k",
            content_type=dispatch_content_type,
            source_codec=session.radio_codec,
            source_bitrate_kbps=session.radio_bitrate,
            target_bitrate_kbps=bitrate,
            transcode_reason=session.radio_relay.reencode_reason,
        )
    # Passed through untouched: an MP3 station under the ceiling, or
    # one that never said what it broadcasts at. Nothing to report,
    # and claiming a conversion here is exactly what the panel used
    # to do for every cast station.
    return FALLBACK_FORMAT


def _start_radio_position_tracker(
    session: SessionState, target, relayed: bool, dispatch_url: str
) -> None:
    """Chromecast/DLNA/Sonos - see core/radio_position.py's module docstring.
    Replaces whatever tracker (if any) was here for a previous dispatch; the
    old one, if still running, notices the generation bump on its own next
    poll and exits."""
    st = session.state
    # Sonos is conditional on the URL actually dispatched (core/state.py's
    # first_radio_position_delivery()): after a retry_radio_via_proxy()
    # success the device is at Beacon's own endpoint, while `relayed` and
    # `dispatch_url` still say otherwise - so it is recomputed, not trusted.
    actual_dispatch_url = (
        radio_stream_url(session.session_id)
        if relayed or st.radio_info.get("proxied")
        else dispatch_url
    )
    position_delivery = first_radio_position_delivery(target, actual_dispatch_url)
    if position_delivery is not None:
        tracker = RadioPositionTracker(session, position_delivery, st.clock.play_generation)
        tracker.start()
        session.radio_position_tracker = tracker
    else:
        session.radio_position_tracker = None


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
        req.targets,
        req.target_name,
        req.target_type,
        previous=session.state.active_delivery,
        on_playback_error=playback_error_reporter(session),
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

        # Same as /play's check, and before the claim for the same reason.
        forbidden = await cast_permissions.authorize_async(session)
        if forbidden:
            logger.info(f"[play-url] Refused: {forbidden}")
            return forbidden

        conflict = await _claim_or_takeover(target, session, req.force)
        if conflict:
            logger.info(f"[play-url] Refused: {conflict}")
            return conflict

        st = session.state

        # A station published as a .m3u/.pls is a text file naming where the
        # audio really is, and no device can play that (see
        # core/playlist_url.py). Beacon's own frontend already sends a
        # resolved URL, which makes this a no-op there - it is here for
        # every other caller, and because getting it wrong looks like a bare
        # `UPnP Error 800` from the speaker with nothing pointing at the
        # cause. Everything below deliberately uses the resolved URL, so
        # what a reconnect replays and what the status reports are the same
        # thing the device was actually given.
        url = await resolve_stream_url(req.url)
        # Captured before anything below writes it: retry_radio_via_proxy()
        # reads radio_info to know which station to re-encode, so it has to
        # be set before the dispatch — and rolled back with everything else
        # if nothing ends up playing.
        previous_radio_info = st.radio_info

        (
            relayed,
            dispatch_url,
            content_type,
            dispatch_content_type,
            refusal,
        ) = await _connect_station(session, req, target, url)

        if refusal is not None:
            # It will answer the device the same way, and re-encoding can't
            # help either — ffmpeg has to fetch the very same URL. Said
            # plainly here rather than letting the speaker fail on it and
            # the re-encode fail behind that, which is what a listener was
            # left to interpret: a speaker reporting ERROR_ACCESS_DENIED,
            # then ERROR_CORRUPT_FILE for the empty re-encode, reads as if
            # the *speaker* were broken.
            logger.info(f"[play-url] {url} refused the connection ({refusal})")
            await session.stop_radio_relay()
            # Whatever was playing before is gone either way: starting this
            # relay tore down the previous station's, and rolling the info
            # back unchanged would leave the status claiming a live relay
            # that no longer exists — same correction the dispatch-failure
            # path below makes, for the same reason.
            st.radio_info = _no_longer_relayed(previous_radio_info)
            await _release_claims(target, session)
            return {
                "error": "delivery_failed",
                "reason": REASON_STATION_REFUSED,
                "device": device_label(target),
                "detail": refusal,
            }

        st.radio_info = {
            "title": req.title,
            "url": url,
            "content_type": content_type,
            # What this dispatch announced, which for a relayed station is
            # the relay's output rather than the station's own type — every
            # later reconnect and every device joining mid-station has to be
            # told the same thing (see radio_content_type()).
            "device_content_type": dispatch_content_type,
            "relayed": relayed,
        }

        # Keyed on the station's own url, not dispatch_url: when relayed,
        # dispatch_url is always this session's fixed relay endpoint
        # regardless of which station is behind it, so keying on it instead
        # would make switching stations in quick succession look like a
        # duplicate of the previous one and silently skip the redispatch —
        # the device would keep pointing at a relay connection that
        # start_radio_relay() has, by then, already torn down.
        # The quality is part of what makes a dispatch a different one: two
        # clients share a session but each has its own quality setting, and
        # the second one arriving within the cooldown used to be dropped as
        # a duplicate — after the relay had already been torn down for it,
        # which left the speaker silent until somebody pressed something.
        dispatch_key = (
            f"play-url:{target}:{url}:{req.max_lossy_format}:{req.max_lossy_bitrate_kbps}"
        )
        if not _is_duplicate_dispatch(st, dispatch_key):
            # This device is about to buffer from scratch, so the connection
            # radio_is_buffering() measures against is the one it is about to
            # open — not whichever it had for the previous station. Cleared
            # before the dispatch, since the device connects inside it.
            session.radio_device_connected_at = None
            try:
                await target.play(dispatch_url, req.title, content_type=dispatch_content_type)
            except Exception as e:
                logger.exception("[play-url] Delivery error")
                # Direct mode's own fallback: a device that refuses the raw
                # station gets one more chance at Beacon's re-encoded copy —
                # see retry_radio_via_proxy() for the two very different
                # refusals this covers. Not reachable when already relayed:
                # dispatch_url is already Beacon's own copy, so a device
                # refusing that has nothing further to retry into.
                if relayed or not await retry_radio_via_proxy(session, target):
                    st.radio_info = previous_radio_info
                    if relayed:
                        # Nothing is playing through it any more — see
                        # start_radio_relay()'s own note on this not
                        # attempting to resurrect whatever station (if any)
                        # was relaying successfully before this call.
                        await session.stop_radio_relay()
                        # start_radio_relay() above already tore down that
                        # previous station's own relay too, as part of
                        # switching to this one (it stops whatever's running
                        # for any *different* URL before starting the new
                        # one) — so the rollback above just claimed a
                        # station is still relayed when its relay in fact no
                        # longer exists. Left uncorrected, the status/UI
                        # would report a live relay indefinitely, until some
                        # unrelated later /play-url happened to fix it.
                        st.radio_info = _no_longer_relayed(st.radio_info)
                    # See /play's identical comment — don't leave the device
                    # locked to this session when nothing actually started
                    # playing on it.
                    await _release_claims(target, session)
                    return delivery_error_response(e, target)

        st.current_track = None
        # A station ends a mix, and a preview with it. Left running, the
        # mix's follow() went on moving current_track through its songs while
        # the station played.
        session.stop_mix()
        # What the stream-info panel reads, decided only now: the dispatch
        # above can still fail and roll everything back, and a format set
        # earlier would then claim a conversion for a station that never
        # started.
        if not st.radio_info.get("proxied"):
            # Otherwise the device-rejected retry has already put the
            # re-encoding format here, and overwriting would hide the
            # transcode from the panel that exists to show it.
            st.current_output_format = _station_output_format(
                session, relayed, dispatch_content_type
            )
        st.is_streaming = True
        if relayed:
            # Superseded by the relay's own ICY parsing (same fetch, same
            # _set_radio_title callback) — stop whatever independent watch
            # might already be running for this session. That is the
            # ordinary way of it: somebody listening on this device (which
            # starts one, see stores/playback.ts's startLocalRadio) sends
            # the station to a speaker. Left running, it would be exactly
            # the second connection per station this mode exists to avoid.
            session.stop_radio_metadata_watch()
        else:
            # See core/icy_metadata.py's own docstring - a cast radio play is
            # the one radio path that already reaches this backend on its own,
            # so its "now playing" watch starts right here rather than needing
            # an extra call from the frontend the way local playback does.
            session.start_radio_metadata_watch(url)
        st.clock.start()
        st.track_ended = False
        st.active_delivery = target
        # Radio has no queue to auto-advance through — see AppState.queue's
        # comment. Stale ids from a previous /play left in place here would
        # be harmless in practice (radio's own track-end never fires) but
        # confusing to find set while radio_info is also set.
        st.queue = []
        st.queue_index = 0

        _start_radio_position_tracker(session, target, relayed, dispatch_url)
        # After the tracker, not before: where there is one, it calibrates
        # the clock from its own readings and these two stand aside rather
        # than poll the same device again (core/cast_position.py's
        # _tracked_for_radio()).
        start_position_sync(session, target)
        await session.event_bus.broadcast(build_status_dict(session))
        return {"status": "playing", "url": url}


@router.post("/pause")
async def pause_playback(
    request: Request, session: SessionState = Depends(require_authenticated_session)
):
    return await pause_session(session, request.headers.get("user-agent", "no user agent"))


async def pause_session(session: SessionState, who: str):
    """`who` asked, for the log: a pause nobody remembers pressing is
    otherwise indistinguishable from one the user did press."""
    if not session.media.base_url:
        # Same "session forgot everything" case /play guards against — a
        # reaped-then-recreated session has no active_delivery to actually
        # pause, but would otherwise silently report success anyway (see
        # git history for the incident this fixes). Surfacing an error here
        # lets the frontend detect the loss and reset to disconnected
        # instead of leaving the play/pause button toggling a phantom
        # session forever with no visible effect.
        logger.warning("[pause] Rejected: media server not configured (waiting for /config)")
        return {"error": "Media server not configured — waiting for /config"}
    async with session.play_lock:
        st = session.state
        if st.active_delivery:
            try:
                await st.active_delivery.pause()
            except Exception as e:
                # Not marked paused: the speaker is still playing, and the
                # clock has to go on agreeing with it.
                logger.exception("[pause] Delivery error")
                return delivery_error_response(e, st.active_delivery)
        elapsed = clock_position(session)
        st.clock.pause(elapsed)
        if st.mix is not None:
            st.mix.freeze()
        logger.info(f"[pause] ⏸ {elapsed:.1f}s into track [{who[:80]}]")
        await session.event_bus.broadcast(build_status_dict(session))
        return {"paused": True}


@router.post("/resume")
async def resume_playback(session: SessionState = Depends(require_authenticated_session)):
    if not session.media.base_url:
        # See /pause's identical guard above for why this matters.
        logger.warning("[resume] Rejected: media server not configured (waiting for /config)")
        return {"error": "Media server not configured — waiting for /config"}
    async with session.play_lock:
        st = session.state
        if not st.clock.is_paused:
            # Already playing — a second /resume landing on top of an
            # already-resumed track (a duplicate/stray call, e.g. an OS
            # media-key or remote-control action arriving after a real one
            # already took effect) must be a no-op here, not reseek:
            # clock.resume() below unconditionally jumps back to
            # resume_offset, which is only ever updated by pause()/seek_to()
            # — so an extra resume() discards everything actually played
            # since the *last real* pause and forces a fresh /stream
            # reconnect on top of it. Observed live (2026-08-20): playback
            # and lyrics repeatedly snapping back near the last pause point
            # every time a duplicate resume slipped through.
            return {"paused": False}
        if st.mix is not None:
            return await mix_cast.resume(session)
        st.clock.resume()

        logger.info(f"[resume] ▶ Seeking to {st.clock.resume_offset:.1f}s")

        if st.active_delivery:
            # Force a fresh /stream connection so FFmpeg applies the seek offset
            # (radio reconnects to its own URL instead — see _current_reconnect_args).
            # Captured once, not called again below for
            # first_radio_position_delivery() — that needs the exact same URL
            # this dispatch actually used, not a second, potentially different
            # computation of it.
            reconnect_args = _current_reconnect_args(session)
            try:
                await st.active_delivery.play(*reconnect_args)
            except Exception as e:
                # Match /play's contract: a JSON {"error": ...} body, not an
                # unhandled exception surfacing as a 500 (the device may have
                # gone unreachable while paused), and classified the same way
                # so a reconnect failure reads as well as a first dispatch's
                # does (see delivery/errors.py).
                logger.exception("[resume] Delivery error")
                return delivery_error_response(e, st.active_delivery)

            # clock.resume() above bumped play_generation, and
            # core/radio_position.py's RadioPositionTracker retires itself
            # on exactly that — radio only (st.radio_info), since tracks
            # don't use it at all. Without this, a pause/resume
            # during the device's own startup buffering (observed live
            # 2026-09-02: Sonos auto-pauses/resumes as part of a normal
            # dispatch, mere seconds after /play-url) leaves the tracker
            # permanently stuck on the pre-resume generation — it notices
            # the mismatch on its next poll and quietly exits for good
            # (by design, see its own docstring), so radio_buffering never
            # clears and the radio visualizer never gets real frames again,
            # even though playback itself is completely unaffected.
            if st.radio_info:
                position_delivery = first_radio_position_delivery(
                    st.active_delivery, reconnect_args[0]
                )
                if position_delivery is not None:
                    tracker = RadioPositionTracker(
                        session, position_delivery, st.clock.play_generation
                    )
                    tracker.start()
                    session.radio_position_tracker = tracker
                else:
                    # The same `else` /play-url and routes/devices.py both
                    # already have, and leaving it out here was a real bug.
                    # first_radio_position_delivery() returns None for a
                    # relayed Sonos (it reports a flat 0.00s over
                    # x-rincon-mp3radio://), so this branch is the *normal*
                    # one for that cast — and a Sonos auto-pauses/resumes
                    # seconds into its own dispatch as a matter of routine
                    # (see core/radio_position.py), so /resume hits it every
                    # single time. Without clearing it, the tracker from the
                    # previous generation stays referenced: it notices the
                    # generation bump and exits on its next poll, but it
                    # exits with ready=False, so build_status_dict()'s
                    # radio_buffering ("Puffert…" on the seek bar) latches
                    # True forever, and core/visualizer_feed.py keeps
                    # picking _OffsetTrackerClock over _FirstByteClock and
                    # reads a frozen elapsed_fn() from it — no frame is ever
                    # released again.
                    session.radio_position_tracker = None

            # The reconnect above starts a *fresh* stream (FFmpeg output
            # restarts near 0 again), re-incurring the device's startup-
            # buffering delay exactly like a brand new /play or a /seek —
            # see apply_position_offset()'s docstring and the identical
            # calls from /play, /play-url, and /seek. Without this,
            # position_offset keeps whatever value was measured before the
            # pause, so elapsed()/lyrics-sync/the visualizer run ahead of
            # what's actually audible until the periodic resync below's
            # first tick catches up, up to POSITION_RESYNC_INTERVAL later.
            # clock.resume() above bumped play_generation, same as seek_to()
            # does — any resync_position_periodically() task still running
            # from before the pause sees that mismatch on its next wake and
            # quietly exits (see that function's own docstring), so without
            # this, periodic resync would silently stop working for good
            # after the *first* pause/resume of any given track.
            #
            # After the radio tracker above, for the reason /play-url gives:
            # where there is one, these two stand aside instead of polling
            # the same device a second time.
            start_position_sync(session, st.active_delivery)

        await session.event_bus.broadcast(build_status_dict(session))
        return {"paused": False}


class PreviewRequest(BaseModel):
    # The songs to preview, in the order they play; each one's queue_index
    # is its place in this list (see routes/local_mix.py's MixSong).
    songs: list[MixSong]
    index: int = 0


@router.post("/preview")
async def start_preview(
    req: PreviewRequest, session: SessionState = Depends(require_authenticated_session)
):
    """Previews an album or playlist on the speakers being cast to - see
    routes/mix_cast.py's start_preview(). Also how a preview moves to
    another of its excerpts."""
    if not 0 <= req.index < len(req.songs):
        return {"error": "No such song"}
    async with session.play_lock:
        entries = [SongEntry(**song.model_dump()) for song in req.songs]
        error = await mix_cast.start_preview(session, entries, req.index)
        return error or {"status": "playing"}


@router.post("/preview/end")
async def end_preview(session: SessionState = Depends(require_authenticated_session)):
    """Stops a preview: the queue's song back where it was, paused."""
    async with session.play_lock:
        await mix_cast.end_preview(session, silence=True)
        return {"status": "paused"}


class SeekRequest(BaseModel):
    position: float


@router.post("/seek")
async def seek_playback(
    body: SeekRequest, session: SessionState = Depends(require_authenticated_session)
):
    async with session.play_lock:
        st = session.state
        if st.mix is not None:
            return await mix_cast.seek(session, body.position)
        position = max(0.0, body.position)
        if st.current_track:
            position = min(position, st.current_track.duration)

        st.clock.seek_to(position)

        if not st.clock.is_paused and st.active_delivery:
            # Captured once — see /resume's identical comment on why
            # first_radio_position_delivery() below reuses this instead of
            # calling _current_reconnect_args() a second time.
            reconnect_args = _current_reconnect_args(session)
            try:
                await st.active_delivery.play(*reconnect_args)
            except Exception as e:
                # See /resume's identical comment.
                logger.exception("[seek] Delivery error")
                return delivery_error_response(e, st.active_delivery)
            # See /resume's identical comment — clock.seek_to() bumps
            # play_generation, which retires the tracker. Radio has
            # no seek UI today (SeekBar.vue swaps it out entirely for the
            # live-elapsed label), so this is defensive symmetry with
            # /resume rather than a path known to be hit in practice.
            if st.radio_info:
                position_delivery = first_radio_position_delivery(
                    st.active_delivery, reconnect_args[0]
                )
                if position_delivery is not None:
                    tracker = RadioPositionTracker(
                        session, position_delivery, st.clock.play_generation
                    )
                    tracker.start()
                    session.radio_position_tracker = tracker
                else:
                    # The same `else` /play-url and routes/devices.py both
                    # already have, and leaving it out here was a real bug.
                    # first_radio_position_delivery() returns None for a
                    # relayed Sonos (it reports a flat 0.00s over
                    # x-rincon-mp3radio://), so this branch is the *normal*
                    # one for that cast — and a Sonos auto-pauses/resumes
                    # seconds into its own dispatch as a matter of routine
                    # (see core/radio_position.py), so /resume hits it every
                    # single time. Without clearing it, the tracker from the
                    # previous generation stays referenced: it notices the
                    # generation bump and exits on its next poll, but it
                    # exits with ready=False, so build_status_dict()'s
                    # radio_buffering ("Puffert…" on the seek bar) latches
                    # True forever, and core/visualizer_feed.py keeps
                    # picking _OffsetTrackerClock over _FirstByteClock and
                    # reads a frozen elapsed_fn() from it — no frame is ever
                    # released again.
                    session.radio_position_tracker = None

            # The reconnect above starts a *fresh* stream (FFmpeg output restarts
            # near 0 again), which re-incurs the device's startup-buffering delay
            # — same as a brand new /play. Without recalibrating here,
            # position_offset keeps whatever value was measured for the *previous*
            # stream (or 0.0 right after a fresh /play), so elapsed() runs ahead
            # of what's actually audible until the track ends. See
            # apply_position_offset()'s docstring and the identical calls from
            # /play and /play-url above — including why these come after the
            # radio tracker rather than before it.
            start_position_sync(session, st.active_delivery)

        logger.info(f"[seek] ⏩ {position:.1f}s")
        await session.event_bus.broadcast(build_status_dict(session))
        return {"position": position}


class QueueRequest(BaseModel):
    # The full queue, same convention as PlayRequest.song_ids/queue_index —
    # history included, not just what's upcoming.
    song_ids: list[str]
    queue_index: int = 0
    # See PlayRequest.original_queue/shuffle/repeat_mode.
    original_queue: list[str] = []
    shuffle: bool = False
    repeat_mode: Literal["off", "all", "one"] = "off"
    # See PlayRequest.autoplay_enabled/autoplay_batch_size.
    autoplay_enabled: bool = False
    autoplay_batch_size: int = 10
    # See PlayRequest.song_hints.
    song_hints: dict[str, SongHint] = {}
    # See PlayRequest.replay_gain_mode - a mode switched mid-song reaches
    # connect with the next queue push rather than the next /play.
    replay_gain_mode: ReplayGainMode | None = None
    # Set by the frontend's own Autoplay top-up only. Only these are checked
    # against a racing second top-up (see _is_duplicate_queue_topup()): a
    # user's "Play next" right after a top-up is shaped exactly like such a
    # racer - the pre-top-up queue extended by something else - and was
    # being dropped as one.
    autoplay_topup: bool = False
    # See PlayRequest.seq — shares session.play_seq's ordering with /play and
    # /play-url, since all three write session.state.queue/queue_index and
    # a stale queue edit must not be able to stomp a more recent song switch
    # (or vice versa).
    seq: int = 0


@router.post("/queue")
async def update_queue(
    req: QueueRequest, session: SessionState = Depends(require_authenticated_session)
):
    """Keeps session.state.queue (routes/stream.py's _advance_or_end() reads
    this to auto-advance casting on its own, build_status_dict() broadcasts
    it to every connected client — see AppState.queue's comment) in sync
    with queue edits the renderer makes *after* the current track already
    started playing — reorder/add/remove/shuffle all mutate the renderer's
    own queue live, but /play only ever seeds session.state.queue once, at
    dispatch time. Without this, those edits stay invisible to connect (auto-
    advance keeps following the stale list from the last /play) and to any
    *other* client sharing this session (its own queue view never updates).

    A full replacement, not a patch — same shape /play's own song_ids/
    queue_index accept, since a client sends its complete current queue on
    every edit (see stores/playback.ts's syncCastQueue()). See
    _is_duplicate_queue_topup()'s own docstring for the one case this
    doesn't just blindly apply: two clients racing to top up autoplay at
    once."""
    async with session.play_lock:
        if _is_stale_seq(session, req.seq):
            logger.info(f"[queue] Ignoring superseded request (seq={req.seq} < {session.play_seq})")
            return {"status": "superseded"}
        if req.seq:
            session.play_seq = req.seq

        st = session.state
        if st.queue:
            if req.autoplay_topup and _is_duplicate_queue_topup(st, st.queue, req.song_ids):
                logger.info("[queue] Ignoring duplicate autoplay top-up (a second client raced it)")
                return {"status": "duplicate"}
            queue_index = req.queue_index if 0 <= req.queue_index < len(req.song_ids) else 0
            st.queue = req.song_ids
            st.queue_index = queue_index
            st.original_queue = req.original_queue
            st.shuffle = req.shuffle
            st.repeat_mode = req.repeat_mode
            st.autoplay_enabled = req.autoplay_enabled
            st.autoplay_batch_size = req.autoplay_batch_size
            if req.song_hints:
                st.song_hints.update({k: v.model_dump() for k, v in req.song_hints.items()})
            if req.replay_gain_mode is not None:
                st.replay_gain_mode = req.replay_gain_mode
            mix_cast.queue_changed(session)
            await session.event_bus.broadcast(build_status_dict(session))
        return {"status": "ok"}


def sanitize_curves(curves: dict[str, list[Any]]) -> dict[str, list[dict[str, float]]]:
    """Every speaker's curve through core/equalizer.py's sanitize(), and the
    ones that end up flat left out."""
    clean = {key: equalizer.sanitize(bands) for key, bands in curves.items()}
    return {key: bands for key, bands in clean.items() if bands}


class EqualizersRequest(BaseModel):
    equalizers: dict[str, list[Any]]


@router.post("/equalizers")
async def update_equalizers(
    req: EqualizersRequest, session: SessionState = Depends(require_authenticated_session)
):
    """A curve changed in the equalizer dialog while this session casts.
    Taken over for whatever starts from here on - the next song, a seek, a
    device reconnecting - rather than cutting into the song that is playing:
    a running ffmpeg's filters are fixed, so applying it now means starting
    the stream again, which the renderer does with an ordinary /play when
    asked to (see stores/equalizer.ts)."""
    async with session.play_lock:
        session.state.equalizers = sanitize_curves(req.equalizers)
    return {"status": "ok"}


@router.post("/stop")
async def stop_playback(session: SessionState = Depends(require_authenticated_session)):
    async with session.play_lock:
        st = session.state
        if st.active_delivery:
            # A stop always ends the session, whatever the device says: a
            # raise here skipped everything below and left the speaker
            # claimed and the session "playing", with no way out but a
            # restart.
            try:
                await st.active_delivery.stop()
            except Exception:
                logger.exception("[stop] Stopping the device failed - ending the session anyway")
        st.is_streaming = False
        st.clock.is_paused = False
        st.track_ended = False
        st.current_track = None
        st.current_output_format = FALLBACK_FORMAT
        st.radio_info = None
        session.stop_radio_metadata_watch()
        await session.stop_radio_relay()
        session.stop_mix()
        st.active_delivery = None
        st.last_dispatch_key = None
        st.queue = []
        st.queue_index = 0
        # Playback is genuinely ending here — let the visualizer's supervisor
        # tear its decoder down now rather than on its next tick (see
        # core/visualizer_feed.py). Immediacy only: is_streaming going False
        # above is what it actually reacts to, notified or not, which is why
        # this belongs after that rather than before it.
        session.visualizer.notify()
        await claims.release_all_for_session(session.session_id)
        logger.info("[stop] ⏹ Playback stopped")
        await session.event_bus.broadcast(build_status_dict(session))
        return {"status": "stopped"}
