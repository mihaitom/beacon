"""routes/upnp.py — NOTIFY /upnp/events/{service}/{label}, the callback cast
devices POST their transport-state and volume changes to.

Lives on the app's existing port rather than a listener of its own: the
callback URL handed to a device just has to be something it can reach on
this LAN, and stream_url() already proves that address works for these
devices (it is where they fetch the audio from).

No token auth, for the same reason GET /stream has none (see its comment):
the device dialling back in cannot attach one. The AVTransport branch treats
every body as untrusted text, only ever parsing known property names out of
it and logging them — it changes no playback state, so an unsolicited POST
there can produce a stray log line and nothing more. The RenderingControl
branch does write state (a session's device_volumes), but only ever a
volume/mute number already scoped to whichever session claims that device
(core/claims.py) — an unsolicited POST from an unclaimed device name simply
finds no owner and is dropped, same as a stray AVTransport one.
"""

import logging
import time

from fastapi import APIRouter, Request, Response

from core.claims import claims
from core.icy_metadata import strip_pulse
from core.session import SessionState, build_status_dict, registry
from core.state import PORT, get_local_ip, radio_dispatch_url
from core.stream_format import radio_content_type
from core.upnp_events import (
    handle_event,
    parse_rendering_control_event,
    parse_stream_title_echo,
    problem_in,
)
from delivery.errors import transport_error_response
from routes.playback import retry_radio_via_proxy

logger = logging.getLogger("connect.upnp")
router = APIRouter()

_CALLBACK_PREFIX = "/upnp/events"

# How rarely a relayed station may be redispatched to the same device after
# a transport failure — see _redispatch_relayed_station() for why this is a
# cooldown rather than the one-shot guard the re-encode path uses. Long
# enough that an unrecoverable relay can't turn recovery into a busy loop,
# short enough that a listener whose speaker dropped out during a station
# reconnect gets it back on its own rather than reaching for the app.
_RELAY_REDISPATCH_COOLDOWN_SECONDS = 30.0

# Renderers vary in how much they send; a LastChange document with a full
# Sonos property set is a few KB. This is far above that and exists only so
# a misbehaving (or hostile) sender cannot stream an unbounded body at us.
_MAX_BODY_BYTES = 256 * 1024

# The range an ICY round-trip sample has to fall in to be treated as a real
# measurement of a device's own startup buffer at all — see
# _handle_stream_title_echo(), and core/session.py's radio_icy_measured_lag
# for why samples can only ever err on the high side.
#
# The lower bound is scripts/icy_sync_probe.py's own reading of its results,
# verbatim: "min < 1s -> reports on read. Dead end, the number is network
# latency." A device that echoes a title that fast is reporting what it has
# *received*, not what it is playing, and that number describes the LAN, not
# a buffer.
#
# The upper bound covers every device this has been measured against with
# room to spare — Sonos over x-rincon-mp3radio:// at 4.7-5.0s, DLNA at
# 5.4-5.6s, Chromecast (the largest) at 10.6-11.0s. It exists because the
# min-estimator alone cannot help the *first* sample: with nothing better to
# compare against, one 16.63s artefact of Sonos's event moderation would
# stand as the estimate until a better sample happened along, and title
# changes on a radio station are minutes apart. Discarding it instead leaves
# the fixed guess in place, which is far closer to right.
_PLAUSIBLE_ICY_LAG = (1.0, 12.0)


def callback_url_for(label: str, service: str = "avtransport") -> str:
    """The CALLBACK a device should POST its events to. `label` and
    `service` come back in the path so one endpoint can serve every
    subscribed device *and* service without needing to match on source
    address — a grouped Sonos pair reports from two different players about
    the same session, and a single player holds one subscription per
    service (see core/upnp_events.py's Subscription)."""
    return f"http://{get_local_ip()}:{PORT}{_CALLBACK_PREFIX}/{service}/{label}"


