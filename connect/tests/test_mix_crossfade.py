"""Tests for core/mix_engine.py's crossfade path: two songs blended the
way core/transition_planner.py plans it, rendered through
core/mix_dsp.py's splitters and core/timestretch.py.

What is checked is what a listener would hear: both songs during the
overlap and only one outside it, the basses swapping rather than doubling,
and beat-matched songs whose kicks land together instead of flamming.
"""

import asyncio

import numpy as np
import pytest

from core.beat_analysis import ANALYSIS_RATE, analyse_samples
from core.mix_dsp import DELAY_FRAMES
from core.mix_engine import MixEngine, MixItem
from core.mix_timeline import SAMPLE_RATE
from core.transition_planner import Settings

from .test_mix_engine import FakeClock, FakeDeck

SR = SAMPLE_RATE


def tone(hz: float, seconds: float, level: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    mono = level * np.sin(2 * np.pi * hz * t)
    return np.repeat(mono[:, None], 2, axis=1)


def clicks(bpm: float, seconds: float, offset: float = 0.0) -> np.ndarray:
    """A kick on every beat - a 70 Hz body with a sharp click on top, so
    some of it is in every band - the first of each bar louder."""
    x = np.zeros((int(seconds * SR), 2))
    n = np.arange(int(0.06 * SR))
    click = np.random.default_rng(7).standard_normal(len(n)) * np.exp(-n / (0.0015 * SR))
    for k in range(int((seconds - offset) * bpm / 60)):
        level = 0.7 if k % 4 == 0 else 0.4
        body = np.sin(2 * np.pi * 70 * n / SR) * np.exp(-n / (0.012 * SR))
        burst = level * (0.6 * body + 0.4 * click)
        i = int((offset + k * 60 / bpm) * SR)
        x[i : i + len(n)] += burst[: len(x) - i, None]
    return x


# Two attacks closer than this are heard as one hit; further apart, as a
# flam. Beat-matched kicks have to stay inside it.
FLAM_SECONDS = 0.012


def click_times(x: np.ndarray, threshold: float = 0.05) -> np.ndarray:
    """Seconds of each sharp attack: the clicks, by their high frequencies.
    An attack starts after a moment of quiet - not in the ringing tail of
    the one before - and one inside FLAM_SECONDS of the last is the same
    hit."""
    quiet = int(0.003 * SR)
    found: list[int] = []
    last_sharp = -quiet
    for i in np.flatnonzero(np.abs(np.diff(x[:, 0])) > threshold):
        if i - last_sharp >= quiet and (not found or i - found[-1] >= FLAM_SECONDS * SR):
            found.append(int(i))
        last_sharp = i
    return np.array(found) / SR


def pcm(x: np.ndarray) -> bytes:
    return (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()


class Rig:
    def __init__(
        self,
        songs: dict[str, np.ndarray],
        settings: Settings,
        analyse=True,
        lead: float = 2.0,
        **items,
    ):
        self.songs = songs
        self.clock = FakeClock()
        order = list(songs)
        self.items = {
            sid: items.get(sid) or MixItem(sid, i, duration=len(songs[sid]) / SR)
            for i, sid in enumerate(order)
        }
        self.order = order
        self.analysed: list[tuple[str, float, float]] = []
        self.engine = MixEngine(
            self.items[order[0]],
            self.items[order[0]].start,
            self._url,
            self._next,
            lead_seconds=lead,
            clock=self.clock,
            deck_factory=lambda item, start: FakeDeck(item, start, pcm(songs[item.song_id]), True),
            settings=settings,
            analyse_fn=self._analyse if analyse else self._no_analysis,
        )

    async def _url(self, item):
        return item.song_id

    async def _next(self, current):
        i = current.queue_index + 1
        return self.items[self.order[i]] if i < len(self.order) else None

    async def _analyse(self, item, start, duration):
        self.analysed.append((item.song_id, start, duration))
        song = self.songs[item.song_id]
        a, b = int(start * SR), int(min(start + duration, len(song) / SR) * SR)
        mono = song[a:b].mean(axis=1)[:: SR // ANALYSIS_RATE].astype(np.float32)
        return analyse_samples(mono, start)

    async def _no_analysis(self, item, start, duration):
        return None

    async def render_all(self) -> np.ndarray:
        self.engine.start()
        ring = self.engine.ring
        raw = bytearray()
        for _ in range(600):
            self.engine.step()
            # Collected as it is written: the ring only keeps a minute
            # behind the (here quickly advancing) wall clock.
            raw += ring.read(len(raw) // 4, ring.head - len(raw) // 4)
            # Let the next song's lookup and the analysis answer, as they
            # would in the seconds a real render runs ahead.
            for _ in range(5):
                await asyncio.sleep(0)
            self.clock.now += 0.5
            if self.engine.ended:
                break
        assert self.engine.ended
        self.engine.stop()
        return np.frombuffer(bytes(raw), dtype="<i2").reshape(-1, 2).astype(np.float64) / 32768


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x**2)))


def band_level(x: np.ndarray, hz: float) -> float:
    """The amplitude of `hz` in `x` (one channel, Hann-windowed DFT bin)."""
    window = np.hanning(len(x))
    spectrum = 2 * np.abs(np.fft.rfft(x[:, 0] * window)) / window.sum()
    return float(spectrum[round(hz * len(x) / SR)])


CROSSFADE = Settings("crossfade", 8.0)


async def test_two_songs_overlap_by_the_crossfade_length():
    a, b = tone(440, 30), tone(660, 20)
    rig = Rig({"a": a, "b": b}, CROSSFADE, analyse=False)
    out = await rig.render_all()
    # a until 22s, both 22-30s, then b: 30 + 20 - 8 seconds, plus the
    # splitter's own delay flushed at the end.
    assert len(out) == pytest.approx((30 + 20 - 8) * SR + DELAY_FRAMES, abs=2)
    before, during, after = out[18 * SR : 20 * SR], out[26 * SR : 28 * SR], out[32 * SR : 34 * SR]
    assert band_level(before, 440) > 0.25 and band_level(before, 660) < 0.01
    assert band_level(during, 440) > 0.08 and band_level(during, 660) > 0.08
    assert band_level(after, 660) > 0.25 and band_level(after, 440) < 0.01


async def test_the_song_change_is_marked_at_the_swap_on_the_delayed_output():
    rig = Rig({"a": tone(440, 30), "b": tone(660, 20)}, CROSSFADE, analyse=False)
    await rig.render_all()
    change = rig.engine.timeline.next_change(0)
    assert change.song_id == "b"
    assert change.frame == 26 * SR + DELAY_FRAMES  # 22s + half of 8s
    assert change.position == pytest.approx(4.0)
    assert rig.engine.timeline.end_frame == len(rig.engine.ring.read(0, 10**9)) // 4


async def test_a_queue_change_during_the_blend_keeps_the_incoming_song():
    rig = Rig(
        {"a": tone(440, 30), "b": tone(660, 20), "c": tone(880, 20)}, CROSSFADE, analyse=False
    )
    rig.engine.start()
    for _ in range(600):
        rig.engine.step()
        for _ in range(5):
            await asyncio.sleep(0)
        rig.clock.now += 0.5
        if rig.engine.next_committed:
            break
    # Nothing of b is in the timeline yet - the swap comes halfway through.
    assert rig.engine.timeline.next_change(0) is None
    assert rig.engine.next_locked(0.0)
    rig.order = ["a", "c"]
    rig.items["c"] = MixItem("c", 1, duration=20.0)
    rig.engine.queue_changed()
    for _ in range(100):
        rig.engine.step()
        for _ in range(5):
            await asyncio.sleep(0)
        rig.clock.now += 0.5
    assert rig.engine.timeline.next_change(0).song_id == "b"
    rig.engine.stop()


async def test_the_transition_is_told_before_it_begins_and_after_it_was_rendered():
    rig = Rig({"a": tone(440, 30), "b": tone(660, 20)}, CROSSFADE, analyse=False)
    rig.engine.start()
    expected = {
        "song_id": "a",
        "queue_index": 0,
        "kind": "crossfade",
        "start": 22.0,
        "change": 26.0,
    }
    told_ahead = False
    for _ in range(600):
        rig.engine.step()
        for _ in range(5):
            await asyncio.sleep(0)
        rig.clock.now += 0.5
        transitions = rig.engine.transitions()
        if transitions and not rig.engine.next_committed:
            told_ahead = True
            assert {k: transitions[-1][k] for k in expected} == expected
        if rig.engine.ended:
            break
    assert told_ahead
    # Rendering is past it; a listener a lead behind is not.
    assert [t["song_id"] for t in rig.engine.transitions()] == ["a"]
    rig.engine.stop()


async def test_a_beatmix_is_told_with_its_ease_and_the_incoming_tempo():
    a = clicks(128, 60, offset=0.21)
    b = clicks(124, 60, offset=0.37)
    rig = Rig({"a": a, "b": b}, CROSSFADE)
    await rig.render_all()
    told = rig.engine.transitions()[-1]
    assert told["kind"] == "beatmix" and told["bpm"] == pytest.approx(124.0, abs=1.0)
    # The ease into the incoming tempo is heard before the overlap.
    assert told["start"] < told["change"] - 8.0


async def test_a_queue_change_that_leaves_the_next_song_keeps_its_beatmix():
    a = clicks(128, 60, offset=0.21)
    b = clicks(124, 60, offset=0.37)
    rig = Rig({"a": a, "b": b}, CROSSFADE)
    rig.engine.start()
    for _ in range(600):
        rig.engine.step()
        for _ in range(5):
            await asyncio.sleep(0)
        rig.clock.now += 0.5
        if rig.engine.transitions():
            break
    analysed = len(rig.analysed)
    # The listener hears a song change, and the queue is told again as is.
    rig.engine.queue_changed()
    for _ in range(600):
        rig.engine.step()
        for _ in range(5):
            await asyncio.sleep(0)
        rig.clock.now += 0.5
        if rig.engine.ended:
            break
    assert len(rig.analysed) == analysed
    assert rig.engine.transitions()[-1]["kind"] == "beatmix"
    rig.engine.stop()


# With a 16 s beatmix these two songs ease from 29.5 s, overlap from 44.5 s;
# without an analysis the crossfade is decided on metadata at 43 s.
BEATMIX_16 = Settings("crossfade", crossfade_seconds=4.0, beatmix_seconds=16.0)


async def _render_with_analysis_held(rig: Rig, release, tick: float = 0.5) -> None:
    """Renders to the end, the analysis answering only once `release(rig)`;
    `tick` is the clock between steps."""
    held = asyncio.Event()
    analyse = rig.engine._analyse_fn

    async def slow(item, start, duration):
        await held.wait()
        return await analyse(item, start, duration)

    rig.engine._analyse_fn = slow
    rig.engine.start()
    for _ in range(round(300 / tick)):
        rig.engine.step()
        if release(rig):
            held.set()
        for _ in range(5):
            await asyncio.sleep(0)
        rig.clock.now += tick
        if rig.engine.ended:
            break
    rig.engine.stop()


def _a_at(rig: Rig) -> float:
    deck = rig.engine._deck
    return deck.position if deck is not None and deck.item.song_id == "a" else 0.0


async def test_a_beatmix_planned_into_its_ease_eases_over_what_is_left():
    rig = Rig({"a": clicks(128, 60, offset=0.21), "b": clicks(124, 60, offset=0.37)}, BEATMIX_16)
    await _render_with_analysis_held(rig, lambda r: _a_at(r) > 35.0)
    told = rig.engine.transitions()[-1]
    assert told["kind"] == "beatmix"
    assert 35.0 < told["start"] < 37.0


async def test_a_beatmix_planned_too_late_to_ease_is_a_crossfade_of_its_own_length(caplog):
    rig = Rig({"a": clicks(128, 60, offset=0.21), "b": clicks(124, 60, offset=0.37)}, BEATMIX_16)
    # Under two bars (3.75 s) before the overlap, before the metadata's turn.
    await _render_with_analysis_held(rig, lambda r: _a_at(r) > 41.0)
    assert "planned too late" in caplog.text
    told = rig.engine.transitions()[-1]
    assert told["kind"] == "crossfade"
    assert told["change"] - told["start"] == pytest.approx(2.0)  # half of 4 s


async def test_after_a_seek_rendering_waits_for_the_plan_rather_than_racing_past_it():
    songs = {"a": clicks(128, 60, offset=0.21), "b": clicks(124, 60, offset=0.37)}
    # Started 9.5 s before the ease, ticking as the render loop does, with a
    # whole 20 s lead to render at once and an analysis that takes a second.
    rig = Rig(songs, BEATMIX_16, lead=20.0, a=MixItem("a", 0, duration=60.0, start=20.0))
    begun = rig.clock.now
    await _render_with_analysis_held(rig, lambda r: r.clock.now >= begun + 1.0, tick=0.05)
    told = rig.engine.transitions()[-1]
    assert told["kind"] == "beatmix"
    assert told["start"] == pytest.approx(29.492, abs=0.01)  # the whole ease
    # Waiting cost no silence: nothing was held.
    assert all(e.playing for e in rig.engine.timeline.entries if e.song_id is not None)


async def test_a_preview_blends_excerpts_and_marks_their_song_positions():
    rig = Rig(
        {"a": tone(440, 20), "b": tone(660, 20)},
        Settings("crossfade", 4.0, preview=True),
        analyse=False,
        a=MixItem("a", 0, duration=200.0, start=100.0, end=120.0, album_id="x", track=1),
        b=MixItem("b", 1, duration=200.0, start=50.0, end=70.0, album_id="x", track=2),
    )
    out = await rig.render_all()
    # Album neighbours, and still blended: 20 + 20 - 4 seconds.
    assert len(out) == pytest.approx((20 + 20 - 4) * SR + DELAY_FRAMES, abs=2)
    assert rig.engine.timeline.at(SR).position == pytest.approx(101.0, abs=0.01)
    change = rig.engine.timeline.next_change(0)
    assert change.song_id == "b"
    assert change.position == pytest.approx(52.0)  # its start, plus half the overlap
    # Faded in at the start and out at the end, so neither is mid-note.
    level = rms(out[5 * SR : 6 * SR])
    assert rms(out[: SR // 100]) < level / 10
    assert rms(out[-SR // 100 :]) < level / 10


async def test_the_basses_swap_instead_of_doubling():
    a = tone(55, 30) + tone(3000, 30, 0.1)
    b = tone(82, 20) + tone(4000, 20, 0.1)
    rig = Rig({"a": a, "b": b}, CROSSFADE, analyse=False)
    out = await rig.render_all()
    early, late = out[int(23 * SR) : int(25.5 * SR)], out[int(26.5 * SR) : int(29 * SR)]
    # First half: the incoming highs are up, its bass is not.
    assert band_level(early, 55) > 0.25 and band_level(early, 82) < 0.02
    assert band_level(early, 4000) > 0.04
    # Second half: the bass is the incoming song's, the outgoing highs fading.
    assert band_level(late, 82) > 0.25 and band_level(late, 55) < 0.02
    assert band_level(late, 3000) > 0.008


async def test_songs_following_on_an_album_join_without_a_fade():
    a, b = tone(440, 10), tone(440, 10)
    items = {
        "a": MixItem("a", 0, duration=10, album_id="x", track=1),
        "b": MixItem("b", 1, duration=10, album_id="x", track=2),
    }
    rig = Rig({"a": a, "b": b}, CROSSFADE, **items)
    out = await rig.render_all()
    assert len(out) == pytest.approx(20 * SR + DELAY_FRAMES, abs=2)
    np.testing.assert_allclose(
        out[DELAY_FRAMES : DELAY_FRAMES + 20 * SR, 0], np.concatenate([a, b])[:, 0], atol=4e-4
    )
    assert rig.analysed == []  # nothing to analyse for a join


async def test_kicks_of_beatmatched_songs_land_together():
    a = clicks(128, 60, offset=0.21)
    b = clicks(124, 60, offset=0.37)
    rig = Rig({"a": a, "b": b}, CROSSFADE)
    out = await rig.render_all()
    entries = rig.engine.timeline.entries
    # The outgoing song is brought to the incoming tempo, never the reverse.
    assert any(e.song_id == "a" and e.rate == pytest.approx(124 / 128, rel=0.01) for e in entries)
    assert all(e.rate == 1.0 for e in entries if e.song_id == "b")
    # Through the whole overlap both songs' clicks are audible (their mids
    # and highs overlap); beat-matched they land on top of each other, so
    # attacks come once per outgoing beat - never as a flam, two attacks a
    # few tens of milliseconds apart.
    bar = 4 * 60 / 128
    swap = rig.engine.timeline.next_change(0).frame
    overlap = out[
        swap - int(2 * bar * SR) + int(0.3 * SR) : swap + int(2 * bar * SR) - int(0.3 * SR)
    ]
    gaps = np.diff(click_times(overlap))
    assert len(gaps) >= 12
    assert np.all(np.abs(gaps - 60 / 124) < FLAM_SECONDS)


async def test_once_it_has_taken_over_the_incoming_song_plays_untouched():
    """Stretching leaves a trace however well it is done; the song a
    listener is now hearing is the one that must not carry it."""
    a = clicks(128, 60, offset=0.21)
    b = clicks(124, 60, offset=0.37) + tone(523, 60, 0.05)
    rig = Rig({"a": a, "b": b}, CROSSFADE)
    out = await rig.render_all()
    swap = rig.engine.timeline.next_change(0)
    assert swap.song_id == "b"
    # From two bars after the swap - past the overlap - to just before the end.
    start = swap.frame + int(2 * 4 * 60 / 124 * SR)
    at = round(swap.position * SR) + start - swap.frame
    heard = out[start : start + 20 * SR, 0]
    # Within a sample: the swap's frame is rounded, its position is not.
    error = min(np.abs(heard - b[at + lag : at + lag + 20 * SR, 0]).max() for lag in (-1, 0, 1))
    assert error < 2e-4  # dither


async def test_without_an_analysis_in_time_it_crossfades_on_the_metadata():
    rig = Rig({"a": tone(440, 30), "b": tone(660, 20)}, CROSSFADE)

    async def never(item, start, duration):
        await asyncio.sleep(3600)

    rig.engine._analyse_fn = never
    await rig.render_all()
    assert rig.engine.timeline.next_change(0).frame == 26 * SR + DELAY_FRAMES


def _ease_start(rig) -> int:
    """Output frame where the outgoing song starts easing into the new tempo."""
    return next(e.frame for e in rig.engine.timeline.entries if e.song_id == "a" and e.frame > 0)


async def test_the_ease_starts_without_a_dip():
    """A stretch started mid-song has nothing to overlap its first frame
    with; unprimed, it fades in from silence for 23 ms."""
    a = clicks(128, 60, offset=0.21) + tone(440, 60, 0.2)
    rig = Rig({"a": a, "b": clicks(124, 60, offset=0.37)}, CROSSFADE)
    out = await rig.render_all()
    start = _ease_start(rig)
    around = out[start - SR // 5 : start + SR // 5, 0]
    window = int(0.005 * SR)
    levels = np.sqrt((around[: len(around) // window * window].reshape(-1, window) ** 2).mean(1))
    assert levels.min() > 0.5 * np.median(levels)


async def test_while_easing_the_timeline_follows_the_outgoing_song():
    """What lyrics and the visualizer read: through the ease, the position
    the timeline gives for a moment is where in the song that moment is."""
    beat, offset = 60 / 128, 0.21
    a = clicks(128, 60, offset=offset)
    rig = Rig({"a": a, "b": clicks(124, 60, offset=0.37)}, CROSSFADE)
    out = await rig.render_all()
    start = _ease_start(rig)
    overlap = next(
        e.frame for e in rig.engine.timeline.entries if e.song_id == "a" and e.rate < 0.97
    )
    times = click_times(out[start:overlap]) + start / SR
    assert len(times) > 20
    for heard in times:
        position = rig.engine.timeline.at_time(heard).position
        nearest = offset + round((position - offset) / beat) * beat
        assert abs(position - nearest) < FLAM_SECONDS
