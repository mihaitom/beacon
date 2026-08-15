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
from core.session import (
    SessionState,
    build_status_dict,
    get_session,
    require_authenticated_session,
)
from core.state import stream_url

from delivery import (
    AirPlayDelivery,
    BaseDelivery,
    ChromecastDelivery,
    DeliveryManager,
    DlnaDelivery,
    SonosDelivery,
)
from media import JellyfinClient, SubsonicClient, server_type_name

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
    for u in (os.getenv("SERVER_URL", ""), os.getenv("SERVER_INTERNAL_URL", ""))
    if u
}
# What /health hands the login screen to skip asking for a server URL at all
# once SERVER_LOCK is on (see ServerLoginView.vue) — SERVER_URL is the
# deployment's own public identity for the server, preferred when set;
# SERVER_INTERNAL_URL (the LAN-only address the proxy/backend actually talk
# to Navidrome through, not reachable from the browser directly in most
# deployments) is a reasonable fallback over showing the user nothing at
# all. For a locked Jellyfin deployment, set SERVER_URL — Jellyfin has no
# internal-URL variable of its own (see configure()'s internal_url comment).
_LOCKED_LOGIN_URL = os.getenv("SERVER_URL") or os.getenv("SERVER_INTERNAL_URL", "")
# What kind of server SERVER_LOCK points at — only meaningful together with
# _LOCKED_LOGIN_URL above. Defaults to "subsonic" for backwards compatibility
# with deployments that lock a server without setting this (all of them,
# before Jellyfin support existed).
_LOCKED_SERVER_TYPE = os.getenv("SERVER_TYPE", "subsonic").strip().lower()


class ConfigRequest(BaseModel):
    credential: str
    url: str
    # "subsonic" (covers Navidrome) or "jellyfin". Defaults to subsonic for
    # backwards compatibility with older Feishin builds that don't send a type.
    server_type: str = "subsonic"
    # Jellyfin requires the user GUID for item lookups; ignored for Subsonic.
    user_id: str = ""
    # Shown to other sessions as "in use by {username}" for claimed devices.
    username: str = ""


