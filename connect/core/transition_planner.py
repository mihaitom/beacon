"""core/transition_planner.py — how one song turns into the next.

A pure function of what is known about both songs (core/beat_analysis.py)
and the listener's setting; core/mix_engine.py carries the plan out. Three
kinds of plan:

- **gapless**: the next song follows on the sample the last one ends. What
  the "gapless" setting always does, and what crossfade does too between
  two songs that follow each other on an album - they were made to run
  into each other.
- **beatmix**, the DJ's way, when both songs have a beat grid that can be
  trusted and tempos within reach of each other:
  - the overlap is a whole number of bars and ends on a downbeat of the
    song going out, where its beat ends - an ambient tail after it is cut;
  - the old song eases into the new one's tempo over a few bars before
    the overlap and holds it to the end (core/timestretch.py); the new
    song is never stretched, so once it has taken over, it plays untouched;
  - the incoming song's first downbeat lands on the overlap's first one -
    and where its beat only sets in after an intro, it starts late enough
    for the beat to set in on the bass swap, as a DJ would;
  - its mids and highs come up over the first half of the bars set while
    its bass stays out; on the downbeat halfway through, the basses swap;
    then the old song's mids and highs go within POST_SWAP_BARS - held
    longer, two songs' voices and chords pile up once the new one has
    taken over;
  - where the incoming song's singing starts (its first synced lyric line)
    is known and within reach, the overlap ends on it instead, so the
    new voice comes in the moment the old song is gone - and where it
    starts early, the whole mix shortens to end there;
  - around the swap, where both songs are fullest, both songs' mids dip
    by MID_DIP_DB: that is where voices and chords sit.
- **crossfade**: the same moves on a clock instead of a beat grid, for
  songs that have none or whose tempos are too far apart. Silence at the
  end of the old song and the start of the new one is skipped either way,
  and one that would run into the incoming singing ends where it starts.

Times in a plan: `out_*`/`in_*` are seconds in each song's own timeline,
everything else is seconds from the start of the overlap.
"""

from dataclasses import dataclass, field, replace
from itertools import pairwise
from typing import Literal

import numpy as np

from .beat_analysis import BeatGrid, RegionAnalysis

Kind = Literal["gapless", "crossfade", "beatmix"]
# Why a crossfade is not a beatmix, for the listener to see:
# - no_analysis: the songs could not be analysed (or not in time, see
#   core/mix_engine.py's analysis_late);
# - no_beat / unsure_beat: one of them has no beat grid, or one too unsure;
# - tempo_apart: the tempos lie further apart than MAX_STRETCH;
# - no_room: no downbeat to end or join on, or too little song for a bar;
# - too_late: the plan came after its ease should have begun.
NoBeatmix = Literal[
    "no_analysis",
    "analysis_late",
    "no_beat",
    "unsure_beat",
    "tempo_apart",
    "no_room",
    "too_late",
]
Band = Literal["low", "mid", "high"]
BANDS: tuple[Band, ...] = ("low", "mid", "high")

# Below this, a grid is not trusted for lining songs up.
MIN_CONFIDENCE = 0.5
# How far the tempos may lie apart for the outgoing song to be sped up or
# slowed down to match: beyond about this, a stretch is heard as one. On a
# drum loop 8 % passed; with voices or synths it did not - a soul ballad
# at 6.2 % was heard as too slow and grainy, synth-pop at 4.5 % with
# artefacts, house at 2.4 % clean (docs/investigations/beatmix-pop-rock.md).
MAX_STRETCH = 0.03
# The bass swap is a cut, not a fade: this short, so it clicks neither.
SWAP_SECONDS = 0.015
# How many bars the outgoing song takes to ease into the incoming tempo -
# and at the least, for a plan that arrived after its ease should have
# begun: eased faster, the change of tempo is heard as one.
EASE_BARS = 8
MIN_EASE_BARS = 2
# A preview does not stretch: its excerpts are too short for an ease, and
# should sound as the songs do. Unstretched, two beat grids drift apart by
# the tempo difference - 0.5 % is 10 ms two seconds into the overlap, by
# the bass swap, just under where kicks start to flam (~12 ms).
PREVIEW_MAX_DRIFT = 0.005
# Overlap lengths a beatmix chooses between, in bars: the incoming song
# comes in over the first half...
_BAR_CHOICES = (16, 8, 4, 2, 1)
# ...and after the bass swap the outgoing one is gone within this many -
# up to _VOCAL_REACH_BARS where that ends it on the incoming singing.
POST_SWAP_BARS = 2
_VOCAL_REACH_BARS = 4
# Both songs' mids around the swap: down this far at it, over a bar either
# side (a quarter of a crossfade). The figure is pyCrossfade's.
MID_DIP_DB = 6.0
_DIP_CROSSFADE_SHARE = 0.25
# Never more of either song than this share of what was analysed.
_MAX_SHARE = 0.5
# beat_end lies on a downbeat of the same grid; this keeps float rounding
# from counting it as just short of one.
_ON_DOWNBEAT = 0.01
# Points per fade curve; between them the engine interpolates linearly.
_CURVE_POINTS = 33


