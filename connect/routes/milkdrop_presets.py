"""routes/milkdrop_presets.py - the Milkdrop presets a listener uploaded, which
follow the account. The account comes from the verified session. See
core/milkdrop_presets.py."""

import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints, field_validator

from core import milkdrop_presets, server_link
from core.auth import require_token
from core.session import SessionState, require_authenticated_session
from routes.play_history import _own

router = APIRouter(prefix="/milkdrop-presets", dependencies=[Depends(require_token)])

PRESET_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
PresetId = Annotated[str, StringConstraints(pattern=PRESET_ID_PATTERN)]
PresetName = Annotated[
    str, StringConstraints(min_length=1, max_length=milkdrop_presets.MAX_NAME_LENGTH)
]


def _bounded(preset: dict | None) -> dict | None:
    if preset is not None and len(json.dumps(preset)) > milkdrop_presets.MAX_PRESET_BYTES:
        raise ValueError("preset too large")
    return preset


class PresetUpload(BaseModel):
    name: PresetName
    preset: dict

    _bound = field_validator("preset")(_bounded)


class PresetRow(BaseModel):
    """A row as paired devices exchange it (routes/device_link.py)."""

    id: PresetId
    name: PresetName
    preset: dict | None
    updated_at: float = Field(ge=0, allow_inf_nan=False)

    _bound = field_validator("preset")(_bounded)


def _account(session: SessionState):
    account = _own(session)
    if account is None:
        raise HTTPException(status_code=409, detail="This account cannot keep presets")
    return account


@router.get("")
def list_presets(session: SessionState = Depends(require_authenticated_session)) -> dict:
    account = _own(session)
    if account is None:
        return {"presets": []}
    server_link.pull_milkdrop_presets(account)
    return {
        "presets": [
            {"id": row["id"], "name": row["name"]}
            for row in milkdrop_presets.index(account)
            if not row["deleted"]
        ]
    }


@router.get("/{preset_id}")
def get_preset(
    preset_id: PresetId, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    found = milkdrop_presets.get(_account(session), preset_id)
    if found is None:
        raise HTTPException(status_code=404, detail="No such preset")
    return {"id": found["id"], "name": found["name"], "preset": found["preset"]}


def _changed(session: SessionState, preset_id: str, name: str, preset: dict | None) -> None:
    account = _account(session)
    if not milkdrop_presets.put(account, preset_id, name, preset):
        raise HTTPException(status_code=409, detail="Too many presets")
    stored = milkdrop_presets.rows(account, [preset_id])
    server_link.note_milkdrop_presets(account, {preset_id: stored[0]["updated_at"]})


@router.put("/{preset_id}")
def put_preset(
    preset_id: PresetId,
    upload: PresetUpload,
    session: SessionState = Depends(require_authenticated_session),
) -> dict:
    _changed(session, preset_id, upload.name, upload.preset)
    return {"status": "ok"}


@router.delete("/{preset_id}")
def delete_preset(
    preset_id: PresetId, session: SessionState = Depends(require_authenticated_session)
) -> dict:
    account = _account(session)
    existing = milkdrop_presets.rows(account, [preset_id])
    if existing and existing[0]["preset"] is not None:
        _changed(session, preset_id, existing[0]["name"], None)
    return {"status": "ok"}
