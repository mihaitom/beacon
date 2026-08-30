"""routes/account_settings.py — GET/POST the settings that follow an
account across devices (language, recommendations opt-in, enabled lyrics
providers, autoplay batch size). See core/account_settings.py's own
docstring for why this exists and what it deliberately doesn't cover
(device-local settings, handled entirely in the renderer — see
services/accountKey.ts). Machine-to-machine, gated by CONNECT_TOKEN like
routes/log_level.py's control plane — the (server_type, server_url,
username) identity below is a partition key, not a credential.
"""

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core import account_settings
from core.auth import require_token

logger = logging.getLogger("connect.account_settings")
router = APIRouter(prefix="/account-settings", dependencies=[Depends(require_token)])


class AccountSettingsPatch(BaseModel):
    server_type: str
    server_url: str
    username: str
    settings: dict


# Both handlers are sync `def`, not `async def`, on purpose: core/
# account_settings.py reads and writes a JSON file (and takes a
# threading.Lock around it), which would otherwise block the whole event
# loop — every stream, every WebSocket — for the duration. FastAPI runs a
# sync handler in its threadpool instead, which is exactly what blocking
# file IO wants.
@router.get("")
def get_account_settings(server_type: str, server_url: str, username: str) -> dict:
    return account_settings.load(server_type, server_url, username)


@router.post("")
def update_account_settings(req: AccountSettingsPatch) -> dict:
    return account_settings.save(req.server_type, req.server_url, req.username, req.settings)
