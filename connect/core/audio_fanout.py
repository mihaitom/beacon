"""core/audio_fanout.py — one live audio stream, handed to many listeners.

The listener half of core/radio_relay.py, split out so the party's
listen-along broadcast (core/party_broadcast.py) serves its guests the same
way the relay serves a station: one encode, a queue per listener, a rolling
burst for whoever joins late, and a slow listener only ever losing its own
audio. Whoever owns the encoder feeds it with publish(); everything about
the listeners lives here.
"""

import asyncio
import time
from collections import deque
from collections.abc import Callable
from contextlib import suppress

# Generous on purpose: at the 8KiB chunks a relay reads, a queue this size
# holds roughly 33MB — about twenty minutes of 192kbps audio — before a
# subscriber that is never coming back starts costing memory instead of just
# falling behind. The old, much smaller value (64 - a few seconds) is what
# let a single burst overflow it and start dropping real audio bytes, which
# reads as stutter, not silence.
AUDIO_QUEUE_MAXSIZE = 4000

# The same fan-out, for a subscriber that would rather skip forward than
# fall behind: the visualizer's analyzer (core/visualizer_feed.py). A
# device must never lose a byte, so its queue is sized to outlast any
# burst — but for analysis, old audio is worthless. Buffering minutes of
# it and then racing to "catch up" is actively harmful: the catch-up runs
# with no pacing at all (_read_pcm()'s own lookahead cap only throttles
# running *ahead*, and a backlog is the other direction), so it decodes
# and FFTs at full CPU speed for as long as the backlog lasts, starving
# the event loop that device audio is also being paced on. Reported live
# 2026-09-03: a 10s device scan was enough to put the analyzer behind, and
# the recovery from it produced audible dropouts on the speaker plus a
# visualizer that stayed frozen — every frame it computed afterwards was
# minutes late and got dropped by _release_frames().
#
# A few seconds is all analysis can use. Beyond that the oldest bytes are
# dropped, not the newest (see publish()), so this subscriber stays at the
# live edge instead of accumulating a debt it can never usefully repay.
ANALYSIS_QUEUE_MAXSIZE = 48


def send_sentinel(q: "asyncio.Queue[bytes | None]") -> None:
    """Hand a subscriber the `None` that means "the stream has stopped for
    good". Has to arrive even on a queue that is already full, or the
    subscriber blocked on it never learns to stop waiting — and a full
    queue is an entirely expected state here, not an anomaly: publish()
    lets a slow subscriber's queue fill rather than stalling everyone else
    behind it. Dropping the oldest chunk to make room costs a reader that is
    already that far behind nothing it could still have played in time.
    (`get_nowait()` cannot fail after `full()` — there is no await between
    them for anything else to drain the queue.)"""
    if q.full():
        q.get_nowait()
    q.put_nowait(None)