async def _handle_rendering_control_event(label: str, body: str) -> None:
    """Push Master-channel Volume/Mute into whichever session currently
    claims `label` (a Sonos room name — RenderingControl subscriptions are
    Sonos-only for now, see delivery/sonos.py) and rebroadcast its status,
    replacing DeviceListItem.vue's 4s poll for that device. A no-op, not an
    error, whenever nobody currently claims it (the app was closed, the
    device was released, or this is simply a stray/unsolicited POST) — the
    reading just has nothing to update."""
    properties = parse_rendering_control_event(body)
    if not properties:
        return
    session_id = claims.owner_of("sonos", label)
    if session_id is None:
        return
    session = registry.get(session_id)
    if session is None:
        return

    key = f"sonos:{label}"
    volume, muted = session.state.device_volumes.get(key, (None, None))
    if "Volume" in properties:
        try:
            volume = int(properties["Volume"])
        except ValueError:
            pass
    if "Mute" in properties:
        muted = properties["Mute"] != "0"
    session.state.device_volumes[key] = (volume, muted)
    await session.event_bus.broadcast(build_status_dict(session))


async def _handle_stream_title_echo(label: str, body: str) -> None:
    """Sonos's own confirmation that a specific ICY title (core/icy_
    metadata.py's IcyMuxer, injected into its own fetch of Beacon's radio
    endpoint) has actually become audible — see core/session.py's
    radio_icy_pending_injection/radio_icy_measured_lag and core/
    visualizer_feed.py's _FirstByteClock for what reads the result.

    The gap between injecting a title and this device reporting the same
    one back over its own AVTransport eventing is a *bound* on its own
    buffering delay — the exact technique scripts/icy_sync_probe.py
    validated against real hardware. Off by default since
    core/icy_metadata.py's ICY_ROUND_TRIP_ENV (nothing functional is left
    reading the result — see that constant's own comment), so in practice
    this function is a no-op now: routes/stream.py's record_injection()
    never arms radio_icy_pending_injection, so `pending is None` below
    always holds. Kept rather than deleted for whoever flips that env var
    back on. Needed at all only because delivery/sonos.py's own
    x-rincon-mp3radio:// dispatch (added to fix Sonos-only dropouts while
    relayed) reports position 0.00s for the entire run, the one live signal
    Chromecast/DLNA still get from RadioPositionTracker.

    A bound, not a reading, and only ever an upper one — which is why
    core/session.py's radio_icy_measured_lag keeps the smallest sample
    rather than the newest. An echo means "the device is currently
    reporting this title", not "it started playing it just now": a device
    cannot report a title before it plays it (so no sample can come out too
    small), but Sonos moderates its own eventing heavily and may simply not
    send anything for a while (so any sample can come out far too large).
    Measured live 2026-09-05: a single routine state=PLAYING NOTIFY, 26s
    after the previous event on the same unchanged URI, yielded 16.63s for
    a device whose real buffer is under five — the probe script's own
    output had already said as much ("min delta ... <- the estimator would
    use this", "spread -> event moderation. The plan's min-estimator eats
    it"); only the min part had never made it over here.

    A no-op whenever there's nothing to match: no title in this NOTIFY at
    all (most don't carry one — LastChange fires on plenty that have
    nothing to do with metadata), nothing currently pending for this
    session, the pending title doesn't match what echoed back (a stale
    echo of an older title, someone else's injection — see
    radio_icy_pending_injection's own comment on that small, accepted
    cross-talk risk), or the sample falls outside _PLAUSIBLE_ICY_LAG."""
    echoed = parse_stream_title_echo(body)
    if not echoed:
        return
    session_id = claims.owner_of("sonos", label)
    if session_id is None:
        return
    session = registry.get(session_id)
    if session is None:
        return
    pending = session.radio_icy_pending_injection
    if pending is None:
        return
    # strip_pulse on the pending side as well: core/icy_metadata.py's
    # pulsed_title() appends an invisible mark on alternating windows to
    # give this measurement a steady cadence, and a device is free to
    # normalise that away before reporting the title back. One that does
    # simply stops producing the extra measurement points — it must not
    # also lose the ones a genuine title change produces.
    if echoed != pending[0] and echoed != strip_pulse(pending[0]):
        return
    lag = time.monotonic() - pending[1]
    session.radio_icy_pending_injection = None
    low, high = _PLAUSIBLE_ICY_LAG
    if not low <= lag <= high:
        logger.info(
            f"[upnp] {label}: ICY round trip implausible — lag={lag:.2f}s outside "
            f"{low:.1f}-{high:.1f}s, discarded (title={echoed!r})"
        )
        return
    # Stored raw, as the round trip it is. What the device does *after*
    # reporting the title — its own output stage — is not part of this
    # measurement and is not corrected for here: the same shortfall applies
    # to Chromecast's polled position, which never touches this code path at
    # all, so it belongs to the clock that consumes both. See
    # core/visualizer_feed.py's visualizer_lead_correction().
    previous = session.radio_icy_measured_lag
    if previous is not None and previous <= lag:
        logger.debug(
            f"[upnp] {label}: ICY round trip {lag:.2f}s not better than the "
            f"{previous:.2f}s already measured — keeping that (title={echoed!r})"
        )
        return
    session.radio_icy_measured_lag = lag
    logger.info(f"[upnp] {label}: ICY round trip measured — lag={lag:.2f}s (title={echoed!r})")


