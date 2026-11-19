"""core/cast_position.py - keeping a cast session's clock on what the speaker
actually plays: one calibration right after a dispatch, then a periodic
resync for as long as the track runs, and the backstop for a track whose end
nobody reported. start_position_sync() starts the first two together.
"""

import asyncio
import logging
import time

from core.playback_clock import MAX_PLAUSIBLE_POSITION_LEAD, POSITION_RESYNC_THRESHOLD
from core.session import (
    SessionState,
    build_status_dict,
    is_this_sessions_stream,
    playback_duration,
)
from core.state import AppState, connection_being_played, fetched_by, is_still_targeted
from delivery import SonosDelivery

# Kept on the playback logger: the log-level setting and every existing log
# reading know these lines under it.
logger = logging.getLogger("connect.playback")


def start_position_sync(session: SessionState, target) -> None:
    """Calibrate once and keep resyncing, for the stream that just started.
    Both tasks retire themselves when the clock's generation moves on."""
    generation = session.state.clock.play_generation
    asyncio.create_task(apply_position_offset(session, target, generation))
    asyncio.create_task(resync_position_periodically(session, target, generation))


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
    either path. resync_position_periodically() would recalibrate against
    it every POSITION_RESYNC_INTERVAL and win the tug-of-war against the
    wall clock, pinning elapsed() near 0 so the radio "running since"
    display never advances. apply_position_offset() was assumed safe from
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


def _tracked_for_radio(session: SessionState, delivery) -> bool:
    """Whether core/radio_position.py's tracker is already measuring this
    delivery for the station currently playing — in which case it also
    calibrates the clock from those same readings (see its
    _calibrate_clock()), and the two functions below must not ask the very
    same device the very same question a second time.

    A DlnaDelivery.get_position() is a real SOAP round trip and a Sonos's
    is two HTTP ones, so a second poller is not free: for the first ten
    seconds of a station the tracker and apply_position_offset() polled at
    0.5s each, doubling exactly the traffic _IDLE_POLL_INTERVAL_SECONDS
    (core/radio_position.py) was introduced to bring down."""
    tracker = session.radio_position_tracker
    return tracker is not None and tracker.delivery is delivery


