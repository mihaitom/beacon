"""Tests for core/upnp_events.py and routes/upnp.py — letting a cast device
report its own transport state instead of only ever being polled."""

import logging
import time
import urllib.error
from typing import ClassVar
from unittest.mock import patch

import pytest

from core import upnp_events
from routes.upnp import callback_url_for

# A NOTIFY body shaped like a real one: the interesting values live in a
# LastChange document that is XML-escaped inside the outer XML.
NOTIFY_BODY = (
    '<?xml version="1.0"?>'
    '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>'
    "&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;"
    "&lt;TransportState val=&quot;{state}&quot;/&gt;"
    "&lt;TransportStatus val=&quot;{status}&quot;/&gt;"
    "&lt;CurrentTrackURI val=&quot;http://10.2.2.11:8071/stream/abc&quot;/&gt;"
    "&lt;CurrentVolume val=&quot;35&quot;/&gt;"
    "&lt;/InstanceID&gt;&lt;/Event&gt;"
    "</LastChange></e:property></e:propertyset>"
)


@pytest.fixture(autouse=True)
def _clean_subscriptions():
    upnp_events._subscriptions.clear()
    yield
    upnp_events._subscriptions.clear()


# ── parse_event ───────────────────────────────────────────────────────────────


def test_parse_event_reads_through_the_double_escaping():
    props = upnp_events.parse_event(NOTIFY_BODY.format(state="PLAYING", status="OK"))
    assert props["TransportState"] == "PLAYING"
    assert props["TransportStatus"] == "OK"
    assert props["CurrentTrackURI"] == "http://10.2.2.11:8071/stream/abc"


def test_parse_event_ignores_properties_we_do_not_care_about():
    """A Sonos LastChange also carries volume, mute, EQ and a pile of
    vendor extensions — keeping those would bury the three fields this
    exists for."""
    props = upnp_events.parse_event(NOTIFY_BODY.format(state="PLAYING", status="OK"))
    assert "CurrentVolume" not in props


def test_parse_event_drops_empty_values():
    """Renderers routinely send val="" to mean "unchanged". Keeping those
    would read as "the URI is now empty" — a state change that never
    happened."""
    body = (
        "<e:propertyset><e:property><LastChange>"
        "&lt;TransportState val=&quot;STOPPED&quot;/&gt;"
        "&lt;CurrentTrackURI val=&quot;&quot;/&gt;"
        "</LastChange></e:property></e:propertyset>"
    )
    props = upnp_events.parse_event(body)
    assert props == {"TransportState": "STOPPED"}


def test_parse_event_returns_empty_for_an_unparseable_body():
    assert upnp_events.parse_event("not xml at all") == {}


# ── problem_in ────────────────────────────────────────────────────────────────


def test_problem_in_is_none_for_a_healthy_transport():
    assert upnp_events.problem_in({"TransportState": "PLAYING", "TransportStatus": "OK"}) is None


def test_problem_in_reports_a_non_ok_status():
    problem = upnp_events.problem_in({"TransportStatus": "ERROR_CANT_CONNECT"})
    assert problem == "ERROR_CANT_CONNECT"


def test_problem_in_combines_status_and_description():
    problem = upnp_events.problem_in(
        {"TransportStatus": "ERROR_CANT_CONNECT", "TransportErrorDescription": "no route"}
    )
    assert "ERROR_CANT_CONNECT" in problem
    assert "no route" in problem


def test_problem_in_reports_a_description_even_without_a_status():
    assert upnp_events.problem_in({"TransportErrorDescription": "decode failed"}) == "decode failed"


def test_problem_in_is_none_when_nothing_was_reported():
    assert upnp_events.problem_in({}) is None


# ── handle_event ──────────────────────────────────────────────────────────────


def test_handle_event_warns_about_a_device_reported_problem(caplog):
    """The whole point: an operator looking at why playback died finds the
    device's own words in the log instead of having to infer them from a
    stream that merely stopped."""
    body = NOTIFY_BODY.format(state="STOPPED", status="ERROR_CANT_CONNECT")
    with caplog.at_level(logging.WARNING, logger="connect.upnp"):
        upnp_events.handle_event("Arbeitszimmer", body)
    message = "\n".join(r.message for r in caplog.records)
    assert "Arbeitszimmer" in message
    assert "ERROR_CANT_CONNECT" in message


def test_handle_event_stays_quiet_for_a_healthy_state(caplog):
    body = NOTIFY_BODY.format(state="PLAYING", status="OK")
    with caplog.at_level(logging.WARNING, logger="connect.upnp"):
        props = upnp_events.handle_event("Arbeitszimmer", body)
    assert props["TransportState"] == "PLAYING"
    assert not caplog.records


def test_handle_event_ignores_a_body_with_nothing_in_it(caplog):
    with caplog.at_level(logging.DEBUG, logger="connect.upnp"):
        assert upnp_events.handle_event("Arbeitszimmer", "<empty/>") == {}
    assert not caplog.records


# ── subscribe / renew / forget ────────────────────────────────────────────────


def _headers(sid: str | None):
    return {"SID": sid} if sid else {}


async def test_subscribe_stores_the_devices_subscription_id():
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:sub-1")):
        sub = await upnp_events.subscribe("Arbeitszimmer", "http://d/evt", "http://me/cb")
    assert sub is not None
    assert sub.sid == "uuid:sub-1"
    assert upnp_events.active_labels() == ["Arbeitszimmer"]


