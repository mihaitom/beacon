"""routes/upnp.py — NOTIFY /upnp/events/{label}, the callback cast devices
POST their transport-state changes to.

Lives on the app's existing port rather than a listener of its own: the
callback URL handed to a device just has to be something it can reach on
this LAN, and stream_url() already proves that address works for these
devices (it is where they fetch the audio from).

No token auth, for the same reason GET /stream has none (see its comment):
the device dialling back in cannot attach one. The handler treats every
body as untrusted text, only ever parsing known property names out of it
and logging them — it changes no playback state, so an unsolicited POST
here can produce a stray log line and nothing more.
"""

import logging

from fastapi import APIRouter, Request, Response

from core.state import PORT, get_local_ip
from core.upnp_events import handle_event

logger = logging.getLogger("connect.upnp")
router = APIRouter()

_CALLBACK_PREFIX = "/upnp/events"

# Renderers vary in how much they send; a LastChange document with a full
# Sonos property set is a few KB. This is far above that and exists only so
# a misbehaving (or hostile) sender cannot stream an unbounded body at us.
_MAX_BODY_BYTES = 256 * 1024


def callback_url_for(label: str) -> str:
    """The CALLBACK a device should POST its events to. `label` comes back
    in the path so one endpoint can serve every subscribed device without
    needing to match on source address — a grouped Sonos pair reports from
    two different players about the same session."""
    return f"http://{get_local_ip()}:{PORT}{_CALLBACK_PREFIX}/{label}"


@router.api_route(_CALLBACK_PREFIX + "/{label}", methods=["NOTIFY"])
async def upnp_event(label: str, request: Request) -> Response:
    """UPnP's own method name, not POST — Starlette routes arbitrary HTTP
    methods, so this needs no special casing beyond naming it here.

    Always answers 200: a device that gets an error back may cancel its
    subscription, and losing eventing because one payload was malformed
    would be a worse outcome than ignoring that payload."""
    raw = await request.body()
    if len(raw) > _MAX_BODY_BYTES:
        logger.debug(f"[upnp] Oversized event body from {label} ({len(raw)} bytes) — ignored")
        return Response(status_code=200)
    try:
        handle_event(label, raw.decode("utf-8", errors="replace"))
    except Exception:
        # Never let a parse failure reach the device as a 5xx — see above.
        logger.exception(f"[upnp] Failed to handle an event from {label}")
    return Response(status_code=200)
