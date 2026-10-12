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
    song going out, where its music ends;
  - the old song eases into the new one's tempo over a few bars before
    the overlap and holds it to the end (core/timestretch.py); the new
    song is never stretched, so once it has taken over, it plays untouched;
  - the incoming song's first downbeat lands on the overlap's first one;
  - for the first half its mids and highs come up while its bass stays
    out; on the downbeat halfway through, the basses swap; for the second
    half the old song's mids and highs go.
- **crossfade**: the same moves on a clock instead of a beat grid, for
  songs that have none or whose tempos are too far apart. Silence at the
  end of the old song and the start of the new one is skipped either way.

Times in a plan: `out_*`/`in_*` are seconds in each song's own timeline,
everything else is seconds from the start of the overlap.
"""

from dataclasses import dataclass, field, replace
from itertools import pairwise
from typing import Literal

import numpy as np

from .beat_analysis import BeatGrid, RegionAnalysis

Kind = Literal["gapless", "crossfade", "beatmix"]
Band = Literal["low", "mid", "high"]
BANDS: tuple[Band, ...] = ("low", "mid", "high")

# Below this, a grid is not trusted for lining songs up.
MIN_CONFIDENCE = 0.5
# How far the tempos may lie apart for the outgoing song to be sped up or
# slowed down to match: beyond about this, a stretch is heard as one.
MAX_STRETCH = 0.08
# The bass swap is a cut, not a fade: this short, so it clicks neither.
SWAP_SECONDS = 0.015
# How many bars the outgoing song takes to ease into the incoming tempo.
EASE_BARS = 8
# Overlap lengths a beatmix chooses between, in bars.
_BAR_CHOICES = (16, 8, 4, 2, 1)
# Never more of either song than this share of what was analysed.
_MAX_SHARE = 0.5
# Points per fade curve; between them the engine interpolates linearly.
_CURVE_POINTS = 33


@dataclass(frozen=True)
class Settings:
    mode: str = "gapless"
    crossfade_seconds: float = 10.0


@dataclass(frozen=True)
class SongFacts:
    """What the planner knows of one song without analysing it."""

    duration: float
    album_id: str | None = None
    disc: int | None = None
    track: int | None = None


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

    @property
    def stretch_start(self) -> float:
        """Where in the outgoing song the plan takes over from plain
        playback: the start of the ease, or the overlap without one."""
        if not self.out_rate:
            return self.out_start
        return self.out_start - song_seconds(self.out_rate, self.out_rate[0][0], 0.0)

    def unstretched(self) -> "TransitionPlan":
        """The same blend as an ordinary crossfade - for a plan that
        arrived after its ease should have begun."""
        return replace(self, kind="crossfade", out_rate=())


def follows_on_album(out: SongFacts, inn: SongFacts) -> bool:
    """`inn` is the next track after `out` on the same album."""
    if not out.album_id or out.album_id != inn.album_id or out.track is None or inn.track is None:
        return False
    out_disc, in_disc = out.disc or 1, inn.disc or 1
    if in_disc == out_disc:
        return inn.track == out.track + 1
    return in_disc == out_disc + 1 and inn.track == 1


def gapless(out: SongFacts) -> TransitionPlan:
    return TransitionPlan("gapless", out.duration, out.duration, 0.0)


def plan_transition(
    settings: Settings,
    out: SongFacts,
    inn: SongFacts,
    out_region: RegionAnalysis | None = None,
    in_region: RegionAnalysis | None = None,
) -> TransitionPlan:
    if settings.mode != "crossfade" or follows_on_album(out, inn):
        return gapless(out)
    beatmix = _beatmix(settings, out_region, in_region)
    if beatmix is not None:
        return beatmix
    return _crossfade(settings, out, out_region, in_region)


def _crossfade(
    settings: Settings,
    out: SongFacts,
    out_region: RegionAnalysis | None,
    in_region: RegionAnalysis | None,
) -> TransitionPlan:
    out_end = out_region.sound_end if out_region else out.duration
    in_start = in_region.sound_start if in_region else 0.0
    available = out_end - (out_region.start if out_region else 0.0)
    overlap = max(0.0, min(settings.crossfade_seconds, available * _MAX_SHARE))
    if in_region is not None:
        overlap = min(overlap, (in_region.end - in_start) * _MAX_SHARE)
    if overlap < 0.5:
        return TransitionPlan("gapless", out_end, out_end, in_start)
    swap = overlap / 2
    return TransitionPlan(
        "crossfade",
        out_start=out_end - overlap,
        out_end=out_end,
        in_start=in_start,
        overlap=overlap,
        swap_at=swap,
        out_lanes=_out_lanes(swap, overlap),
        in_lanes=_in_lanes(swap),
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
    settings: Settings, out_region: RegionAnalysis | None, in_region: RegionAnalysis | None
) -> TransitionPlan | None:
    if out_region is None or in_region is None:
        return None
    out, inn = out_region.grid, in_region.grid
    if out is None or inn is None:
        return None
    if min(out.confidence, inn.confidence) < MIN_CONFIDENCE:
        return None
    rate = stretch_for(out, inn)
    if rate is None:
        return None
    # A bar in each song's own time, and in the stream's through the
    # overlap - where the outgoing song plays at the incoming tempo.
    bar = 4 * out.period
    stream_bar = bar / rate
    # The overlap ends on the last downbeat the outgoing song's music reaches.
    ends = out.downbeats(out_region.start, out_region.sound_end)
    if len(ends) == 0:
        return None
    out_end = float(ends[-1])
    # The incoming song joins on its first downbeat with music.
    starts = inn.downbeats(in_region.sound_start - 0.05, in_region.end)
    if len(starts) == 0:
        return None
    in_start = float(starts[0])
    in_room = in_region.end - in_start
    out_room = out_end - out_region.start
    bars = next(
        (
            n
            for n in _BAR_CHOICES
            if n * stream_bar <= max(settings.crossfade_seconds, stream_bar)
            and n * bar <= out_room
            and n * stream_bar <= in_room
        ),
        None,
    )
    if bars is None:
        return None
    out_start = out_end - bars * bar
    overlap = bars * stream_bar
    # Halfway, on a downbeat - or for a one-bar mix, on its third beat.
    swap = (bars // 2) * stream_bar if bars > 1 else stream_bar / 2
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
        out_lanes=_out_lanes(swap, overlap),
        in_lanes=_in_lanes(swap),
        out_rate=out_rate,
        bpm_out=out.bpm,
        bpm_in=inn.bpm,
    )


def _curve(start: float, end: float, rising: bool) -> Lane:
    x = np.linspace(0.0, 1.0, _CURVE_POINTS)
    gains = np.sin(x * np.pi / 2) if rising else np.cos(x * np.pi / 2)
    times = start + x * (end - start)
    return Lane(tuple(float(t) for t in times), tuple(float(g) for g in gains))


def _step(at: float, rising: bool) -> Lane:
    before, after = (0.0, 1.0) if rising else (1.0, 0.0)
    return Lane((at, at + SWAP_SECONDS), (before, after))


def _in_lanes(swap: float) -> dict[str, Lane]:
    """Mids and highs come up until the swap; the bass comes in on it."""
    rise = _curve(0.0, swap, rising=True)
    return {"low": _step(swap, rising=True), "mid": rise, "high": rise}


def _out_lanes(swap: float, overlap: float) -> dict[str, Lane]:
    """The bass goes on the swap; mids and highs fade out after it."""
    fall = _curve(swap, overlap, rising=False)
    return {"low": _step(swap, rising=False), "mid": fall, "high": fall}


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
        out_lanes=_out_lanes(swap, overlap),
        in_lanes=_in_lanes(swap),
    )
