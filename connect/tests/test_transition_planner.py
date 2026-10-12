"""Tests for core/transition_planner.py — how one song turns into the next."""

import numpy as np
import pytest

from core.beat_analysis import BeatGrid, RegionAnalysis
from core.transition_planner import (
    MAX_STRETCH,
    SWAP_SECONDS,
    Settings,
    SongFacts,
    plan_transition,
    rate_at,
    song_seconds,
    stretch_for,
)

CROSSFADE = Settings("crossfade", 10.0)
OUT = SongFacts(240.0, album_id="x", track=3)
IN = SongFacts(200.0, album_id="y", track=1)


def grid(bpm: float, phase: float, downbeat: float, confidence: float = 0.9) -> BeatGrid:
    return BeatGrid(60 / bpm, phase, downbeat, confidence, 0.8)


def out_region(bpm=128.0, sound_end=238.0, **kw) -> RegionAnalysis:
    g = grid(bpm, 180.02, 180.02, **kw)
    return RegionAnalysis(180.0, 240.0, 180.0, sound_end, g)


def in_region(bpm=126.0, sound_start=0.4, downbeat=0.5, **kw) -> RegionAnalysis:
    g = grid(bpm, downbeat, downbeat, **kw)
    return RegionAnalysis(0.0, 60.0, sound_start, 60.0, g)


def lane_at(lane, t: float) -> float:
    return float(np.interp(t, lane.times, lane.gains))


# ── Which kind ─────────────────────────────────────────────────────────────


def test_gapless_mode_is_always_gapless():
    plan = plan_transition(Settings("gapless"), OUT, IN, out_region(), in_region())
    assert plan.kind == "gapless" and plan.out_end == 240.0 and plan.in_start == 0.0


@pytest.mark.parametrize(
    ("out", "inn", "follows"),
    [
        (SongFacts(1, "a", 1, 3), SongFacts(1, "a", 1, 4), True),
        (SongFacts(1, "a", 1, 9), SongFacts(1, "a", 2, 1), True),
        (SongFacts(1, "a", None, 3), SongFacts(1, "a", None, 4), True),
        (SongFacts(1, "a", 1, 3), SongFacts(1, "a", 1, 5), False),
        (SongFacts(1, "a", 1, 3), SongFacts(1, "b", 1, 4), False),
        (SongFacts(1, None, 1, 3), SongFacts(1, None, 1, 4), False),
    ],
)
def test_songs_that_follow_on_an_album_join_without_a_fade(out, inn, follows):
    plan = plan_transition(CROSSFADE, out, inn)
    assert (plan.kind == "gapless") == follows


def test_beatmix_needs_trusted_grids_and_reachable_tempos():
    assert plan_transition(CROSSFADE, OUT, IN, out_region(), in_region()).kind == "beatmix"
    weak = in_region(confidence=0.3)
    assert plan_transition(CROSSFADE, OUT, IN, out_region(), weak).kind == "crossfade"
    far = in_region(bpm=100.0)
    assert plan_transition(CROSSFADE, OUT, IN, out_region(), far).kind == "crossfade"
    assert plan_transition(CROSSFADE, OUT, IN).kind == "crossfade"


def test_double_and_half_tempo_still_beatmix():
    # The outgoing song's rate: its beat brought to the incoming beat,
    # counted doubled or halved.
    assert stretch_for(grid(174, 0, 0), grid(87.5, 0, 0)) == pytest.approx(175 / 174)
    assert stretch_for(grid(87, 0, 0), grid(172, 0, 0)) == pytest.approx(172 / 174)
    assert stretch_for(grid(128, 0, 0), grid(128 * (1 + MAX_STRETCH + 0.01), 0, 0)) is None


# ── A beatmix ──────────────────────────────────────────────────────────────


def test_a_beatmix_is_whole_bars_ending_on_the_last_downbeat_with_music():
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), in_region())
    # Through the overlap the stream runs at the incoming tempo.
    assert plan.overlap == pytest.approx(4 * 4 * 60 / 126)  # 4 bars, the most within 10s
    downbeats = out_region().grid.downbeats(180, 238)
    assert plan.out_end == pytest.approx(downbeats[-1])
    assert plan.out_end <= 238.0
    assert plan.out_start == pytest.approx(plan.out_end - 4 * 4 * 60 / 128)
    # On a downbeat of the incoming song, at or after its music starts.
    assert plan.in_start == pytest.approx(0.5)


