"""routes/join.py — /join (add a device mid-stream), /claim (claim without playback)"""

import asyncio
import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.auth import require_token
from core.session import (
    SessionState,
    build_status_dict,
    check_claims,
    displace_target,
    registry,
    require_authenticated_session,
)
from core.state import find_sonos, radio_dispatch_url, resolve_target, stream_url
from core.stream_format import FALLBACK_CONTENT_TYPE, radio_content_type
from delivery import (
    AirPlayDelivery,
    BaseDelivery,
    ChromecastDelivery,
    DeliveryManager,
    DlnaDelivery,
    SonosDelivery,
)
from routes.playback import _release_claims, playback_error_reporter

logger = logging.getLogger("connect.devices")
router = APIRouter(dependencies=[Depends(require_token)])


class JoinRequest(BaseModel):
    target_name: str
    target_type: str
    # See PlayRequest.force in routes/playback.py.
    force: bool = False


def _add_target(st, new_d: BaseDelivery) -> None:
    """Fold `new_d` into the session's active delivery, promoting a single
    delivery to a DeliveryManager on the way. Shared by both of /join's
    paths, the reservation and the real dispatch, so the two can never
    disagree about what the target set now is.

    Matched on type *and* target name: two protocols can legitimately reach
    the same speaker under the same name (an AirPlay and a Sonos "Kitchen"
    are different targets, which is exactly why every device key in the
    frontend is `type:name`), and matching on the name alone silently
    dropped the second one.
    """
    if isinstance(st.active_delivery, DeliveryManager):
        current = st.active_delivery.deliveries
    elif st.active_delivery:
        current = [st.active_delivery]
    else:
        current = []
    if any(isinstance(d, type(new_d)) and d.target == new_d.target for d in current):
        return
    if isinstance(st.active_delivery, DeliveryManager):
        st.active_delivery.deliveries.append(new_d)
    elif st.active_delivery:
        st.active_delivery = DeliveryManager.from_deliveries([st.active_delivery, new_d])
    else:
        st.active_delivery = new_d


