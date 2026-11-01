"""routes/lights.py — the lights dialog's Hue setup, and local playback reports.

Instance-wide like the log level and the integration key: the lights
belong to the house this connect runs in, so CONNECT_TOKEN is the gate,
not an account.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core import fanart
from core.auth import require_token
from core.session import SessionState, get_session
from lights import config as lights_config
from lights import hue
from lights.config import MAX_LEAD_MS, MIN_BRIGHTNESS
from lights.controller import controller

logger = logging.getLogger("connect.lights")
router = APIRouter(prefix="/lights", dependencies=[Depends(require_token)])

# A bridge found over mDNS stays listed this long before the next look -
# bridges rarely move, and a search takes a few seconds of multicast.
DISCOVERY_MAX_AGE_SECONDS = 600.0

# How long a pairing request waits for the bridge's button. The UI says to
# press it first; this is the margin for walking over to it.
PAIR_WAIT_SECONDS = 30.0
_PAIR_POLL_SECONDS = 1.0


_found: list[hue.Bridge] = []
_found_at = 0.0
_refreshing: asyncio.Task | None = None


async def _refresh_found() -> list[hue.Bridge]:
    global _found, _found_at
    try:
        _found = await hue.discover()
    except Exception as e:
        logger.info(f"[lights] Looking for a Hue bridge failed: {e}")
    _found_at = time.monotonic()
    return _found


async def found_bridges() -> list[hue.Bridge]:
    """The bridges on the network, as last seen. The very first call waits
    for a search - it is what decides whether the app shows a lights button
    at all; later ones answer at once and look again in the background
    once the list is old."""
    global _refreshing
    if _found_at == 0.0:
        return await _refresh_found()
    stale = time.monotonic() - _found_at > DISCOVERY_MAX_AGE_SECONDS
    if stale and (_refreshing is None or _refreshing.done()):
        _refreshing = asyncio.create_task(_refresh_found())
    return _found


def reset_discovery_for_tests() -> None:
    global _found, _found_at, _refreshing
    _found, _found_at, _refreshing = [], 0.0, None


def _bridge(cfg: lights_config.LightsConfig) -> hue.Bridge:
    return hue.Bridge(cfg.bridge_host, cfg.bridge_id)


def _pairing(cfg: lights_config.LightsConfig) -> hue.Pairing:
    return hue.Pairing(cfg.username, cfg.clientkey, cfg.app_id)


def _area_dict(area: hue.Area) -> dict:
    return {"id": area.area_id, "name": area.name, "lights": len(area.channels)}


@router.get("")
async def get_lights():
    cfg = lights_config.get()
    areas = None
    reachable = None
    if cfg.paired:
        try:
            areas = [_area_dict(a) for a in await hue.list_areas(_bridge(cfg), _pairing(cfg))]
            reachable = True
        except hue.HueError as e:
            logger.info(f"[lights] Bridge not reachable: {e}")
            reachable = False
    found = [] if cfg.paired else await found_bridges()
    return {
        "paired": cfg.paired,
        "found": [{"host": b.host, "id": b.bridge_id} for b in found],
        "bridge": {"host": cfg.bridge_host, "id": cfg.bridge_id} if cfg.paired else None,
        "reachable": reachable,
        "areas": areas,
        "area_id": cfg.area_id or None,
        "enabled": cfg.enabled,
        "lead_ms": cfg.lead_ms,
        "style": cfg.style,
        "colour_mode": cfg.colour_mode,
        "fixed_colour": cfg.fixed_colour,
        "theme_colour": cfg.theme_colour,
        "theme_follows_picture": cfg.theme_follows_picture,
        "brightness": cfg.brightness,
        "picture": controller.picture,
        "playing": controller.streaming,
        "start_error": controller.last_error,
    }


@router.post("/discover")
async def discover_bridges():
    bridges = await _refresh_found()
    return {"bridges": [{"host": b.host, "id": b.bridge_id} for b in bridges]}


class PairRequest(BaseModel):
    host: str = Field(min_length=1, max_length=255)


@router.post("/pair")
async def pair_bridge(req: PairRequest):
    try:
        bridge = await hue.identify(req.host.strip())
    except hue.HueError as e:
        raise HTTPException(status_code=404, detail="no_bridge") from e
    deadline = time.monotonic() + PAIR_WAIT_SECONDS
    while True:
        try:
            pairing = await hue.pair(bridge, "connect")
            break
        except hue.LinkButtonNotPressedError:
            if time.monotonic() >= deadline:
                raise HTTPException(status_code=408, detail="link_button") from None
            await asyncio.sleep(_PAIR_POLL_SECONDS)
        except hue.HueError as e:
            logger.warning(f"[lights] Pairing failed: {e}")
            raise HTTPException(status_code=502, detail="pairing_failed") from e
    # A new pairing starts over: an area id from another bridge means
    # nothing here.
    lights_config.forget()
    lights_config.update(
        bridge_host=bridge.host,
        bridge_id=bridge.bridge_id,
        username=pairing.username,
        clientkey=pairing.clientkey,
        app_id=pairing.app_id,
    )
    controller.retry_now()
    return await get_lights()


# The bridge's resource ids. Checked because it goes into a bridge URL and
# into every stream frame's header, which has room for exactly this.
_AREA_ID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


class LightsUpdate(BaseModel):
    area_id: str | None = Field(default=None, pattern=_AREA_ID)
    enabled: bool | None = None
    lead_ms: int | None = Field(default=None, ge=-MAX_LEAD_MS, le=MAX_LEAD_MS)
    style: Literal["pulse", "calm", "party", "chase"] | None = None
    colour_mode: Literal["theme", "palette", "rotate", "fixed"] | None = None
    fixed_colour: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    theme_colour: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    theme_follows_picture: bool | None = None
    brightness: int | None = Field(default=None, ge=MIN_BRIGHTNESS, le=100)


@router.put("")
async def update_lights(req: LightsUpdate):
    cfg = lights_config.get()
    if not cfg.paired:
        raise HTTPException(status_code=409, detail="not_paired")
    changes = req.model_dump(exclude_none=True)
    for key in ("fixed_colour", "theme_colour"):
        if key in changes:
            changes[key] = changes[key].lower()
    lights_config.update(**changes)
    controller.retry_now()
    return await get_lights()


@router.delete("")
async def forget_lights():
    """Forgets the bridge. The pairing stays listed in the Hue app until
    removed there - the bridge offers no way to revoke it remotely."""
    await controller.stop()
    lights_config.forget()
    controller.start()
    return {"paired": False}


class PictureReport(BaseModel):
    song_id: str = Field(min_length=1, max_length=512)
    # A Fanart.tv image URL, or None for the cover.
    url: str | None = Field(default=None, max_length=2048)


@router.get("/picture")
async def get_picture():
    """Only the picture: for the open dialog to follow a track change
    without asking the bridge each time, as GET /lights does."""
    return {"picture": controller.picture}


@router.put("/picture", status_code=204)
async def report_picture(req: PictureReport):
    """What an app's Now Playing shows behind a song, so the lights take
    the colours of what is in the foreground."""
    if req.url is not None and not fanart.is_allowed_image_url(req.url):
        raise HTTPException(status_code=422, detail="not_fanart")
    controller.set_picture(req.song_id, req.url)


class LocalReport(BaseModel):
    song_id: str = Field(min_length=1, max_length=512)
    position: float = Field(ge=0)
    playing: bool


@router.post("/local", status_code=204)
async def report_local(req: LocalReport, session: SessionState = Depends(get_session)):
    """Local playback in the desktop app, which the lights follow when
    nothing is being cast."""
    controller.report_local(session.session_id, req.song_id, req.position, req.playing)


@router.delete("/local", status_code=204)
async def stop_local(session: SessionState = Depends(get_session)):
    controller.forget_local(session.session_id)
