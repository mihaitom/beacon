"""Tests for casting with transitions on (routes/mix_cast.py and its hooks
in routes/playback.py and routes/stream.py).

The mix itself is core/mix_engine.py's and is tested there. What matters
here is the session around it: that a mix is set up only when asked for,
that the clock counts stream time and the position is mapped back to a
song, that song changes are followed and the end is reported, and that
anything done by hand starts a new mix.

Decks are replaced with silent stand-ins: nothing here may start ffmpeg.
"""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

import core.mix_engine as me
from core.mix_engine import MixEngine, MixItem
from core.mix_timeline import SAMPLE_RATE
from core.session import build_status_dict, compute_position
from core.streamer import REASON_TRANSITIONS, resolve_mix_format
from delivery import ChromecastDelivery
from media import Track
from routes import mix_cast
from routes.playback import _finish_orphaned_track, _resync_position_once
from routes.stream import _resume_after_interruption, advance_now

SR = SAMPLE_RATE
TRACKS = {
    str(i): Track(id=str(i), title=f"Song {i}", artist="Artist", duration=180, album="Album")
    for i in range(1, 5)
}
GAPLESS = {"mode": "gapless", "crossfade_seconds": 10}


class SilentDeck:
    """A deck whose decoder never delivers - enough for everything here."""

    def __init__(self, item, start, url_fn=None):
        self.item = item
        self.start = start
        self.produced = False
        self.decoder_done = False
        self.closed = False

    @property
    def position(self):
        return self.start

    @property
    def finished(self):
        return False

    @property
    def available(self):
        return 0

    def discard(self, frames):
        pass

    def open(self):
        pass

    def close(self):
        self.closed = True

    def take(self, frames):
        return b""


@pytest.fixture(autouse=True)
def _silent_decks(monkeypatch):
    monkeypatch.setattr(me, "Deck", SilentDeck)


