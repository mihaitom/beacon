"""core/mix_timeline.py — which song a mixed stream plays at which moment.

A mix (core/mix_engine.py) is one stream that runs through song after song.
Its own time is **stream time**: sample frames written since the mix began.
A listener knows only that - a device reports how long it has been playing
the stream, a browser how far its <audio> has got - and the timeline turns
it back into the song and the position in it.

One entry per change: a song starting, a hold (the decoder could not keep
up, so the stream went on in silence while the song stood still), the end.
Positions are counted in frames too, so a song change sits on the exact
sample it happens at and nothing drifts by rounding.

`rate` is song time per stream time. It is 1 except while a song is being
stretched to another's tempo; a ramp is written as a run of short entries
rather than as a curve, which keeps the arithmetic here linear.
"""

from bisect import bisect_right
from dataclasses import dataclass
from typing import Any

SAMPLE_RATE = 44100

# How much stream time behind the newest entry is kept: a listener can be
# up to this far behind the mix's render head and still be told what it hears.
_KEEP_FRAMES = 300 * SAMPLE_RATE


@dataclass(frozen=True)
class TimelineEntry:
    """From `frame` on, the stream plays `song_id` from `position` (seconds
    into the song) at `rate`, or holds it there while not `playing`. A
    `song_id` of None after the start is the end of the mix."""

    frame: int
    song_id: str | None
    queue_index: int | None
    position: float
    playing: bool
    rate: float = 1.0
    # Whatever the owner attached to the song (the cast path's Track), handed
    # back when the song comes up so it never has to be looked up again.
    payload: Any = None
    # The song begins here, as opposed to going on after a hold. What tells
    # a song played again (repeat-one) from the same song carrying on.
    starts: bool = False

    @property
    def stream_time(self) -> float:
        return self.frame / SAMPLE_RATE


@dataclass(frozen=True)
class Heard:
    """What plays at one stream time."""

    entry: TimelineEntry
    position: float

    @property
    def song_id(self) -> str | None:
        return self.entry.song_id

    @property
    def queue_index(self) -> int | None:
        return self.entry.queue_index


class Timeline:
    def __init__(self) -> None:
        self._entries: list[TimelineEntry] = []
        self._frames: list[int] = []
        self.end_frame: int | None = None

    @property
    def entries(self) -> list[TimelineEntry]:
        return list(self._entries)

    @property
    def last(self) -> TimelineEntry | None:
        return self._entries[-1] if self._entries else None

    def mark(
        self,
        frame: int,
        song_id: str | None,
        queue_index: int | None,
        position: float,
        playing: bool,
        rate: float = 1.0,
        payload: Any = None,
        starts: bool = False,
    ) -> TimelineEntry:
        """Record a change at `frame`. Frames only ever move forward; a mark
        at the same frame as the last one replaces it."""
        if self._frames and frame < self._frames[-1]:
            raise ValueError(f"timeline went backwards: {frame} < {self._frames[-1]}")
        entry = TimelineEntry(frame, song_id, queue_index, position, playing, rate, payload, starts)
        if self._frames and frame == self._frames[-1]:
            self._entries[-1] = entry
        else:
            self._entries.append(entry)
            self._frames.append(frame)
        return entry

    def mark_end(self, frame: int) -> None:
        self.mark(frame, None, None, 0.0, playing=False)
        self.end_frame = frame

    def at(self, frame: int) -> Heard | None:
        """What plays at `frame`, or None before the first entry. Past the
        end marker it is the end marker itself."""
        i = bisect_right(self._frames, frame) - 1
        if i < 0:
            return None
        entry = self._entries[i]
        if not entry.playing:
            return Heard(entry, entry.position)
        return Heard(entry, entry.position + (frame - entry.frame) / SAMPLE_RATE * entry.rate)

    def at_time(self, stream_time: float) -> Heard | None:
        return self.at(round(stream_time * SAMPLE_RATE))

    def next_change(self, frame: int) -> TimelineEntry | None:
        """The first entry after `frame` that starts a song (or ends the
        mix) - what a follower waits for. Holds and rate steps within one
        song are not changes; the same song starting over is."""
        i = bisect_right(self._frames, frame)
        current = self._entries[i - 1] if i > 0 else None
        for entry in self._entries[i:]:
            if (
                current is None
                or entry.starts
                or entry.song_id != current.song_id
                or entry.queue_index != current.queue_index
            ):
                return entry
        return None

    def prune(self, before_frame: int) -> None:
        """Forget entries nobody can be listening at any more. The entry in
        force at `before_frame` is kept, since it still answers for it."""
        i = bisect_right(self._frames, before_frame) - 1
        if i > 0:
            del self._entries[:i]
            del self._frames[:i]

    def prune_behind(self, head_frame: int) -> None:
        self.prune(head_frame - _KEEP_FRAMES)

    def to_json(self) -> list[dict]:
        """For a listener that maps time itself (the local player)."""
        return [
            {
                "t": e.stream_time,
                "song_id": e.song_id,
                "queue_index": e.queue_index,
                "position": e.position,
                "playing": e.playing,
                "rate": e.rate,
                "start": e.starts,
            }
            for e in self._entries
        ]
