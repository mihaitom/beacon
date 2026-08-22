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

Deliberately log-only. Nothing here feeds back into playback decisions: no
auto-stop, no auto-recovery, no position handling. That keeps a diagnostic
addition from becoming a new way for playback to break, which matters more
than usual in a subsystem with this bug history. Reacting to these events
(surfacing a dead cast to the frontend, see TODO.md) is a deliberate next
step, not something to slip in here.
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

# LastChange arrives as an XML document embedded, escaped, inside the
# NOTIFY body's XML — hence the double unescape in parse_event() before
# these can match.
_PROPERTY_RE = re.compile(r"<(\w+)\s+val=\"([^\"]*)\"")

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
    """One live AVTransport subscription. `sid` is the device's own handle
    for it, needed to renew or cancel; it changes whenever the device
    reboots or lets the lease lapse."""

    label: str
    event_url: str
    sid: str
    renew_at: float = field(default=0.0)


# Keyed by the caller's label (a device/target name), not by URL — a
# renamed-but-same-IP device should replace its subscription rather than
# accumulate a second one.
_subscriptions: dict[str, Subscription] = {}


def _request(url: str, headers: dict[str, str]) -> dict[str, str]:
    req = urllib.request.Request(url, method="SUBSCRIBE", headers=headers)
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
        return dict(resp.headers)


async def subscribe(label: str, event_url: str, callback_url: str) -> Subscription | None:
    """Open (or replace) a subscription for `label`. Returns None on
    failure — eventing is diagnostic, so a device that refuses it must not
    stop that device from playing."""
    headers = {
        "CALLBACK": f"<{callback_url}>",
        "NT": "upnp:event",
        "TIMEOUT": f"Second-{_SUBSCRIPTION_SECONDS}",
    }
    try:
        resp_headers = await asyncio.to_thread(_request, event_url, headers)
    except (urllib.error.URLError, OSError, ValueError) as e:
        logger.debug(f"[upnp] SUBSCRIBE failed for {label}: {e}")
        return None

    sid = resp_headers.get("SID")
    if not sid:
        logger.debug(f"[upnp] SUBSCRIBE for {label} returned no SID")
        return None

    sub = Subscription(
        label=label,
        event_url=event_url,
        sid=sid,
        renew_at=time.monotonic() + _SUBSCRIPTION_SECONDS - _RENEW_MARGIN_SECONDS,
    )
    _subscriptions[label] = sub
    logger.debug(f"[upnp] Subscribed to {label}'s transport events")
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
        logger.debug(f"[upnp] Renewal failed for {sub.label}: {e}")
        _subscriptions.pop(sub.label, None)
        return False
    sub.renew_at = time.monotonic() + _SUBSCRIPTION_SECONDS - _RENEW_MARGIN_SECONDS
    return True


def forget(label: str) -> None:
    """Drop a subscription locally. No UNSUBSCRIBE call: the lease expires
    on its own, and a device that has become unreachable (the usual reason
    for dropping one) would only make this block."""
    _subscriptions.pop(label, None)


def active_labels() -> list[str]:
    return sorted(_subscriptions)


def parse_event(body: str) -> dict[str, str]:
    """Pull the properties worth having out of a NOTIFY body.

    The interesting values sit in a LastChange document that is XML-escaped
    inside the NOTIFY's own XML, so unescaping has to happen twice before
    the attributes are visible. Returns only non-empty values — renderers
    routinely send a property with val="" to mean "unchanged", which would
    otherwise read as "the URI is now empty"."""
    text = body.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    text = text.replace("&amp;", "&")
    found = {}
    for name, value in _PROPERTY_RE.findall(text):
        if name in _KEPT_PROPERTIES and value:
            found[name] = value
    return found


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
