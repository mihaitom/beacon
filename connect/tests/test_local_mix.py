"""Tests for transitions in Beacon's own player: core/local_mixes.py and
routes/local_mix.py. The mix itself is core/mix_engine.py's and tested
there; decks are silent stand-ins here, so nothing starts ffmpeg."""

import time
from typing import ClassVar
from unittest.mock import patch

import pytest

import core.mix_engine as me
from core import local_mixes
from core.local_mixes import LocalMix, SongEntry
from core.mix_engine import MixEngine, MixItem
from routes import local_mix as routes

from .test_mix_cast import SilentDeck

PLAYER = "tab-abc123"
GAPLESS = {"mode": "gapless", "crossfade_seconds": 10}


@pytest.fixture(autouse=True)
def _silent_decks(monkeypatch):
    monkeypatch.setattr(me, "Deck", SilentDeck)
    yield
    local_mixes.stop_all()


@pytest.fixture
def configured(client, default_session):
    client.post("/config", json={"url": "http://nav:4533", "credential": "x"})
    with patch.object(default_session.media, "get_stream_url", side_effect=lambda i: f"u/{i}"):
        yield client


def _songs(*ids, start=0):
    return [{"id": i, "queue_index": start + n, "duration": 200} for n, i in enumerate(ids)]


def _start(client, *ids, **extra):
    body = {"songs": _songs(*ids), "transitions": GAPLESS, **extra}
    return client.post(f"/stream/local/mix/{PLAYER}", json=body)


def test_starting_a_mix_answers_its_run_and_timeline(configured, default_session):
    r = _start(configured, "a", "b", position=30)
    body = r.json()
    assert body["timeline"][0]["song_id"] == "a"
    assert body["timeline"][0]["position"] == 30
    assert body["next_committed"] is False
    mix = local_mixes.get(default_session.session_id, PLAYER)
    assert mix.engine.epoch == body["epoch"] and mix.engine.started


def test_starting_again_replaces_the_previous_run(configured, default_session):
    first = _start(configured, "a").json()["epoch"]
    old = local_mixes.get(default_session.session_id, PLAYER).engine
    second = _start(configured, "b").json()["epoch"]
    assert first != second and old.stopped
    r = configured.get(f"/stream/local/mix/{PLAYER}/timeline", params={"epoch": first})
    assert r.status_code == 410


def test_a_player_id_is_checked(configured):
    r = configured.post(
        "/stream/local/mix/a.b", json={"songs": _songs("a"), "transitions": GAPLESS}
    )
    assert r.status_code == 400
    assert configured.delete("/stream/local/mix/x").status_code == 400


def test_the_queue_update_reaches_the_mix(configured, default_session):
    _start(configured, "a", "b")
    with patch.object(MixEngine, "queue_changed") as changed:
        r = configured.put(
            f"/stream/local/mix/{PLAYER}/queue",
            json={"songs": _songs("a", "c"), "repeat_mode": "all"},
        )
    assert r.json() == {"status": "ok"}
    changed.assert_called_once()
    mix = local_mixes.get(default_session.session_id, PLAYER)
    assert [s.id for s in mix.songs] == ["a", "c"] and mix.repeat_mode == "all"


@pytest.fixture
def waveforms():
    # 200 s songs: 2/3 s a peak, loud for 20 s from 100 s.
    loud = [0.0] * 300
    loud[150:180] = [1.0] * 30
    with patch("core.waveform.get_waveform", return_value=loud) as get:
        yield get


def _preview(client, *ids, index=0):
    body = {"songs": _songs(*ids), "index": index}
    return client.post(f"/stream/local/preview/{PLAYER}", json=body)