@dataclass(frozen=True)
class Settings:
    mode: str = "gapless"
    # The longest overlap of a crossfade, and the bars a beatmix is set to:
    # half of them up to its bass swap, then a short fade (overlap_bars()),
    # fewer where the songs leave no room. Without bars (a preview) a
    # beatmix is as many whole bars as fit the crossfade's length.
    crossfade_seconds: float = 10.0
    beatmix_bars: int | None = None
    # A preview of excerpts (core/preview.py): always blended, album
    # neighbours too, and never stretched - see PREVIEW_MAX_DRIFT.
    preview: bool = False

    @property
    def longest_seconds(self) -> float:
        """The longest overlap either kind may take: a beatmix's counted at
        120 BPM, two seconds a bar - a slower one is cut down to fewer
        bars by the songs' own room rather than planned any earlier."""
        bars = overlap_bars(self.beatmix_bars, self.preview) if self.beatmix_bars else 0
        beatmix = bars * 2.0
        return max(self.crossfade_seconds, beatmix)


def overlap_bars(n: int, preview: bool = False) -> int:
    """Bars a beatmix of `n` set really overlaps: the first half, then the
    outgoing song's fade after the swap. A preview keeps the other half
    too - its excerpts are mid-song throughout, with no end to cut to."""
    if n == 1 or preview:
        return n
    return n // 2 + min(n - n // 2, POST_SWAP_BARS)


@dataclass(frozen=True)
class SongFacts:
    """What the planner knows of one song without analysing it."""

    duration: float
    album_id: str | None = None
    disc: int | None = None
    track: int | None = None
    # Where it starts playing: 0, or an excerpt's start (core/preview.py).
    start: float = 0.0


@dataclass(frozen=True)
class Lane:
    """A gain over the overlap: `times` (seconds from its start) to
    `gains`, linear in between, held flat beyond both ends."""

    times: tuple[float, ...]
    gains: tuple[float, ...]


@dataclass(frozen=True)
class TransitionPlan:
    kind: Kind
    # Where the overlap begins in the outgoing song, and where it is cut.
    out_start: float
    out_end: float
    # Where the incoming song is when the overlap begins.
    in_start: float
    overlap: float = 0.0
    # When, into the overlap, the incoming song counts as playing.
    swap_at: float = 0.0
    out_lanes: dict[str, Lane] = field(default_factory=dict)
    in_lanes: dict[str, Lane] = field(default_factory=dict)
    # Outgoing song seconds per stream second: (time from overlap start,
    # rate) points, linear in between, 1 outside them. The ease into the
    # incoming tempo lies before the overlap, at negative times.
    out_rate: tuple[tuple[float, float], ...] = ()
    bpm_out: float | None = None
    bpm_in: float | None = None
    # On a crossfade: why it is not a beatmix.
    no_beatmix: NoBeatmix | None = None

    @property
    def stretch_start(self) -> float:
        """Where in the outgoing song the plan takes over from plain
        playback: the start of the ease, or the overlap without one."""
        if not self.out_rate:
            return self.out_start
        return self.out_start - song_seconds(self.out_rate, self.out_rate[0][0], 0.0)


def follows_on_album(out: SongFacts, inn: SongFacts) -> bool:
    """`inn` is the next track after `out` on the same album."""
    if not out.album_id or out.album_id != inn.album_id or out.track is None or inn.track is None:
        return False
    out_disc, in_disc = out.disc or 1, inn.disc or 1
    if in_disc == out_disc:
        return inn.track == out.track + 1
    return in_disc == out_disc + 1 and inn.track == 1


