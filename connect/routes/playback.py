"""routes/playback.py — /play, /play-url, /pause, /resume, /stop"""

import asyncio
import copy
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.auth import require_token
from core.claims import claims
from core.playlist_url import resolve_stream_url
from core.radio_position import RadioPositionTracker
from core.session import (
    SessionState,
    build_status_dict,
    check_claims,
    compute_position,
    displace_target,
    mark_interrupted,
    registry,
    require_authenticated_session,
    track_label,
)
from core.state import (
    AppState,
    audio_capability_limits,
    first_radio_position_delivery,
    is_still_targeted,
    list_target_pairs,
    radio_dispatch_url,
    radio_stream_url,
    resolve_target,
    stream_url,
)
from core.stream_format import probe_stream, radio_content_type
from core.streamer import (
    FALLBACK_FORMAT,
    REASON_DEVICE_REJECTED_STREAM,
    resolve_output_format,
)
from delivery import SonosDelivery
from delivery.errors import REASON_STATION_REFUSED, delivery_error_response, device_label

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
    pre-top-up base and applied normally. Anything that isn't shaped like a
    top-up at all (a reorder, an insert in the middle, a removal, shuffle
    toggling the order) always returns False too and is applied exactly as
    before — this only ever suppresses a second top-up racing the first."""

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


# A device reporting itself this far *ahead* of the wall clock this early
# into a stream is a stale/bogus reading, not real startup-buffering lag —
# see _apply_position_offset().
MAX_PLAUSIBLE_POSITION_LEAD = 15.0


def _reports_no_radio_position(st: AppState, delivery) -> bool:
    """Whether this delivery's own reported position is worthless for the
    station currently playing, and must not be calibrated against at all.

    True for exactly one case: a Sonos serving beacon-hosted radio.
    delivery/sonos.py's own _dispatch_uri() rewrites that URL onto Sonos's
    x-rincon-mp3radio:// scheme (see its docstring — added 2026-09-04 to fix
    Sonos-only audio dropouts while relayed), and a Sonos dispatched that
    way reports a flat 0.00s for the entire run. Same exclusion core/
    state.py's first_radio_position_delivery() already applies to
    RadioPositionTracker, kept as its own predicate here because both
    calibration paths below need it and each used to answer it differently.

    A constant 0.00s is not a harmless reading to calibrate against, in
    either path. _resync_position_periodically() would recalibrate against
    it every POSITION_RESYNC_INTERVAL and win the tug-of-war against the
    wall clock, pinning elapsed() near 0 so the radio "running since"
    display never advances. _apply_position_offset() was assumed safe from
    that because it only ever runs once — it is not: calibrate(0.0) sets
    position_offset to -elapsed_since_stream_start(), and since a Sonos
    routinely fails or answers None for its first few get_position() calls
    (two SOAP round trips each) that lands seconds in, for an offset of
    several negative seconds. MAX_PLAUSIBLE_POSITION_LEAD only rejects
    readings that are implausibly *ahead*, never one absurdly behind, so
    nothing caught it. Reported live as the radio time counter jumping
    backwards — it slews in over _OFFSET_SLEW_SECONDS and then stays wrong
    for the rest of the run.

    Deliberately keyed on `relayed or proxied` rather than on the delivery
    type alone: a Sonos cast *directly* at a station's own URL is not
    rewritten, reports a real position, and stays fully calibrated."""
    if not isinstance(delivery, SonosDelivery) or not st.radio_info:
        return False
    return bool(st.radio_info.get("relayed") or st.radio_info.get("proxied"))


def _position_candidate(st: AppState, target):
    """The delivery to calibrate this session's clock against — the first
    that can report a position and whose reading is actually usable right
    now (see _reports_no_radio_position()).

    Skipping just the unusable delivery rather than giving up on the whole
    target matters for a multi-target cast: `candidate` is simply the first
    SUPPORTS_POSITION delivery, so a Sonos that happens to sort ahead of a
    Chromecast used to disable position resync for the session entirely,
    including for the Chromecast that does report a usable position."""
    deliveries = getattr(target, "deliveries", [target])
    return next(
        (d for d in deliveries if d.SUPPORTS_POSITION and not _reports_no_radio_position(st, d)),
        None,
    )


# Rough guess applied immediately, before the actual per-device
# measurement below has had a chance to complete — that can take a couple
# of seconds (the polling loop only checks every 0.5s), and starting from
# "no delay" for that whole gap is almost always more wrong than a
# reasonable guess, since practically every cast protocol has *some*
# startup buffering. Roughly splits the difference between "no delay" and
# the couple of seconds a slow-starting device takes — overwritten the
# moment a real measurement lands.
PROVISIONAL_STARTUP_DELAY = 1.0


async def _apply_position_offset(session: SessionState, target, generation: int) -> None:
    """Set `position_offset` for the track that just started playing.

    `compute_position()` returns `wall_elapsed + position_offset`. A device
    that's buffering lags behind the wall clock, so `position_offset` is
    normally negative (a second or two, depending on the target). This is
    what keeps the lyrics view in sync with what's actually audible.

    Every delivery here can answer where playback is — read off the device
    for Sonos/Chromecast/DLNA, derived from what has been pushed for AirPlay
    — so the normal path is to poll briefly once, measure the actual delay,
    then keep it constant for the rest of the track (re-buffering mid-track
    is left to _resync_position_periodically()). A delivery declaring a
    FIXED_OFFSET instead short-circuits that with its own estimate; none
    currently does, and one that did would be saying it has nothing better.
    """
    st = session.state
    deliveries = getattr(target, "deliveries", [target])

    # Every branch below mutates the shared session clock — a stale task
    # (this generation already superseded by a newer /play, /seek, or
    # /resume before this task got to run at all) would stomp the *current*
    # track's clock with a value meant for a track that isn't playing
    # anymore. Checked once here up front for the immediate writes below,
    # and again after every await further down (get_position() is a real
    # device round trip, easily a second or more — see the identical
    # re-check in _resync_position_once()).
    if st.clock.play_generation != generation or not st.is_streaming:
        return

    fixed = max((d.FIXED_OFFSET for d in deliveries), default=0.0)
    if fixed:
        st.clock.set_fixed_offset(-fixed)
        logger.debug(f"[lyrics-sync] fixed position_offset={st.clock.position_offset:.2f}s")
        await session.event_bus.broadcast(build_status_dict(session))
        return

    # Not simply the first SUPPORTS_POSITION delivery — a Sonos serving
    # beacon-hosted radio reports a flat 0.00s and calibrating against that
    # once is enough to pull position_offset seconds negative for the whole
    # run. See _reports_no_radio_position() for the full account.
    candidate = _position_candidate(st, target)
    if candidate is None:
        return

    st.clock.set_fixed_offset(-PROVISIONAL_STARTUP_DELAY)
    logger.debug(
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
        except Exception as e:
            logger.debug(f"[lyrics-sync] {candidate.target}: position read failed: {e}")
            continue
        # get_position() above is a real device round trip — a /play, /seek,
        # or /resume landing while it was in flight has by now already reset
        # the clock for a brand new stream, while device_pos here is still
        # the *old* stream's reading. Re-check freshness again here, not
        # just before the request (same race _resync_position_once() guards
        # against, see its own comment) — comparing device_pos against a
        # newer stream's clock below would corrupt its calibration.
        if st.clock.play_generation != generation or not st.is_streaming:
            logger.debug(
                f"[lyrics-sync] {candidate.target}: superseded while get_position() "
                f"was in flight (generation {generation} -> {st.clock.play_generation}) "
                "— discarding"
            )
            return
        # is None: no reading yet, keep polling. A real 0.0 (very common
        # right at track start, which is exactly what this loop is trying to
        # calibrate against) must NOT be treated the same way — `if not
        # device_pos` used to do that, silently skipping every legitimate
        # zero reading until either a nonzero one arrived or the 10s
        # deadline gave up and left position_offset at the crude
        # PROVISIONAL_STARTUP_DELAY guess for the whole track. A negative
        # reading is a bogus one (matches _resync_position_once()'s own
        # guard below) — not a real position either.
        if device_pos is None or device_pos < 0:
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
        logger.debug(
            f"[lyrics-sync] {candidate.target}: calibrated position_offset="
            f"{offset:.2f}s (device {device_pos:.2f}s vs. wall {wall_elapsed:.2f}s)"
        )
        await session.event_bus.broadcast(build_status_dict(session))
        return


# How often to re-check the device's own reported position against our
# wall-clock model for the rest of a track's playback — _apply_position_offset()
# above deliberately only measures once, right at the start (see its own
# docstring: "re-buffering mid-track is not accounted for"). This is what
# actually accounts for it, and also catches the case that one-shot
# calibration structurally can't: a seek initiated on the device's own
# remote/app instead of through Beacon, which our wall-clock model has no
# other way of ever finding out about. Not as tight an interval as e.g. the
# device-volume slider's 4s poll (services/connect/volume.ts's equivalent)
# — this runs for a whole session's entire track length, continuously, not
# just while a UI happens to have a picker open.
POSITION_RESYNC_INTERVAL = 8.0

# How much the *newly measured* offset is allowed to differ from the
# *already-applied* one (offset_before, below) before it's worth
# recalibrating over — ordinary jitter rather than something a user
# actually did. On this LAN, that jitter isn't network RTT (negligible for
# a local SSDP+UPnP round trip) — it's SonosDelivery.get_position()'s own
# H:M:S-string position, which only ever carries whole-second resolution.
# That alone puts a ~1s floor under how tight this can usefully go: nothing
# on our side can measure a real device more precisely than the device
# itself reports it. Small enough to catch a "skip 10s" tap, large enough
# that this quantization alone never crosses it on a stable stream.
#
# Deliberately NOT compared against the raw device/wall-clock delta on its
# own (an earlier version of this did) — once a device has any lasting
# offset at all (a Sonos's own several-second startup buffering, say), that
# raw delta sits well past this threshold *permanently*, on every single
# check, even though nothing further has actually changed since the offset
# that already accounts for it was applied. That recalibrated (and
# rebroadcast over SSE) every ~8s indefinitely once a track legitimately
# needed any real correction at all — read live as the position UI
# visibly jittering nonstop for the rest of the track, not just around the
# one moment something really happened.
POSITION_RESYNC_THRESHOLD = 1.0


async def _resync_position_once(session: SessionState, candidate, generation: int) -> None:
    """One resync check/correction against `candidate` — split out from
    _resync_position_periodically() below purely so it's directly testable
    without needing to unwind an infinite loop (see that function for the
    guards deciding whether/when this gets called at all, and the docstring
    explaining what this is actually for)."""
    try:
        device_pos = await candidate.get_position()
    except Exception as e:
        logger.warning(f"[position-resync] {candidate.target}: get_position() failed: {e}")
        return
    st = session.state
    # get_position() above is a real device round trip — SonosDelivery.
    # _get_device() does a fresh, uncached SSDP discover() on every call,
    # easily a second or more, not instant. _resync_position_periodically
    # only checked play_generation/is_streaming *before* kicking this off;
    # a /play, /seek, or /resume landing while it was in flight (e.g.
    # restarting the current track mid-playback via the Previous button)
    # has by now already reset the clock for a brand new stream, while
    # device_pos here is still the *old* stream's reading. Comparing the
    # two against each other below would recalibrate position_offset from
    # numbers belonging to two different streams — observed live as a
    # freshly-restarted track's displayed position getting stuck near
    # 0:00 for a while, the same symptom as the already-fixed near-track-
    # end case above, just from an unrelated cause.
    if st.clock.play_generation != generation or not st.is_streaming:
        logger.debug(
            f"[position-resync] {candidate.target}: superseded while get_position() was "
            f"in flight (generation {generation} -> {st.clock.play_generation}) — discarding"
        )
        return
    # Same race, other axis: /device-stop can drop this candidate out of the
    # session while the round trip above was in flight, and it leaves
    # play_generation alone — see is_still_targeted() (core/state.py).
    if not is_still_targeted(st.active_delivery, candidate):
        logger.debug(
            f"[position-resync] {candidate.target}: no longer a target of this session "
            "while get_position() was in flight — discarding"
        )
        return
    # Frozen right here, immediately after get_position() returns (and the
    # freshness check above), rather than after any further work below —
    # any extra device round trip inserted between reading device_pos and
    # freezing this would bias delta below by however long that took
    # (device_pos would always read older than wall_elapsed).
    wall_elapsed = st.clock.elapsed_since_stream_start()
    offset_before = st.clock.position_offset
    if device_pos is None or device_pos < 0:
        logger.debug(
            f"[position-resync] {candidate.target}: no usable position "
            f"(raw={device_pos!r}, play_generation={st.clock.play_generation}, "
            f"is_streaming={st.is_streaming})"
        )
        return
    # A device clearly reporting well past the track's own duration is a
    # bogus/glitched reading (or has already rolled onto whatever comes
    # after, which our own session doesn't know about yet either way) —
    # not something to recalibrate against.
    if st.current_track and device_pos > st.current_track.duration + POSITION_RESYNC_THRESHOLD:
        logger.debug(
            f"[position-resync] {candidate.target}: device={device_pos:.2f}s past track "
            f"duration={st.current_track.duration}s — ignoring"
        )
        return
    # The mirror image of the guard above: once the wall clock has already
    # reached (or nearly reached) the track's own duration, a device
    # position that suddenly drops back down is far more likely the device
    # having already finished/stopped this track than someone rewinding to
    # the very start in its last second — SonosDelivery.get_position()
    # reports a bare 0:00:00 once its transport has nothing playing,
    # indistinguishable at the value level from a genuine rewind. Trusting
    # it here recalibrates position_offset by (close to) the entire elapsed
    # wall-clock duration, which _fire_track_end's own remaining =
    # clock.seconds_until(...) reads directly (see that function's
    # docstring) — every subsequent resync during the ffmpeg-done-early
    # overrun window then pushed its schedule further into the future
    # instead of ever converging, so the track never auto-advanced and the
    # displayed position visibly snapped back toward 0:00 instead (observed
    # live 2026-08-20, a full track stuck until manually restarted).
    if (
        st.current_track
        and wall_elapsed >= st.current_track.duration - POSITION_RESYNC_THRESHOLD
        and device_pos < wall_elapsed - POSITION_RESYNC_THRESHOLD
    ):
        logger.debug(
            f"[position-resync] {candidate.target}: wall clock already at/past track end "
            f"(wall={wall_elapsed:.2f}s, duration={st.current_track.duration}s) and "
            f"device={device_pos:.2f}s dropped back below it — likely already finished, "
            "not a real rewind — ignoring"
        )
        return

    delta = device_pos - wall_elapsed
    # How far *this* measurement would move position_offset from what's
    # already applied — see POSITION_RESYNC_THRESHOLD's own comment for why
    # this, and not abs(delta) alone, is what actually gets compared
    # against it.
    change = delta - offset_before
    logger.debug(
        f"[position-resync] {candidate.target}: device={device_pos:.2f}s wall={wall_elapsed:.2f}s "
        f"delta={delta:+.2f}s change={change:+.2f}s offset_before={offset_before:.2f}s "
        f"play_generation={st.clock.play_generation} is_paused={st.clock.is_paused}"
    )
    if abs(change) < POSITION_RESYNC_THRESHOLD:
        return

    offset = st.clock.calibrate(device_pos)
    logger.info(
        f"[position-resync] {candidate.target}: external position change detected — "
        f"device={device_pos:.2f}s wall={wall_elapsed:.2f}s, offset {offset_before:.2f}s "
        f"-> {offset:.2f}s"
    )
    await session.event_bus.broadcast(build_status_dict(session))


async def _resync_position_periodically(session: SessionState, target, generation: int) -> None:
    """Keeps position_offset accurate for as long as this track keeps
    playing, by re-measuring the device's actual position every
    POSITION_RESYNC_INTERVAL and recalibrating (_resync_position_once above)
    if it's drifted from the wall-clock model by more than
    POSITION_RESYNC_THRESHOLD — see the constants above and
    _apply_position_offset()'s docstring for why this exists as a
    *separate*, ongoing function rather than just running that one for
    longer. Self-terminates the same way that one does: checking
    play_generation/is_streaming at the top of every iteration rather than
    needing an explicit cancellation from /stop or a superseding /play —
    /stop in particular has no reference to this task to cancel even if it
    wanted to, same as it has none for _apply_position_offset()'s task.

    Only ever meaningful for SUPPORTS_POSITION deliveries — which is all of
    them now, AirPlay included (see AirPlayDelivery.get_position()) — same
    restriction _apply_position_offset() has. A delivery falling back to a
    FIXED_OFFSET has nothing to resync against and is skipped here.

    Unlike that one-shot calibration's MAX_PLAUSIBLE_POSITION_LEAD guard
    (device position *ahead* of the wall clock is treated as a stale
    leftover reading, since nothing legitimate should outrun a stream that
    just started), a device position ahead of the wall-clock model here is
    exactly the "someone skipped forward on the device itself" case this
    function exists to catch — once a stream is well-established, deviation
    in *either* direction is plausible, so both get treated the same way
    (past a small threshold, not asymmetrically) — see
    _resync_position_once()'s own comment.
    """
    st = session.state
    if _position_candidate(st, target) is None:
        return

    while True:
        await asyncio.sleep(POSITION_RESYNC_INTERVAL)
        if st.clock.play_generation != generation or not st.is_streaming:
            return
        # Re-picked every iteration rather than chosen once above, because
        # what _reports_no_radio_position() answers can change *after* this
        # task starts: retry_radio_via_proxy() sets radio_info["proxied"]
        # only once the device has already refused the station's own stream
        # and been pointed at Beacon's endpoint instead, which is exactly
        # when a Sonos gets rewritten onto x-rincon-mp3radio:// and starts
        # reporting a flat 0.00s. A candidate chosen once, before that
        # happened, would then spend the rest of the run recalibrating
        # against that constant every 8s and pin elapsed() near 0 — the very
        # thing that predicate exists to prevent.
        candidate = _position_candidate(st, target)
        if candidate is None:
            return
        # Retires this task when /device-stop removed `candidate` from the
        # session — see is_still_targeted() (core/state.py) for why
        # play_generation above does not cover that, and what polling a
        # stopped speaker did to auto-advance. /device-stop starts a fresh
        # task for whatever is left, so this is a handover, not a loss of
        # resync.
        if not is_still_targeted(st.active_delivery, candidate):
            logger.info(
                f"[position-resync] {candidate.target}: no longer a target of this "
                "session — stopping resync for it"
            )
            return
        if st.clock.is_paused:
            continue
        await _resync_position_once(session, candidate, generation)


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

    st.radio_info = {**st.radio_info, "proxied": True, "content_type": FALLBACK_FORMAT.content_type}
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
    if st.radio_info:
        content_type = radio_content_type(st.radio_info)
        url = radio_dispatch_url(session.session_id, st.radio_info)
        return url, st.radio_info["title"], "", None, None, "", content_type
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


def playback_error_reporter(session: SessionState) -> Callable[[str], Awaitable[None]]:
    """The callback a delivery uses to say "this stopped and nobody asked".

    See BaseDelivery.on_playback_error for why deliveries need one at all.
    Only AirPlay ever calls it; every other target's failure surfaces as
    its GET /stream connection closing, which routes/stream.py notices on
    its own.

    Note this marks the *session* interrupted, not one device. For a
    single-target cast — which is what AirPlay is in practice — those are
    the same thing. For a multi-target one they are not, and the session
    would be marked interrupted while the other devices play on. That gap
    is the same one documented in
    docs/playback-bugs/multi-target-partial-drop-not-surfaced.md, which
    _mark_disconnected_if_not_reconnected() has for the same reason: there
    is no per-device notion of "streaming" to flip. Reporting a real
    failure against the session beats today's alternative of not reporting
    it at all, but it is not a per-device signal and must not be read as
    one.
    """

    async def _report(detail: str) -> None:
        logger.error(
            f"[playback] Delivery reported playback failure: {detail} | "
            f"{track_label(session) or 'no track'}"
        )
        await mark_interrupted(session)

    return _report


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
        url = stream_url(session.session_id)
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
        max_rate, max_depth = audio_capability_limits(target)
        # Remembered before resolving, so auto-advance and the /resume and
        # /seek paths below all see the same ceiling this dispatch used.
        session.state.max_lossy_format = req.max_lossy_format
        session.state.max_lossy_bitrate_kbps = req.max_lossy_bitrate_kbps
        output_format = await resolve_output_format(
            track_url,
            gain=req.gain,
            max_sample_rate=max_rate,
            max_bit_depth=max_depth,
            max_lossy_format=req.max_lossy_format,
            max_lossy_bitrate_kbps=req.max_lossy_bitrate_kbps,
        )

        if target:
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
        # nothing actually started playing on the device — see the except
        # branch below. copy.copy() is enough for clock: PlaybackClock is a
        # flat dataclass of primitives, no nested mutable state to worry about.
        previous_track = st.current_track
        previous_gain = st.current_track_gain
        previous_output_format = st.current_output_format
        previous_is_streaming = st.is_streaming
        previous_radio_info = st.radio_info
        previous_track_ended = st.track_ended
        previous_active_delivery = st.active_delivery
        previous_clock = copy.copy(st.clock)
        previous_queue = st.queue
        previous_queue_index = st.queue_index
        previous_original_queue = st.original_queue
        previous_shuffle = st.shuffle
        previous_repeat_mode = st.repeat_mode
        previous_autoplay_enabled = st.autoplay_enabled
        previous_autoplay_batch_size = st.autoplay_batch_size

        st.current_track = track
        st.current_track_gain = req.gain
        st.current_output_format = output_format
        st.is_streaming = True
        if st.radio_info is not None:
            session.stop_radio_metadata_watch()
            await session.stop_radio_relay()
        st.radio_info = None
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
                    logger.exception("[play] Delivery error")
                    st.current_track = previous_track
                    st.current_track_gain = previous_gain
                    st.current_output_format = previous_output_format
                    st.radio_info = previous_radio_info
                    st.track_ended = previous_track_ended
                    # Only if nothing else has touched active_delivery since
                    # this dispatch's own write to it above — a force-
                    # takeover's displace_target() can (rarely) mutate both
                    # this and is_streaming together, without this session's
                    # own play_lock, when its own play_lock-timeout fallback
                    # kicks in (see active_delivery_seq's own comment in
                    # core/state.py). Restoring the pre-dispatch snapshot
                    # over that would silently undo a takeover another
                    # session was already told (via the "displaced"
                    # broadcast) had succeeded — unconditionally restoring
                    # is correct for everything else here, which
                    # displace_target() never touches.
                    if st.active_delivery_seq == dispatch_delivery_seq:
                        st.active_delivery = previous_active_delivery
                        st.is_streaming = previous_is_streaming
                    st.clock = previous_clock
                    st.queue = previous_queue
                    st.queue_index = previous_queue_index
                    st.original_queue = previous_original_queue
                    st.shuffle = previous_shuffle
                    st.repeat_mode = previous_repeat_mode
                    st.autoplay_enabled = previous_autoplay_enabled
                    st.autoplay_batch_size = previous_autoplay_batch_size
                    # Dispatch never actually reached the device — release the
                    # claim just granted above instead of leaving it locked to
                    # this session (device_in_use for everyone else) with
                    # nothing actually playing on it.
                    await _release_claims(target, session)
                    return delivery_error_response(e, target)

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

        asyncio.create_task(_apply_position_offset(session, target, st.clock.play_generation))
        asyncio.create_task(
            _resync_position_periodically(session, target, st.clock.play_generation)
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
        # Asked of the station rather than guessed from its file extension:
        # a `.aac` URL is routinely served as `audio/aacp` (HE-AAC), and
        # announcing the extension's own `audio/aac` is what a Sonos
        # rejects with ERROR_UNSUPPORTED_FORMAT — for a stream it plays
        # fine once told the truth. See core/stream_format.py; the
        # extension guess is still the fallback there.
        probed = await probe_stream(url)
        if probed.refused:
            # The station answered Beacon's own probe with a 4xx. It will
            # answer the device the same way, and re-encoding it can't
            # help either — ffmpeg has to fetch the very same URL. Said
            # plainly here instead of letting the speaker fail on it and
            # the re-encode fail behind that, which is what a listener was
            # left to interpret: a speaker reporting ERROR_ACCESS_DENIED,
            # then ERROR_CORRUPT_FILE for the empty re-encode, reads as if
            # the *speaker* were broken.
            #
            # Only the handful of codes that mean the station itself said
            # no (see _REFUSED_STATUSES) — a timeout, a refused connection
            # or a 5xx still dispatch as before, since a station can be
            # slow or briefly broken and play fine anyway, and refusing to
            # try would be worse than trying and failing.
            logger.info(f"[play-url] {url} refused the connection — not dispatching")
            st.radio_info = previous_radio_info
            await _release_claims(target, session)
            return {
                "error": "delivery_failed",
                "reason": REASON_STATION_REFUSED,
                "device": device_label(target),
                "detail": probed.detail or url,
            }
        content_type = probed.content_type

        # Relayed (default) routes the device at Beacon's own relay
        # (core/radio_relay.py) instead of the station directly — one fetch
        # of the station feeds every cast target's audio, the visualizer,
        # and the ICY title watch below at once. The relay has to be up
        # before dispatch, unlike the direct mode's ICY watch (started only
        # after a successful dispatch, further down): dispatch itself needs
        # to know where the relay's device-audio actually is.
        relayed = not req.cast_directly
        dispatch_url = url
        dispatch_content_type = content_type
        if relayed:
            relay = await session.start_radio_relay(url, content_type)
            if relay.connected:
                dispatch_url = radio_stream_url(session.session_id)
                dispatch_content_type = relay.device_content_type
            else:
                # The relay never got as far as a running ffmpeg (the
                # station refused this second connection, or never answered
                # — probe_radio_stream() above used a connection of its own,
                # and some stations allow exactly one at a time). Pointing
                # the device at /stream/radio anyway would answer 200 with a
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

        st.radio_info = {
            "title": req.title,
            "url": url,
            "content_type": content_type,
            "relayed": relayed,
        }

        # Keyed on the station's own url, not dispatch_url: when relayed,
        # dispatch_url is always this session's fixed relay endpoint
        # regardless of which station is behind it, so keying on it instead
        # would make switching stations in quick succession look like a
        # duplicate of the previous one and silently skip the redispatch —
        # the device would keep pointing at a relay connection that
        # start_radio_relay() has, by then, already torn down.
        if not _is_duplicate_dispatch(st, f"play-url:{target}:{url}"):
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
                        if st.radio_info is not None:
                            st.radio_info = {**st.radio_info, "relayed": False}
                    # See /play's identical comment — don't leave the device
                    # locked to this session when nothing actually started
                    # playing on it.
                    await _release_claims(target, session)
                    return delivery_error_response(e, target)

        st.current_track = None
        # Left alone when the retry above already set it to the re-encoding
        # format — overwriting here would hide the transcode from the panel
        # that exists to show it.
        if not st.radio_info.get("proxied"):
            st.current_output_format = FALLBACK_FORMAT
        st.is_streaming = True
        if relayed:
            # Superseded by the relay's own ICY parsing (same fetch, same
            # _set_radio_title callback) — stop whatever independent watch
            # might already be running for this session. stores/playback.ts's
            # playRadioStation() always calls /radio-metadata/start once,
            # even when about to cast (local playback needs it and casting
            # doesn't know that in advance) — left running here, that would
            # be exactly the second connection per station this mode exists
            # to avoid.
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

        asyncio.create_task(_apply_position_offset(session, target, st.clock.play_generation))
        asyncio.create_task(
            _resync_position_periodically(session, target, st.clock.play_generation)
        )
        # Chromecast/DLNA/Sonos — see core/radio_position.py's module
        # docstring, and core/state.py's first_radio_position_delivery()
        # for why Sonos is conditional on the URL actually dispatched: a
        # retry_radio_via_proxy() success above means the device ended up
        # at Beacon's own endpoint (radio_stream_url()) even though
        # `relayed` itself is still False for that path, same as `dispatch_
        # url` — recomputed here rather than trusted, for exactly that
        # reason. Replaces whatever tracker (if any) was here for a
        # previous dispatch; the old one, if still running, notices the
        # generation bump on its own next poll and exits.
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
        await session.event_bus.broadcast(build_status_dict(session))
        return {"status": "playing", "url": url}


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
        logger.warning("[pause] Rejected: media server not configured (waiting for /config)")
        return {"error": "Media server not configured — waiting for /config"}
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

            # The reconnect above starts a *fresh* stream (FFmpeg output
            # restarts near 0 again), re-incurring the device's startup-
            # buffering delay exactly like a brand new /play or a /seek —
            # see _apply_position_offset()'s docstring and the identical
            # calls from /play, /play-url, and /seek. Without this,
            # position_offset keeps whatever value was measured before the
            # pause, so elapsed()/lyrics-sync/the visualizer run ahead of
            # what's actually audible until the periodic resync below's
            # first tick catches up, up to POSITION_RESYNC_INTERVAL later.
            asyncio.create_task(
                _apply_position_offset(session, st.active_delivery, st.clock.play_generation)
            )
            # clock.resume() above bumped play_generation, same as seek_to()
            # does — any _resync_position_periodically() task still running
            # from before the pause sees that mismatch on its next wake and
            # quietly exits (see that function's own docstring), so without
            # this, periodic resync would silently stop working for good
            # after the *first* pause/resume of any given track.
            asyncio.create_task(
                _resync_position_periodically(session, st.active_delivery, st.clock.play_generation)
            )
            # Same generation-bump problem, for core/radio_position.py's
            # RadioPositionTracker — radio only (st.radio_info), since
            # tracks don't use it at all. Without this, a pause/resume
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
            asyncio.create_task(
                _resync_position_periodically(session, st.active_delivery, st.clock.play_generation)
            )
            # See /resume's identical comment — same generation-bump problem
            # for core/radio_position.py's RadioPositionTracker. Radio has
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
            if _is_duplicate_queue_topup(st, st.queue, req.song_ids):
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
            await session.event_bus.broadcast(build_status_dict(session))
        return {"status": "ok"}


@router.post("/stop")
async def stop_playback(session: SessionState = Depends(require_authenticated_session)):
    async with session.play_lock:
        st = session.state
        if st.active_delivery:
            await st.active_delivery.stop()
        st.is_streaming = False
        st.clock.is_paused = False
        st.track_ended = False
        st.current_track = None
        st.current_output_format = FALLBACK_FORMAT
        st.radio_info = None
        session.stop_radio_metadata_watch()
        await session.stop_radio_relay()
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
