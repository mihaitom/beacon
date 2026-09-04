"""Tests for core/upnp_events.py and routes/upnp.py — letting a cast device
report its own transport state instead of only ever being polled."""

import html
import logging
import time
import urllib.error
from typing import ClassVar
from unittest.mock import patch

import pytest

from core import icy_metadata, upnp_events
from core.icy_metadata import ICY_PULSE_SECONDS, pulsed_title, strip_pulse
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


# ── parse_stream_title_echo ──────────────────────────────────────────────────
# CurrentTrackMetaData's own value is a DIDL-Lite document, escaped once more
# than the properties parse_event() reads — see parse_stream_title_echo()'s
# own comment on the escape depth that costs, and on the bug this fixture
# used to hide by getting that depth wrong.


def _stream_content_notify(title: str, tag: str = "r:streamContent") -> str:
    """A NOTIFY body at the escape depth a real renderer actually sends.

    Built by escaping twice, deliberately, rather than writing the outer
    markup out as literal `&lt;`-entities with a once-escaped DIDL dropped
    into it: those two look almost identical but put the DIDL one level
    apart, and this fixture used to do the latter. That made every
    `<r:streamContent>` reachable by a single unescape layer, so
    parse_stream_title_echo() passed here while returning None for every
    real echo a Sonos ever sent — the ICY round-trip lag was never measured
    once in production and the whole test file stayed green. Escaping the
    same way the device does is what keeps the two from drifting apart
    again."""
    didl = f"<DIDL-Lite><item><{tag}>{title}</{tag}></item></DIDL-Lite>"
    last_change = (
        f'<Event><InstanceID val="0"><CurrentTrackMetaData val="{html.escape(didl)}"/>'
        "</InstanceID></Event>"
    )
    return (
        "<e:propertyset><e:property><LastChange>"
        f"{html.escape(last_change)}"
        "</LastChange></e:property></e:propertyset>"
    )


def test_parse_stream_title_echo_reads_sonos_own_field():
    body = _stream_content_notify("MARK 001")
    assert upnp_events.parse_stream_title_echo(body) == "MARK 001"


def test_parse_stream_title_echo_falls_back_to_dc_title():
    """A generic DLNA renderer puts the ICY title in dc:title instead —
    same field icy_sync_probe.py falls back to."""
    body = _stream_content_notify("MARK 002", tag="dc:title")
    assert upnp_events.parse_stream_title_echo(body) == "MARK 002"


def test_parse_stream_title_echo_prefers_streamcontent_over_dc_title():
    didl = (
        "<DIDL-Lite><item>"
        "<dc:title>Connect</dc:title>"
        "<r:streamContent>MARK 003</r:streamContent>"
        "</item></DIDL-Lite>"
    )
    last_change = f'<Event><CurrentTrackMetaData val="{html.escape(didl)}"/></Event>'
    body = (
        "<e:propertyset><e:property><LastChange>"
        f"{html.escape(last_change)}"
        "</LastChange></e:property></e:propertyset>"
    )
    assert upnp_events.parse_stream_title_echo(body) == "MARK 003"


def test_parse_stream_title_echo_survives_ampersands_and_apostrophes():
    """The echoed title is compared byte-for-byte against what IcyMuxer
    injected (routes/upnp.py's _handle_stream_title_echo()), so a title
    that comes back still carrying entities simply fails that check and the
    measurement is thrown away. Both characters below are ordinary in real
    track titles, and `&` in particular sits at a *third* escape level here
    — one deeper than the markup around it."""
    body = _stream_content_notify("Simon &amp; Garfunkel - Don&apos;t")
    assert upnp_events.parse_stream_title_echo(body) == "Simon & Garfunkel - Don't"


def test_parse_stream_title_echo_returns_none_without_one():
    """Most NOTIFYs carry no title change at all — LastChange fires on
    plenty of properties that have nothing to do with metadata."""
    body = NOTIFY_BODY.format(state="PLAYING", status="OK")
    assert upnp_events.parse_stream_title_echo(body) is None


def test_parse_stream_title_echo_returns_none_for_an_empty_title():
    body = _stream_content_notify("")
    assert upnp_events.parse_stream_title_echo(body) is None