async def _handle_transport_problem(label: str, problem: str) -> None:
    """A device reporting, on its own event channel, that what it was given
    isn't playing.

    Only radio *direct to the device* (PlayUrlRequest.cast_directly=True —
    see routes/playback.py) ever gets acted on here, and only once. A Sonos
    accepts a station's URI, answers the /play-url call successfully, and
    *then* reports ERROR_UNSUPPORTED_FORMAT (a format it won't decode) or
    ERROR_ACCESS_DENIED (an https URL on someone else's host) moments
    later — so there is no failure at the point anyone is still waiting on
    a response, and until now the listener saw nothing at all while the
    speaker sat silent. Beacon re-encodes the station and points the
    device at that instead; see retry_radio_via_proxy() for why one retry
    fixes both refusals without telling them apart.

    A relayed station (the default — core/radio_relay.py) takes a different
    route out of here, _redispatch_relayed_station(): the device already
    only ever sees Beacon's own honest MP3 stream there, so neither refusal
    reason applies and there is nothing to re-encode it into.
    retry_radio_via_proxy() must not run for one — it would redispatch the
    exact same relay URL while wrongly marking radio_info as
    "proxied"/"device rejected", which then blocks any recovery from ever
    running again for this station, permanently, the next time the device's
    connection drops (found live 2026-09-01, chasing a *different* bug: a
    relayed station whose device connection kept dropping for a real
    reason — RadioRelay leaving its PCM output undrained and stalling its
    own ffmpeg — looped through here, marked itself "proxied" on the first
    drop, and would have gone permanently silent on a second one even after
    that root cause was fixed).

    A queued track is deliberately left alone: its own GET /stream
    connection closing is what routes/stream.py already watches for, and a
    second, overlapping recovery path for the same event would fight it.

    Anything not currently claimed by a session is a no-op — the same
    "nothing to update" case _handle_rendering_control_event() has."""
    session_id = claims.owner_of("sonos", label)
    if session_id is None:
        return
    session = registry.get(session_id)
    if session is None:
        return
    st = session.state
    if not st.radio_info or st.active_delivery is None:
        return
    if st.radio_info.get("relayed"):
        await _redispatch_relayed_station(session, label, problem)
        return
    if st.radio_info.get("proxied"):
        return

    logger.info(f"[upnp] {label} refused the station ({problem}) — re-encoding it")
    if not await retry_radio_via_proxy(session, st.active_delivery):
        # Nothing left to try. Tell the client rather than leaving a silent
        # speaker and a UI that still says "playing" — this is the one
        # path where the failure never reached a request's own response.
        await session.event_bus.broadcast(
            build_status_dict(
                session, delivery_error=transport_error_response(problem, st.active_delivery)
            )
        )


