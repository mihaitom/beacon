"""routes/devices.py — /config, /health, /device-stop

Discovery lives in routes/discovery.py, volume in routes/volume.py, and
/join + /claim in routes/join.py — split out since this file used to mix all
of it together.
"""

import asyncio
import logging
import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.auth import require_token
from core.claims import claims
from core.radio_position import RadioPositionTracker
from core.session import (
    SessionState,
    build_status_dict,
    get_session,
    require_authenticated_session,
)
from core.state import first_radio_position_delivery, radio_dispatch_url, stream_url
from core.stream_format import FALLBACK_CONTENT_TYPE, radio_content_type
from delivery import (
    AirPlayDelivery,
    BaseDelivery,
    ChromecastDelivery,
    DeliveryManager,
    DlnaDelivery,
    SonosDelivery,
)
from media import JellyfinClient, PlexClient, SubsonicClient, server_type_name
from routes.playback import _resync_position_periodically

logger = logging.getLogger("connect.devices")
router = APIRouter(dependencies=[Depends(require_token)])

# When SERVER_LOCK=true, /config's url must match one of these (mirrors the
# frontend's own server-lock — see src/renderer/features/action-required/
# utils/server-lock.ts's normalizeServerUrl) — otherwise a caller who knows
# the shared CONNECT_TOKEN could hand /config a *different*, real media
# server's valid credentials and still reach this deployment's LAN devices.
# Left unenforced if SERVER_URL isn't set, so it can't accidentally lock
# everyone out on a deployment that hasn't been given one.
_SERVER_LOCK = os.getenv("SERVER_LOCK", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
_LOCKED_URLS = {
    u.rstrip("/")
    for u in (os.getenv("SERVER_URL", ""), os.getenv("NAVIDROME_INTERNAL_URL", ""))
    if u
}
# What /health hands the login screen to skip asking for a server URL at all
# once SERVER_LOCK is on (see ServerLoginView.vue) — SERVER_URL is the
# deployment's own public identity for the server, preferred when set;
# NAVIDROME_INTERNAL_URL (the LAN-only address the proxy/backend actually talk
# to Navidrome through, not reachable from the browser directly in most
# deployments) is a reasonable fallback over showing the user nothing at
# all. For a locked Jellyfin deployment, set SERVER_URL — Jellyfin has no
# internal-URL variable of its own (see configure()'s internal_url comment).
_LOCKED_LOGIN_URL = os.getenv("SERVER_URL") or os.getenv("NAVIDROME_INTERNAL_URL", "")
# What kind of server SERVER_LOCK points at — only meaningful together with
# _LOCKED_LOGIN_URL above. Defaults to "subsonic" for backwards compatibility
# with deployments that lock a server without setting this (all of them,
# before Jellyfin support existed).
_LOCKED_SERVER_TYPE = os.getenv("SERVER_TYPE", "subsonic").strip().lower()


class ConfigRequest(BaseModel):
    credential: str
    url: str
    # "subsonic" (covers Navidrome) or "jellyfin". Defaults to subsonic for
    # backwards compatibility with older clients that don't send a type.
    server_type: str = "subsonic"
    # Jellyfin requires the user GUID for item lookups; ignored for Subsonic.
    user_id: str = ""
    # Plex's playlist writes need the *server's* clientIdentifier (from
    # list_resources()/the server picker, not the account) to build a
    # server://{machineIdentifier}/... item URI — see media/plex_bridge.py's
    # _playlist_item_uri(). Ignored for Subsonic/Jellyfin.
    machine_identifier: str = ""
    # Shown to other sessions as "in use by {username}" for claimed devices.
    username: str = ""


@router.post("/config")
async def configure(req: ConfigRequest, session: SessionState = Depends(get_session)):
    server_type = req.server_type.lower()
    # NAVIDROME_INTERNAL_URL and JELLYFIN_INTERNAL_URL are deliberately separate
    # env vars, not one shared between server types — that used to be a
    # single NAVIDROME_INTERNAL_URL applied regardless of server_type, which
    # meant a Jellyfin session's ping() call was hit with Navidrome's own
    # LAN address instead, always failing since Navidrome has no /Users/Me
    # endpoint. Plex has no equivalent var at all: its server address comes
    # from Plex's own account-based discovery (list_resources()), which
    # already prefers a local, LAN-reachable connection over a remote one
    # when it finds one — there's no manually-typed URL for an override to
    # even apply to. All three clients fall back to req.url (the login URL)
    # when their own internal_url is empty either way.
    if server_type == "jellyfin":
        internal_url = os.getenv("JELLYFIN_INTERNAL_URL", "")
    elif server_type == "plex":
        internal_url = ""
    else:
        internal_url = os.getenv("NAVIDROME_INTERNAL_URL", "")

    if _SERVER_LOCK and _LOCKED_URLS and req.url.rstrip("/") not in _LOCKED_URLS:
        logger.warning(f"[config] Rejected — url outside SERVER_LOCK allow-list: {req.url}")
        raise HTTPException(
            status_code=403,
            detail="Server URL does not match the locked server for this deployment",
        )

    media: JellyfinClient | PlexClient | SubsonicClient
    if server_type == "jellyfin":
        media = JellyfinClient(
            req.url,
            token=req.credential,
            user_id=req.user_id,
            internal_url=internal_url,
        )
    elif server_type == "plex":
        media = PlexClient(
            req.url,
            token=req.credential,
            internal_url=internal_url,
            machine_identifier=req.machine_identifier,
        )
    else:
        media = SubsonicClient(req.url, credential=req.credential, internal_url=internal_url)

    # See config_seq's own comment — claimed before the slow ping() below so
    # a second, newer /config call landing while this one is still verifying
    # its credential is what actually gets applied, not whichever of the two
    # happens to finish last.
    session.config_seq += 1
    seq = session.config_seq

    # Verify the credential actually authenticates before trusting it — the
    # shared CONNECT_TOKEN only proves "this request came through our nginx",
    # not that the caller is a legitimate media-server user (see
    # core/session.py's require_authenticated_session).
    if not await asyncio.to_thread(media.ping):
        logger.warning(
            f"[config] Rejected — {server_type} server at {req.url} did not accept the credential"
        )
        raise HTTPException(status_code=401, detail="Media server rejected the supplied credential")

    if session.config_seq != seq:
        logger.info(
            f"[config] Superseded by a newer /config call for this session — "
            f"discarding this one's result ({req.url})"
        )
        return {"status": "ok"}

    session.media = media
    session.authenticated = True
    session.display_name = req.username or session.session_id

    if server_type == "jellyfin":
        logger.info(
            f"[config] Jellyfin configured & verified: {req.url} "
            f"(internal: {internal_url or 'same'}, user_id: {req.user_id or 'missing'})"
        )
    elif server_type == "plex":
        logger.info(f"[config] Plex configured & verified: {req.url}")
    else:
        logger.info(
            f"[config] Subsonic configured & verified: {req.url} "
            f"(internal: {internal_url or 'same'})"
        )

    # Where the verification request actually landed, if that isn't what was
    # typed — a login given as http:// against a server that redirects to
    # https:// verifies fine (every client here follows redirects, see
    # media/http_client.py) and then pays a 301 on every request for the rest
    # of the session. The frontend adopts this so later requests go straight
    # to the address that answered. Only reported when it genuinely differs
    # and only for clients that can tell us (see SubsonicClient._get); an
    # internal-URL override deliberately reports nothing, since that address
    # is ours to reach, not necessarily the browser's.
    resolved = getattr(media, "resolved_url", "") or ""
    if resolved and resolved != req.url.rstrip("/"):
        logger.info(f"[config] Login URL {req.url} actually resolves to {resolved}")
        return {"status": "ok", "resolved_url": resolved}
    return {"status": "ok"}


@router.get("/health")
async def health(session: SessionState = Depends(get_session)):
    import shutil

    return {
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "navidrome_configured": bool(session.media.base_url),
        # Reachable pre-login (get_session doesn't require authenticated=True)
        # — ServerLoginView.vue checks this before rendering, so a
        # SERVER_LOCK=true deployment never shows a URL field/server-type
        # picker for a server the user isn't actually free to change anyway.
        "server_lock": (
            {"url": _LOCKED_LOGIN_URL, "server_type": _LOCKED_SERVER_TYPE}
            if _SERVER_LOCK and _LOCKED_LOGIN_URL
            else None
        ),
        # What the *currently authenticated* session is actually talking to
        # — distinct from server_lock above (a login-screen hint that exists
        # even pre-auth, and only set at all for a locked deployment). Lets
        # the frontend gate Navidrome/Jellyfin-specific UI correctly even in
        # an unlocked, multi-server deployment (see services/capabilities.ts).
        "session_server_type": (server_type_name(session.media) if session.authenticated else None),
    }


async def _group_followers_of(
    coordinator_dev, remaining: list[BaseDelivery]
) -> list[tuple[SonosDelivery, object]]:
    """The Sonos deliveries in `remaining` that are actually grouped behind
    `coordinator_dev`, paired with their resolved SoCo device.

    Stopping a Sonos coordinator silences everything grouped behind it, so
    those speakers have to be unjoined and re-dispatched first (see
    /device-stop). Every other Sonos has its own independent stream and must
    be left alone: a speaker not in this group is its own coordinator, and
    restarting it is an audible gap on a device the user never touched.

    A device whose group can't be read is counted as a follower — that is
    the conservative half of the trade: a redundant restart is a stutter, a
    missed one is a speaker that goes quiet and stays quiet.
    """

    def _follows(rem_dev) -> bool:
        try:
            group = rem_dev.group
            if group is None or group.coordinator is None:
                return False
            return group.coordinator.uid == coordinator_dev.uid
        except Exception as ex:
            logger.warning(
                f"[device-stop] Could not read {getattr(rem_dev, 'player_name', '?')}'s group "
                f"({ex}) — treating it as a follower"
            )
            return True

    followers: list[tuple[SonosDelivery, object]] = []
    for rem in remaining:
        if not isinstance(rem, SonosDelivery):
            continue
        try:
            rem_dev = await asyncio.to_thread(rem._get_device)
        except Exception as ex:
            logger.warning(f"[device-stop] Could not resolve follower {rem.target}: {ex}")
            continue
        if await asyncio.to_thread(_follows, rem_dev):
            followers.append((rem, rem_dev))
    return followers


@router.post("/device-stop")
async def stop_device(
    device_type: str,
    name: str,
    session: SessionState = Depends(require_authenticated_session),
):
    """Stop one device while keeping others playing.

    For Sonos coordinators: unjoins remaining followers first so the coordinator's
    stop command doesn't kill the whole group, then restarts the stream on them.
    """
    type_cls: type[BaseDelivery]
    if device_type == "sonos":
        type_cls = SonosDelivery
    elif device_type == "chromecast":
        type_cls = ChromecastDelivery
    elif device_type == "dlna":
        type_cls = DlnaDelivery
    else:
        type_cls = AirPlayDelivery

    # Serialized under session.play_lock, same as /play, /pause, /seek etc.
    # (see that field's docstring) — without it, a concurrent /play reading
    # session.state.active_delivery mid-way through this handler could
    # overwrite the active_delivery this function computes below, or vice
    # versa, leaving tracked state out of sync with what's actually playing.
    async with session.play_lock:
        active = session.state.active_delivery
        candidates = (
            active.deliveries if isinstance(active, DeliveryManager) else [active] if active else []
        )
        # The actual live instance being stopped, if found — AirPlay in
        # particular needs this: its RAOP stream task/connection live on the
        # instance itself (see delivery/airplay.py), so stopping a freshly
        # constructed AirPlayDelivery(name) below would be a no-op that never
        # touches the real stream, leaving it playing forever.
        matched = next(
            (d for d in candidates if isinstance(d, type_cls) and d.target == name), None
        )
        remaining: list[BaseDelivery] = [d for d in candidates if d is not matched]
        # Which delivery the session's running _resync_position_periodically()
        # task is polling: it picks the first position-capable one and holds
        # onto it for the whole track. If that is the device being stopped
        # here, that task retires itself on its next wake (see
        # _still_targeted()) and the remaining devices would be left with no
        # position resync at all for the rest of the track — so a replacement
        # gets started below. Any other device going away leaves that task
        # polling a device it still legitimately owns, and starting a second
        # one for the same candidate would just double the round trips.
        resync_candidate = next((d for d in candidates if d.SUPPORTS_POSITION), None)

        logger.info(
            f"[device-stop] {device_type}:{name} — remaining: "
            f"{[d.target for d in remaining] or 'none'}"
        )

        need_restart = False
        # Set instead of returned early on: a device that refused to stop
        # must still be taken out of active_delivery below, since its claim
        # is released either way — otherwise /status keeps reporting a
        # target this session no longer owns, the picker re-ticks its
        # checkbox from that, and the frontend and the claim registry
        # disagree about who has the speaker. Reported at the end.
        stop_error: str | None = None
        try:
            if device_type == "sonos":
                # Resolved through the delivery's own cache
                # (delivery/sonos.py's _cached_device()) rather than a bare
                # soco.discover(): a full SSDP sweep here blocks a worker
                # thread for the whole discovery timeout while this handler
                # holds play_lock, so every /play, /pause and /seek on this
                # session waits it out — right in the middle of a device
                # switch, which is exactly when the frontend fires them.
                # See SonosDelivery._get_device()'s own docstring for the
                # multicast cost this cache exists to avoid.
                stopped = matched if isinstance(matched, SonosDelivery) else SonosDelivery(name)
                try:
                    target_dev = await asyncio.to_thread(stopped._get_device)
                except Exception as ex:
                    target_dev = None
                    logger.warning(f"[device-stop] Sonos '{name}' not found on network: {ex}")

                if target_dev:
                    is_coord = await asyncio.to_thread(lambda: target_dev.is_coordinator)
                    logger.debug(f"[device-stop] {name} is_coordinator={is_coord}")

                    # Only the devices actually following *this* coordinator
                    # — a standalone Sonos is its own coordinator, so
                    # `is_coord and remaining` alone was true whenever any
                    # second Sonos was still active, and each of those got
                    # unjoined and re-dispatched below even though it was
                    # playing its own independent stream. That is an audible
                    # restart on a speaker the user never touched, and it is
                    # what made switching between two Sonos speakers stutter.
                    followers = (
                        await _group_followers_of(target_dev, remaining)
                        if is_coord and remaining
                        else []
                    )

                    if followers:
                        logger.info(f"[device-stop] Ungrouping {len(followers)} follower(s) …")
                        for rem, rem_dev in followers:
                            try:
                                await asyncio.to_thread(rem_dev.unjoin)
                                logger.debug(f"[device-stop] {rem.target} ungrouped")
                            except Exception as ex:
                                logger.warning(f"[device-stop] unjoin {rem.target}: {ex}")
                        await asyncio.sleep(0.3)
                        need_restart = True
                    elif not is_coord:
                        await asyncio.to_thread(target_dev.unjoin)
                        await asyncio.sleep(0.1)

                    await asyncio.to_thread(target_dev.stop)
                    logger.info(f"[device-stop] {name} stopped")
            elif device_type == "chromecast":
                await ChromecastDelivery(name).stop()
            elif device_type == "dlna":
                await DlnaDelivery(name).stop()
            else:
                await (matched or AirPlayDelivery(name)).stop()

        except Exception as e:
            logger.exception(f"[device-stop] {name}")
            stop_error = str(e)

        # Released whether or not the stop itself worked — same reasoning as
        # /play's and /join's own claim release on a failed dispatch (see
        # routes/playback.py's _release_claims()), just for the opposite
        # direction: without this, /discover kept reporting device_in_use
        # for a device that was never confirmed to still be playing
        # anything.
        await claims.release(device_type, name, session.session_id)

        st = session.state
        if not remaining:
            st.is_streaming = False
            st.active_delivery = None
            # Radio's own teardown, matching /stop's (see stop_playback()).
            # A queued track needs no equivalent — its ffmpeg lives inside
            # the device's own GET /stream connection and dies with it —
            # but a relay does not: it keeps fetching the station and
            # holding its ffmpeg open until the session is reaped, which is
            # exactly the per-station cost the relay exists to avoid paying
            # more than once. radio_info goes with it rather than lingering
            # as "relayed" with no relay behind it; nothing can reach it
            # again anyway, since /join refuses a session that isn't
            # streaming.
            st.radio_info = None
            session.stop_radio_metadata_watch()
            await session.stop_radio_relay()
        else:
            new_delivery: BaseDelivery | DeliveryManager = (
                remaining[0] if len(remaining) == 1 else DeliveryManager.from_deliveries(remaining)
            )
            st.active_delivery = new_delivery

            if need_restart and st.is_streaming:
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
                content_type = (
                    radio_content_type(st.radio_info) if st.radio_info else FALLBACK_CONTENT_TYPE
                )
                logger.info(f"[device-stop] Restarting stream: {url}")
                try:
                    await new_delivery.play(url, title, content_type=content_type)
                except Exception:
                    logger.exception("[device-stop] Restart error")

            if st.is_streaming and matched is not None and resync_candidate is matched:
                asyncio.create_task(
                    _resync_position_periodically(session, new_delivery, st.clock.play_generation)
                )

            # Same handover, for core/radio_position.py's tracker (radio
            # only, and only when the removed device was the one it was
            # actually polling — matched is the delivery instance being
            # stopped, radio_position_tracker.delivery is what the tracker
            # holds, and they can differ from resync_candidate above since
            # this only ever tracks Chromecast/DLNA, not every
            # SUPPORTS_POSITION type).
            tracker = session.radio_position_tracker
            if (
                st.is_streaming
                and st.radio_info
                and matched is not None
                and tracker is not None
                and tracker.delivery is matched
            ):
                # Recomputed rather than reusing `url` above: that one only
                # exists inside the need_restart branch, and this check
                # doesn't share that guard — st.radio_info is already known
                # truthy here (the `and st.radio_info` above), so this is
                # exactly what a fresh dispatch to this station would use.
                replacement = first_radio_position_delivery(
                    new_delivery, radio_dispatch_url(session.session_id, st.radio_info)
                )
                if replacement is not None:
                    # started_at carried over from the tracker being
                    # replaced, not defaulted to now: `replacement` is a
                    # device that has been playing this same station all
                    # along and is *not* re-dispatched here, so its buffer
                    # filled back when the outgoing tracker was created.
                    # Without this, buffer_lag() reads negative for it and
                    # the visualizer loses its lag correction for the rest
                    # of the session — see that method's own comment.
                    new_tracker = RadioPositionTracker(
                        session,
                        replacement,
                        st.clock.play_generation,
                        started_at=tracker.started_at,
                    )
                    new_tracker.start()
                    session.radio_position_tracker = new_tracker
                else:
                    session.radio_position_tracker = None

    await session.event_bus.broadcast(build_status_dict(session))
    if stop_error:
        return {"error": stop_error}
    return {"status": "stopped", "device": name}