def test_a_preview_plays_the_loudest_stretch_of_each_song(configured, default_session, waveforms):
    _start(configured, "x")
    old = local_mixes.get(default_session.session_id, PLAYER).engine
    body = _preview(configured, "a", "b", "c", index=1).json()
    assert old.stopped
    # Its timeline says where in the song, read like a mix's.
    assert body["timeline"][0]["song_id"] == "b"
    assert body["timeline"][0]["queue_index"] == 1
    assert body["timeline"][0]["position"] == pytest.approx(100.0)
    mix = local_mixes.get(default_session.session_id, PLAYER)
    assert mix.preview and mix.engine.settings.preview
    assert (mix.engine.first.start, mix.engine.first.end) == pytest.approx((100.0, 120.0))
    waveforms.assert_any_call("b", "u/b")


def test_a_preview_ignores_the_queue_and_checks_its_index(configured, default_session, waveforms):
    _preview(configured, "a", "b")
    with patch.object(MixEngine, "queue_changed") as changed:
        r = configured.put(f"/stream/local/mix/{PLAYER}/queue", json={"songs": _songs("z")})
    assert r.json() == {"status": "ok"}
    changed.assert_not_called()
    assert _preview(configured, "a", index=3).status_code == 400
    assert (
        configured.post("/stream/local/preview/a.b", json={"songs": _songs("a")}).status_code == 400
    )


def test_pause_and_resume_freeze_the_mix(configured, default_session):
    _start(configured, "a")
    engine = local_mixes.get(default_session.session_id, PLAYER).engine
    configured.post(f"/stream/local/mix/{PLAYER}/pause")
    assert engine.paused
    configured.post(f"/stream/local/mix/{PLAYER}/resume")
    assert not engine.paused


def test_a_mix_loaded_without_playing_stands_still(configured, default_session):
    _start(configured, "a", paused=True)
    engine = local_mixes.get(default_session.session_id, PLAYER).engine
    assert engine.paused
    configured.post(f"/stream/local/mix/{PLAYER}/resume")
    assert not engine.paused


def test_stop_ends_the_mix(configured, default_session):
    _start(configured, "a")
    engine = local_mixes.get(default_session.session_id, PLAYER).engine
    configured.delete(f"/stream/local/mix/{PLAYER}")
    assert engine.stopped and local_mixes.get(default_session.session_id, PLAYER) is None


def test_the_audio_is_served_from_the_stream_time_asked_for(configured, default_session):
    epoch = _start(configured, "a").json()["epoch"]

    async def fake(mix, start_time, fmt):
        assert start_time == 12.5
        assert fmt.content_type == "audio/flac"
        yield b"mixed"

    with patch.object(routes, "mix_audio", side_effect=fake):
        r = configured.get(
            f"/stream/local/mix/{PLAYER}/audio",
            params={"epoch": epoch, "from": 12.5, "fmt": "flac"},
        )
    assert r.content == b"mixed"


def test_a_byte_resume_of_the_audio_is_refused(configured):
    """Chromium reopens a dropped stream's URL from the byte it got to; the
    URL says `from`, so serving it would replay the run from there - from
    its first song, for the opening URL. Refused, the player reconnects by
    stream time."""
    epoch = _start(configured, "a").json()["epoch"]
    with patch.object(routes, "mix_audio") as audio:
        r = configured.get(
            f"/stream/local/mix/{PLAYER}/audio",
            params={"epoch": epoch, "from": 0, "fmt": "flac"},
            headers={"Range": "bytes=201814-"},
        )
    assert r.status_code == 416
    audio.assert_not_called()


def test_the_elements_opening_range_is_served(configured):
    epoch = _start(configured, "a").json()["epoch"]

    async def fake(mix, start_time, fmt):
        yield b"mixed"

    with patch.object(routes, "mix_audio", side_effect=fake):
        r = configured.get(
            f"/stream/local/mix/{PLAYER}/audio",
            params={"epoch": epoch, "from": 0, "fmt": "flac"},
            headers={"Range": "bytes=0-"},
        )
    assert r.status_code == 200 and r.content == b"mixed"


@pytest.mark.parametrize(("fmt", "br"), [("wav", None), ("mp3", 999), ("flac", 128), ("aac", None)])
def test_only_the_formats_a_transcode_allows_are_encoded(configured, fmt, br):
    epoch = _start(configured, "a").json()["epoch"]
    params = {"epoch": epoch, "fmt": fmt, **({"br": br} if br else {})}
    assert configured.get(f"/stream/local/mix/{PLAYER}/audio", params=params).status_code == 400


