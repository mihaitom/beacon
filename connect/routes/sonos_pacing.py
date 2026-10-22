"""routes/sonos_pacing.py — GET/POST whether the older Sonos models get their
stream at playback speed (core/sonos_pacing.py). Settings → Advanced's
switch reads and writes this; gated by CONNECT_TOKEN like routes/log_level.py,
an installation-wide setting like that one.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.auth import require_token
from core.sonos_pacing import old_models_paced, set_old_models_paced

router = APIRouter(dependencies=[Depends(require_token)])


class SonosPacingRequest(BaseModel):
    paced: bool


@router.get("/sonos-pacing")
async def get_sonos_pacing():
    return {"paced": old_models_paced()}


@router.post("/sonos-pacing")
async def set_sonos_pacing(req: SonosPacingRequest):
    set_old_models_paced(req.paced)
    return {"paced": req.paced}
