"""routes/log_level.py — GET/POST the backend's own runtime log verbosity.

Settings' log-level dropdown (SettingsView.vue) reads/writes this instead of
requiring the LOG_LEVEL env var + a container restart. Machine-to-machine,
gated by CONNECT_TOKEN like routes/remote.py's control plane — this is an
app-level setting, not tied to any particular media-server login.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.auth import require_token
from core.log_level import LEVELS, apply, current_level

logger = logging.getLogger("connect.log_level")
router = APIRouter(dependencies=[Depends(require_token)])


class LogLevelRequest(BaseModel):
    level: str


@router.get("/log-level")
async def get_log_level():
    return {"level": current_level(), "levels": LEVELS}


@router.post("/log-level")
async def set_log_level(req: LogLevelRequest):
    level = req.level.strip().upper()
    if level not in LEVELS:
        raise HTTPException(status_code=422, detail=f"Invalid log level: {req.level!r}")
    apply(level)
    return {"level": level}
