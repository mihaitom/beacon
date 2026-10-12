"""Tests for core/mix_engine.py — songs into one continuous stream.

Decks are fakes holding known PCM and the clock is a fake too, so every
assertion is about exact frames. One test at the end runs real ffmpeg
decoders, for the part a fake cannot answer: that a song split across two
files comes back out of the mix without a gap.
"""

import asyncio
import shutil
import subprocess
import wave

import numpy as np
import pytest

import core.mix_engine as me
from core.mix_engine import MixEngine, MixItem, apply_gain
from core.mix_timeline import SAMPLE_RATE

SR = SAMPLE_RATE


def _pcm(frames: int, start: int = 0) -> bytes:
    """Stereo s16le whose samples count up, so any lost or doubled frame
    shows."""
    values = (np.arange(start, start + frames, dtype=np.int64) % 30000).astype("<i2")
    return np.repeat(values, 2).tobytes()


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class FakeDeck:
    def __init__(self, item: MixItem, start: float, pcm: bytes, arrived: bool) -> None:
        self.item = item
        self.start = start
        self._pending = pcm
        self._buf = bytearray(pcm if arrived else b"")
        if arrived:
            self._pending = b""
        self.produced = arrived and bool(pcm)
        self.decoder_done = arrived
        self._consumed = 0
        self.closed = False

    def arrive(self) -> None:
        self._buf += self._pending
        self.produced = self.produced or bool(self._pending)
        self._pending = b""
        self.decoder_done = True

    @property
    def position(self) -> float:
        return self.start + self._consumed / SR

    @property
    def finished(self) -> bool:
        return self.decoder_done and not self._buf

    @property
    def available(self) -> int:
        return len(self._buf) // 4

    def discard(self, frames: int) -> None:
        drop = min(frames * 4, len(self._buf))
        del self._buf[:drop]
        self._consumed += frames

    def open(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True

    def take(self, frames: int) -> bytes:
        n = min(frames * 4, len(self._buf))
        out = bytes(self._buf[:n])
        del self._buf[:n]
        self._consumed += n // 4
        return out


class Rig:
    def __init__(self, songs: dict[str, bytes], order: list[str], lead: float = 2.0, **kw):
        self.songs = songs
        self.order = order
        self.slow: set[str] = set()
        self.decks: list[FakeDeck] = []
        self.clock = FakeClock()
        self.items = {
            sid: MixItem(sid, i, duration=len(songs[sid]) / 4 / SR) for i, sid in enumerate(order)
        }
        self.items.update(kw.pop("items", {}))
        self.engine = MixEngine(
            self.items[order[0]],
            kw.pop("position", 0.0),
            self._url,
            self._next,
            lead_seconds=lead,
            clock=self.clock,
            deck_factory=self._deck,
            **kw,
        )

    async def _url(self, item):
        return item.song_id

    async def _next(self, current: MixItem):
        i = current.queue_index + 1
        if i >= len(self.order):
            return None
        return self.items[self.order[i]]

    def _deck(self, item, start):
        deck = FakeDeck(item, start, self.songs[item.song_id], item.song_id not in self.slow)
        self.decks.append(deck)
        return deck

    async def run(self, steps: int = 20, advance: float = 0.0) -> None:
        for _ in range(steps):
            self.engine.step()
            await asyncio.sleep(0)  # let next_fn answer
            self.clock.now += advance

    def rendered(self) -> bytes:
        return self.engine.ring.read(0, self.engine.ring.head)


async def test_two_songs_join_bit_exact():
    a, b = _pcm(2 * SR), _pcm(SR // 3, start=7)
    rig = Rig({"a": a, "b": b}, ["a", "b"], lead=4.0)
    rig.engine.start()
    await rig.run()
    assert rig.rendered() == a + b
    join = len(a) // 4
    assert rig.engine.timeline.at(join - 1).song_id == "a"
    assert rig.engine.timeline.at(join).song_id == "b"
    assert rig.engine.timeline.at(join).position == 0.0
    assert rig.engine.end_stream_time == pytest.approx((len(a) + len(b)) / 4 / SR)
    assert rig.engine.ring.closed
    rig.engine.stop()


async def test_each_song_plays_at_its_own_gain():
    a, b = _pcm(2 * SR, start=100), _pcm(2 * SR, start=100)
    rig = Rig(
        {"a": a, "b": b},
        ["a", "b"],
        lead=5.0,
        items={"b": MixItem("b", 1, gain=0.5, duration=2.0)},
    )
    rig.engine.start()
    await rig.run()
    out = np.frombuffer(rig.rendered(), dtype="<i2")
    first = np.frombuffer(a, dtype="<i2")
    assert np.array_equal(out[: len(first)], first)
    assert np.array_equal(out[len(first) :], np.rint(first * 0.5).astype("<i2"))
    rig.engine.stop()


def test_gain_clips_instead_of_wrapping():
    loud = np.array([30000, -30000], dtype="<i2").tobytes()
    assert np.frombuffer(apply_gain(loud, 2.0), dtype="<i2").tolist() == [32767, -32768]


async def test_rendering_stays_one_lead_ahead_of_the_wall_clock():
    rig = Rig({"a": _pcm(10 * SR)}, ["a"], lead=2.0)
    rig.engine.start()
    await rig.run(steps=5)
    assert rig.engine.ring.head == 2 * SR
    rig.clock.now += 1.5
    await rig.run(steps=5)
    assert rig.engine.ring.head == int(3.5 * SR)
    rig.engine.stop()


async def test_paused_nothing_more_is_rendered_and_the_clock_resumes_where_it_stood():
    rig = Rig({"a": _pcm(10 * SR)}, ["a"], lead=2.0)
    rig.engine.start()
    await rig.run(steps=2)
    rig.engine.freeze()
    rig.clock.now += 60
    await rig.run(steps=5)
    assert rig.engine.ring.head == 2 * SR
    rig.engine.unfreeze()
    rig.clock.now += 1.0
    await rig.run(steps=2)
    assert rig.engine.ring.head == 3 * SR
    rig.engine.stop()


async def test_a_slow_first_song_is_waited_for_not_covered_in_silence():
    """The wall clock starts with the first audio: a speaker waits for the
    decoder either way, and silence up front would only delay the song."""
    rig = Rig({"a": _pcm(SR)}, ["a"])
    rig.slow.add("a")
    rig.engine.start()
    rig.clock.now += 30
    await rig.run(steps=3)
    assert rig.engine.ring.head == 0
    rig.decks[0].arrive()
    await rig.run(steps=3)
    assert rig.rendered()[:16] == _pcm(4)


async def test_a_late_next_song_is_waited_for_while_the_lead_lasts():
    a, b = _pcm(SR), _pcm(SR, start=3)
    rig = Rig({"a": a, "b": b}, ["a", "b"], lead=2.0)
    rig.slow.add("b")
    rig.engine.start()
    await rig.run(steps=3)
    # a is all out; b has nothing yet, and a whole second of lead remains.
    assert rig.engine.ring.head == SR
    rig.decks[1].arrive()
    await rig.run(steps=3)
    assert rig.rendered() == a + b
    rig.engine.stop()


async def test_out_of_lead_silence_goes_out_and_the_song_is_held_not_skipped():
    a, b = _pcm(SR), _pcm(SR, start=3)
    rig = Rig({"a": a, "b": b}, ["a", "b"], lead=2.0)
    rig.slow.add("b")
    rig.engine.start()
    await rig.run(steps=3)
    rig.clock.now += 1.5  # lead now 0.5s, under the starve threshold
    await rig.run(steps=1)
    t = rig.engine.timeline
    held = t.at(SR + 10)
    assert held.song_id == "b" and not held.entry.playing and held.position == 0.0
    silence_until = rig.engine.ring.head
    assert rig.engine.ring.read(SR, silence_until - SR) == bytes((silence_until - SR) * 4)

    rig.decks[1].arrive()
    rig.clock.now += 0.5
    await rig.run(steps=1)
    resumed = t.at(silence_until)
    assert resumed.song_id == "b" and resumed.entry.playing and resumed.position == 0.0
    assert rig.engine.ring.read(silence_until, 1) == _pcm(1, start=3)
    rig.engine.stop()


async def test_a_song_that_produces_nothing_is_skipped():
    a, c = _pcm(2 * SR), _pcm(1000, start=5)
    rig = Rig({"a": a, "b": b"", "c": c}, ["a", "b", "c"], lead=4.0)
    rig.engine.start()
    await rig.run()
    assert rig.rendered() == a + c
    assert rig.engine.timeline.at(2 * SR).song_id == "c"


async def test_a_mix_of_broken_songs_ends_instead_of_trying_forever():
    rig = Rig({"a": b"", "b": b"", "c": b"", "d": _pcm(100)}, ["a", "b", "c", "d"])
    rig.engine.start()
    await rig.run()
    assert rig.engine.ended
    assert rig.engine.ring.head == 0


async def test_repeat_one_loops_the_same_song_gaplessly():
    a = _pcm(2 * SR)
    rig = Rig({"a": a}, ["a"], lead=8.0)
    plays = 0

    async def again(current):
        nonlocal plays
        plays += 1
        return current if plays < 3 else None

    rig.engine._next_fn = again
    rig.engine.start()
    await rig.run()
    assert rig.rendered() == a * 3


async def test_a_queue_change_drops_the_opened_next_song_and_asks_again():
    a, b, c = _pcm(3 * SR), _pcm(100, start=1), _pcm(100, start=2)
    rig = Rig({"a": a, "b": b, "c": c}, ["a", "b", "c"], lead=1.0)
    rig.engine.start()
    await rig.run(steps=2)
    opened_b = rig.decks[1]
    assert opened_b.item.song_id == "b"
    rig.order = ["a", "c"]
    rig.items["c"] = MixItem("c", 1, duration=100 / SR)
    rig.engine.queue_changed()
    assert opened_b.closed
    await rig.run(steps=20, advance=0.25)
    assert rig.rendered()[: len(a + c)] == a + c
    assert rig.engine.timeline.at(3 * SR).song_id == "c"


async def test_the_next_song_is_locked_once_its_join_is_rendered():
    a, b = _pcm(3 * SR), _pcm(100, start=1)
    rig = Rig({"a": a, "b": b}, ["a", "b"], lead=1.0)
    rig.engine.start()
    await rig.run(steps=2)
    assert not rig.engine.next_locked(0.0)
    await rig.run(steps=20, advance=0.25)
    assert rig.engine.next_locked(0.0)
    # Heard from b on, only the end of the mix follows: nothing to keep.
    assert not rig.engine.next_locked(3.0)


async def test_excerpts_play_from_their_start_and_say_where_in_the_song_they_are():
    a, b = _pcm(SR), _pcm(SR, start=5)
    items = {
        "a": MixItem("a", 0, duration=200.0, start=50.0, end=51.0),
        "b": MixItem("b", 1, duration=200.0, start=80.0, end=81.0),
    }
    rig = Rig({"a": a, "b": b}, ["a", "b"], lead=4.0, items=items, position=50.0)
    rig.engine.start()
    await rig.run()
    assert [d.start for d in rig.decks] == [50.0, 80.0]
    assert rig.rendered() == a + b
    assert rig.engine.timeline.at(SR // 2).position == pytest.approx(50.5)
    assert rig.engine.timeline.at(SR + SR // 2).position == pytest.approx(80.5)


def test_an_excerpt_is_cut_and_faded_by_its_decoder():
    whole = me.decode_cmd("u", 50.0)
    assert "-t" not in whole and "-af" not in whole
    excerpt = me.decode_cmd("u", 50.0, 70.0)
    assert excerpt[excerpt.index("-t") + 1] == "20.000"
    fades = excerpt[excerpt.index("-af") + 1]
    assert "afade=t=in" in fades and "afade=t=out:st=18.000" in fades


def test_an_excerpt_is_analysed_within_its_bounds_only():
    out = MixItem("a", 0, duration=300.0, start=100.0, end=120.0)
    inn = MixItem("b", 1, duration=300.0, start=60.0, end=80.0)
    assert me._analysis_windows(out, inn) == ((100.0, 20.0), (60.0, 20.0))
    whole = MixItem("a", 0, duration=300.0)
    assert me._analysis_windows(whole, whole) == ((240.0, 65.0), (0.0, 60.0))


async def test_the_next_song_is_asked_for_only_near_the_end():
    rig = Rig({"a": _pcm(120 * SR), "b": _pcm(10)}, ["a", "b"], lead=1.0)
    rig.slow.add("a")
    rig.engine.start()
    rig.decks[0]._buf += rig.decks[0]._pending[: 4 * SR]  # a trickle, decoder still going
    rig.decks[0].produced = True
    await rig.run(steps=2)
    assert len(rig.decks) == 1


async def test_a_listener_that_stopped_reading_holds_rendering_back():
    rig = Rig({"a": _pcm(30 * SR)}, ["a"], lead=2.0)
    rig.engine.start()
    await rig.run(steps=1)

    class Stuck:
        closed = False
        fed_frame = 0

        def close(self):
            pass

    rig.engine._connections.append(Stuck())
    rig.clock.now += 10
    await rig.run(steps=3)
    assert rig.engine.ring.head == 2 * SR
    rig.engine.stop()


async def test_stopping_closes_the_decks_and_the_ring():
    rig = Rig({"a": _pcm(10 * SR), "b": _pcm(10)}, ["a", "b"])
    rig.engine.start()
    await rig.run(steps=2)
    rig.engine.stop()
    assert all(d.closed for d in rig.decks)
    assert rig.engine.ring.closed


# ── Real decoders ───────────────────────────────────────────────────────────


def _sine(frames: int) -> np.ndarray:
    t = np.arange(frames)
    mono = (12000 * np.sin(2 * np.pi * 441 * t / SR)).astype("<i2")
    return np.repeat(mono, 2)


def _write_wav(path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(samples.tobytes())


async def _mix_files(paths: list[str], durations: list[float], monkeypatch) -> np.ndarray:
    """The mix of `paths` through real decoders. What is asked here is
    whether a join is exact, not how the engine paces itself: on the real
    clock, its head start at a join is only what it has rendered so far, and
    a decoder slower than that to start - a CI runner under coverage -
    gets silence held in its place. So it is never given up on here."""
    monkeypatch.setattr(me, "_STARVE_LEAD_SECONDS", float("-inf"))
    items = [MixItem(str(i), i, duration=d) for i, d in enumerate(durations)]

    async def url(item):
        return paths[int(item.song_id)]

    async def nxt(current):
        i = current.queue_index + 1
        return items[i] if i < len(items) else None

    engine = MixEngine(items[0], 0.0, url, nxt, lead_seconds=60.0)
    engine.start()
    try:
        async with asyncio.timeout(20):
            while not engine.ended:
                await asyncio.sleep(0.05)
    finally:
        engine.stop()
    return np.frombuffer(engine.ring.read(0, engine.ring.head), dtype="<i2")


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")
async def test_a_song_split_into_two_files_comes_out_whole(tmp_path, monkeypatch):
    monkeypatch.setattr(me, "FFMPEG_BIN", "ffmpeg")
    whole = _sine(2 * SR)
    _write_wav(tmp_path / "a.wav", whole[: 2 * 50_000])
    _write_wav(tmp_path / "b.wav", whole[2 * 50_000 :])
    paths = [str(tmp_path / "a.wav"), str(tmp_path / "b.wav")]
    out = await _mix_files(paths, [1.13, 0.87], monkeypatch)
    assert np.array_equal(out, whole)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")
async def test_an_excerpt_decodes_to_its_length_fading_in_and_out(tmp_path, monkeypatch):
    monkeypatch.setattr(me, "FFMPEG_BIN", "ffmpeg")
    _write_wav(tmp_path / "a.wav", _sine(6 * SR))
    cmd = me.decode_cmd(str(tmp_path / "a.wav"), 1.0, 4.0)
    done = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, check=True)
    left = np.frombuffer(done.stdout, dtype="<i2")[0::2].astype(np.int32)
    assert abs(len(left) - 3 * SR) <= 64
    assert np.abs(left[:100]).max() < 1000  # fading in
    assert np.abs(left[SR : SR + 2000]).max() > 11000  # full level between
    assert np.abs(left[-100:]).max() < 1000  # faded out


def _encode_mp3(wav, mp3) -> None:
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(wav), "-c:a", "libmp3lame"]
        + ["-b:a", "320k", str(mp3)],
        check=True,
    )


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg")
async def test_mp3_padding_does_not_open_a_gap_at_the_join(tmp_path, monkeypatch):
    """MP3 pads each file at both ends; ffmpeg's decoder trims that again
    from the LAME header a file carries. With it trimmed the sine runs on
    across the join; untrimmed there would be tens of ms of silence."""
    monkeypatch.setattr(me, "FFMPEG_BIN", "ffmpeg")
    whole = _sine(4 * SR)
    split = 2 * 100_000
    _write_wav(tmp_path / "a.wav", whole[:split])
    _write_wav(tmp_path / "b.wav", whole[split:])
    for name in ("a", "b"):
        await asyncio.to_thread(_encode_mp3, tmp_path / f"{name}.wav", tmp_path / f"{name}.mp3")
    paths = [str(tmp_path / "a.mp3"), str(tmp_path / "b.mp3")]
    out = await _mix_files(paths, [2.27, 1.73], monkeypatch)
    assert abs(len(out) - len(whole)) <= 2 * 64
    left = out[0::2].astype(np.int32)
    around = left[split // 2 - 2000 : split // 2 + 2000]
    # A gap shows as a run of near-silence where the sine should be loud.
    quiet = np.abs(around) < 200
    longest = max(len(run) for run in "".join("1" if q else "0" for q in quiet).split("0"))
    assert longest < 20


async def test_the_last_song_ending_inside_a_block_keeps_its_last_audio():
    """The end of the queue already known, the last song's final frames and
    its end fall into one block: those frames go out before the stream
    closes, rather than being refused by a ring already closed."""
    a = _pcm(SR // 3)  # not a whole number of render blocks
    rig = Rig({"a": a}, ["a"], lead=4.0)
    rig.slow.add("a")
    rig.engine.start()
    await rig.run(steps=3)  # asks for the next song: there is none
    rig.decks[0].arrive()
    await rig.run(steps=3)
    assert rig.engine.ended and rig.engine.ring.closed
    assert rig.rendered() == a
