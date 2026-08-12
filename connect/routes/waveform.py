"""routes/waveform.py — GET /waveform/{track_id}

Peak-amplitude data for the player's waveform seek bar (TrackWaveform.vue).
See core/waveform.py for the actual decode logic.
"""

import logging

from fastapi import APIRouter, Depends

from core import waveform
from core.auth import require_token
from core.session import SessionState, get_session

logger = logging.getLogger("connect.waveform")
router = APIRouter(prefix="/waveform", dependencies=[Depends(require_token)])


@router.get("/{track_id}")
async def get_waveform(
    track_id: str, session: SessionState = Depends(get_session)
) -> dict[str, list[float]]:
    url = session.media.get_stream_url(track_id)
    return {"peaks": await waveform.get_waveform(track_id, url)}