@pytest.fixture
def media(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    with (
        patch.object(default_session.media, "get_track", side_effect=lambda i: TRACKS[i]),
        patch.object(default_session.media, "get_stream_url", side_effect=lambda i: f"u/{i}"),
    ):
        yield
    default_session.stop_mix()


def _play(client, **extra):
    body = {
        "song_ids": ["1", "2", "3"],
        "target_name": "TV",
        "target_type": "chromecast",
        "transitions": GAPLESS,
        **extra,
    }
    return client.post("/play", json=body)


# ── /play ──────────────────────────────────────────────────────────────────


def test_without_transitions_no_mix_is_ever_made(client, default_session, media):
    for song, transitions in (("1", None), ("2", {"mode": "off"})):
        with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
            _play(client, song_ids=[song], transitions=transitions)
        assert default_session.state.mix is None
        assert play.await_args.args[4] == 180.0
        assert default_session.state.clock.resume_offset == 0.0


def test_with_transitions_one_endless_stream_is_dispatched(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        r = _play(client, start_position=30)
    assert r.json()["status"] == "playing"
    st = default_session.state
    assert st.mix is not None and st.mix.started
    assert st.mix.first.song_id == "1" and st.mix.start_position == 30
    url, *_rest = play.await_args.args
    # No length: the stream goes on with the queue.
    assert play.await_args.args[4] is None
    assert url.endswith(".aac")
    assert build_status_dict(default_session)["stream_info"]["transcode_reason"] == (
        REASON_TRANSITIONS
    )
    # The clock counts stream time from 0; the position is the song's.
    assert st.clock.elapsed() < 1.0
    assert compute_position(default_session) == pytest.approx(30, abs=1.0)


def test_the_first_song_plays_at_the_gain_it_was_sent_with(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        _play(client, gain=0.5, song_hints={"1": {"gain": 0.9}, "2": {"gain": 0.7}})
    st = default_session.state
    assert st.mix.first.gain == 0.5
    assert st.song_hints["2"]["gain"] == 0.7


def test_a_refused_dispatch_leaves_the_previous_mix_playing(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        _play(client)
    first = default_session.state.mix
    with patch.object(ChromecastDelivery, "play", new=AsyncMock(side_effect=OSError("gone"))):
        r = _play(client, song_ids=["3"])
    assert "error" in r.json()
    assert default_session.state.mix is first and not first.stopped


def test_a_new_play_ends_the_previous_mix(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        _play(client)
        first = default_session.state.mix
        _play(client, song_ids=["3"])
    assert first.stopped
    assert default_session.state.mix.first.song_id == "3"


def test_playing_without_transitions_after_a_mix_ends_it(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        _play(client)
        first = default_session.state.mix
        _play(client, song_ids=["3"], transitions=None)
    assert first.stopped and default_session.state.mix is None


def test_a_duplicate_play_keeps_the_mix_the_device_is_reading(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        _play(client)
        first = default_session.state.mix
        _play(client)
    play.assert_awaited_once()
    assert default_session.state.mix is first and not first.stopped


def test_a_paused_play_holds_the_mix_without_starting_it(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        _play(client, paused=True, start_position=42)
    play.assert_not_awaited()
    st = default_session.state
    assert not st.mix.started
    assert compute_position(default_session) == 42.0


# ── By hand: pause, resume, seek, skip, stop ───────────────────────────────


def test_pause_freezes_the_mix_at_its_stream_time(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        _play(client)
    with patch.object(ChromecastDelivery, "pause", new=AsyncMock()):
        client.post("/pause")
    st = default_session.state
    assert st.mix.paused
    # Stream time, not the song's position (which is 0 here as well): a
    # second at most, the startup delay the clock assumes for a new stream.
    assert st.clock.is_paused and st.clock.resume_offset <= 1.5


def test_resume_starts_a_new_mix_where_the_pause_was(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        _play(client, paused=True, start_position=42)
        first = default_session.state.mix
        client.post("/resume")
    play.assert_awaited_once()
    st = default_session.state
    assert first.stopped
    assert st.mix.first.song_id == "1" and st.mix.start_position == 42.0
    assert st.mix.started and not st.clock.is_paused


def test_seek_starts_a_new_mix_from_the_same_song(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        _play(client)
        first = default_session.state.mix
        r = client.post("/seek", json={"position": 99})
    assert r.json() == {"position": 99}
    assert play.await_count == 2
    assert first.stopped
    assert default_session.state.mix.start_position == 99


def test_seek_while_paused_stays_paused(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        _play(client, paused=True)
        client.post("/seek", json={"position": 60})
    play.assert_not_awaited()
    st = default_session.state
    assert st.clock.is_paused
    assert compute_position(default_session) == 60.0


def test_stop_ends_the_mix(client, default_session, media):
    with (
        patch.object(ChromecastDelivery, "play", new=AsyncMock()),
        patch.object(ChromecastDelivery, "stop", new=AsyncMock()),
    ):
        _play(client)
        mix = default_session.state.mix
        client.post("/stop")
    assert mix.stopped and default_session.state.mix is None


def test_a_queue_edit_reaches_the_mix(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        _play(client)
    with patch.object(MixEngine, "queue_changed") as changed:
        client.post(
            "/queue",
            json={"song_ids": ["1", "3"], "queue_index": 0, "song_hints": {"3": {"gain": 0.8}}},
        )
    changed.assert_called_once()
    assert default_session.state.song_hints["3"]["gain"] == 0.8


async def test_a_party_skip_starts_a_new_mix_at_the_next_song(default_session):
    st = default_session.state
    st.queue, st.queue_index, st.is_streaming = ["1", "2"], 0, True
    st.active_delivery = ChromecastDelivery("TV")
    st.mix = MixEngine(MixItem("1", 0, payload=TRACKS["1"]), 0.0, AsyncMock(), AsyncMock())
    with (
        patch.object(default_session.media, "get_track", side_effect=lambda i: TRACKS[i]),
        patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play,
    ):
        assert await advance_now(default_session)
    play.assert_awaited_once()
    assert st.mix.first.song_id == "2" and st.queue_index == 1
    default_session.stop_mix()


async def test_resuming_after_an_interruption_starts_where_it_stopped(default_session):
    st = default_session.state
    st.active_delivery = ChromecastDelivery("TV")
    st.current_track = TRACKS["1"]
    st.queue = ["1", "2"]
    mix = MixEngine(MixItem("1", 0, payload=TRACKS["1"]), 10.0, AsyncMock(), AsyncMock())
    st.mix = mix
    st.clock.start(0.0)
    st.clock.pause(5.0)
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()) as play:
        assert await _resume_after_interruption(default_session)
    play.assert_awaited_once()
    assert mix.stopped
    assert st.mix.start_position == pytest.approx(15.0)
    default_session.stop_mix()


# ── The stream and the clock ───────────────────────────────────────────────


def test_a_device_connecting_is_served_the_mix(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        _play(client)
    default_session.state.clock.resume_offset = 3.0

    async def fake_mix_audio(mix, start_time, fmt):
        assert start_time == 3.0
        yield b"mixed"

    with (
        patch("routes.stream.stream_tracks") as single_song,
        patch.object(mix_cast, "mix_audio", side_effect=fake_mix_audio),
    ):
        r = client.get(f"/stream/{default_session.session_id}")
    assert r.content == b"mixed"
    single_song.assert_not_called()


def test_the_position_is_mapped_through_the_timeline(default_session):
    st = default_session.state
    mix = MixEngine(MixItem("1", 0), 50.0, AsyncMock(), AsyncMock())
    mix.timeline.mark(10 * SR, "2", 1, 0.0, playing=True)
    st.mix, st.is_streaming, st.current_track = mix, True, TRACKS["2"]
    st.clock.start(12.0)
    assert compute_position(default_session) == pytest.approx(2.0, abs=0.2)
    st.clock.start(4.0)
    st.current_track = TRACKS["1"]
    assert compute_position(default_session) == pytest.approx(54.0, abs=0.2)


async def test_a_device_position_past_the_song_is_not_ignored_in_a_mix(default_session):
    """A mix's device position is the whole stream's - long past the song
    it started on."""
    st = default_session.state
    st.is_streaming, st.current_track = True, TRACKS["1"]
    st.mix = MixEngine(MixItem("1", 0), 0.0, AsyncMock(), AsyncMock())
    st.clock.start(0.0)
    st.clock.play_start_time -= 400.0  # 400s into the stream
    device = ChromecastDelivery("TV")
    st.active_delivery = device
    with patch.object(device, "get_position", new=AsyncMock(return_value=405.0)):
        await _resync_position_once(default_session, device, st.clock.play_generation)
    assert st.clock.position_offset == pytest.approx(5.0, abs=0.5)


async def test_a_mix_is_never_closed_out_as_an_orphaned_song(default_session):
    st = default_session.state
    st.is_streaming, st.current_track = True, TRACKS["1"]
    st.mix = MixEngine(MixItem("1", 0), 0.0, AsyncMock(), AsyncMock())
    st.clock.start(0.0)
    st.clock.play_start_time -= 1000.0  # far past the first song's 180s
    assert not await _finish_orphaned_track(default_session, st.clock.play_generation)
    assert st.is_streaming


# ── Following the mix ──────────────────────────────────────────────────────


async def test_follow_moves_the_session_on_when_the_next_song_is_heard(default_session):
    st = default_session.state
    st.queue, st.queue_index, st.is_streaming = ["1", "2"], 0, True
    st.current_track = TRACKS["1"]
    first, second = MixItem("1", 0, payload=TRACKS["1"]), MixItem("2", 1, 0.6, payload=TRACKS["2"])
    mix = MixEngine(first, 0.0, AsyncMock(), AsyncMock())
    mix.timeline.mark(int(0.1 * SR), "2", 1, 0.0, playing=True, payload=second)
    st.mix = mix
    st.clock.start(0.0)
    events = default_session.event_bus.subscribe()
    task = asyncio.create_task(mix_cast.follow(default_session, mix))
    async with asyncio.timeout(3):
        while st.current_track is not TRACKS["2"]:
            await asyncio.sleep(0.02)
    assert st.queue_index == 1 and st.current_track_gain == 0.6
    assert not events.empty()
    st.mix = None
    task.cancel()


async def test_follow_reports_the_end_of_the_mix(default_session):
    st = default_session.state
    st.is_streaming, st.current_track = True, TRACKS["1"]
    mix = MixEngine(MixItem("1", 0, payload=TRACKS["1"]), 0.0, AsyncMock(), AsyncMock())
    mix.timeline.mark_end(int(0.05 * SR))
    st.mix = mix
    st.clock.start(0.0)
    async with asyncio.timeout(3):
        await mix_cast.follow(default_session, mix)
    assert not st.is_streaming and st.track_ended


async def test_follow_applies_a_change_it_slept_past(default_session):
    """A change the clock is already beyond (a stalled loop) is still
    applied, not skipped over for the one after it."""
    st = default_session.state
    st.queue, st.is_streaming = ["1", "2", "3"], True
    second = MixItem("2", 1, payload=TRACKS["2"])
    third = MixItem("3", 2, payload=TRACKS["3"])
    mix = MixEngine(MixItem("1", 0, payload=TRACKS["1"]), 0.0, AsyncMock(), AsyncMock())
    mix.timeline.mark(SR, "2", 1, 0.0, playing=True, payload=second)
    mix.timeline.mark(600 * SR, "3", 2, 0.0, playing=True, payload=third)
    st.mix = mix
    st.clock.start(5.0)
    task = asyncio.create_task(mix_cast.follow(default_session, mix))
    async with asyncio.timeout(3):
        while st.current_track is not TRACKS["2"]:
            await asyncio.sleep(0.02)
    st.mix = None
    task.cancel()


# ── The next song ──────────────────────────────────────────────────────────


async def _next(session, current, **state):
    for key, value in state.items():
        setattr(session.state, key, value)
    with patch.object(session.media, "get_track", side_effect=lambda i: TRACKS[i]):
        return await mix_cast.next_item(session, current)


async def test_the_next_song_follows_the_queue(default_session):
    item = await _next(default_session, MixItem("1", 0), queue=["1", "2"])
    assert (item.song_id, item.queue_index, item.payload) == ("2", 1, TRACKS["2"])


async def test_the_next_song_is_found_after_the_queue_was_rearranged(default_session):
    item = await _next(default_session, MixItem("2", 1), queue=["3", "4", "2", "1"])
    assert (item.song_id, item.queue_index) == ("1", 3)


async def test_repeat_one_plays_the_same_song_again(default_session):
    current = MixItem("1", 0)
    assert await _next(default_session, current, queue=["1", "2"], repeat_mode="one") is current


async def test_repeat_all_starts_the_queue_over(default_session):
    item = await _next(default_session, MixItem("2", 1), queue=["1", "2"], repeat_mode="all")
    assert (item.song_id, item.queue_index) == ("1", 0)


async def test_the_end_of_the_queue_ends_the_mix(default_session):
    item = await _next(
        default_session,
        MixItem("2", 1),
        queue=["1", "2"],
        repeat_mode="off",
        autoplay_enabled=False,
    )
    assert item is None


async def test_the_next_song_carries_its_hint(default_session):
    default_session.state.song_hints = {"2": {"gain": 0.4, "album_id": "al", "track": 2}}
    item = await _next(default_session, MixItem("1", 0), queue=["1", "2"])
    assert (item.gain, item.album_id, item.track) == (0.4, "al", 2)


# ── The format ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("codecs", "ceiling", "flac_ok", "content_type"),
    [
        (frozenset({"mp3", "aac", "flac"}), None, False, "audio/aac"),
        (frozenset({"mp3", "flac"}), None, False, "audio/mpeg"),
        (frozenset({"mp3", "aac", "flac"}), None, True, "audio/flac"),
        (frozenset({"mp3", "aac"}), None, True, "audio/aac"),
        (frozenset({"mp3", "aac", "flac"}), ("mp3", 128), True, "audio/mpeg"),
        (frozenset({"mp3", "aac", "flac", "opus"}), ("opus", 96), True, "audio/ogg"),
    ],
)
def test_the_mix_goes_out_in_what_the_device_plays(codecs, ceiling, flac_ok, content_type):
    fmt = resolve_mix_format(None, codecs, *(ceiling or (None, None)), continuous_flac=flac_ok)
    assert fmt.content_type == content_type
    assert fmt.transcode_reason == REASON_TRANSITIONS


def test_an_endless_mp3_carries_no_length_header():
    fmt = resolve_mix_format(None, frozenset({"mp3"}), None, None, continuous_flac=False)
    assert fmt.ffmpeg_args[fmt.ffmpeg_args.index("-write_xing") + 1] == "0"


def test_the_crossfade_setting_reaches_this_run_and_the_next(client, default_session, media):
    crossfade = {"mode": "crossfade", "crossfade_seconds": 16}
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        _play(client, transitions=crossfade)
        assert default_session.state.mix.settings.mode == "crossfade"
        assert default_session.state.mix.settings.crossfade_seconds == 16
        client.post("/seek", json={"position": 10})
    # A seek starts a new run, with the setting the /play brought.
    assert default_session.state.mix.settings.crossfade_seconds == 16


def test_gapless_runs_on_the_bit_exact_path(client, default_session, media):
    with patch.object(ChromecastDelivery, "play", new=AsyncMock()):
        _play(client)
    assert default_session.state.mix.settings.mode == "gapless"
    assert not default_session.state.mix._dsp


async def test_a_device_joining_a_mix_narrows_the_encode_for_the_whole_set(default_session):
    from delivery import AirPlayDelivery
    from routes.join import _refit_output_format

    st = default_session.state
    st.current_track = TRACKS["1"]
    st.active_delivery = ChromecastDelivery("TV")
    st.mix = MixEngine(MixItem("1", 0), 0.0, AsyncMock(), AsyncMock())
    st.current_output_format = mix_cast.mix_output_format(default_session, st.active_delivery, None)
    assert st.current_output_format.content_type == "audio/aac"

    assert await _refit_output_format(default_session, AirPlayDelivery("Kitchen"))
    assert st.current_output_format.content_type == "audio/mpeg"
    assert st.current_output_format.transcode_reason == REASON_TRANSITIONS