async def _redispatch_relayed_station(session: SessionState, label: str, problem: str) -> None:
    """A relayed station's own recovery: point the device back at the same
    relay endpoint it already had.

    That is not the no-op it looks like. The relay outlives any one device
    connection (see core/radio_relay.py) and keeps reconnecting to the
    station on its own, so the usual reason a device ends up here is that
    it ran its buffer dry during one of those reconnects and gave up on its
    HTTP connection — with audio flowing again by the time this runs.
    Without a redispatch the speaker stays silent until the listener
    restarts playback by hand, which is what excluding relayed stations
    from recovery entirely used to mean.

    Rate-limited rather than one-shot, and deliberately so: `proxied`'s
    "only ever once" guard is right for a re-encode (a device that refuses
    Beacon's MP3 will refuse it again), but wrong here, where each drop is
    a fresh transport failure that may well succeed on the next attempt.
    The cooldown is what keeps a genuinely broken relay from turning this
    into the redispatch loop the exclusion was originally added to stop —
    an unrecoverable one now costs one retry every
    _RELAY_REDISPATCH_COOLDOWN_SECONDS instead of as fast as the device can
    report failures.

    Reported live 2026-09-04: a redispatched Sonos went silent for its own
    fresh startup-buffering delay same as any other, but the seek bar kept
    showing "Live" ticking straight through it rather than "Buffering…" —
    session.state.clock.elapsed_since_stream_start() (what
    core/session.py's radio_is_buffering() checks a relayed Sonos against,
    that device having no RadioPositionTracker of its own to poll instead —
    see core/state.py's first_radio_position_delivery()) was still counting
    from the *original* dispatch, minutes ago, not this fresh one, so the
    buffering window it's compared against had already long since elapsed.
    restream_from() below is the same fix routes/stream.py's own device-
    reconnect handling already applies for the identical reason (see that
    call's own comment) — re-basing only the stream-start reference, never
    elapsed() itself, so the displayed position doesn't jump.

    No RadioPositionTracker recreated here, unlike /play-url, /resume and
    /seek's identical-looking block — this handler only ever runs for a
    Sonos (see _handle_transport_problem's claims.owner_of("sonos", ...)
    guard), and a relayed one never has a tracker to begin with (see
    first_radio_position_delivery()'s own docstring on why Sonos over
    x-rincon-mp3radio:// is excluded) — there is nothing here that would
    need replacing."""
    st = session.state
    assert st.radio_info is not None and st.active_delivery is not None
    now = time.monotonic()
    if now - session.last_radio_redispatch < _RELAY_REDISPATCH_COOLDOWN_SECONDS:
        logger.debug(f"[upnp] {label} reported {problem} again — still in redispatch cooldown")
        return
    session.last_radio_redispatch = now

    url = radio_dispatch_url(session.session_id, st.radio_info)
    logger.info(f"[upnp] {label} lost the relayed station ({problem}) — redispatching {url}")
    try:
        await st.active_delivery.play(
            url, st.radio_info["title"], content_type=radio_content_type(st.radio_info)
        )
    except Exception:
        logger.exception("[upnp] Redispatching the relayed station failed")
        # Same reasoning as the re-encode path below — this failure never
        # reached any request's own response, so the client only learns
        # about it here.
        await session.event_bus.broadcast(
            build_status_dict(
                session, delivery_error=transport_error_response(problem, st.active_delivery)
            )
        )
        return
    st.clock.restream_from(st.clock.stream_restart_position())
    # Not just left to the next periodic status tick — a listener staring
    # at a frozen "Live" readout for however long that tick takes to come
    # around is exactly the confusing gap this whole fix exists to close.
    await session.event_bus.broadcast(build_status_dict(session))


@router.api_route(_CALLBACK_PREFIX + "/{service}/{label}", methods=["NOTIFY"])
async def upnp_event(service: str, label: str, request: Request) -> Response:
    """UPnP's own method name, not POST — Starlette routes arbitrary HTTP
    methods, so this needs no special casing beyond naming it here.

    Always answers 200: a device that gets an error back may cancel its
    subscription, and losing eventing because one payload was malformed
    would be a worse outcome than ignoring that payload."""
    raw = await request.body()
    if len(raw) > _MAX_BODY_BYTES:
        logger.debug(
            f"[upnp] Oversized event body from {label} ({service}, {len(raw)} bytes) — ignored"
        )
        return Response(status_code=200)
    body = raw.decode("utf-8", errors="replace")
    try:
        if service == "renderingcontrol":
            await _handle_rendering_control_event(label, body)
        else:
            properties = handle_event(label, body)
            problem = problem_in(properties) if properties else None
            if problem:
                await _handle_transport_problem(label, problem)
            await _handle_stream_title_echo(label, body)
    except Exception:
        # Never let a parse failure reach the device as a 5xx — see above.
        logger.exception(f"[upnp] Failed to handle a {service} event from {label}")
    return Response(status_code=200)