def gapless(out: SongFacts, inn: SongFacts) -> TransitionPlan:
    return TransitionPlan("gapless", out.duration, out.duration, inn.start)


def plan_transition(
    settings: Settings,
    out: SongFacts,
    inn: SongFacts,
    out_region: RegionAnalysis | None = None,
    in_region: RegionAnalysis | None = None,
    in_vocals: float | None = None,
) -> TransitionPlan:
    """`in_vocals`: where in the incoming song its singing starts, if known."""
    if settings.mode != "crossfade" or (not settings.preview and follows_on_album(out, inn)):
        return gapless(out, inn)
    beatmix = _beatmix(settings, out_region, in_region, in_vocals)
    if isinstance(beatmix, TransitionPlan):
        return beatmix
    plan = _crossfade(settings, out, inn, out_region, in_region, in_vocals)
    if plan.kind != "crossfade":
        return plan
    plan = replace(plan, no_beatmix=beatmix)
    if beatmix == "tempo_apart":
        # Both grids are there to get this far; told to show how far apart.
        assert out_region and out_region.grid and in_region and in_region.grid
        plan = replace(plan, bpm_out=out_region.grid.bpm, bpm_in=in_region.grid.bpm)
    return plan


def _crossfade(
    settings: Settings,
    out: SongFacts,
    inn: SongFacts,
    out_region: RegionAnalysis | None,
    in_region: RegionAnalysis | None,
    in_vocals: float | None = None,
) -> TransitionPlan:
    out_end = out_region.sound_end if out_region else out.duration
    in_start = in_region.sound_start if in_region else inn.start
    available = out_end - (out_region.start if out_region else 0.0)
    overlap = max(0.0, min(settings.crossfade_seconds, available * _MAX_SHARE))
    if in_region is not None:
        overlap = min(overlap, (in_region.end - in_start) * _MAX_SHARE)
    if in_vocals is not None and not settings.preview:
        # Over by the time the singing starts - but no shorter than half
        # the length, which would be a cut more than a fade.
        until = in_vocals - in_start
        if overlap / 2 <= until < overlap:
            overlap = until
    if overlap < 0.5:
        return TransitionPlan("gapless", out_end, out_end, in_start)
    return _crossfade_over(out_end, in_start, overlap)


def ease_from(plan: TransitionPlan, position: float) -> TransitionPlan | None:
    """The same beatmix, its ease begun at `position` (seconds in the
    outgoing song) and so shorter - for a plan that arrived after its ease
    should have begun. None when that leaves under MIN_EASE_BARS."""
    if not plan.out_rate or plan.bpm_out is None:
        return None
    room = plan.out_start - position
    if room < MIN_EASE_BARS * 4 * 60 / plan.bpm_out:
        return None
    rate = plan.out_rate[-1][1]
    # Song advances (1 + rate) / 2 per stream second through the ease.
    ease = room * 2 / (1 + rate)
    return replace(plan, out_rate=((-ease, 1.0), (0.0, rate), (plan.overlap, rate)))


def as_crossfade(settings: Settings, plan: TransitionPlan) -> TransitionPlan:
    """A beatmix as an ordinary crossfade, between the same two points - for
    one that arrived after its ease should have begun. Unmatched, its beat
    grid means nothing, and neither does its length in bars."""
    late = _crossfade_over(plan.out_end, plan.in_start, settings.crossfade_seconds)
    return replace(late, no_beatmix="too_late")


def _crossfade_over(out_end: float, in_start: float, overlap: float) -> TransitionPlan:
    swap = overlap / 2
    return TransitionPlan(
        "crossfade",
        out_start=out_end - overlap,
        out_end=out_end,
        in_start=in_start,
        overlap=overlap,
        swap_at=swap,
        out_lanes=_out_lanes(swap, overlap, dip=overlap * _DIP_CROSSFADE_SHARE),
        in_lanes=_in_lanes(swap, dip=overlap * _DIP_CROSSFADE_SHARE),
    )


def stretch_for(out: BeatGrid, inn: BeatGrid) -> float | None:
    """The rate to play the outgoing song at so its beat matches the
    incoming one's - counting the incoming beats as they are, doubled or
    halved, whichever needs least - or None when even that is too far."""
    best = None
    for factor in (1.0, 2.0, 0.5):
        rate = out.period / (inn.period / factor)
        if best is None or abs(rate - 1) < abs(best - 1):
            best = rate
    return best if best is not None and abs(best - 1) <= MAX_STRETCH else None