@router.post("/config")
async def configure(req: ConfigRequest, session: SessionState = Depends(get_session)):
    server_type = req.server_type.lower()
    # SERVER_INTERNAL_URL is specifically Navidrome's own LAN-internal
    # address — applying it to a Jellyfin session too (as this used to, before
    # a real Jellyfin server was ever tested against it) meant Jellyfin's
    # ping() call would hit Navidrome's URL instead, always failing since
    # Navidrome has no /Users/Me endpoint. Jellyfin has no equivalent env var:
    # its internal_url always comes from whatever URL the login screen sent
    # (req.url) — JellyfinClient already falls back to that when internal_url
    # is empty, and unlike Navidrome there's no separate always-on proxy
    # route reading a fixed backend URL for it (see media/jellyfin_bridge.py,
    # which is session-scoped, not env-var-scoped).
    internal_url = os.getenv("SERVER_INTERNAL_URL", "") if server_type != "jellyfin" else ""

    if _SERVER_LOCK and _LOCKED_URLS and req.url.rstrip("/") not in _LOCKED_URLS:
        logger.warning(
            f"[config] Rejected — url outside SERVER_LOCK allow-list: {req.url}"
        )
        raise HTTPException(
            status_code=403,
            detail="Server URL does not match the locked server for this deployment",
        )

    media: JellyfinClient | SubsonicClient
    if server_type == "jellyfin":
        media = JellyfinClient(
            req.url,
            token=req.credential,
            user_id=req.user_id,
            internal_url=internal_url,
        )
    else:
        media = SubsonicClient(
            req.url, credential=req.credential, internal_url=internal_url
        )

    # Verify the credential actually authenticates before trusting it — the
    # shared CONNECT_TOKEN only proves "this request came through our nginx",
    # not that the caller is a legitimate media-server user (see
    # core/session.py's require_authenticated_session).
    if not await asyncio.to_thread(media.ping):
        logger.warning(
            f"[config] Rejected — {server_type} server at {req.url} "
            "did not accept the credential"
        )
        raise HTTPException(
            status_code=401, detail="Media server rejected the supplied credential"
        )

    session.media = media
    session.authenticated = True
    session.display_name = req.username or session.session_id

    if server_type == "jellyfin":
        logger.info(
            f"[config] Jellyfin configured & verified: {req.url} "
            f"(internal: {internal_url or 'same'}, user_id: {req.user_id or 'missing'})"
        )
    else:
        logger.info(
            f"[config] Subsonic configured & verified: {req.url} "
            f"(internal: {internal_url or 'same'})"
        )
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
        "session_server_type": (
            server_type_name(session.media) if session.authenticated else None
        ),
    }


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
    active = session.state.active_delivery
    candidates = (
        active.deliveries
        if isinstance(active, DeliveryManager)
        else [active]
        if active
        else []
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

    logger.info(
        f"[device-stop] {device_type}:{name} — remaining: "
        f"{[d.target for d in remaining] or 'none'}"
    )

    need_restart = False
    try:
        if device_type == "sonos":
            import soco as _soco

            all_soco = await asyncio.to_thread(lambda: list(_soco.discover() or []))
            target_dev = next(
                (d for d in all_soco if d.player_name.lower() == name.lower()), None
            )
            if target_dev:
                is_coord = await asyncio.to_thread(lambda: target_dev.is_coordinator)
                logger.debug(f"[device-stop] {name} ist_koordinator={is_coord}")

                if is_coord and remaining:
                    logger.info(
                        f"[device-stop] Ungrouping {len(remaining)} follower(s) …"
                    )
                    for rem in remaining:
                        if isinstance(rem, SonosDelivery):
                            rem_dev = next(
                                (
                                    d
                                    for d in all_soco
                                    if d.player_name.lower() == rem.target.lower()
                                ),
                                None,
                            )
                            if rem_dev:
                                try:
                                    await asyncio.to_thread(rem_dev.unjoin)
                                    logger.debug(
                                        f"[device-stop] {rem.target} ungrouped"
                                    )
                                except Exception as ex:
                                    logger.warning(
                                        f"[device-stop] unjoin {rem.target}: {ex}"
                                    )
                    await asyncio.sleep(0.3)
                    need_restart = True
                elif not is_coord:
                    await asyncio.to_thread(target_dev.unjoin)
                    await asyncio.sleep(0.1)

                await asyncio.to_thread(target_dev.stop)
                logger.info(f"[device-stop] {name} stopped")
            else:
                logger.warning(f"[device-stop] Sonos '{name}' not found on network")
        elif device_type == "chromecast":
            await ChromecastDelivery(name).stop()
        elif device_type == "dlna":
            await DlnaDelivery(name).stop()
        else:
            await (matched or AirPlayDelivery(name)).stop()

    except Exception as e:
        logger.error(f"[device-stop] {name}: {e}", exc_info=True)
        return {"error": str(e)}

    await claims.release(device_type, name, session.session_id)

    st = session.state
    if not remaining:
        st.is_streaming = False
        st.active_delivery = None
    else:
        new_delivery: BaseDelivery | DeliveryManager = (
            remaining[0]
            if len(remaining) == 1
            else DeliveryManager.from_deliveries(remaining)
        )
        st.active_delivery = new_delivery

        if need_restart and st.is_streaming:
            url = (
                st.radio_info["url"]
                if st.radio_info
                else stream_url(session.session_id)
            )
            title = st.radio_info["title"] if st.radio_info else "Connect"
            logger.info(f"[device-stop] Restarting stream: {url}")
            try:
                await new_delivery.play(url, title)
            except Exception as e:
                logger.error(f"[device-stop] Restart error: {e}", exc_info=True)

    await session.event_bus.broadcast(build_status_dict(session))
    return {"status": "stopped", "device": name}
