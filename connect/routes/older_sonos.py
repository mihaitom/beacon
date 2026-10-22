"""routes/older_sonos.py — GET/POST how the older Sonos models get a song
(core/older_sonos.py). Settings → Advanced reads and writes this; gated by
CONNECT_TOKEN like routes/log_level.py, an installation-wide setting like
that one.
"""

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.auth import require_token
from core.older_sonos import MODES, set_stream_mode, stream_mode

router = APIRouter(dependencies=[Depends(require_token)])


class OlderSonosRequest(BaseModel):
    mode: Literal["whole", "paced", "file"]


@router.get("/older-sonos")
async def get_older_sonos():
    return {"mode": stream_mode(), "modes": list(MODES)}


@router.post("/older-sonos")
async def set_older_sonos(req: OlderSonosRequest):
    set_stream_mode(req.mode)
    return {"mode": req.mode}