# ── parse_rendering_control_event ───────────────────────────────────────────

# Shaped like a real RenderingControl LastChange: channel-qualified, unlike
# AVTransport's — see _RENDERING_CONTROL_PROPERTY_RE's own comment.
RC_NOTIFY_BODY = (
    '<?xml version="1.0"?>'
    '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>'
    "&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;"
    "&lt;Volume channel=&quot;Master&quot; val=&quot;{volume}&quot;/&gt;"
    "&lt;Volume channel=&quot;LF&quot; val=&quot;99&quot;/&gt;"
    "&lt;Volume channel=&quot;RF&quot; val=&quot;99&quot;/&gt;"
    "&lt;Mute channel=&quot;Master&quot; val=&quot;{mute}&quot;/&gt;"
    "&lt;/InstanceID&gt;&lt;/Event&gt;"
    "</LastChange></e:property></e:propertyset>"
)


def test_parse_rendering_control_event_reads_master_channel_volume_and_mute():
    props = upnp_events.parse_rendering_control_event(RC_NOTIFY_BODY.format(volume="35", mute="0"))
    assert props == {"Volume": "35", "Mute": "0"}


def test_parse_rendering_control_event_ignores_lf_rf_channels():
    """Only Master is what GET /device-volume and the slider already mean
    by "this device's volume" — LF/RF only diverge when someone's
    deliberately unbalanced a stereo pair."""
    props = upnp_events.parse_rendering_control_event(RC_NOTIFY_BODY.format(volume="35", mute="0"))
    assert "99" not in props.values()


def test_parse_rendering_control_event_returns_empty_for_an_unparseable_body():
    assert upnp_events.parse_rendering_control_event("not xml at all") == {}


def test_parse_rendering_control_event_returns_only_whats_present():
    """The spec doesn't require a device to send both Volume and Mute on
    every change — a Mute-only toggle shouldn't fabricate a Volume key."""
    body = (
        "<e:propertyset><e:property><LastChange>"
        "&lt;Mute channel=&quot;Master&quot; val=&quot;1&quot;/&gt;"
        "</LastChange></e:property></e:propertyset>"
    )
    assert upnp_events.parse_rendering_control_event(body) == {"Mute": "1"}


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
        sub = await upnp_events.subscribe(
            "Arbeitszimmer", "avtransport", "http://d/evt", "http://me/cb"
        )
    assert sub is not None
    assert sub.sid == "uuid:sub-1"
    assert upnp_events.active_labels() == ["Arbeitszimmer/avtransport"]


async def test_subscribe_returns_none_when_the_device_refuses():
    """Eventing is diagnostic — a device that won't have it must still be
    able to play, so this can never raise into a dispatch."""
    with patch.object(upnp_events, "_request", side_effect=urllib.error.URLError("nope")):
        sub = await upnp_events.subscribe(
            "Arbeitszimmer", "avtransport", "http://d/evt", "http://me/cb"
        )
    assert sub is None
    assert upnp_events.active_labels() == []


async def test_subscribe_returns_none_when_no_sid_comes_back():
    with patch.object(upnp_events, "_request", return_value=_headers(None)):
        assert (
            await upnp_events.subscribe("A", "avtransport", "http://d/evt", "http://me/cb") is None
        )


async def test_subscribe_replaces_an_existing_subscription_for_the_same_label_and_service():
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:one")):
        await upnp_events.subscribe("A", "avtransport", "http://d/evt", "http://me/cb")
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:two")):
        await upnp_events.subscribe("A", "avtransport", "http://d/evt", "http://me/cb")
    assert upnp_events.active_labels() == ["A/avtransport"]
    assert upnp_events._subscriptions[("A", "avtransport")].sid == "uuid:two"


async def test_subscribe_holds_one_subscription_per_service_for_the_same_label():
    """A single Sonos player carries both an AVTransport and a
    RenderingControl subscription at once (see delivery/sonos.py) — the
    second must not evict the first."""
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:av")):
        await upnp_events.subscribe("A", "avtransport", "http://d/evt1", "http://me/cb1")
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:rc")):
        await upnp_events.subscribe("A", "renderingcontrol", "http://d/evt2", "http://me/cb2")
    assert upnp_events.active_labels() == ["A/avtransport", "A/renderingcontrol"]


