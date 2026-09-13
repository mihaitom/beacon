"""Tests for routes/join.py — /join and /claim."""

from unittest.mock import AsyncMock, patch

import pytest

from delivery import (
    AirPlayDelivery,
    ChromecastDelivery,
    DeliveryManager,
    DlnaDelivery,
    SonosDelivery,
)

# ── /join ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def _streaming(default_session):
    default_session.state.is_streaming = True
    yield


def test_join_rejected_when_not_streaming(client, default_session):
    r = client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})
    assert "error" in r.json()


def test_join_chromecast_plays_and_sets_active(client, default_session, _streaming):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        r = client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    assert r.json()["status"] == "joined"
    play.assert_awaited_once()
    assert isinstance(default_session.state.active_delivery, ChromecastDelivery)
    assert default_session.state.active_delivery.target == "TV"


def test_join_releases_the_claim_when_the_device_fails_to_start(
    client, default_session, _streaming
):
    """Regression test: check_claims() grants the claim before play() is
    ever attempted — a device that then fails to actually start (offline,
    connection refused, ...) must not stay locked to this session
    (device_in_use for everyone else) with nothing actually playing on it,
    same as /play's own identical failure handling."""
    from core.claims import claims

    with patch.object(
        ChromecastDelivery, "play", new=AsyncMock(side_effect=RuntimeError("unreachable"))
    ):
        r = client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    # The same body /play answers with, so the app can name the speaker and
    # say what went wrong instead of showing the library's raw text.
    body = r.json()
    assert body["error"] == "delivery_failed"
    assert body["device"] == "TV"
    assert body["detail"] == "unreachable"
    assert claims.owner_of("chromecast", "TV") is None
    # Never actually joined — active_delivery must be left exactly as it
    # was before this call, not pointing at a device nothing is playing on.
    assert default_session.state.active_delivery is None


def test_join_airplay_plays_and_sets_active(client, default_session, _streaming):
    with patch.object(AirPlayDelivery, "play", new=AsyncMock()) as play:
        r = client.post("/join", json={"target_type": "airplay", "target_name": "HomePod"})

    assert r.json()["status"] == "joined"
    play.assert_awaited_once()
    assert isinstance(default_session.state.active_delivery, AirPlayDelivery)


def test_join_dlna_plays_and_sets_active(client, default_session, _streaming):
    with patch.object(DlnaDelivery, "play", new=AsyncMock()) as play:
        r = client.post("/join", json={"target_type": "dlna", "target_name": "Receiver"})

    assert r.json()["status"] == "joined"
    play.assert_awaited_once()
    assert isinstance(default_session.state.active_delivery, DlnaDelivery)
    assert default_session.state.active_delivery.target == "Receiver"


def test_join_chromecast_appends_to_existing_manager(client, default_session, _streaming):
    existing = AirPlayDelivery("HomePod")
    default_session.state.active_delivery = DeliveryManager.from_deliveries([existing])

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    mgr = default_session.state.active_delivery
    assert isinstance(mgr, DeliveryManager)
    assert len(mgr.deliveries) == 2
    assert any(isinstance(d, ChromecastDelivery) for d in mgr.deliveries)


def test_join_chromecast_promotes_single_active_to_manager(client, default_session, _streaming):
    default_session.state.active_delivery = AirPlayDelivery("HomePod")

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    mgr = default_session.state.active_delivery
    assert isinstance(mgr, DeliveryManager)
    assert {type(d) for d in mgr.deliveries} == {AirPlayDelivery, ChromecastDelivery}


def test_join_reserves_instead_of_dispatching_while_paused(client, default_session, _streaming):
    """None of these cast protocols has a "load without playing", so a device
    dispatched into a paused session starts making sound — the user's pause
    undone by adding a speaker, or by switching to one. Everything that
    starts playback again re-dispatches the whole target set anyway
    (/resume, /seek, /play), so the device only has to be *in* it by then."""
    from core.claims import claims

    default_session.state.clock.pause(42.0)

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        r = client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    assert r.json()["status"] == "reserved"
    play.assert_not_awaited()
    # Reserved means reserved: claimed, and part of the target set every
    # client's /status reports and the next /resume dispatches to.
    assert claims.owner_of("chromecast", "TV") == default_session.session_id
    assert isinstance(default_session.state.active_delivery, ChromecastDelivery)
    assert default_session.state.active_delivery.target == "TV"


def test_resume_dispatches_a_device_reserved_while_paused(client, default_session, _streaming):
    """The other half of the reservation: /resume replays active_delivery
    from scratch, which is what actually gets the reserved device playing.
    Without that, reserving would just be a device that never starts."""
    from media import SubsonicClient

    default_session.media = SubsonicClient("http://nav")
    default_session.state.clock.pause(42.0)

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})
        play.assert_not_awaited()
        r = client.post("/resume")

    assert r.json() == {"paused": False}
    play.assert_awaited_once()


