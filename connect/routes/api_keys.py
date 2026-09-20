"""routes/api_keys.py — GET /api-keys, POST /api-keys/{service}

The installation-wide keys for external services (core/api_keys.py). The
frontend's Settings section drives every one of them through here, so a new
keyed service is a registry entry plus its own module, not another pair of
routes.

Machine-to-machine (CONNECT_TOKEN), not session-scoped: like routes/lastfm.py
and routes/recommendations.py, nothing here touches session.media. The key
itself is never sent back — only whether one is set, and whether it came
from the environment.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core import api_keys
from core.auth import require_token

router = APIRouter(prefix="/api-keys", dependencies=[Depends(require_token)])


class ApiKeyRequest(BaseModel):
    key: str


def _statuses() -> dict:
    return {service: api_keys.status(service) for service in api_keys.SERVICES}


@router.get("")
def list_keys() -> dict:
    return {"keys": _statuses()}


# Sync `def`, like routes/account_settings.py's handlers and for the same
# reason: this writes a file, which would otherwise block the event loop.
@router.post("/{service}")
def set_key(service: str, req: ApiKeyRequest) -> dict:
    # The service is checked against the fixed registry rather than used as
    # a filename directly - see core/api_keys.py's own docstring.
    if service not in api_keys.SERVICES:
        raise HTTPException(status_code=404, detail=f"Unknown service {service!r}")
    api_keys.set(service, req.key)
    return {"keys": _statuses()}
