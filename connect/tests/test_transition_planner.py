"""Tests for core/transition_planner.py — how one song turns into the next."""

from dataclasses import replace

import numpy as np
import pytest

from core.beat_analysis import BeatGrid, RegionAnalysis
from core.transition_planner import (
    MAX_STRETCH,
    MIN_EASE_BARS,
    SWAP_SECONDS,
    Settings,
    SongFacts,
    as_crossfade,
    ease_from,
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
    mixed = plan_transition(CROSSFADE, OUT, IN, out_region(), in_region())
    assert mixed.kind == "beatmix" and mixed.no_beatmix is None
    weak = in_region(confidence=0.3)
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), weak)
    assert (plan.kind, plan.no_beatmix) == ("crossfade", "unsure_beat")
    far = in_region(bpm=100.0)
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), far)
    assert (plan.kind, plan.no_beatmix) == ("crossfade", "tempo_apart")
    # How far apart is told along.
    assert (plan.bpm_out, plan.bpm_in) == (pytest.approx(128.0), pytest.approx(100.0))
    plan = plan_transition(CROSSFADE, OUT, IN)
    assert (plan.kind, plan.no_beatmix) == ("crossfade", "no_analysis")
    beatless = replace(in_region(), grid=None)
    assert plan_transition(CROSSFADE, OUT, IN, out_region(), beatless).no_beatmix == "no_beat"


def test_a_beatmix_too_late_to_ease_says_so_as_a_crossfade():
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), in_region())
    late = as_crossfade(CROSSFADE, plan)
    assert (late.kind, late.no_beatmix) == ("crossfade", "too_late")


PREVIEW = Settings("crossfade", 4.0, preview=True)


def test_a_preview_blends_album_neighbours_too():
    out, inn = SongFacts(240.0, "a", 1, 3), SongFacts(200.0, "a", 1, 4)
    assert plan_transition(CROSSFADE, out, inn).kind == "gapless"
    assert plan_transition(PREVIEW, out, inn).kind == "crossfade"


def test_a_preview_beatmixes_only_tempos_that_need_no_stretch():
    close = plan_transition(PREVIEW, OUT, IN, out_region(128.0), in_region(128.4))
    assert close.kind == "beatmix" and close.out_rate == ()
    assert close.overlap <= 4.0
    # 128 into 126 would be eased into on a song; a preview has no room.
    apart = plan_transition(PREVIEW, OUT, IN, out_region(128.0), in_region(126.0))
    assert apart.kind == "crossfade"


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


def test_a_beatmix_and_a_crossfade_have_lengths_of_their_own():
    settings = Settings("crossfade", crossfade_seconds=4.0, beatmix_seconds=31.0)
    beatmix = plan_transition(settings, OUT, IN, out_region(), in_region())
    assert beatmix.kind == "beatmix"
    assert beatmix.overlap == pytest.approx(16 * 4 * 60 / 126)
    crossfade = plan_transition(settings, OUT, IN)
    assert crossfade.kind == "crossfade" and crossfade.overlap == pytest.approx(4.0)


def test_without_a_beatmix_length_a_beatmix_takes_the_crossfade_one():
    plan = plan_transition(Settings("crossfade", 31.0), OUT, IN, out_region(), in_region())
    assert plan.overlap == pytest.approx(16 * 4 * 60 / 126)


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


def test_a_late_ease_starts_where_the_song_is_and_keeps_the_rate():
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), in_region())
    assert plan.out_rate
    later = plan.stretch_start + 3.0
    shorter = ease_from(plan, later)
    assert shorter is not None
    assert shorter.stretch_start == pytest.approx(later)
    assert shorter.out_rate[-1] == plan.out_rate[-1]
    assert (shorter.out_start, shorter.overlap) == (plan.out_start, plan.overlap)


def test_a_late_ease_needs_two_bars():
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), in_region())
    bar = 4 * 60 / 128
    assert ease_from(plan, plan.out_start - MIN_EASE_BARS * bar - 0.01) is not None
    assert ease_from(plan, plan.out_start - MIN_EASE_BARS * bar + 0.01) is None