def _position_candidate(session: SessionState, target):
    """The delivery to calibrate this session's clock against — the first
    that can report a position, whose reading is actually usable right now
    (see _reports_no_radio_position()), and that nothing else is already
    measuring (see _tracked_for_radio()).

    Skipping just the unusable delivery rather than giving up on the whole
    target matters for a multi-target cast: `candidate` is simply the first
    SUPPORTS_POSITION delivery, so a Sonos that happens to sort ahead of a
    Chromecast used to disable position resync for the session entirely,
    including for the Chromecast that does report a usable position."""
    st = session.state
    deliveries = getattr(target, "deliveries", [target])
    return next(
        (
            d
            for d in deliveries
            if d.SUPPORTS_POSITION
            and not _reports_no_radio_position(st, d)
            and not _tracked_for_radio(session, d)
        ),
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


async def apply_position_offset(session: SessionState, target, generation: int) -> None:
    """Set `position_offset` for the track that just started playing.

    `compute_position()` returns `wall_elapsed + position_offset`. A device
    that's buffering lags behind the wall clock, so `position_offset` is
    normally negative (a second or two, depending on the target). This is
    what keeps the lyrics view in sync with what's actually audible.

    Every delivery here can answer where playback is — read off the device
    for Sonos/Chromecast/DLNA, derived from what has been pushed for AirPlay
    — so the normal path is to poll briefly once, measure the actual delay,
    then keep it constant for the rest of the track (re-buffering mid-track
    is left to resync_position_periodically()). A delivery declaring a
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
    # re-check in resync_position_once()).
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
    candidate = _position_candidate(session, target)
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
        # just before the request (same race resync_position_once() guards
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
        # reading is a bogus one (matches resync_position_once()'s own
        # guard below) — not a real position either.
        if device_pos is None or device_pos < 0:
            continue
        follow_the_connection_played(st, candidate, generation)
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
        _position_frozen(st, candidate, generation, device_pos)
        offset = st.clock.calibrate(device_pos)
        logger.debug(
            f"[lyrics-sync] {candidate.target}: calibrated position_offset="
            f"{offset:.2f}s (device {device_pos:.2f}s vs. wall {wall_elapsed:.2f}s)"
        )
        await session.event_bus.broadcast(build_status_dict(session))
        return


# How often to re-check the device's own reported position against our
# wall-clock model for the rest of a track's playback — apply_position_offset()
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


async def _foreign_uri(session: SessionState, candidate) -> str | None:
    """What `candidate` plays instead of this session's stream, or None when
    it plays ours or cannot say."""
    try:
        uri = await candidate.current_uri()
    except Exception as e:
        logger.debug(f"[position-resync] {candidate.target}: current_uri() failed: {e}")
        return None
    if uri is None or is_this_sessions_stream(session, uri):
        return None
    return uri


def follow_the_connection_played(st: AppState, candidate, generation: int) -> None:
    """Base the clock's stream frame on the connection `candidate` is
    actually playing.

    routes/stream.py re-bases it on every connection the device opens by
    itself, as a reconnect - but a Sonos opens a second one at the start of
    a stream only to probe it, and keeps playing the first. Left on the
    probe's start, every position compared against the device was off by
    the difference: 2s, observed as the visualizer and the lights running
    that far ahead of the sound."""
    mine = [c for c in st.open_streams if fetched_by(candidate, c.peer, c.sender)]
    played = connection_being_played(mine, generation)
    if played is None or played.start == st.clock.track_start_position:
        return
    logger.info(
        f"[position-resync] {candidate.target}: plays the connection from "
        f"{played.start:.1f}s, not the one from {st.clock.track_start_position:.1f}s "
        "— following it"
    )
    st.clock.restream_from(played.start)


def _position_frozen(st: AppState, candidate, generation: int, device_pos: float) -> bool:
    """Whether `device_pos` is the device still repeating the first position
    it gave for this stream, which says nothing about where it is.

    Some renderers (LinkPlay) report 0:00:00 for as long as they play. Each
    of those readings looked like a rewind to the start, and recalibrating
    onto it every POSITION_RESYNC_INTERVAL pulled the clock back by the whole
    time played - the display kept jumping to 0:00, and the track end it
    schedules from moved out with it (#94). The first reading is taken as
    usual; until a later one differs, the clock runs on its own. Once the
    position has moved, the device is followed again, rewinds included."""
    first = st.first_device_reading
    if first is None or first[0] != generation or first[1] != candidate.target:
        st.first_device_reading = (generation, candidate.target, device_pos, False)
        return False
    _, _, first_pos, moved = first
    if moved:
        return False
    if device_pos != first_pos:
        st.first_device_reading = (generation, candidate.target, first_pos, True)
        return False
    return True


def _describe_open_streams(st) -> str:
    if not st.open_streams:
        return "no stream connection open"
    return "; ".join(f"stream {conn.describe()}" for conn in st.open_streams)


async def resync_position_once(session: SessionState, candidate, generation: int) -> None:
    """One resync check/correction against `candidate` — split out from
    resync_position_periodically() below purely so it's directly testable
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
    # easily a second or more, not instant. resync_position_periodically
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
    follow_the_connection_played(st, candidate, generation)
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
    st.device_reading = (generation, time.time(), device_pos, candidate.target)
    if _position_frozen(st, candidate, generation, device_pos):
        logger.debug(
            f"[position-resync] {candidate.target}: device={device_pos:.2f}s "
            f"wall={wall_elapsed:.2f}s, the same position as its first reading of "
            "this stream - it does not report one, keeping the clock"
        )
        return
    # A device clearly reporting well past the track's own duration is a
    # bogus/glitched reading (or has already rolled onto whatever comes
    # after, which our own session doesn't know about yet either way) —
    # not something to recalibrate against.
    # A mix spans many songs, so neither guard against the song's own end
    # below applies to it: its device position is the whole stream's.
    within_one_song = st.current_track is not None and st.mix is None
    if within_one_song and device_pos > st.current_track.duration + POSITION_RESYNC_THRESHOLD:
        logger.debug(
            f"[position-resync] {candidate.target}: device={device_pos:.2f}s past track "
            f"duration={st.current_track.duration}s — ignoring"
        )
        return
    # The mirror image of the guard above: once the wall clock has already
    # reached (or nearly reached) the end of the track, a device
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
    #
    # In the track's own frame (where this stream began plus how long it has
    # run) and against where the audio sent ends: after a seek, or with a
    # file whose listed length is off, the device finishes well short of
    # the listed duration, and was stuck the same way (#56).
    track_position = st.clock.track_start_position + wall_elapsed
    track_end = playback_duration(st)
    if (
        within_one_song
        and track_position >= track_end - POSITION_RESYNC_THRESHOLD
        and device_pos < wall_elapsed - POSITION_RESYNC_THRESHOLD
    ):
        logger.debug(
            f"[position-resync] {candidate.target}: wall clock already at/past track end "
            f"(at {track_position:.2f}s of {track_end:.2f}s) and "
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
        f" | {_describe_open_streams(st)}"
    )
    if abs(change) < POSITION_RESYNC_THRESHOLD:
        return

    # A jump this size can also mean somebody else - another app, another
    # Beacon - put something on the speaker, whose position says nothing
    # about ours. Asked only now, since it costs a second device round trip.
    if st.radio_info is None:
        foreign = await _foreign_uri(session, candidate)
        # The same races as after get_position() above.
        if (
            st.clock.play_generation != generation
            or not st.is_streaming
            or not is_still_targeted(st.active_delivery, candidate)
        ):
            return
        if foreign is not None:
            logger.info(
                f"[position-resync] {candidate.target}: device={device_pos:.2f}s "
                f"wall={wall_elapsed:.2f}s, but it plays {foreign[:80]!r}, not this "
                "session's stream — leaving the clock alone"
            )
            return
        # The device has played on during that round trip, by as much as the
        # clock has.
        device_pos += st.clock.elapsed_since_stream_start() - wall_elapsed

    offset = st.clock.calibrate(device_pos)
    logger.info(
        f"[position-resync] {candidate.target}: external position change detected — "
        f"device={device_pos:.2f}s wall={wall_elapsed:.2f}s, offset {offset_before:.2f}s "
        f"-> {offset:.2f}s | {_describe_open_streams(st)}"
    )
    # Whether the device itself thinks it started over, and why - asked
    # only here, since it costs more device round trips.
    try:
        transport = await candidate.describe_transport()
    except Exception as e:
        transport = f"unavailable ({e})"
    if transport:
        logger.info(f"[position-resync] {candidate.target}: device reports {transport}")
    await session.event_bus.broadcast(build_status_dict(session))


# How far past a track's own duration the wall clock has to be before
# finish_orphaned_track() below concludes that nothing is going to report
# this track's end. Generous on purpose: the normal path (routes/stream.py's
# _advance_or_end) fires within a second or two of the duration, and the
# ffmpeg-done-early overrun window legitimately sits right at it. This only
# has to be long enough that a healthy end has certainly already happened —
# STREAM_DISCONNECT_GRACE_SECONDS is the longest wait in that path, and this
# is comfortably past it.
ORPHANED_TRACK_GRACE_SECONDS = 20.0


async def finish_orphaned_track(session: SessionState, generation: int) -> bool:
    """Close out a track whose end nobody reported, and say whether it did.

    Exactly one place marks a track finished: routes/stream.py's
    _advance_or_end(). It refuses to, deliberately and silently, when the
    stream generator calling it belongs to an older play_generation than the
    clock — that guard is what stops a superseded stream from declaring the
    end of a track that is no longer the one playing.

    But a generator can be superseded and *still be the one feeding the
    device*: a second /play for the same track on the same target (a
    double-dispatched click, see stores/playback.ts's startCurrent) bumps the
    generation without the device ever reopening its connection, so the
    bytes keep coming from the now-older generator. It plays to the end
    perfectly normally, then declines to report it — and nothing else ever
    does. Observed live 2026-09-05: `ended` never reached the frontend, so
    isPlaying stayed true, the visualizer froze on its last frame, and this
    very resync loop was still polling a stopped speaker five minutes past a
    229s track. See docs/investigations/streaming/track-end-never-reported.md.

    Rather than teach that guard to distinguish the two cases (it cannot -
    from inside the generator, "superseded but still feeding" and
    "superseded and replaced" look identical), this is the backstop for
    every way a track end can go unreported: the wall clock is well past the
    track's own duration, the device has dropped back to a standstill, and
    no stream connection is open any more. All three together cannot
    describe a track that is still playing.
    """
    st = session.state
    track = st.current_track
    if track is None or not track.duration or st.mix is not None:
        # A mix reports its own end (routes/mix_cast.py's follow()).
        return False
    # elapsed_since_stream_start(), the same measure resync_position_once()
    # compares against — not elapsed(), whose position_offset is the very
    # thing a stalled track's resyncs have been pushing around, and not
    # seconds_until(), which clamps at zero and so can never express "past
    # the end" at all.
    wall_elapsed = st.clock.elapsed_since_stream_start()
    if wall_elapsed < float(track.duration) + ORPHANED_TRACK_GRACE_SECONDS:
        return False
    if st.active_stream_connections > 0:
        return False
    logger.info(
        f"[position-resync] {track.artist} — {track.title}: track end was never reported "
        f"({wall_elapsed:.0f}s elapsed of {track.duration}s, no stream connection open) "
        "— marking it finished"
    )
    st.is_streaming = False
    st.track_ended = True
    await session.event_bus.broadcast(build_status_dict(session))
    return True


async def resync_position_periodically(session: SessionState, target, generation: int) -> None:
    """Keeps position_offset accurate for as long as this track keeps
    playing, by re-measuring the device's actual position every
    POSITION_RESYNC_INTERVAL and recalibrating (resync_position_once above)
    if it's drifted from the wall-clock model by more than
    POSITION_RESYNC_THRESHOLD — see the constants above and
    apply_position_offset()'s docstring for why this exists as a
    *separate*, ongoing function rather than just running that one for
    longer. Self-terminates the same way that one does: checking
    play_generation/is_streaming at the top of every iteration rather than
    needing an explicit cancellation from /stop or a superseding /play —
    /stop in particular has no reference to this task to cancel even if it
    wanted to, same as it has none for apply_position_offset()'s task.

    Only ever meaningful for SUPPORTS_POSITION deliveries — which is all of
    them now, AirPlay included (see AirPlayDelivery.get_position()) — same
    restriction apply_position_offset() has. A delivery falling back to a
    FIXED_OFFSET has nothing to resync against and is skipped here.

    Unlike that one-shot calibration's MAX_PLAUSIBLE_POSITION_LEAD guard
    (device position *ahead* of the wall clock is treated as a stale
    leftover reading, since nothing legitimate should outrun a stream that
    just started), a device position ahead of the wall-clock model here is
    exactly the "someone skipped forward on the device itself" case this
    function exists to catch — once a stream is well-established, deviation
    in *either* direction is plausible, so both get treated the same way
    (past a small threshold, not asymmetrically) — see
    resync_position_once()'s own comment.
    """
    st = session.state
    if _position_candidate(session, target) is None:
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
        candidate = _position_candidate(session, target)
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
        # Before recalibrating against it: is this track actually still
        # playing at all? See finish_orphaned_track().
        if await finish_orphaned_track(session, generation):
            return
        await resync_position_once(session, candidate, generation)