async def test_subscribe_returns_none_when_the_device_refuses():
    """Eventing is diagnostic — a device that won't have it must still be
    able to play, so this can never raise into a dispatch."""
    with patch.object(upnp_events, "_request", side_effect=urllib.error.URLError("nope")):
        sub = await upnp_events.subscribe("Arbeitszimmer", "http://d/evt", "http://me/cb")
    assert sub is None
    assert upnp_events.active_labels() == []


async def test_subscribe_returns_none_when_no_sid_comes_back():
    with patch.object(upnp_events, "_request", return_value=_headers(None)):
        assert await upnp_events.subscribe("A", "http://d/evt", "http://me/cb") is None


async def test_subscribe_replaces_an_existing_subscription_for_the_same_label():
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:one")):
        await upnp_events.subscribe("A", "http://d/evt", "http://me/cb")
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:two")):
        await upnp_events.subscribe("A", "http://d/evt", "http://me/cb")
    assert upnp_events.active_labels() == ["A"]
    assert upnp_events._subscriptions["A"].sid == "uuid:two"


async def test_renew_extends_the_lease():
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:1")):
        sub = await upnp_events.subscribe("A", "http://d/evt", "http://me/cb")
    sub.renew_at = 0.0
    with patch.object(upnp_events, "_request", return_value={}):
        assert await upnp_events.renew(sub) is True
    assert sub.renew_at > time.monotonic()


async def test_a_failed_renewal_drops_the_subscription():
    """A device that rebooted has forgotten the SID and will reject every
    future renewal — holding on to it would mean never resubscribing, and a
    silent subscription is indistinguishable from a healthy one."""
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:1")):
        sub = await upnp_events.subscribe("A", "http://d/evt", "http://me/cb")
    with patch.object(upnp_events, "_request", side_effect=OSError("gone")):
        assert await upnp_events.renew(sub) is False
    assert upnp_events.active_labels() == []


async def test_forget_drops_a_subscription_without_calling_the_device():
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:1")):
        await upnp_events.subscribe("A", "http://d/evt", "http://me/cb")
    with patch.object(upnp_events, "_request", side_effect=AssertionError("must not call")):
        upnp_events.forget("A")
    assert upnp_events.active_labels() == []


async def test_renew_due_subscriptions_only_renews_what_is_due():
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:1")):
        due = await upnp_events.subscribe("due", "http://d/evt", "http://me/cb")
        await upnp_events.subscribe("fresh", "http://d/evt", "http://me/cb")
    due.renew_at = time.monotonic() - 1
    calls = []

    def _record(url, headers):
        calls.append(headers.get("SID"))
        return {}

    with patch.object(upnp_events, "_request", side_effect=_record):
        await upnp_events.renew_due_subscriptions()

    assert len(calls) == 1


def test_request_sends_a_subscribe_and_returns_the_response_headers():
    """The one place that actually speaks HTTP. SUBSCRIBE is not a method
    urllib knows, so this checks it really goes out as one rather than
    being silently downgraded to GET."""

    class _Resp:
        headers: ClassVar[dict[str, str]] = {"SID": "uuid:from-device", "TIMEOUT": "Second-1800"}

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    captured = {}

    def _urlopen(req, timeout=None):
        captured["method"] = req.get_method()
        captured["url"] = req.full_url
        captured["callback"] = req.get_header("Callback")
        return _Resp()

    with patch("core.upnp_events.urllib.request.urlopen", _urlopen):
        headers = upnp_events._request("http://device/evt", {"CALLBACK": "<http://me/cb>"})

    assert captured["method"] == "SUBSCRIBE"
    assert captured["url"] == "http://device/evt"
    assert captured["callback"] == "<http://me/cb>"
    assert headers["SID"] == "uuid:from-device"


# ── routes/upnp.py ────────────────────────────────────────────────────────────


def test_callback_url_carries_the_label_in_the_path():
    """One endpoint serves every subscribed device — a grouped Sonos pair
    reports from two players about the same session, so the path is what
    tells them apart rather than the source address."""
    assert callback_url_for("Arbeitszimmer").endswith("/upnp/events/Arbeitszimmer")


def test_notify_endpoint_logs_the_event_and_answers_200(client):
    body = NOTIFY_BODY.format(state="STOPPED", status="ERROR_CANT_CONNECT")
    with patch("routes.upnp.handle_event") as handler:
        response = client.request("NOTIFY", "/upnp/events/Arbeitszimmer", content=body)
    assert response.status_code == 200
    handler.assert_called_once()
    assert handler.call_args[0][0] == "Arbeitszimmer"


def test_notify_endpoint_ignores_an_oversized_body(client):
    huge = "x" * (upnp_events_max() + 1)
    with patch("routes.upnp.handle_event", side_effect=AssertionError("must not parse")) as h:
        response = client.request("NOTIFY", "/upnp/events/A", content=huge)
    assert response.status_code == 200
    h.assert_not_called()


def test_notify_endpoint_still_answers_200_when_handling_raises(client):
    """A device that gets an error back may cancel its subscription —
    losing eventing over one malformed payload is worse than dropping it."""
    with patch("routes.upnp.handle_event", side_effect=ValueError("boom")):
        response = client.request("NOTIFY", "/upnp/events/A", content="<x/>")
    assert response.status_code == 200


def upnp_events_max() -> int:
    from routes.upnp import _MAX_BODY_BYTES

    return _MAX_BODY_BYTES