async def test_renew_extends_the_lease():
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:1")):
        sub = await upnp_events.subscribe("A", "avtransport", "http://d/evt", "http://me/cb")
    sub.renew_at = 0.0
    with patch.object(upnp_events, "_request", return_value={}):
        assert await upnp_events.renew(sub) is True
    assert sub.renew_at > time.monotonic()


async def test_a_failed_renewal_drops_the_subscription():
    """A device that rebooted has forgotten the SID and will reject every
    future renewal — holding on to it would mean never resubscribing, and a
    silent subscription is indistinguishable from a healthy one."""
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:1")):
        sub = await upnp_events.subscribe("A", "avtransport", "http://d/evt", "http://me/cb")
    with patch.object(upnp_events, "_request", side_effect=OSError("gone")):
        assert await upnp_events.renew(sub) is False
    assert upnp_events.active_labels() == []


async def test_forget_drops_a_subscription_without_calling_the_device():
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:1")):
        await upnp_events.subscribe("A", "avtransport", "http://d/evt", "http://me/cb")
    with patch.object(upnp_events, "_request", side_effect=AssertionError("must not call")):
        upnp_events.forget("A", "avtransport")
    assert upnp_events.active_labels() == []


async def test_renew_due_subscriptions_only_renews_what_is_due():
    with patch.object(upnp_events, "_request", return_value=_headers("uuid:1")):
        due = await upnp_events.subscribe("due", "avtransport", "http://d/evt", "http://me/cb")
        await upnp_events.subscribe("fresh", "avtransport", "http://d/evt", "http://me/cb")
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


def test_callback_url_carries_the_service_and_label_in_the_path():
    """One endpoint serves every subscribed device *and* service — a
    grouped Sonos pair reports from two players about the same session, and
    each player holds one subscription per service (see
    core/upnp_events.py's Subscription), so both need to be in the path
    rather than just the source address."""
    assert callback_url_for("Arbeitszimmer", "avtransport").endswith(
        "/upnp/events/avtransport/Arbeitszimmer"
    )


def test_callback_url_defaults_to_avtransport():
    assert callback_url_for("Arbeitszimmer").endswith("/upnp/events/avtransport/Arbeitszimmer")


def test_notify_endpoint_logs_the_event_and_answers_200(client):
    body = NOTIFY_BODY.format(state="STOPPED", status="ERROR_CANT_CONNECT")
    with patch("routes.upnp.handle_event") as handler:
        response = client.request("NOTIFY", "/upnp/events/avtransport/Arbeitszimmer", content=body)
    assert response.status_code == 200
    handler.assert_called_once()
    assert handler.call_args[0][0] == "Arbeitszimmer"


def test_notify_endpoint_ignores_an_oversized_body(client):
    huge = "x" * (upnp_events_max() + 1)
    with patch("routes.upnp.handle_event", side_effect=AssertionError("must not parse")) as h:
        response = client.request("NOTIFY", "/upnp/events/avtransport/A", content=huge)
    assert response.status_code == 200
    h.assert_not_called()


def test_notify_endpoint_still_answers_200_when_handling_raises(client):
    """A device that gets an error back may cancel its subscription —
    losing eventing over one malformed payload is worse than dropping it."""
    with patch("routes.upnp.handle_event", side_effect=ValueError("boom")):
        response = client.request("NOTIFY", "/upnp/events/avtransport/A", content="<x/>")
    assert response.status_code == 200


# ── routes/upnp.py — ICY StreamTitle round-trip (_handle_stream_title_echo) ──
# The live counterpart to scripts/icy_sync_probe.py's own one-off
# measurement — see core/session.py's radio_icy_pending_injection/
# radio_icy_measured_lag and core/visualizer_feed.py's _FirstByteClock for
# the two ends of this.


