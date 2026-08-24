"""routes/upnp.py — NOTIFY /upnp/events/{service}/{label}, the callback cast
devices POST their transport-state and volume changes to.

Lives on the app's existing port rather than a listener of its own: the
callback URL handed to a device just has to be something it can reach on
this LAN, and stream_url() already proves that address works for these
devices (it is where they fetch the audio from).

No token auth, for the same reason GET /stream has none (see its comment):
the device dialling back in cannot attach one. The AVTransport branch treats
every body as untrusted text, only ever parsing known property names out of
it and logging them — it changes no playback state, so an unsolicited POST
there can produce a stray log line and nothing more. The RenderingControl
branch does write state (a session's device_volumes), but only ever a
volume/mute number already scoped to whichever session claims that device
(core/claims.py) — an unsolicited POST from an unclaimed device name simply
finds no owner and is dropped, same as a stray AVTransport one.
"""

import logging

from fastapi import APIRouter, Request, Response

from core.claims import claims
from core.session import build_status_dict, registry
from core.state import PORT, get_local_ip
from core.upnp_events import handle_event, parse_rendering_control_event

logger = logging.getLogger("connect.upnp")
router = APIRouter()

_CALLBACK_PREFIX = "/upnp/events"

# Renderers vary in how much they send; a LastChange document with a full
# Sonos property set is a few KB. This is far above that and exists only so
# a misbehaving (or hostile) sender cannot stream an unbounded body at us.
_MAX_BODY_BYTES = 256 * 1024


def callback_url_for(label: str, service: str = "avtransport") -> str:
    """The CALLBACK a device should POST its events to. `label` and
    `service` come back in the path so one endpoint can serve every
    subscribed device *and* service without needing to match on source
    address — a grouped Sonos pair reports from two different players about
    the same session, and a single player holds one subscription per
    service (see core/upnp_events.py's Subscription)."""
    return f"http://{get_local_ip()}:{PORT}{_CALLBACK_PREFIX}/{service}/{label}"


async def _handle_rendering_control_event(label: str, body: str) -> None:
    """Push Master-channel Volume/Mute into whichever session currently
    claims `label` (a Sonos room name — RenderingControl subscriptions are
    Sonos-only for now, see delivery/sonos.py) and rebroadcast its status,
    replacing DeviceListItem.vue's 4s poll for that device. A no-op, not an
    error, whenever nobody currently claims it (the app was closed, the
    device was released, or this is simply a stray/unsolicited POST) — the
    reading just has nothing to update."""
    properties = parse_rendering_control_event(body)
    if not properties:
        return
    session_id = claims.owner_of("sonos", label)
    if session_id is None:
        return
    session = registry.get(session_id)
    if session is None:
        return

    key = f"sonos:{label}"
    volume, muted = session.state.device_volumes.get(key, (None, None))
    if "Volume" in properties:
        try:
            volume = int(properties["Volume"])
        except ValueError:
            pass
    if "Mute" in properties:
        muted = properties["Mute"] != "0"
    session.state.device_volumes[key] = (volume, muted)
    await session.event_bus.broadcast(build_status_dict(session))


@router.api_route(_CALLBACK_PREFIX + "/{service}/{label}", methods=["NOTIFY"])
async def upnp_event(service: str, label: str, request: Request) -> Response:
    """UPnP's own method name, not POST — Starlette routes arbitrary HTTP
    methods, so this needs no special casing beyond naming it here.

    Always answers 200: a device that gets an error back may cancel its
    subscription, and losing eventing because one payload was malformed
    would be a worse outcome than ignoring that payload."""
    raw = await request.body()
    if len(raw) > _MAX_BODY_BYTES:
        logger.debug(
            f"[upnp] Oversized event body from {label} ({service}, {len(raw)} bytes) — ignored"
        )
        return Response(status_code=200)
    body = raw.decode("utf-8", errors="replace")
    try:
        if service == "renderingcontrol":
            await _handle_rendering_control_event(label, body)
        else:
            handle_event(label, body)
    except Exception:
        # Never let a parse failure reach the device as a 5xx — see above.
        logger.exception(f"[upnp] Failed to handle a {service} event from {label}")
    return Response(status_code=200)
