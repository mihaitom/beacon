"""core/preview.py — previewing an album or playlist: an excerpt of a few
of its songs, mixed into each other (docs/plans/preview-with-transitions.md).

The tab picks the songs. This picks which part of each one plays - by its
waveform, the loudest stretch away from intro and outro, which is most
often the chorus or the drop - and hands the mix one excerpt after the
other until the list ends.
"""

import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Any

import numpy as np

from . import waveform
from .local_mixes import SongEntry
from .mix_engine import MixItem
from .transition_planner import Settings

EXCERPT_SECONDS = 20.0
# Shorter than a song transition: two excerpts taken mid-song are both
# full, and a long overlap of the two turns to mush.
OVERLAP_SECONDS = 4.0
SETTINGS = Settings("crossfade", OVERLAP_SECONDS, preview=True)
# Where in a song an excerpt may lie, as shares of its length: clear of
# intro and outro.
_WINDOW = (0.2, 0.8)
# Without a waveform: a fixed point, past the first verse in most songs.
_FALLBACK_AT = 0.35
# A brickwalled master peaks near full scale almost throughout, so windows
# this close to the loudest count as equally loud...
_TIE = 0.02
# ...and the one nearest this point is taken.
_PREFER_AT = 0.4


def pick_excerpt(
    peaks: list[float], duration: float, length: float = EXCERPT_SECONDS
) -> tuple[float, float]:
    """(start, end) of the excerpt to play, in seconds of the song. `peaks`
    spread evenly over `duration`, as core/waveform.py makes them."""
    if duration <= 0:
        return 0.0, length
    if duration <= length:
        return 0.0, duration
    lo, hi = duration * _WINDOW[0], duration * _WINDOW[1]
    if hi - lo < length:
        start = (duration - length) / 2
        return start, start + length
    start = _loudest_start(peaks, duration, length, lo, hi)
    if start is None:
        start = min(max(duration * _FALLBACK_AT, lo), hi - length)
    return start, start + length


def _loudest_start(
    peaks: list[float], duration: float, length: float, lo: float, hi: float
) -> float | None:
    if not peaks:
        return None
    per = duration / len(peaks)
    width = max(1, round(length / per))
    first, last = math.ceil(lo / per), math.floor(hi / per) - width
    if last < first:
        return None
    sums = np.concatenate([[0.0], np.cumsum(np.asarray(peaks, dtype=np.float64))])
    means = (sums[first + width : last + width + 1] - sums[first : last + 1]) / width
    candidates = np.flatnonzero(means >= means.max() - _TIE) + first
    best = min(candidates, key=lambda i: abs(i * per - duration * _PREFER_AT))
    return float(best * per)


WaveformFn = Callable[[str, str], Awaitable[list[float]]]


@dataclass
class PreviewSongs:
    """The songs of one preview, in the order they play. An entry's
    `queue_index` is its place in this list - what the tab reads back from
    the timeline."""

    entries: list[SongEntry]
    url_fn: Callable[[MixItem], Awaitable[str | None]]
    # core/waveform.py's, looked up when used.
    waveform_fn: WaveformFn | None = None
    # How an entry becomes the whole song as a mix item - a cast needs the
    # media server's Track as its payload (routes/mix_cast.py).
    item_fn: Callable[[SongEntry], Awaitable[MixItem]] | None = None

    async def item(self, index: int) -> MixItem | None:
        """The excerpt to play of songs[index], or None past the last."""
        if not 0 <= index < len(self.entries):
            return None
        entry = self.entries[index]
        whole = await self.item_fn(entry) if self.item_fn else entry.item()
        url = await self.url_fn(whole)
        waveform_fn = self.waveform_fn or waveform.get_waveform
        peaks = await waveform_fn(whole.song_id, url) if url else []
        start, end = pick_excerpt(peaks, whole.duration)
        return replace(whole, start=start, end=end)

    async def next_item(self, current: MixItem) -> MixItem | None:
        return await self.item((current.queue_index or 0) + 1)


@dataclass
class CastPreview:
    """A preview playing on the session's speakers (routes/mix_cast.py), and
    what it interrupted: where the session goes back to, paused, when it
    ends. Track and OutputFormat are typed loosely to keep core/state.py
    free of this module."""

    songs: PreviewSongs
    index: int
    resume_track: Any
    resume_gain: float
    resume_format: Any
    resume_position: float
    # Whether the interrupted song was playing in a mix of its own.
    resume_mixed: bool

    def describe(self) -> dict:
        """For the status: which songs, which of them now, and where the
        queue's song will be."""
        return {
            "song_ids": [entry.id for entry in self.songs.entries],
            "index": self.index,
            "resume_at": self.resume_position,
        }