def test_join_while_paused_keeps_an_existing_target(client, default_session, _streaming):
    existing = SonosDelivery("Kitchen")
    default_session.state.active_delivery = existing
    default_session.state.clock.pause(10.0)

    r = client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    assert r.json()["status"] == "reserved"
    active = default_session.state.active_delivery
    assert isinstance(active, DeliveryManager)
    assert [d.target for d in active.deliveries] == ["Kitchen", "TV"]


def test_join_matches_an_existing_target_on_type_as_well_as_name(
    client, default_session, _streaming
):
    """Two protocols can legitimately reach the same speaker under the same
    name, which is exactly why every device key in the frontend is
    `type:name`. Matching on the name alone silently dropped the second."""
    default_session.state.active_delivery = SonosDelivery("Kitchen")
    default_session.state.clock.pause(10.0)

    client.post("/join", json={"target_type": "airplay", "target_name": "Kitchen"})

    active = default_session.state.active_delivery
    assert isinstance(active, DeliveryManager)
    assert [type(d) for d in active.deliveries] == [SonosDelivery, AirPlayDelivery]


def test_join_does_not_add_the_same_target_twice(client, default_session, _streaming):
    default_session.state.active_delivery = ChromecastDelivery("TV")
    default_session.state.clock.pause(10.0)

    client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    assert isinstance(default_session.state.active_delivery, ChromecastDelivery)


def test_join_sonos_joins_the_existing_groups_coordinator(client, default_session, _streaming):
    """The success path test_join_sonos_falls_back_to_individual_play_when_
    group_fails below doesn't reach — that one fails resolving the
    coordinator itself, before ever getting to the new device's own lookup
    or the actual group .join() call this exercises."""
    from unittest.mock import MagicMock

    existing_sonos = SonosDelivery("Küche")
    default_session.state.active_delivery = existing_sonos
    coordinator_dev = MagicMock()
    joiner_dev = MagicMock()

    def _fake_get_device(self):
        return coordinator_dev if self.target == "Küche" else joiner_dev

    with patch.object(SonosDelivery, "_get_device", _fake_get_device):
        r = client.post("/join", json={"target_type": "sonos", "target_name": "Wohnzimmer"})

    assert r.json()["status"] == "joined"
    joiner_dev.join.assert_called_once_with(coordinator_dev)


def test_join_sonos_falls_back_to_individual_play_when_group_fails(
    client, default_session, _streaming
):
    existing_sonos = SonosDelivery("Küche")
    default_session.state.active_delivery = existing_sonos

    fallback = AsyncMock()
    with (
        patch.object(SonosDelivery, "_get_device", side_effect=RuntimeError("group failed")),
        patch.object(SonosDelivery, "play", new=fallback),
    ):
        r = client.post("/join", json={"target_type": "sonos", "target_name": "Wohnzimmer"})

    assert r.json()["status"] == "joined"
    fallback.assert_awaited_once()


def test_join_tells_a_late_device_the_stations_own_content_type(
    client, default_session, _streaming
):
    """A station probed as AAC when it started (see core/stream_format.py)
    has to be announced as AAC to every device that joins later too."""
    default_session.state.radio_info = {
        "title": "OWR International",
        "url": "http://stream/owr.aac",
        "content_type": "audio/aacp",
    }

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    play.assert_awaited_once_with(
        "http://stream/owr.aac", "OWR International", content_type="audio/aacp"
    )


def test_join_reconnects_to_radio_url_not_stream_proxy(client, default_session, _streaming):
    """Radio has no track loaded, so joining an additional device must reuse
    its own URL — the FFmpeg /stream proxy 204s with nothing to play."""
    default_session.state.radio_info = {"title": "Radio FM", "url": "http://stream/radio"}

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        r = client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    assert r.json()["status"] == "joined"
    # A station with no recorded type falls back to the extension guess,
    # which is exactly what every join did before this.
    play.assert_awaited_once_with("http://stream/radio", "Radio FM", content_type="audio/mpeg")


def test_join_sonos_without_existing_sonos_plays_individually(client, default_session, _streaming):
    default_session.state.active_delivery = None

    with patch.object(SonosDelivery, "play", new=AsyncMock()) as play:
        r = client.post("/join", json={"target_type": "sonos", "target_name": "Wohnzimmer"})

    assert r.json()["status"] == "joined"
    play.assert_awaited_once()


def test_join_rejected_when_target_claimed_by_another_session(client, _streaming):
    import asyncio

    from core.claims import claims

    asyncio.run(claims.claim("chromecast", "TV", "some-other-session"))

    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        r = client.post("/join", json={"target_type": "chromecast", "target_name": "TV"})

    body = r.json()
    assert body["error"] == "device_in_use"
    assert body["device"] == {"name": "TV", "type": "chromecast"}
    play.assert_not_awaited()


