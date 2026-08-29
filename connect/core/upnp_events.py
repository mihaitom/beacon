"""core/upnp_events.py — UPnP eventing: let a cast device report its own state.

Everything beacon knows about a casting device today it has to *ask* for:
routes/playback.py polls GetPositionInfo every few seconds, and that only
ever answers "where are you", never "what went wrong". A device that stops
on its own — a decoder error, a stream it gave up on, a group re-forming
underneath it — looks from here exactly like a device that is simply idle,
which is why the 2026-08-22 cast drops on beacon-dev could be characterised
(clean FIN, everything ACKed, nothing commanded it) but not explained.

UPnP eventing inverts that. Subscribing to a renderer's AVTransport service
makes it POST a NOTIFY to us whenever its transport state changes, and those
notifications carry TransportStatus and TransportErrorDescription alongside
TransportState — the device naming its own failure instead of us inferring
it from a silence.

AVTransport events are deliberately log-only. Nothing here feeds back into
playback decisions from them: no auto-stop, no auto-recovery, no position
handling. That keeps a diagnostic addition from becoming a new way for
playback to break, which matters more than usual in a subsystem with this
bug history. Reacting to *those* (surfacing a dead cast to the frontend) is
a deliberate next step, not something to slip in here.

RenderingControl events are the one narrow exception (routes/upnp.py):
volume/mute pushed to whichever session currently claims the device (see
core/claims.py), replacing DeviceListItem.vue's 4s poll. Safe to feed back
in a way the transport-state case above isn't — a wrong volume reading
changes what a number on screen says, not what audio is playing, so there's
no equivalent failure mode to guard against.
"""

import asyncio
import logging
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

logger = logging.getLogger("connect.upnp")

# How long to ask the device to keep the subscription for, and how far
# before that to renew. UPnP subscriptions are leases: miss the renewal and
# the device silently stops notifying, which would look identical to "no
# problems occurred".
_SUBSCRIPTION_SECONDS = 1800
_RENEW_MARGIN_SECONDS = 300
_HTTP_TIMEOUT = 10.0

# The AVTransport event service path is the same on Sonos and on generic
# DLNA renderers built from the same UPnP profile.
AVTRANSPORT_EVENT_PATH = "/MediaRenderer/AVTransport/Event"
# Same idea, the volume/mute-reporting sibling service — see
# parse_rendering_control_event()'s own comment for why its LastChange body
# needs a different parser than AVTransport's.
RENDERINGCONTROL_EVENT_PATH = "/MediaRenderer/RenderingControl/Event"

# LastChange arrives as an XML document embedded, escaped, inside the
# NOTIFY body's XML — hence the double unescape in parse_event() before
# these can match.
_PROPERTY_RE = re.compile(r"<(\w+)\s+val=\"([^\"]*)\"")

# RenderingControl's LastChange is channel-qualified — <Volume
# channel="Master" val="35"/>, plus an LF/RF pair per stereo leg and a
# handful of Sonos extensions this app has no use for — so _PROPERTY_RE
# above doesn't match it at all (it expects val="" as the first, only
# attribute, true for every AVTransport property but not these). Only the
# Master channel is kept: that's the one both the existing GET
# /device-volume endpoint and DeviceListItem.vue's slider already mean by
# "this device's volume" — LF/RF only diverge when someone's deliberately
# unbalanced a stereo pair, not something either surface exposes.
_RENDERING_CONTROL_PROPERTY_RE = re.compile(r'<(Volume|Mute)\s+channel="Master"\s+val="([^"]*)"')

# The properties worth keeping out of a LastChange payload that also
# carries volume, mute, EQ and a dozen Sonos-specific extensions.
_KEPT_PROPERTIES = (
    "TransportState",
    "TransportStatus",
    "TransportErrorDescription",
    "CurrentTrackURI",
    "AVTransportURI",
    "NumberOfTracks",
)

# TransportStatus is "OK" on a healthy renderer; anything else (Sonos emits
# ERROR_CANT_CONNECT, and the spec allows vendor values) is the device
# reporting a problem it will not otherwise tell us about.
_HEALTHY_STATUS = "OK"


@dataclass
class Subscription:
    """One live subscription to one service on one device. `sid` is the
    device's own handle for it, needed to renew or cancel; it changes
    whenever the device reboots or lets the lease lapse."""

    label: str
    service: str
    event_url: str
    sid: str
    renew_at: float = field(default=0.0)


# Keyed by (label, service), not by URL — a renamed-but-same-IP device
# should replace its subscription rather than accumulate a second one, and
# a device can hold one subscription per service (AVTransport and
# RenderingControl) at once, which a bare label-keyed dict couldn't.
_subscriptions: dict[tuple[str, str], Subscription] = {}


def _request(url: str, headers: dict[str, str]) -> dict[str, str]:
    req = urllib.request.Request(url, method="SUBSCRIBE", headers=headers)
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
        return dict(resp.headers)


