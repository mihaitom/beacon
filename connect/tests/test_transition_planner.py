"""Tests for core/transition_planner.py — how one song turns into the next."""

from dataclasses import replace

import numpy as np
import pytest

from core.beat_analysis import BeatGrid, RegionAnalysis
from core.transition_planner import (
    MAX_STRETCH,
    MIN_EASE_BARS,
    POST_SWAP_BARS,
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


def assert_bars(plan, n: int, bpm: float = 126.0) -> None:
    """`plan` is a beatmix of `n` bars set: the incoming song in for half
    of them before the bass swap, the outgoing one gone within
    POST_SWAP_BARS after it."""
    bar = 4 * 60 / bpm
    assert plan.swap_at == pytest.approx(n // 2 * bar)
    assert plan.overlap - plan.swap_at == pytest.approx(min(n - n // 2, POST_SWAP_BARS) * bar)


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


def test_voices_and_synths_are_not_stretched_audibly():
    """Heard: 6.2 % on a soul ballad too slow and grainy, 4.5 % on
    synth-pop with artefacts, 2.4 % on house clean
    (docs/investigations/beatmix-pop-rock.md)."""
    assert stretch_for(grid(106.3, 0, 0), grid(99.8, 0, 0)) is None
    assert stretch_for(grid(86.9, 0, 0), grid(83.0, 0, 0)) is None
    assert stretch_for(grid(125.0, 0, 0), grid(128.0, 0, 0)) is not None


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


def test_a_beatmix_ends_where_the_beat_does_not_in_an_ambient_tail():
    downbeat = float(out_region().grid.downbeats(220, 222)[0])
    # A hair short, as float rounding leaves it, still ends on that downbeat.
    region = replace(out_region(), beat_end=downbeat - 1e-9)
    plan = plan_transition(CROSSFADE, OUT, IN, region, in_region())
    assert plan.kind == "beatmix"
    assert plan.out_end == pytest.approx(downbeat)


def test_the_incoming_song_never_joins_before_its_own_start():
    """A downbeat a hair before the sound is fine to join on - unless that
    is before the song starts at all, where the deck would begin at its
    start instead and the whole mix play that far off the beat."""
    region = replace(in_region(downbeat=-0.03, sound_start=0.0), start=0.0)
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), region)
    assert plan.kind == "beatmix"
    assert plan.in_start == pytest.approx(-0.03 + 4 * 60 / 126)


def test_an_incoming_beat_after_an_intro_sets_in_on_the_bass_swap():
    downbeat = float(in_region().grid.downbeats(30, 32)[0])
    region = replace(in_region(), beat_start=downbeat - 1e-9)
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), region)
    assert plan.kind == "beatmix"
    assert plan.in_start + plan.swap_at == pytest.approx(downbeat)
    # Still on one of its downbeats.
    assert region.grid.downbeats(plan.in_start - 0.01, plan.in_start + 0.01).size == 1


def test_an_incoming_beat_from_the_start_joins_at_the_start():
    region = replace(in_region(), beat_start=2.4)
    plan = plan_transition(CROSSFADE, OUT, IN, out_region(), region)
    assert plan.in_start == pytest.approx(0.5)


def test_a_preview_keeps_its_excerpt_start_however_late_the_beat():
    preview = replace(CROSSFADE, preview=True)
    region = replace(in_region(bpm=128.0), beat_start=30.0)
    plan = plan_transition(preview, OUT, IN, out_region(), region)
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
    for band in ("mid", "high"):
        rise, fall = plan.in_lanes[band], plan.out_lanes[band]
        assert lane_at(rise, 0) == 0.0 and lane_at(fall, end) == pytest.approx(0.0, abs=1e-9)
    high_in, high_out = plan.in_lanes["high"], plan.out_lanes["high"]
    assert lane_at(high_in, swap) == pytest.approx(1.0) and lane_at(high_out, swap) == 1.0
    gains = [lane_at(high_in, t) for t in np.linspace(0, swap, 50)]
    assert gains == sorted(gains)


@pytest.mark.parametrize("bars", [None, 8])
def test_both_songs_mids_dip_at_the_swap_where_voices_pile_up(bars):
    """Where both songs play fullest, their mids - voices, chords - are
    taken down 6 dB each; away from it, and in the other bands, nothing."""
    settings = Settings("crossfade", 10.0, bars)
    for plan in (
        plan_transition(settings, OUT, IN, out_region(), in_region()),
        plan_transition(settings, OUT, IN),
    ):
        swap = plan.swap_at
        dipped = lane_at(plan.in_lanes["mid"], swap) / lane_at(plan.in_lanes["high"], swap)
        assert 20 * np.log10(dipped) == pytest.approx(-6.0, abs=0.1)
        out = lane_at(plan.out_lanes["mid"], swap) / lane_at(plan.out_lanes["high"], swap)
        assert 20 * np.log10(out) == pytest.approx(-6.0, abs=0.1)
        assert lane_at(plan.in_lanes["mid"], 0.0) == 0.0
        assert lane_at(plan.out_lanes["mid"], 0.0) == 1.0
        assert lane_at(plan.in_lanes["high"], swap) == pytest.approx(1.0)


