"""Tests for delivery/errors.py — turning a delivery library's own
exception into something the frontend can say a useful sentence about."""

import pytest
from soco.exceptions import SoCoUPnPException

from delivery.errors import (
    REASON_BUSY,
    REASON_REJECTED,
    REASON_UNKNOWN,
    REASON_UNREACHABLE,
    classify_delivery_error,
    classify_transport_problem,
    delivery_error_response,
    device_label,
    transport_error_response,
)


def _upnp(error_code: str) -> SoCoUPnPException:
    return SoCoUPnPException(
        message=f"UPnP Error {error_code} received:  from 10.2.2.112",
        error_code=error_code,
        error_xml="<xml/>",
    )


class _FakeDelivery:
    def __init__(self, target: str):
        self.target = target

    def __repr__(self) -> str:
        return f"FakeDelivery({self.target})"


class _FakeManager:
    def __init__(self, names: list[str]):
        self._names = names

    def list_targets(self) -> list[dict]:
        return [{"name": n, "type": "sonos"} for n in self._names]


class TestClassify:
    @pytest.mark.parametrize("code", ["800", "701", "714", "716"])
    def test_a_speaker_refusing_what_it_was_handed_reads_as_rejected(self, code):
        # 800 is the one this was written for: a Sonos vendor fault, in
        # practice "I won't play that", raised for the .m3u playlist file
        # a station was published as (see core/playlist_url.py).
        assert classify_delivery_error(_upnp(code)) == REASON_REJECTED

    def test_a_speaker_already_busy_is_told_apart(self):
        assert classify_delivery_error(_upnp("715")) == REASON_BUSY

    def test_an_unmapped_upnp_code_falls_back_to_unknown(self):
        # A fault code nobody has hit yet must not be guessed at - it still
        # carries its own text through as `detail`, which is no worse than
        # what every failure used to show.
        assert classify_delivery_error(_upnp("402")) == REASON_UNKNOWN

    @pytest.mark.parametrize(
        "error", [ConnectionError("refused"), TimeoutError("timed out"), OSError("no route")]
    )
    def test_a_speaker_that_never_answered_reads_as_unreachable(self, error):
        assert classify_delivery_error(error) == REASON_UNREACHABLE

    def test_anything_else_is_unknown(self):
        assert classify_delivery_error(RuntimeError("boom")) == REASON_UNKNOWN


class TestDeviceLabel:
    def test_names_a_single_speaker_the_way_a_listener_knows_it(self):
        assert device_label(_FakeDelivery("Arbeitszimmer")) == "Arbeitszimmer"

    def test_names_every_speaker_in_a_group(self):
        # manager.play() raises the first failure without saying which
        # device it came from, so naming one would be a guess.
        assert device_label(_FakeManager(["room A", "room B"])) == "room A, room B"

    def test_falls_back_to_the_objects_own_text_for_anything_else(self):
        assert device_label("plain-target") == "plain-target"


class TestResponse:
    def test_carries_the_reason_the_device_and_the_raw_text(self):
        response = delivery_error_response(_upnp("800"), _FakeDelivery("Arbeitszimmer"))
        assert response == {
            "error": "delivery_failed",
            "reason": REASON_REJECTED,
            "device": "Arbeitszimmer",
            "detail": "UPnP Error 800 received:  from 10.2.2.112",
        }

    def test_falls_back_to_the_exception_type_when_it_carries_no_message(self):
        # `detail` is what someone debugging reads; an empty string there
        # would be strictly worse than naming the exception class.
        response = delivery_error_response(RuntimeError(), _FakeDelivery("room A"))
        assert response["detail"] == "RuntimeError"


class TestTransportProblems:
    """A device that accepted what it was given and then reported, on its
    own event channel, that it isn't playing it — see routes/upnp.py."""

    @pytest.mark.parametrize(
        ("problem", "expected"),
        [
            # Both seen in practice: a format the speaker won't decode, and
            # an https URL on someone else's host (reported for a plain
            # MP3, so not a format problem at all).
            ("ERROR_UNSUPPORTED_FORMAT", REASON_REJECTED),
            ("ERROR_ACCESS_DENIED", REASON_REJECTED),
            ("ERROR_CANT_REACH_SERVER", REASON_UNREACHABLE),
            ("ERROR_CONNECT_FAILED", REASON_UNREACHABLE),
            ("ERROR_SOMETHING_NEW", REASON_UNKNOWN),
        ],
    )
    def test_classifies_a_transport_status(self, problem, expected):
        assert classify_transport_problem(problem) == expected

    def test_reads_the_status_out_of_the_devices_own_longer_description(self):
        # problem_in() appends the device's description after ": ".
        problem = "ERROR_UNSUPPORTED_FORMAT: 8,0,OWR.aac,streamtheworld.com,https://...,,0"
        assert classify_transport_problem(problem) == REASON_REJECTED

    def test_builds_the_same_body_a_raised_failure_does(self):
        problem = "ERROR_ACCESS_DENIED: 4,0,OWR_DAB.mp3"
        response = transport_error_response(problem, _FakeDelivery("Arbeitszimmer"))
        assert response == {
            "error": "delivery_failed",
            "reason": REASON_REJECTED,
            "device": "Arbeitszimmer",
            "detail": problem,
        }