async def subscribe(
    label: str, service: str, event_url: str, callback_url: str
) -> Subscription | None:
    """Open (or replace) a subscription for (`label`, `service`). Returns
    None on failure — eventing is diagnostic, so a device that refuses it
    must not stop that device from playing."""
    headers = {
        "CALLBACK": f"<{callback_url}>",
        "NT": "upnp:event",
        "TIMEOUT": f"Second-{_SUBSCRIPTION_SECONDS}",
    }
    try:
        resp_headers = await asyncio.to_thread(_request, event_url, headers)
    except (urllib.error.URLError, OSError, ValueError) as e:
        logger.debug(f"[upnp] SUBSCRIBE failed for {label} ({service}): {e}")
        return None

    sid = resp_headers.get("SID")
    if not sid:
        logger.debug(f"[upnp] SUBSCRIBE for {label} ({service}) returned no SID")
        return None

    sub = Subscription(
        label=label,
        service=service,
        event_url=event_url,
        sid=sid,
        renew_at=time.monotonic() + _SUBSCRIPTION_SECONDS - _RENEW_MARGIN_SECONDS,
    )
    _subscriptions[(label, service)] = sub
    logger.debug(f"[upnp] Subscribed to {label}'s {service} events")
    return sub


async def renew(sub: Subscription) -> bool:
    """Extend an existing lease. On failure the subscription is dropped so
    the next ensure_subscribed() opens a fresh one — a device that rebooted
    has forgotten the SID and would reject every future renewal."""
    try:
        await asyncio.to_thread(
            _request,
            sub.event_url,
            {"SID": sub.sid, "TIMEOUT": f"Second-{_SUBSCRIPTION_SECONDS}"},
        )
    except (urllib.error.URLError, OSError, ValueError) as e:
        logger.debug(f"[upnp] Renewal failed for {sub.label} ({sub.service}): {e}")
        _subscriptions.pop((sub.label, sub.service), None)
        return False
    sub.renew_at = time.monotonic() + _SUBSCRIPTION_SECONDS - _RENEW_MARGIN_SECONDS
    return True


def forget(label: str, service: str = "avtransport") -> None:
    """Drop a subscription locally. No UNSUBSCRIBE call: the lease expires
    on its own, and a device that has become unreachable (the usual reason
    for dropping one) would only make this block."""
    _subscriptions.pop((label, service), None)


def active_labels() -> list[str]:
    return sorted(f"{label}/{service}" for label, service in _subscriptions)


def _unescape_last_change(body: str) -> str:
    """LastChange sits XML-escaped inside the NOTIFY body's own XML, so
    unescaping has to happen twice before its attributes are visible.
    Shared by both event parsers below."""
    text = body.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    return text.replace("&amp;", "&")


def parse_event(body: str) -> dict[str, str]:
    """Pull the AVTransport properties worth having out of a NOTIFY body.
    Returns only non-empty values — renderers routinely send a property
    with val="" to mean "unchanged", which would otherwise read as "the URI
    is now empty"."""
    text = _unescape_last_change(body)
    found = {}
    for name, value in _PROPERTY_RE.findall(text):
        if name in _KEPT_PROPERTIES and value:
            found[name] = value
    return found


def parse_rendering_control_event(body: str) -> dict[str, str]:
    """Pull Master-channel Volume/Mute out of a RenderingControl NOTIFY
    body — see _RENDERING_CONTROL_PROPERTY_RE's own comment for why this
    needs a different pattern than parse_event()'s. Returns a dict with
    whichever of "Volume"/"Mute" the device actually reported this time —
    Sonos sends both on any change, but the spec doesn't require it, and
    routes/upnp.py only updates the fields it actually got."""
    text = _unescape_last_change(body)
    return dict(_RENDERING_CONTROL_PROPERTY_RE.findall(text))


def problem_in(properties: dict[str, str]) -> str | None:
    """The device's own description of what went wrong, or None if it is
    reporting a healthy transport."""
    status = properties.get("TransportStatus")
    description = properties.get("TransportErrorDescription")
    if status and status != _HEALTHY_STATUS:
        return f"{status}: {description}" if description else status
    if description:
        return description
    return None


def handle_event(label: str, body: str) -> dict[str, str]:
    """Log what a device reported. Returns the parsed properties so the
    route can stay a thin adapter and the interesting logic stays testable
    without an HTTP layer."""
    properties = parse_event(body)
    if not properties:
        return properties

    problem = problem_in(properties)
    if problem:
        # The whole point of this module — a WARNING the operator can find
        # when playback died, rather than having to infer it from a stream
        # that simply stopped.
        state = properties.get("TransportState", "?")
        logger.warning(
            f"[upnp] {label} reports a transport problem: {problem} "
            f"(state={state}, uri={properties.get('CurrentTrackURI', '?')})"
        )
    else:
        logger.debug(
            f"[upnp] {label} state={properties.get('TransportState', '?')} "
            f"uri={properties.get('CurrentTrackURI', '?')}"
        )
    return properties


async def renew_due_subscriptions() -> None:
    """One pass over every live subscription, renewing whatever is close to
    expiring. Called by the background task in main.py's lifespan; split out
    so tests don't need to drive an infinite loop."""
    now = time.monotonic()
    for sub in list(_subscriptions.values()):
        if sub.renew_at <= now:
            await renew(sub)