# ── Ending on the incoming singing ─────────────────────────────────────────

BARS_8 = Settings("crossfade", 4.0, beatmix_bars=8)
IN_BAR = 4 * 60 / 126


def test_a_beatmix_ends_where_the_incoming_singing_starts():
    """Heard: the voice coming in as the old song goes beat an overlap that
    ended two bars after the swap, with the intro still running."""
    for sung_bar in (5, 6, 7, 8):
        vocals = 0.5 + sung_bar * IN_BAR - 0.3  # a pickup just before the downbeat
        plan = plan_transition(BARS_8, OUT, IN, out_region(), in_region(), vocals)
        assert plan.kind == "beatmix"
        assert plan.swap_at == pytest.approx(4 * IN_BAR)
        assert plan.in_start + plan.overlap == pytest.approx(0.5 + sung_bar * IN_BAR)
        # Still ending on the outgoing song's last downbeat with music.
        assert plan.out_end == pytest.approx(out_region().grid.downbeats(180, 238)[-1])


def test_singing_that_starts_early_shortens_the_whole_mix_to_end_on_it():
    vocals = 0.5 + 3 * IN_BAR
    plan = plan_transition(BARS_8, OUT, IN, out_region(), in_region(), vocals)
    assert plan.in_start + plan.overlap == pytest.approx(vocals)
    assert plan.swap_at == pytest.approx(2 * IN_BAR)


@pytest.mark.parametrize("sung_bar", [0, 1, 12, 30])
def test_singing_out_of_reach_leaves_the_mix_as_set(sung_bar):
    plan = plan_transition(BARS_8, OUT, IN, out_region(), in_region(), 0.5 + sung_bar * IN_BAR)
    assert_bars(plan, 8)


def test_a_beat_set_to_start_on_the_swap_keeps_its_swap():
    downbeat = float(in_region().grid.downbeats(30, 32)[0])
    region = replace(in_region(), beat_start=downbeat)
    early = plan_transition(BARS_8, OUT, IN, out_region(), region)
    vocals = early.in_start + 3 * IN_BAR
    plan = plan_transition(BARS_8, OUT, IN, out_region(), region, vocals)
    assert plan.in_start + plan.swap_at == pytest.approx(downbeat)
    assert_bars(plan, 8)


def test_a_crossfade_into_singing_ends_where_it_starts():
    plan = plan_transition(CROSSFADE, OUT, IN, in_vocals=7.0)
    assert plan.kind == "crossfade" and plan.in_start + plan.overlap == pytest.approx(7.0)
    # Never under half its length: that would be a cut.
    short = plan_transition(CROSSFADE, OUT, IN, in_vocals=3.0)
    assert short.overlap == pytest.approx(10.0)


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
    assert_bars(plan, 16)
    short = plan_transition(Settings("crossfade", 2.0), OUT, IN, out_region(), in_region())
    assert short.overlap == pytest.approx(4 * 60 / 126)  # never under one bar


def test_a_beatmix_lasts_the_bars_set_and_a_crossfade_its_own_length():
    for n in (4, 8, 16):
        settings = Settings("crossfade", crossfade_seconds=4.0, beatmix_bars=n)
        beatmix = plan_transition(settings, OUT, IN, out_region(), in_region())
        assert beatmix.kind == "beatmix"
        assert_bars(beatmix, n)
    crossfade = plan_transition(settings, OUT, IN)
    assert crossfade.kind == "crossfade" and crossfade.overlap == pytest.approx(4.0)


def test_a_beatmix_with_too_little_song_for_its_bars_takes_fewer():
    # 16 bars at 70 BPM are 55 s, more than the incoming 60 s leave once a
    # region of 30 s is all there is.
    settings = Settings("crossfade", crossfade_seconds=4.0, beatmix_bars=16)
    short_in = RegionAnalysis(0.0, 30.0, 0.4, 30.0, grid(70.0, 0.5, 0.5))
    plan = plan_transition(settings, OUT, IN, out_region(bpm=70.5), short_in)
    assert plan.kind == "beatmix"
    assert_bars(plan, 8, bpm=70.0)


def test_without_bars_a_beatmix_takes_the_crossfade_length():
    plan = plan_transition(Settings("crossfade", 31.0), OUT, IN, out_region(), in_region())
    assert_bars(plan, 16)


def test_after_the_swap_the_outgoing_song_is_gone_within_two_bars():
    """Held for the second half of a long overlap, two songs' voices pile
    up once the new one has taken over."""
    settings = Settings("crossfade", crossfade_seconds=4.0, beatmix_bars=16)
    plan = plan_transition(settings, OUT, IN, out_region(), in_region())
    bar = 4 * 60 / 126
    gone = plan.swap_at + 2 * bar
    assert lane_at(plan.out_lanes["mid"], gone) == pytest.approx(0.0, abs=1e-9)
    assert plan.overlap == pytest.approx(gone)
    # Still ending on the last downbeat with music, still on the incoming tempo.
    assert plan.out_end == pytest.approx(out_region().grid.downbeats(180, 238)[-1])
    assert plan.out_start + song_seconds(plan.out_rate, 0.0, plan.overlap) == pytest.approx(
        plan.out_end
    )


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