def test_an_old_run_is_not_served(configured):
    _start(configured, "a")
    r = configured.get(f"/stream/local/mix/{PLAYER}/audio", params={"epoch": "old", "fmt": "flac"})
    assert r.status_code == 410


def test_an_endless_mp3_carries_no_length_header():
    args, _ = routes.output_args("mp3", 320)
    assert args[args.index("-write_xing") + 1] == "0"


# ── The next song ──────────────────────────────────────────────────────────


def _local(*entries, repeat_mode="off") -> LocalMix:
    return LocalMix("s", "p", None, list(entries), repeat_mode)


def test_the_next_song_is_the_one_after_the_current_in_the_list():
    mix = _local(SongEntry("a", 0), SongEntry("b", 1, gain=0.5), SongEntry("c", 2))
    nxt = mix.next_item(MixItem("b", 1))
    assert (nxt.song_id, nxt.queue_index) == ("c", 2)
    assert mix.next_item(MixItem("a", 0)).gain == 0.5


def test_the_list_may_start_before_where_the_mix_already_is():
    """The tab sends its list from the song it hears; the mix renders ahead
    and may already be on the next one."""
    mix = _local(SongEntry("a", 4), SongEntry("b", 5), SongEntry("c", 6))
    assert mix.next_item(MixItem("b", 5)).song_id == "c"


def test_repeat_all_wrap_is_the_tabs_list_order():
    mix = _local(SongEntry("c", 2), SongEntry("a", 0))
    assert mix.next_item(MixItem("c", 2)).queue_index == 0


def test_repeat_one_plays_the_song_again():
    current = MixItem("a", 0)
    assert _local(SongEntry("a", 0), repeat_mode="one").next_item(current) is current


def test_a_queue_edit_that_moves_the_current_song_keeps_the_mix_going():
    """A removal before the current song shifts its queue_index while its
    deck still carries the old one."""
    mix = _local(SongEntry("b", 1), SongEntry("c", 2))
    nxt = mix.next_item(MixItem("b", 2))
    assert (nxt.song_id, nxt.queue_index) == ("c", 2)


def test_a_song_queued_twice_follows_from_the_nearer_place():
    mix = _local(SongEntry("a", 0), SongEntry("x", 1), SongEntry("a", 7), SongEntry("y", 8))
    assert mix.next_item(MixItem("a", 6)).song_id == "y"
    assert mix.next_item(MixItem("a", 0)).song_id == "x"


def test_nothing_follows_the_end_of_the_list_or_a_song_it_lost():
    mix = _local(SongEntry("a", 0), SongEntry("b", 1))
    assert mix.next_item(MixItem("b", 1)) is None
    assert mix.next_item(MixItem("x", 9)) is None


# ── Housekeeping ───────────────────────────────────────────────────────────


async def _running(player="p1") -> LocalMix:
    async def url(item):
        return None

    return local_mixes.start("s", player, [SongEntry("a", 0)], 0, 0.0, "off", url, 20.0)


async def test_a_mix_nobody_asks_about_is_stopped():
    mix = await _running()
    now = time.monotonic()
    assert local_mixes.reap_once(now) == []
    assert local_mixes.reap_once(now + local_mixes.ORPHAN_SECONDS + 1) == [("s", "p1")]
    assert mix.engine.stopped


async def test_a_paused_mix_is_kept_far_longer():
    mix = await _running()
    mix.engine.freeze()
    later = time.monotonic() + local_mixes.ORPHAN_SECONDS + 1
    assert local_mixes.reap_once(later) == []
    assert local_mixes.reap_once(later + local_mixes.PAUSED_ORPHAN_SECONDS) == [("s", "p1")]


async def test_a_mix_being_listened_to_is_kept():
    mix = await _running()
    with patch.object(MixEngine, "listeners", new=1):
        assert local_mixes.reap_once(time.monotonic() + 10_000) == []
    assert not mix.engine.stopped