def test_the_bass_swaps_on_the_middle_downbeat_and_never_doubles():
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), in_region())
    assert plan.swap_at == pytest.approx(2 * 4 * 60 / 126)
    for t in np.linspace(0, plan.overlap, 200):
        both = lane_at(plan.out_lanes["low"], t) * lane_at(plan.in_lanes["low"], t)
        assert (
            both == pytest.approx(0.0, abs=1e-9) or plan.swap_at <= t <= plan.swap_at + SWAP_SECONDS
        )
    assert lane_at(plan.in_lanes["low"], plan.swap_at - 0.01) == 0.0
    assert lane_at(plan.in_lanes["low"], plan.swap_at + SWAP_SECONDS) == 1.0


def test_mids_and_highs_come_in_first_and_go_out_last():
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), in_region())
    swap, end = plan.swap_at, plan.overlap
    mid_in, mid_out = plan.in_lanes["mid"], plan.out_lanes["mid"]
    assert lane_at(mid_in, 0) == 0.0 and lane_at(mid_in, swap) == pytest.approx(1.0)
    assert lane_at(mid_out, swap) == 1.0 and lane_at(mid_out, end) == pytest.approx(0.0, abs=1e-9)
    gains = [lane_at(mid_in, t) for t in np.linspace(0, swap, 50)]
    assert gains == sorted(gains)


def test_the_outgoing_song_eases_into_the_incoming_tempo_before_the_overlap():
    """The incoming song is never stretched: once it has taken over, it
    plays as it is."""
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), in_region())
    rate = 126 / 128
    ease_from = plan.out_rate[0][0]
    assert ease_from < 0
    assert rate_at(plan.out_rate, ease_from - 0.1) == 1.0
    assert rate_at(plan.out_rate, ease_from / 2) == pytest.approx((1 + rate) / 2)
    for t in np.linspace(0, plan.overlap - 0.01, 20):
        assert rate_at(plan.out_rate, t) == pytest.approx(rate)
    # Played that way, the outgoing song reaches its last downbeat exactly
    # where the overlap ends - the beats stay together all the way.
    assert plan.out_start + song_seconds(plan.out_rate, 0.0, plan.overlap) == pytest.approx(
        plan.out_end
    )
    assert plan.stretch_start == pytest.approx(
        plan.out_start + song_seconds(plan.out_rate, 0.0, ease_from)
    )


def test_the_ease_stays_inside_what_was_analysed():
    """It begins where the plan has to be ready by - analysis covers the
    song's end, so the ease is cut to fit inside it."""
    region = out_region()
    late = RegionAnalysis(229.0, 240.0, 229.0, 238.0, region.grid)
    plan = plan_transition(CROSSFADE, OUT, IN, late, in_region())
    assert plan.kind == "beatmix"
    assert plan.stretch_start == pytest.approx(229.0)


def test_the_same_tempo_needs_no_stretch():
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), in_region(bpm=128.0))
    assert plan.kind == "beatmix" and plan.out_rate == ()
    assert plan.stretch_start == plan.out_start


def test_a_longer_setting_buys_more_bars():
    plan = plan_transition(Settings("crossfade", 31.0), OUT, IN, out_region(), in_region())
    assert plan.overlap == pytest.approx(16 * 4 * 60 / 126)
    short = plan_transition(Settings("crossfade", 2.0), OUT, IN, out_region(), in_region())
    assert short.overlap == pytest.approx(4 * 60 / 126)  # never under one bar


# ── A crossfade ────────────────────────────────────────────────────────────


def test_a_crossfade_skips_silence_at_both_ends():
    out = RegionAnalysis(180.0, 240.0, 180.0, 236.0, None)
    inn = RegionAnalysis(0.0, 60.0, 1.5, 60.0, None)
    plan = plan_transition(CROSSFADE, OUT, IN, out, inn)
    assert plan.kind == "crossfade"
    assert plan.out_end == 236.0 and plan.out_start == 226.0 and plan.in_start == 1.5
    assert plan.swap_at == 5.0


def test_without_any_analysis_a_crossfade_runs_on_the_metadata():
    plan = plan_transition(CROSSFADE, OUT, IN)
    assert (plan.out_start, plan.out_end, plan.in_start) == (230.0, 240.0, 0.0)


def test_a_very_short_song_is_never_more_than_half_faded():
    short = SongFacts(6.0)
    plan = plan_transition(CROSSFADE, short, IN, RegionAnalysis(0, 6, 0, 6, None))
    assert plan.overlap == 3.0