async def test_notify_measures_the_round_trip_when_the_echo_matches(client, default_session):
    from core.claims import claims

    await claims.claim("sonos", "Arbeitszimmer", default_session.session_id)
    injected_at = time.monotonic() - 2.5
    default_session.radio_icy_pending_injection = ("MARK 001", injected_at)
    body = _stream_content_notify("MARK 001")

    response = client.request("NOTIFY", "/upnp/events/avtransport/Arbeitszimmer", content=body)

    assert response.status_code == 200
    assert default_session.radio_icy_measured_lag == pytest.approx(2.5, abs=0.5)
    # Consumed — a later, unrelated NOTIFY must not re-match the same
    # injection a second time.
    assert default_session.radio_icy_pending_injection is None


async def test_notify_ignores_an_echo_that_does_not_match_whats_pending(client, default_session):
    from core.claims import claims

    await claims.claim("sonos", "Arbeitszimmer", default_session.session_id)
    pending = ("MARK 001", time.monotonic())
    default_session.radio_icy_pending_injection = pending
    body = _stream_content_notify("a stale, different title")

    client.request("NOTIFY", "/upnp/events/avtransport/Arbeitszimmer", content=body)

    assert default_session.radio_icy_measured_lag is None
    # Still pending, untouched — a later NOTIFY carrying the real echo must
    # still be able to match it.
    assert default_session.radio_icy_pending_injection == pending


async def test_notify_is_a_no_op_with_nothing_pending(client, default_session):
    from core.claims import claims

    await claims.claim("sonos", "Arbeitszimmer", default_session.session_id)
    body = _stream_content_notify("MARK 001")

    response = client.request("NOTIFY", "/upnp/events/avtransport/Arbeitszimmer", content=body)

    assert response.status_code == 200
    assert default_session.radio_icy_measured_lag is None


async def test_notify_ignores_a_non_positive_measured_lag(client, default_session):
    """A stale/out-of-order NOTIFY, or a clock oddity, must not overwrite a
    perfectly good previous measurement (or set a nonsensical one) — see
    _handle_stream_title_echo()'s own comment."""
    from core.claims import claims

    await claims.claim("sonos", "Arbeitszimmer", default_session.session_id)
    default_session.radio_icy_measured_lag = 5.0
    # Injected "in the future" relative to when the NOTIFY handling itself
    # runs — an artificial way to force lag <= 0 without depending on real
    # timing.
    default_session.radio_icy_pending_injection = ("MARK 001", time.monotonic() + 100.0)
    body = _stream_content_notify("MARK 001")

    client.request("NOTIFY", "/upnp/events/avtransport/Arbeitszimmer", content=body)

    assert default_session.radio_icy_measured_lag == 5.0  # untouched
    # Still consumed either way — a non-positive result is still a result,
    # not "try again with the same injection".
    assert default_session.radio_icy_pending_injection is None


def test_notify_stream_title_echo_is_a_no_op_for_an_unclaimed_device(client):
    """Same "nothing to update" case _handle_rendering_control_event() has
    — a stray/unsolicited NOTIFY, or a device nobody currently casts radio
    to."""
    body = _stream_content_notify("MARK 001")
    response = client.request("NOTIFY", "/upnp/events/avtransport/Nobody", content=body)
    assert response.status_code == 200


async def test_notify_stream_title_echo_is_a_no_op_for_a_claim_with_no_live_session(client):
    """A claim can outlive the session that made it (see core/claims.py) —
    same "nothing to update" shape as an unclaimed device, just one step
    further along."""
    from core.claims import claims

    await claims.claim("sonos", "Ghost", "a-session-id-that-does-not-exist")
    body = _stream_content_notify("MARK 001")

    response = client.request("NOTIFY", "/upnp/events/avtransport/Ghost", content=body)

    assert response.status_code == 200


# ── routes/upnp.py — RenderingControl (volume/mute push) ────────────────────


async def test_notify_pushes_volume_into_the_claiming_session(client, default_session):
    from core.claims import claims

    await claims.claim("sonos", "Arbeitszimmer", default_session.session_id)
    body = RC_NOTIFY_BODY.format(volume="42", mute="0")

    response = client.request("NOTIFY", "/upnp/events/renderingcontrol/Arbeitszimmer", content=body)

    assert response.status_code == 200
    assert default_session.state.device_volumes["sonos:Arbeitszimmer"] == (42, False)