async def test_a_reaped_session_takes_its_players_mixes_with_it():
    one, two = await _running("p1"), await _running("p2")
    local_mixes.stop_session("s")
    assert one.engine.stopped and two.engine.stopped


def test_a_local_crossfade_mixes_in_floating_point(configured, default_session):
    _start(configured, "a", transitions={"mode": "crossfade", "crossfade_seconds": 6})
    engine = local_mixes.get(default_session.session_id, PLAYER).engine
    assert engine._dsp and engine.settings.crossfade_seconds == 6


class FakeHls:
    """Stands in for core/mix_hls.py's encode, which needs a real ffmpeg
    (tests/test_mix_hls.py runs that)."""

    made: ClassVar[list["FakeHls"]] = []

    def __init__(self, engine, fmt, codec_args):
        self.engine, self.fmt, self.codec_args = engine, fmt, codec_args
        self.packed = fmt == "mp3"
        self.closed = False
        self.failed = False
        FakeHls.made.append(self)

    def start(self):
        pass

    def close(self):
        self.closed = True

    async def wait_for_segments(self, count, timeout):
        pass

    def playlist(self, query):
        return f"#EXTM3U\n0.m4s?{query}\n"

    async def segment(self, index):
        return b"seg" if index == 0 else None


@pytest.fixture
def fake_hls(monkeypatch):
    FakeHls.made = []
    monkeypatch.setattr(local_mixes, "MixHls", FakeHls)
    return FakeHls.made


def test_webkit_gets_the_run_as_a_live_playlist(configured, fake_hls):
    epoch = _start(configured, "a").json()["epoch"]
    params = {"epoch": epoch, "fmt": "aac", "br": 192, "token": "t"}
    r = configured.get(f"/stream/local/mix/{PLAYER}/hls/index.m3u8", params=params)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/vnd.apple.mpegurl"
    assert "token=t" in r.text  # segment URIs carry the auth along
    assert configured.get(f"/stream/local/mix/{PLAYER}/hls/0.m4s", params=params).content == b"seg"
    assert configured.get(f"/stream/local/mix/{PLAYER}/hls/1.m4s", params=params).status_code == 404
    assert configured.get(f"/stream/local/mix/{PLAYER}/hls/0.mp3", params=params).status_code == 404
    # One encode for every request of the same quality.
    assert len(fake_hls) == 1


def test_another_quality_replaces_the_runs_encode(configured, default_session, fake_hls):
    epoch = _start(configured, "a").json()["epoch"]
    url = f"/stream/local/mix/{PLAYER}/hls/index.m3u8"
    configured.get(url, params={"epoch": epoch, "fmt": "aac", "br": 192})
    configured.get(url, params={"epoch": epoch, "fmt": "aac", "br": 128})
    assert [h.closed for h in fake_hls] == [True, False]
    configured.delete(f"/stream/local/mix/{PLAYER}")
    assert fake_hls[1].closed


def test_a_failed_encode_ends_the_run_so_the_tab_starts_over(configured, default_session, fake_hls):
    epoch = _start(configured, "a").json()["epoch"]
    params = {"epoch": epoch, "fmt": "aac", "br": 192}
    configured.get(f"/stream/local/mix/{PLAYER}/hls/index.m3u8", params=params)
    engine = local_mixes.get(default_session.session_id, PLAYER).engine
    fake_hls[0].failed = True
    r = configured.get(f"/stream/local/mix/{PLAYER}/timeline", params={"epoch": epoch})
    assert r.status_code == 410 and r.json()["detail"] == "No such mix"
    assert engine.stopped


def test_an_old_run_or_a_bad_format_gets_no_playlist(configured, fake_hls):
    epoch = _start(configured, "a").json()["epoch"]
    url = f"/stream/local/mix/{PLAYER}/hls/index.m3u8"
    assert configured.get(url, params={"epoch": "old", "fmt": "flac"}).status_code == 410
    assert configured.get(url, params={"epoch": epoch, "fmt": "wav"}).status_code == 400
    assert fake_hls == []