def test_join_with_force_displaces_other_sessions_claim(client, default_session, _streaming):
    import asyncio

    from core.claims import claims
    from core.session import registry

    other = asyncio.run(registry.get_or_create("some-other-session"))
    other.state.is_streaming = True
    other_delivery = ChromecastDelivery("TV")
    other.state.active_delivery = other_delivery
    asyncio.run(claims.claim("chromecast", "TV", "some-other-session"))

    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
        patch.object(ChromecastDelivery, "stop", new=AsyncMock()) as other_stop,
    ):
        r = client.post(
            "/join",
            json={"force": True, "target_type": "chromecast", "target_name": "TV"},
        )

    assert r.json()["status"] == "joined"
    play.assert_awaited_once()
    other_stop.assert_awaited_once()
    assert other.state.active_delivery is None
    assert other.state.is_streaming is False
    assert claims.owner_of("chromecast", "TV") == default_session.session_id
    assert isinstance(default_session.state.active_delivery, ChromecastDelivery)


# ── /claim ────────────────────────────────────────────────────────────────────


def test_claim_sets_active_delivery_without_starting_playback(client, default_session):
    from core.claims import claims

    r = client.post("/claim", json={"targets": [{"name": "TV", "type": "chromecast"}]})

    assert r.json()["status"] == "claimed"
    # resolve_target() always wraps a `targets` list in a DeliveryManager,
    # even for a single device.
    active = default_session.state.active_delivery
    assert isinstance(active, DeliveryManager)
    assert [d.target for d in active.deliveries] == ["TV"]
    assert isinstance(active.deliveries[0], ChromecastDelivery)
    # No playback started — /claim only reserves the device.
    assert default_session.state.is_streaming is False
    assert claims.owner_of("chromecast", "TV") == default_session.session_id


def test_claim_rejected_without_force_when_claimed_by_another_session(client, default_session):
    import asyncio

    from core.claims import claims

    asyncio.run(claims.claim("chromecast", "TV", "some-other-session"))

    r = client.post("/claim", json={"targets": [{"name": "TV", "type": "chromecast"}]})

    body = r.json()
    assert body["error"] == "device_in_use"
    assert body["device"] == {"name": "TV", "type": "chromecast"}


def test_claim_with_force_displaces_other_sessions_claim_and_stops_their_delivery(
    client, default_session
):
    import asyncio

    from core.claims import claims
    from core.session import registry

    other = asyncio.run(registry.get_or_create("some-other-session"))
    other.state.is_streaming = True
    other_delivery = ChromecastDelivery("TV")
    other.state.active_delivery = other_delivery
    asyncio.run(claims.claim("chromecast", "TV", "some-other-session"))

    with patch.object(ChromecastDelivery, "stop", new=AsyncMock()) as other_stop:
        r = client.post(
            "/claim",
            json={"force": True, "targets": [{"name": "TV", "type": "chromecast"}]},
        )

    assert r.json()["status"] == "claimed"
    other_stop.assert_awaited_once()
    assert other.state.active_delivery is None
    assert other.state.is_streaming is False
    assert claims.owner_of("chromecast", "TV") == default_session.session_id
    active = default_session.state.active_delivery
    assert isinstance(active, DeliveryManager)
    assert [d.target for d in active.deliveries] == ["TV"]
    assert default_session.state.is_streaming is False


def test_claim_returns_error_with_no_targets(client, default_session):
    r = client.post("/claim", json={"targets": []})
    assert "error" in r.json()


# ── /join re-resolves the stream for a stricter newcomer ────────────────────
# The format a session streams is resolved for the target set as it stood at
# /play. Until this existed nothing resolved it again, so a device joining a
# running cast got whatever the first one could take — measured live as a
# DLNA renderer capped at 48kHz joining a Chromecast that had been handed a
# 24/96 source untouched (see
# docs/investigations/multichannel-flac-silent-on-sonos.md).


@pytest.fixture
def _casting_a_track(default_session):
    """A session streaming a real track to a Chromecast, which is the
    permissive half of the pairing below: 96kHz/24-bit, so a high-res source
    reaches it on the copy tier with nothing changed."""
    from media import SubsonicClient
    from media.base import Track

    default_session.media = SubsonicClient("http://nav")
    default_session.state.current_track = Track("1", "Song", "Artist", 200, "")
    default_session.state.active_delivery = ChromecastDelivery("TV")
    default_session.state.clock.start(0.0)
    yield default_session


