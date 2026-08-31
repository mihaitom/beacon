"""delivery/errors.py — turns a delivery library's own exception into
something the frontend can say a useful sentence about.

What reaches a listener otherwise is whatever the library happened to
raise, verbatim. `UPnP Error 800 received:  from 10.2.2.112` is a real
example, shown in the cast overlay's own alert exactly like that: it names
no device the listener recognises, no action they could take, and not even
which of the two things they just did produced it.

The classification is deliberately coarse. A UPnP fault code says what
layer refused, not why, and guessing further would mean inventing detail
the speaker never gave us. Three outcomes are enough to be honest and
still useful — the device rejected what it was handed, the device was
busy, or the device could not be reached — and the raw text still travels
alongside as `detail` for anyone who needs it, as well as going to the log
in full.

The reason strings are a contract with the frontend (see
services/connect/types.ts's DeliveryFailedError and the `connect.error.*`
i18n keys) — matched exactly there, so they are stable identifiers, not
prose."""

import logging

from soco.exceptions import SoCoUPnPException

logger = logging.getLogger("connect.delivery.errors")

#: The device understood the request and refused what it was handed - a
#: format it can't decode, a URL it can't fetch, a playlist file where it
#: expected audio (see core/playlist_url.py, the case this was written for).
REASON_REJECTED = "rejected"
#: The device is busy with something it won't interrupt on its own.
REASON_BUSY = "busy"
#: Nothing answered - powered off, off the network, a wrong address.
REASON_UNREACHABLE = "unreachable"
#: The *station* refused the connection, not the device: it answered
#: Beacon's own probe with 401/403/404/410. Kept apart from
#: REASON_UNREACHABLE (which is about the speaker) because the two need
#: opposite things from whoever reads them — one is "check your speaker",
#: the other is "this station isn't serving us".
REASON_STATION_REFUSED = "station_refused"
#: Anything this can't place. Carries `detail` through to the UI, which is
#: no worse than what every failure used to show.
REASON_UNKNOWN = "unknown"

# UPnP fault codes worth telling apart, per AVTransport:1. 800 is not in
# that spec at all - it is inside the 800-899 range reserved for
# vendor-defined faults, and is what a Sonos answers with when it will not
# take a URI it was given (an unplayable stream, most often), which is
# exactly the "rejected" case as far as anyone listening is concerned.
_UPNP_REASONS = {
    "701": REASON_REJECTED,  # Transition not available
    "714": REASON_REJECTED,  # Illegal MIME-type
    "716": REASON_REJECTED,  # Resource not found
    "800": REASON_REJECTED,  # Sonos vendor fault, in practice "I won't play that"
    "715": REASON_BUSY,  # Resource is currently in use
}


# What a device reports on its own event channel, rather than raising at
# the point it was asked (see routes/upnp.py). Sonos's AVTransport
# TransportStatus values; the two seen in practice are the first two, both
# for a station the speaker simply will not take from where it was told to
# get it — a format it won't decode, or an https URL on a stranger's host.
_TRANSPORT_STATUS_REASONS = {
    "ERROR_UNSUPPORTED_FORMAT": REASON_REJECTED,
    "ERROR_ACCESS_DENIED": REASON_REJECTED,
    "ERROR_CANT_REACH_SERVER": REASON_UNREACHABLE,
    "ERROR_CONNECT_FAILED": REASON_UNREACHABLE,
}


def classify_transport_problem(problem: str) -> str:
    """One of the REASON_* constants for a device's own transport-status
    report. `problem` is upnp_events.problem_in()'s output — the status
    name, optionally followed by ": " and the device's own description."""
    return _TRANSPORT_STATUS_REASONS.get(problem.split(":")[0].strip(), REASON_UNKNOWN)


def transport_error_response(problem: str, target: object) -> dict:
    """The same body delivery_error_response() builds, for a failure that
    arrived as an event instead of an exception. Shaped identically so the
    frontend has one thing to understand, not two."""
    reason = classify_transport_problem(problem)
    logger.info(f"[delivery] {target!r} reported: reason={reason} detail={problem}")
    return {
        "error": "delivery_failed",
        "reason": reason,
        "device": device_label(target),
        "detail": problem,
    }


def classify_delivery_error(error: BaseException) -> str:
    """One of the REASON_* constants above for anything a delivery's play()
    can raise."""
    if isinstance(error, SoCoUPnPException):
        return _UPNP_REASONS.get(str(error.error_code), REASON_UNKNOWN)
    # ConnectionError and TimeoutError are both OSError subclasses, as is
    # everything requests raises through to here for a speaker that has
    # gone away - one check covers the lot.
    if isinstance(error, OSError):
        return REASON_UNREACHABLE
    return REASON_UNKNOWN


def device_label(target: object) -> str:
    """The speaker's own name, as a listener knows it.

    A single delivery carries one (BaseDelivery.target); a DeliveryManager
    is several at once and names all of them, because manager.play() raises
    the first failure without saying which device it came from (see its own
    comment on the all-failed case). Naming every device in the group is
    honest about that, where naming one would be a guess."""
    single = getattr(target, "target", None)
    if isinstance(single, str):
        return single
    list_targets = getattr(target, "list_targets", None)
    if callable(list_targets):
        return ", ".join(t["name"] for t in list_targets()) or "?"
    return str(target)


def delivery_error_response(error: BaseException, target: object) -> dict:
    """The error body a failed dispatch returns to the client.

    Shaped like /play's existing `device_in_use` response (a stable `error`
    key plus the fields the message needs) so the frontend tells them apart
    the same way — see services/connect/types.ts.

    `detail` is the library's own text, unchanged. It is never the whole
    message shown, only ever the technical line under it: a listener needs
    to know their speaker refused the station, and someone debugging needs
    to know it said 800."""
    reason = classify_delivery_error(error)
    detail = str(error).strip() or type(error).__name__
    logger.info(f"[delivery] {target!r} failed: reason={reason} detail={detail}")
    return {
        "error": "delivery_failed",
        "reason": reason,
        "device": device_label(target),
        "detail": detail,
    }
