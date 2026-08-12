"""routes/volume.py — /volume (active Sonos group), /device-volume (any device)"""

import asyncio
import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.auth import require_token
from core.session import SessionState, check_ownership, require_authenticated_session
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
        return {"volume": device.volume}
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
    return {"volume": volume}


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
            return {"volume": device.volume}
        if device_type == "chromecast":
            cast = await asyncio.to_thread(ChromecastDelivery(name)._get_device)
            return {"volume": int(round(cast.status.volume_level * 100))}
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