def _probing(codec="flac", sample_rate=96000, bit_depth=24, channels=2):
    from core.streamer import SourceInfo

    return patch(
        "core.streamer._probe_source",
        AsyncMock(
            return_value=SourceInfo(
                codec=codec,
                sample_rate=sample_rate,
                bit_depth=bit_depth,
                bitrate_kbps=None,
                duration=200.0,
                channels=channels,
            )
        ),
    )


def test_join_narrows_the_stream_for_a_stricter_device(client, _casting_a_track, _streaming):
    st = _casting_a_track.state
    st.current_output_format = __import__(
        "core.streamer", fromlist=["FALLBACK_FORMAT"]
    ).FALLBACK_FORMAT

    with _probing(), patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        with patch.object(DlnaDelivery, "play", new=AsyncMock()):
            r = client.post("/join", json={"target_type": "dlna", "target_name": "Beamer"})

    assert r.json()["status"] == "joined"
    # The DLNA renderer's own 48kHz ceiling now decides the stream, not the
    # Chromecast's 96kHz one.
    assert st.current_output_format.target_sample_rate == 48000
    assert "-ar" in st.current_output_format.ffmpeg_args


def test_join_re_dispatches_every_target_not_just_the_newcomer(
    client, _casting_a_track, _streaming
):
    """There is one ffmpeg per session and every device shares it, so a
    format that has to change cannot change for the joiner alone — the
    device already playing would carry on with the old encode."""
    with _probing():
        with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as cast_play:
            with patch.object(DlnaDelivery, "play", new=AsyncMock()) as dlna_play:
                client.post("/join", json={"target_type": "dlna", "target_name": "Beamer"})

    cast_play.assert_awaited()
    dlna_play.assert_awaited()


def test_join_leaves_the_stream_alone_when_the_newcomer_adds_no_constraint(
    client, _casting_a_track, _streaming
):
    """The ordinary join, and the reason the probe is skipped rather than
    run and discarded: a second device no stricter than the first cannot
    change the answer, so nothing is re-resolved and nothing already
    playing is interrupted."""
    st = _casting_a_track.state
    st.active_delivery = DlnaDelivery("Beamer")
    before = st.current_output_format

    with patch("core.streamer._probe_source", new=AsyncMock()) as probe:
        with patch.object(SonosDelivery, "play", new=AsyncMock()):
            r = client.post("/join", json={"target_type": "sonos", "target_name": "Kitchen"})

    assert r.json()["status"] == "joined"
    probe.assert_not_awaited()
    assert st.current_output_format is before


def test_join_while_paused_still_narrows_the_format_for_the_next_resume(
    client, _casting_a_track, _streaming
):
    """The reservation path dispatches nothing, but /resume replays the set
    using whatever format is on the session by then — so the refit has to
    have happened even though no device was touched here."""
    st = _casting_a_track.state
    st.clock.pause(42.0)

    with _probing():
        with patch.object(DlnaDelivery, "play", new=AsyncMock()) as dlna_play:
            r = client.post("/join", json={"target_type": "dlna", "target_name": "Beamer"})

    assert r.json()["status"] == "reserved"
    dlna_play.assert_not_awaited()
    assert st.current_output_format.target_sample_rate == 48000


def test_join_puts_everything_back_when_the_re_dispatch_fails(client, _casting_a_track, _streaming):
    """Unlike the ordinary join, this path commits the target set and the
    format *before* dispatching, because the dispatch needs both — so a
    failure has to undo them as well as release the claim.

    Every target is failed deliberately: DeliveryManager.play() re-raises
    only when all of them did, treating a partial failure as a dispatch
    that did start somewhere (see its own comment, and
    docs/investigations/multi-target-partial-drop-not-surfaced.md)."""
    from core.claims import claims

    st = _casting_a_track.state
    before_format = st.current_output_format
    before_delivery = st.active_delivery
    dead = AsyncMock(side_effect=OSError("gone"))

    with _probing():
        with patch.object(ChromecastDelivery, "play", new=dead):
            with patch.object(DlnaDelivery, "play", new=dead):
                r = client.post("/join", json={"target_type": "dlna", "target_name": "Beamer"})

    assert "error" in r.json()
    assert st.current_output_format is before_format
    assert st.active_delivery is before_delivery
    assert claims.owner_of("dlna", "Beamer") is None


def test_join_does_not_probe_for_radio(client, _casting_a_track, _streaming):
    """Radio has no resolved output format at all — it joins on the
    station's own URL rather than the /stream proxy."""
    st = _casting_a_track.state
    st.radio_info = {"title": "Station", "url": "http://station/live", "content_type": "audio/mpeg"}

    with patch("core.streamer._probe_source", new=AsyncMock()) as probe:
        with patch.object(DlnaDelivery, "play", new=AsyncMock()):
            client.post("/join", json={"target_type": "dlna", "target_name": "Beamer"})

    probe.assert_not_awaited()