class AudioFanout:
    """`burst_limits` returns the (seconds, bytes) the rolling burst is
    trimmed to, asked on every trim so the owner can change it at runtime.
    The burst is trimmed by age, which is playing time only because every
    owner paces its output at 1x.

    A chunk may carry a `tag` — the broadcast's stream time of its first
    sample — so a listener can be told where in the stream its own audio
    begins (start_tag()). The radio relay has no use for one."""

    def __init__(self, burst_limits: Callable[[], tuple[float, int]]) -> None:
        self._burst_limits = burst_limits
        self._subscribers: list[asyncio.Queue[bytes | None]] = []
        # id() of the subscribers that asked for `lossy` — identity is
        # exactly the question being asked.
        self._lossy: set[int] = set()
        # Tag of the first chunk each subscriber was handed, by id(); see
        # start_tag(). Holds None until that chunk exists.
        self._start_tags: dict[int, float | None] = {}
        # Since when nothing has been listening. Starts now rather than at
        # the first subscriber: a stream nobody ever connects to is exactly
        # as orphaned as one everybody has left.
        self.no_listeners_since: float | None = time.monotonic()
        self._burst: deque[tuple[float, bytes, float | None]] = deque()
        self.burst_bytes = 0
        self.stopped = False

    @property
    def subscribers(self) -> list["asyncio.Queue[bytes | None]"]:
        return self._subscribers

    def subscribe(
        self, *, lossy: bool = False, burst: bool = False
    ) -> "asyncio.Queue[bytes | None]":
        """One more reader of the stream. A `None` read from the queue means
        it has stopped for good.

        `lossy` is for a subscriber that wants the live edge rather than
        every byte (the visualizer's analyzer): a small queue whose *oldest*
        entries are dropped when it can't keep up. A player never does: a
        gap in its audio is audible.

        `burst` is the opposite request: hand me the last few seconds up
        front, so what I am playing has a buffer behind it."""
        maxsize = ANALYSIS_QUEUE_MAXSIZE if lossy else AUDIO_QUEUE_MAXSIZE
        q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=maxsize)
        if self.stopped:
            # A real race, not a caller mistake: a streaming response
            # subscribes once its generator is first iterated, by which
            # point the stream may have stopped. stop() has already handed
            # out its sentinels, so an ordinary subscription would wait on a
            # queue nothing will ever feed.
            q.put_nowait(None)
            return q
        self._subscribers.append(q)
        if lossy:
            self._lossy.add(id(q))
        self._start_tags[id(q)] = None
        self._note_listener_change()
        if burst:
            self._trim_burst()
            for _, chunk, tag in self._burst:
                if self._start_tags[id(q)] is None:
                    self._start_tags[id(q)] = tag
                with suppress(asyncio.QueueFull):
                    q.put_nowait(chunk)
        return q

    def unsubscribe(self, q: "asyncio.Queue[bytes | None]") -> None:
        if q in self._subscribers:
            self._subscribers.remove(q)
        self._lossy.discard(id(q))
        self._start_tags.pop(id(q), None)
        self._note_listener_change()

    def start_tag(self, q: "asyncio.Queue[bytes | None]") -> float | None:
        """Tag of the first chunk `q` was handed, or None while it has been
        handed nothing tagged yet."""
        return self._start_tags.get(id(q))

    @property
    def listeners(self) -> int:
        """Subscribers actually *playing* the stream. The visualizer's
        analyzer is deliberately not one: it only subscribes because
        something else is playing, and counting it would keep a stream
        alive that nobody hears any more."""
        return len(self._subscribers) - len(self._lossy)

    def orphaned_for(self) -> float:
        """How long nothing has been listening, or 0.0 while something is."""
        since = self.no_listeners_since
        return 0.0 if since is None else time.monotonic() - since

    def publish(self, chunk: bytes, tag: float | None = None) -> None:
        """Copies `chunk` to every subscriber and keeps it for the burst."""
        self._remember_for_burst(chunk, tag)
        for q in list(self._subscribers):
            if tag is not None and self._start_tags.get(id(q), 0.0) is None:
                self._start_tags[id(q)] = tag
            try:
                q.put_nowait(chunk)
            except asyncio.QueueFull:
                if id(q) not in self._lossy:
                    continue  # a slow listener falls behind rather than blocking the others
                # Lossy subscriber: make room by discarding what it has not
                # read yet, so it resumes at the live edge instead of
                # working through a backlog. See ANALYSIS_QUEUE_MAXSIZE.
                with suppress(asyncio.QueueEmpty):
                    q.get_nowait()
                with suppress(asyncio.QueueFull):
                    q.put_nowait(chunk)

    def stop(self) -> None:
        """Ends the stream for every subscriber, for good."""
        self.stopped = True
        for q in self._subscribers:
            send_sentinel(q)
        self._subscribers.clear()
        self._lossy.clear()
        self._start_tags.clear()

    def _note_listener_change(self) -> None:
        """Set on the way down to zero and cleared on the way back up, so an
        ordinary reconnect resets the orphan clock rather than accumulating
        against it."""
        if self.listeners > 0:
            self.no_listeners_since = None
        elif self.no_listeners_since is None:
            self.no_listeners_since = time.monotonic()

    def _remember_for_burst(self, chunk: bytes, tag: float | None) -> None:
        """Unconditional, whether or not anything is subscribed: what makes
        the burst useful is having the seconds already in hand when somebody
        arrives, which is exactly the moment it is too late to start
        collecting them."""
        self._burst.append((time.monotonic(), chunk, tag))
        self.burst_bytes += len(chunk)
        self._trim_burst()

    def _trim_burst(self) -> None:
        """Drops everything older than the burst window (and anything past
        the byte ceiling). Also on the way *out*: while the source is down
        nothing new arrives, so age alone is what empties this — which keeps
        a listener reconnecting after an outage from being handed audio from
        before it."""
        window, max_bytes = self._burst_limits()
        cutoff = time.monotonic() - window
        while self._burst and (self._burst[0][0] < cutoff or self.burst_bytes > max_bytes):
            _, chunk, _ = self._burst.popleft()
            self.burst_bytes -= len(chunk)