async def test_notify_broadcasts_the_updated_status_with_the_new_volume(client, default_session):
    from core.claims import claims
    from delivery import SonosDelivery

    default_session.state.active_delivery = SonosDelivery("Arbeitszimmer")
    await claims.claim("sonos", "Arbeitszimmer", default_session.session_id)
    q = default_session.event_bus.subscribe()
    body = RC_NOTIFY_BODY.format(volume="42", mute="0")

    client.request("NOTIFY", "/upnp/events/renderingcontrol/Arbeitszimmer", content=body)

    payload = q.get_nowait()
    assert payload["targets"] == [
        {"name": "Arbeitszimmer", "type": "sonos", "volume": 42, "muted": False}
    ]


async def test_notify_volume_only_update_does_not_clobber_a_known_mute(client, default_session):
    from core.claims import claims

    await claims.claim("sonos", "Arbeitszimmer", default_session.session_id)
    default_session.state.device_volumes["sonos:Arbeitszimmer"] = (10, True)
    body = (
        "<e:propertyset><e:property><LastChange>"
        "&lt;Volume channel=&quot;Master&quot; val=&quot;55&quot;/&gt;"
        "</LastChange></e:property></e:propertyset>"
    )

    client.request("NOTIFY", "/upnp/events/renderingcontrol/Arbeitszimmer", content=body)

    assert default_session.state.device_volumes["sonos:Arbeitszimmer"] == (55, True)


def test_notify_rendering_control_is_a_no_op_for_an_unclaimed_device(client, default_session):
    """A stray/unsolicited POST, or a device nobody has cast to yet — same
    as an AVTransport NOTIFY from a device nobody's watching, this must not
    raise or fabricate a session's worth of state."""
    body = RC_NOTIFY_BODY.format(volume="42", mute="0")

    response = client.request("NOTIFY", "/upnp/events/renderingcontrol/NobodysDevice", content=body)

    assert response.status_code == 200
    assert default_session.state.device_volumes == {}


def upnp_events_max() -> int:
    from routes.upnp import _MAX_BODY_BYTES

    return _MAX_BODY_BYTES


# ── ICY round-trip estimation ───────────────────────────────────────────────
# See routes/upnp.py's _handle_stream_title_echo() and core/session.py's
# radio_icy_measured_lag: an echo is an upper bound on the device's buffer,
# never a reading, so the estimate is the smallest plausible sample.


async def _notify(client, session, title):
    from core.claims import claims

    await claims.claim("sonos", "Arbeitszimmer", session.session_id)
    client.request(
        "NOTIFY",
        "/upnp/events/avtransport/Arbeitszimmer",
        content=_stream_content_notify(title),
    )


async def test_notify_keeps_the_smallest_sample_not_the_newest(client, default_session):
    """Sonos moderates its own eventing and can go half a minute without
    sending anything, so a later sample is routinely far too large. It can
    never be too small — a device cannot report a title it has not played —
    so the minimum is the estimator, exactly as scripts/icy_sync_probe.py
    concluded against real hardware."""
    default_session.radio_icy_pending_injection = ("A", time.monotonic() - 4.7)
    await _notify(client, default_session, "A")
    assert default_session.radio_icy_measured_lag == pytest.approx(4.7, abs=0.5)

    default_session.radio_icy_pending_injection = ("B", time.monotonic() - 9.0)
    await _notify(client, default_session, "B")
    assert default_session.radio_icy_measured_lag == pytest.approx(4.7, abs=0.5)

    default_session.radio_icy_pending_injection = ("C", time.monotonic() - 2.2)
    await _notify(client, default_session, "C")
    assert default_session.radio_icy_measured_lag == pytest.approx(2.2, abs=0.5)


async def test_notify_discards_an_implausible_sample_rather_than_adopting_it(
    client, default_session
):
    """The live 2026-09-05 failure: one routine state=PLAYING NOTIFY, 26s
    after the previous event, produced a 16.63s "round trip" for a device
    whose real buffer is under five. The min-estimator alone cannot help a
    *first* sample, so an implausible one is thrown away and the fixed guess
    stays in place instead."""
    default_session.radio_icy_pending_injection = ("A", time.monotonic() - 16.63)
    await _notify(client, default_session, "A")
    assert default_session.radio_icy_measured_lag is None