@router.post("/join")
async def join_stream(
    req: JoinRequest, session: SessionState = Depends(require_authenticated_session)
):
    st = session.state
    if not st.is_streaming:
        return {"error": "No active stream"}

    type_cls: type[BaseDelivery]
    if req.target_type == "sonos":
        type_cls = SonosDelivery
    elif req.target_type == "chromecast":
        type_cls = ChromecastDelivery
    elif req.target_type == "dlna":
        type_cls = DlnaDelivery
    else:
        type_cls = AirPlayDelivery
    new_d: BaseDelivery = type_cls(req.target_name)

    # Serialized under session.play_lock — same lock /play, /pause, /seek
    # etc. use to guard active_delivery/is_streaming (see its docstring).
    # Without this, a concurrent /play on this same session can read
    # st.active_delivery before this join's append lands and then
    # unconditionally overwrite it once its own device call finishes,
    # silently dropping the just-joined device from tracked state (it
    # keeps physically playing, but becomes invisible to /status and
    # unreachable by /stop/pause).
    async with session.play_lock:
        error, displaced = await check_claims(new_d, session, force=req.force)
        if error:
            return error
        for target_type, name, owner in displaced:
            owner_session = registry.get(owner)
            if owner_session:
                await displace_target(owner_session, target_type, name)

        # Nothing to dispatch to a device joining a *paused* session: it
        # only has to be in active_delivery by the time playback starts
        # again, and everything that starts it re-dispatches the whole set
        # from scratch — /resume and /seek replay active_delivery.play()
        # (routes/playback.py), /play and /play-url build a fresh target
        # from the request. /seek already works exactly this way, and
        # deliberately touches no device at all while paused.
        #
        # Dispatching now and pausing a moment later, which is what this
        # did, costs a burst of sound on the speaker the user just picked
        # (none of these protocols has a "load without playing"), a GET
        # /stream connection and its FFmpeg run that the very next /resume
        # throws away, and — for a second Sonos — an ad-hoc group join that
        # DeliveryManager.play() would then redo properly on its own.
        #
        # The trade is that the device is only proven reachable when
        # playback actually starts, rather than here: a reservation cannot
        # fail the way a dispatch can. That is the same contract /claim has
        # always had, and the failure still surfaces — as a delivery error
        # naming the speaker, on the /resume that could not reach it.
        if st.clock.is_paused:
            logger.info(f"[join] Session is paused — {req.target_name} reserved, not dispatched")
            _add_target(st, new_d)
            await session.event_bus.broadcast(build_status_dict(session))
            return {"status": "reserved", "device": req.target_name}

        # Radio has no track loaded (session.state.current_track stays None
        # for it — see /play-url), so it must join on its own raw URL rather
        # than the FFmpeg /stream proxy, which 204s with no track loaded.
        url = (
            radio_dispatch_url(session.session_id, st.radio_info)
            if st.radio_info
            else stream_url(session.session_id)
        )
        title = st.radio_info["title"] if st.radio_info else "Connect"
        # The station's own type, as probed when it started playing — a
        # device joining an AAC station mid-play needs telling the same
        # thing the first one was, or it refuses the stream the first one
        # is happily playing (see core/stream_format.py). A queued track
        # keeps play()'s own default, which is what it always used.
        content_type = radio_content_type(st.radio_info) if st.radio_info else FALLBACK_CONTENT_TYPE
        logger.info(f"[join] {req.target_type}:{req.target_name} → {url}")

        try:
            if req.target_type == "sonos":
                existing_sonos = find_sonos(st.active_delivery)
                if existing_sonos:
                    try:
                        coordinator = await asyncio.to_thread(existing_sonos[0]._get_device)
                        joiner = await asyncio.to_thread(new_d._get_device)
                        await asyncio.to_thread(joiner.join, coordinator)
                        logger.info(
                            f"[join] {req.target_name} joining group of {existing_sonos[0].target}"
                        )
                    except Exception as e:
                        logger.warning(
                            f"[join] Group join failed ({e}), falling back to individual stream"
                        )
                        await new_d.play(url, title, content_type=content_type)
                else:
                    await new_d.play(url, title, content_type=content_type)
            else:
                await new_d.play(url, title, content_type=content_type)
        except Exception as e:
            # Unlike the inner try/except above (a group-join attempt
            # falling back to an individual stream, not a hard failure),
            # this is the same "dispatch never actually reached the
            # device" case /play's own identical handler guards against —
            # without releasing it here, check_claims() above leaves the
            # device locked to this session (device_in_use for everyone
            # else) with nothing actually playing on it.
            logger.exception("[join] Delivery error")
            await _release_claims(new_d, session)
            return {"error": str(e)}

        _add_target(st, new_d)

    await session.event_bus.broadcast(build_status_dict(session))
    return {"status": "joined", "device": req.target_name}


class ClaimRequest(BaseModel):
    targets: list[dict]
    # See PlayRequest.force in routes/playback.py.
    force: bool = False


@router.post("/claim")
async def claim_device(
    req: ClaimRequest, session: SessionState = Depends(require_authenticated_session)
):
    """Claim one or more devices for this session WITHOUT starting playback.

    For the takeover flow when the user has nothing loaded to play yet: a
    device already in use can still be taken over — the previous owner's
    playback stops and hands back to local (same as any other takeover, see
    displace_target()) — without requiring the new owner to already have a
    track or radio stream queued up. The device becomes this session's
    active target so the next /play (once something is actually picked)
    targets it automatically, and /status "targets" for it right away.
    """
    target = resolve_target(
        req.targets, None, None, on_playback_error=playback_error_reporter(session)
    )
    if not target:
        return {"error": "No target configured"}

    # Same play_lock reasoning as /join above — this write to
    # active_delivery must be serialized against /play, /pause, /seek etc.
    async with session.play_lock:
        error, displaced = await check_claims(target, session, force=req.force)
        if error:
            return error
        for target_type, name, owner in displaced:
            owner_session = registry.get(owner)
            if owner_session:
                await displace_target(owner_session, target_type, name)

        session.state.active_delivery = target
    await session.event_bus.broadcast(build_status_dict(session))
    return {"status": "claimed"}
