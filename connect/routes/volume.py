"""routes/volume.py — /volume (active Sonos group), /device-volume (any device)"""

import asyncio
import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.auth import require_token
from core.session import (
    SessionState,
    build_status_dict,
    check_ownership,
    require_authenticated_session,
)
from core.state import find_sonos
from delivery import ChromecastDelivery, DlnaDelivery, SonosDelivery

logger = logging.getLogger("connect.devices")
router = APIRouter(dependencies=[Depends(require_token)])


class VolumeRequest(BaseModel):
    volume: int


@router.get("/volume")
async def get_volume(session: SessionState = Depends(require_authenticated_session)):
    sonos_targets = find_sonos(session.state.active_delivery)
    if not sonos_targets:
        return {"error": "No active Sonos target"}
    try:
        device = await asyncio.to_thread(sonos_targets[0]._get_device)
        volume = device.volume
        # Seeds device_volumes the same as a RenderingControl push would —
        # this is DeviceListItem.vue's "initial fetch when the list opens"
        # (see TODO.md), which still has to be a live round trip since
        # nothing has necessarily pushed a value yet. Broadcast, not just
        # recorded: DeviceListItem.vue reads volume from the reactive
        # ConnectStatus (connectStore.activeTargets), not from this
        # response directly, so the fetch that's supposed to seed the very
        # first paint needs to actually reach that path instead of sitting
        # in device_volumes until some unrelated status change picks it up.
        _record_volume(session, "sonos", sonos_targets[0].target, volume, None)
        await session.event_bus.broadcast(build_status_dict(session))
        return {"volume": volume}
    except Exception as e:
        logger.warning(f"[volume] get error: {e}")
        return {"error": str(e)}


@router.post("/volume")
async def set_volume(
    req: VolumeRequest, session: SessionState = Depends(require_authenticated_session)
):
    volume = max(0, min(100, req.volume))
    sonos_targets = find_sonos(session.state.active_delivery)
    if not sonos_targets:
        return {"error": "No active Sonos target"}

    async def _set(d: SonosDelivery):
        device = await asyncio.to_thread(d._get_device)
        await asyncio.to_thread(setattr, device, "volume", volume)

    await asyncio.gather(*[_set(d) for d in sonos_targets], return_exceptions=True)
    # Optimistic, ahead of whatever RenderingControl NOTIFY the device sends
    # back for this — the round trip on that is easily a second or more
    # (same SSDP-discovery cost as every other device call, see
    # SonosDelivery._get_device()'s comment), and the slider that triggered
    # this already shows `volume` as its own value; broadcasting it again
    # once the device's own event lands is harmless, just redundant.
    for d in sonos_targets:
        _record_volume(session, "sonos", d.target, volume, None)
    await session.event_bus.broadcast(build_status_dict(session))
    return {"volume": volume}


def _record_volume(
    session: SessionState,
    device_type: str,
    name: str,
    volume: int | None,
    muted: bool | None,
) -> None:
    """Writes into device_volumes without clobbering whichever half (volume/
    muted) this particular update doesn't know about — mirrors routes/
    upnp.py's identical merge for the same reason: a Mute-only RenderingControl
    event shouldn't blank out the last known volume, and vice versa."""
    key = f"{device_type}:{name}"
    prev_volume, prev_muted = session.state.device_volumes.get(key, (None, None))
    session.state.device_volumes[key] = (
        volume if volume is not None else prev_volume,
        muted if muted is not None else prev_muted,
    )


@router.get("/device-volume")
async def get_device_volume(
    device_type: str,
    name: str,
    session: SessionState = Depends(require_authenticated_session),
):
    error = check_ownership(device_type, name, session)
    if error:
        return error
    try:
        if device_type == "sonos":
            device = await asyncio.to_thread(SonosDelivery(name)._get_device)
            volume = device.volume
            # Broadcast for the same reason /volume's GET does — see its
            # comment. chromecast/dlna below don't: those stay on
            # DeviceListItem.vue's existing poll, unchanged, so there's no
            # reactive path for this response to feed.
            _record_volume(session, "sonos", name, volume, None)
            await session.event_bus.broadcast(build_status_dict(session))
            return {"volume": volume}
        if device_type == "chromecast":
            cast = await asyncio.to_thread(ChromecastDelivery(name)._get_device)
            return {"volume": round(cast.status.volume_level * 100)}
        if device_type == "dlna":
            volume = await DlnaDelivery(name).get_volume()
            if volume is None:
                return {"error": f"Volume control not supported for {name}"}
            return {"volume": volume}
        return {"error": f"Volume control not supported for {device_type}"}
    except Exception as e:
        logger.warning(f"[device-volume] get '{name}': {e}")
        return {"error": str(e)}


@router.post("/device-volume")
async def set_device_volume(
    device_type: str,
    name: str,
    req: VolumeRequest,
    session: SessionState = Depends(require_authenticated_session),
):
    error = check_ownership(device_type, name, session)
    if error:
        return error
    volume = max(0, min(100, req.volume))
    try:
        if device_type == "sonos":
            device = await asyncio.to_thread(SonosDelivery(name)._get_device)
            await asyncio.to_thread(setattr, device, "volume", volume)
            _record_volume(session, "sonos", name, volume, None)
            await session.event_bus.broadcast(build_status_dict(session))
            return {"volume": volume}
        if device_type == "chromecast":
            cast = await asyncio.to_thread(ChromecastDelivery(name)._get_device)
            await asyncio.to_thread(cast.set_volume, volume / 100.0)
            return {"volume": volume}
        if device_type == "dlna":
            await DlnaDelivery(name).set_volume(volume)
            return {"volume": volume}
        return {"error": f"Volume control not supported for {device_type}"}
    except Exception as e:
        logger.warning(f"[device-volume] set '{name}': {e}")
        return {"error": str(e)}