async def test_notify_discards_a_sample_too_fast_to_be_playback(client, default_session):
    """icy_sync_probe.py, verbatim: "min < 1s -> reports on read. Dead end,
    the number is network latency." """
    default_session.radio_icy_pending_injection = ("A", time.monotonic() - 0.2)
    await _notify(client, default_session, "A")
    assert default_session.radio_icy_measured_lag is None


async def test_notify_matches_an_echo_that_dropped_the_pulse_mark(client, default_session):
    """A device is free to normalise core/icy_metadata.py's invisible pulse
    mark away before reporting the title back. One that does simply stops
    producing the extra measurement points — it must not also lose the ones
    a genuine title change produces."""
    default_session.radio_icy_pending_injection = (
        pulsed_title("Artist - Song", ICY_PULSE_SECONDS),  # an odd window: marked
        time.monotonic() - 4.7,
    )
    await _notify(client, default_session, "Artist - Song")  # echoed back unmarked
    assert default_session.radio_icy_measured_lag == pytest.approx(4.7, abs=0.5)


# ── pulsed_title ────────────────────────────────────────────────────────────


def test_pulsed_title_does_nothing_unless_switched_on(monkeypatch):
    """Off by default. It exists to supply the ICY round-trip measurement
    with samples, and that measurement no longer steers anything — leaving
    it on would push a metadata update to every connected device every 8
    seconds for a number nothing consumes."""
    monkeypatch.delenv(icy_metadata.ICY_PULSE_ENV, raising=False)
    assert pulsed_title("Artist - Song", ICY_PULSE_SECONDS * 1.5) == "Artist - Song"
    assert pulsed_title("Artist - Song", ICY_PULSE_SECONDS * 2.5) == "Artist - Song"


def test_pulsed_title_alternates_on_the_pulse_cadence(monkeypatch):
    """Switched on, it gives a device something that changed on a steady
    rhythm — the only way to get more than one round-trip sample per song
    out of an ordinary station, which is what anyone re-investigating this
    would want."""
    monkeypatch.setenv(icy_metadata.ICY_PULSE_ENV, "1")
    marked = pulsed_title("Artist - Song", ICY_PULSE_SECONDS * 1.5)
    plain = pulsed_title("Artist - Song", ICY_PULSE_SECONDS * 2.5)
    assert plain == "Artist - Song"
    assert marked != plain
    assert strip_pulse(marked) == plain


def test_pulsed_title_is_invisible_and_survives_the_echo_parse(monkeypatch):
    monkeypatch.setenv(icy_metadata.ICY_PULSE_ENV, "1")
    """The mark is what a Sonos shows on its own display, so it has to add
    nothing a listener can see — and it has to come back out of a NOTIFY
    intact, or the exact-match check would reject every marked echo."""
    marked = pulsed_title("Artist - Song", ICY_PULSE_SECONDS)
    assert marked.strip() == marked  # str.strip() must not eat the mark
    assert marked.replace("\u200b", "") == "Artist - Song"
    assert upnp_events.parse_stream_title_echo(_stream_content_notify(marked)) == marked


def test_pulsed_title_is_phase_aligned_across_connections(monkeypatch):
    monkeypatch.setenv(icy_metadata.ICY_PULSE_ENV, "1")
    """Derived from the clock, not counted per muxer: there is one IcyMuxer
    per device connection, and a per-connection counter would give each its
    own phase — several connections would then inject conflicting titles and
    an injection from one would be paired with an echo belonging to another."""
    now = 123.456
    assert pulsed_title("A", now) == pulsed_title("A", now)


def test_pulsed_title_passes_an_absent_title_through():
    """Nothing to pulse yet — a bare mark on its own would be a title where
    the station has none."""
    assert pulsed_title(None, ICY_PULSE_SECONDS) is None
    assert pulsed_title("", ICY_PULSE_SECONDS) == ""