def _beatmix(
    settings: Settings,
    out_region: RegionAnalysis | None,
    in_region: RegionAnalysis | None,
    in_vocals: float | None = None,
) -> TransitionPlan | NoBeatmix:
    if out_region is None or in_region is None:
        return "no_analysis"
    out, inn = out_region.grid, in_region.grid
    if out is None or inn is None:
        return "no_beat"
    if min(out.confidence, inn.confidence) < MIN_CONFIDENCE:
        return "unsure_beat"
    rate = stretch_for(out, inn)
    if rate is None:
        return "tempo_apart"
    if settings.preview:
        if abs(rate - 1) > PREVIEW_MAX_DRIFT:
            return "tempo_apart"
        rate = 1.0
    # A bar in each song's own time, and in the stream's through the
    # overlap - where the outgoing song plays at the incoming tempo.
    bar = 4 * out.period
    stream_bar = bar / rate
    # The overlap ends on the last downbeat the outgoing song's beat reaches;
    # an ambient tail after it is cut, as a DJ would.
    music_end = out_region.sound_end
    if out_region.beat_end is not None:
        music_end = min(music_end, out_region.beat_end + _ON_DOWNBEAT)
    ends = out.downbeats(out_region.start, music_end)
    if len(ends) == 0:
        return "no_room"
    out_end = float(ends[-1])
    # The incoming song joins on its first downbeat with music - one a hair
    # before the sound counts, but never one before the song itself: a deck
    # cannot start ahead of its start, and would play the whole mix that
    # far off the beat.
    starts = inn.downbeats(max(in_region.sound_start - 0.05, in_region.start), in_region.end)
    if len(starts) == 0:
        return "no_room"
    first = float(starts[0])
    out_room = out_end - out_region.start

    def joins_at(n: int) -> float:
        """Where the incoming song joins an overlap of `n` bars: late enough
        for its beat to set in on the swap - never before its music."""
        if in_region.beat_start is None or settings.preview:
            return first
        at = in_region.beat_start - (n // 2) * stream_bar
        on = inn.downbeats(first, at + _ON_DOWNBEAT)
        return float(on[-1]) if len(on) else first

    def as_set(n: int) -> bool:
        if settings.beatmix_bars:
            return n <= settings.beatmix_bars
        return n * stream_bar <= max(settings.crossfade_seconds, stream_bar)

    bars = next(
        (
            n
            for n in _BAR_CHOICES
            if as_set(n)
            and overlap_bars(n, settings.preview) * bar <= out_room
            and overlap_bars(n, settings.preview) * stream_bar <= in_region.end - joins_at(n)
        ),
        None,
    )
    if bars is None:
        return "no_room"
    in_start = joins_at(bars)
    before, total = bars // 2, overlap_bars(bars, settings.preview)
    if in_vocals is not None and bars > 1 and not settings.preview:
        # Moved only where the incoming beat is not set to start on the swap.
        late_join = in_start > first
        fit = _vocal_fit(bars, round((in_vocals - in_start) / stream_bar), late_join)
        if fit and fit[1] * bar <= out_room and fit[1] * stream_bar <= in_region.end - in_start:
            before, total = fit
    out_start = out_end - total * bar
    overlap = total * stream_bar
    # On a downbeat - halfway into the bars set, or for a one-bar mix on
    # its third beat.
    swap = before * stream_bar if bars > 1 else stream_bar / 2
    out_rate: tuple[tuple[float, float], ...] = ()
    if rate != 1.0:
        # The ease runs through song the analysis has covered, so the plan
        # is there before it begins; it plays (1 + rate) / 2 song per second.
        ease = min(EASE_BARS * bar, (out_start - out_region.start) * 2 / (1 + rate))
        out_rate = ((-ease, 1.0),) if ease > 0 else ()
        out_rate += ((0.0, rate), (overlap, rate))
    return TransitionPlan(
        "beatmix",
        out_start=out_start,
        out_end=out_end,
        in_start=in_start,
        overlap=overlap,
        swap_at=swap,
        out_lanes=_out_lanes(swap, overlap, dip=stream_bar),
        in_lanes=_in_lanes(swap, dip=stream_bar),
        out_rate=out_rate,
        bpm_out=out.bpm,
        bpm_in=inn.bpm,
    )


def _vocal_fit(bars: int, sung: int, late_join: bool) -> tuple[int, int] | None:
    """(bars before the swap, bars in all) for a mix of `bars` set whose
    incoming singing starts `sung` bars into the overlap - ending the
    overlap on it - or None where it cannot."""
    before = bars // 2
    reach = min(_VOCAL_REACH_BARS, bars - before)
    if before < sung <= before + reach:
        return before, sung
    # Singing before the swap: the mix shortens to end on it, its swap a
    # bar ahead - unless the beat is set to start on the swap.
    if 2 <= sung <= before and not late_join:
        return sung - 1, sung
    return None


def _curve(start: float, end: float, rising: bool) -> Lane:
    x = np.linspace(0.0, 1.0, _CURVE_POINTS)
    gains = np.sin(x * np.pi / 2) if rising else np.cos(x * np.pi / 2)
    times = start + x * (end - start)
    return Lane(tuple(float(t) for t in times), tuple(float(g) for g in gains))


def _step(at: float, rising: bool) -> Lane:
    before, after = (0.0, 1.0) if rising else (1.0, 0.0)
    return Lane((at, at + SWAP_SECONDS), (before, after))


def _dipped(lane: Lane, swap: float, width: float) -> Lane:
    """`lane` with MID_DIP_DB taken out around `swap`, a raised cosine
    `width` either side of it."""
    x = np.linspace(-1.0, 1.0, _CURVE_POINTS)
    times = np.union1d(lane.times, swap + x * width)
    depth = 1.0 - 10 ** (-MID_DIP_DB / 20)
    near = np.clip(np.abs(times - swap) / width, 0.0, 1.0)
    dip = 1.0 - depth * 0.5 * (1.0 + np.cos(np.pi * near))
    gains = np.interp(times, lane.times, lane.gains) * dip
    return Lane(tuple(float(t) for t in times), tuple(float(g) for g in gains))


def _in_lanes(swap: float, dip: float) -> dict[str, Lane]:
    """Mids and highs come up until the swap; the bass comes in on it."""
    rise = _curve(0.0, swap, rising=True)
    return {"low": _step(swap, rising=True), "mid": _dipped(rise, swap, dip), "high": rise}


def _out_lanes(swap: float, overlap: float, dip: float) -> dict[str, Lane]:
    """The bass goes on the swap; mids and highs fade out after it."""
    fall = _curve(swap, overlap, rising=False)
    return {"low": _step(swap, rising=False), "mid": _dipped(fall, swap, dip), "high": fall}


def rate_at(points: tuple[tuple[float, float], ...], t: float) -> float:
    """The stretched song's rate `t` seconds from the overlap's start."""
    if not points or t < points[0][0] or t >= points[-1][0]:
        return 1.0
    return float(np.interp(t, [p[0] for p in points], [p[1] for p in points]))


def song_seconds(points: tuple[tuple[float, float], ...], a: float, b: float) -> float:
    """How far the stretched song advances from stream time `a` to `b`
    (seconds from the overlap's start): the rate's integral, exact for a
    rate that is linear between its points."""
    if b < a:
        return -song_seconds(points, b, a)
    times = [p[0] for p in points]
    edges = [a, *(x for x in times if a < x < b), b]
    total = 0.0
    for x0, x1 in pairwise(edges):
        if not points or x1 <= times[0] or x0 >= times[-1]:
            total += x1 - x0
        else:
            rates = np.interp([x0, x1], times, [p[1] for p in points])
            total += (x1 - x0) * float(rates[0] + rates[1]) / 2
    return total


def crossfade_from(
    settings: Settings, position: float, out_end: float, in_start: float
) -> TransitionPlan | None:
    """A crossfade starting where the outgoing song already is - for a plan
    that arrived too late to start where it wanted to. None when there is
    too little of the song left to fade over."""
    overlap = min(settings.crossfade_seconds, out_end - position)
    if overlap < 1.0:
        return None
    swap = overlap / 2
    return TransitionPlan(
        "crossfade",
        out_start=position,
        out_end=position + overlap,
        in_start=in_start,
        overlap=overlap,
        swap_at=swap,
        out_lanes=_out_lanes(swap, overlap, dip=overlap * _DIP_CROSSFADE_SHARE),
        in_lanes=_in_lanes(swap, dip=overlap * _DIP_CROSSFADE_SHARE),
    )
