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
    """Seconds of each sharp attack: the clicks, by their high frequencies,
    with attacks inside FLAM_SECONDS of each other counted once."""
    sharp = np.abs(np.diff(x[:, 0]))
    found, i = [], 0
    while i < len(sharp):
        if sharp[i] > threshold:
            found.append(i)
            i += int(FLAM_SECONDS * SR)
        else:
            i += 1
    return np.array(found) / SR


def pcm(x: np.ndarray) -> bytes:
    return (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()


class Rig:
    def __init__(self, songs: dict[str, np.ndarray], settings: Settings, analyse=True, **items):
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
            0.0,
            self._url,
            self._next,
            lead_seconds=2.0,
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
    plan = rig.engine._plan or None
    log_kind = [e for e in rig.engine.timeline.entries if e.song_id == "b"]
    assert log_kind and log_kind[0].rate == pytest.approx(128 / 124, rel=0.01)
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
    assert np.all(np.abs(gaps - 60 / 128) < FLAM_SECONDS)
    del plan


async def test_without_an_analysis_in_time_it_crossfades_on_the_metadata():
    rig = Rig({"a": tone(440, 30), "b": tone(660, 20)}, CROSSFADE)

    async def never(item, start, duration):
        await asyncio.sleep(3600)

    rig.engine._analyse_fn = never
    await rig.render_all()
    assert rig.engine.timeline.next_change(0).frame == 26 * SR + DELAY_FRAMES
