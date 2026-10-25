"""core/stream_diagnostics.py — how a cast stream reaches each of its devices
right now, for Now Playing's overlay while the log level is DEBUG (#56).

What the log says after the fact, live: what each target's newest /stream
connection has handed it, in bytes and seconds of audio, and when it last
took any; where the device last said it was; how far ahead of it the audio
sent runs; and what it asked for - a HEAD, a byte range, ICY metadata. A
speaker's own diagnostics pages say none of this (a Sonos on current
firmware no longer lists connections or processes), so this is the only
place it can be seen while it happens.

Cast to several targets at once, every one of them fetches the stream on
its own, so all of the above is told per target: a connection or request
belongs to the target it came from (BaseDelivery.stream_peer, or the name
connect sends along when it fetches for AirPlay). One from an address no
target has - a speaker playing on from its own app, a renderer fetching
from another address than the one it was found at - gets an entry of its
own rather than being dropped, since that is exactly what is worth seeing.
"""

import time

from delivery.manager import DeliveryManager

from .device_reports import last_reported
from .session import SessionState, compute_position, playback_duration
from .state import StreamConnection

# How many of a target's requests are listed, newest first.
_REQUESTS_SHOWN = 3
# How long an address that is no target stays listed after it last asked
# for anything: long enough to read off the overlay, short enough that the
# speakers of an earlier cast drop out on their own.
_UNKNOWN_PEER_SECONDS = 60.0


def _fetched_by(delivery, peer: str | None, sender: str | None) -> bool:
    if sender is not None:
        return sender.lower() == delivery.target.lower()
    return peer is not None and peer == delivery.stream_peer


def describe_stream(session: SessionState) -> dict:
    st = session.state
    now = time.time()
    generation = st.clock.play_generation
    delivery = st.active_delivery
    deliveries = getattr(delivery, "deliveries", [delivery] if delivery else [])

    connections = list(reversed(st.recent_streams))
    requests = list(reversed(st.stream_requests))
    claimed_connections: set[int] = set()
    claimed_requests: set[int] = set()

    targets = []
    for d in deliveries:
        mine = [c for c in connections if _fetched_by(d, c.peer, c.sender)]
        asked = [r for r in requests if _fetched_by(d, r.get("peer"), r.get("sender"))]
        claimed_connections.update(id(c) for c in mine)
        claimed_requests.update(id(r) for r in asked)
        coordinator = delivery.coordinator_of(d) if isinstance(delivery, DeliveryManager) else None
        targets.append(
            _describe_target(
                session,
                kind=type(d).__name__.replace("Delivery", "").lower(),
                name=d.target,
                connections=mine,
                requests=asked,
                follows=coordinator.target if coordinator else None,
                now=now,
            )
        )

    # Whatever no target claimed, by the address it came from.
    unknown: dict[str, tuple[list, list]] = {}
    for c in connections:
        if id(c) not in claimed_connections and c.generation == generation:
            unknown.setdefault(c.sender or c.peer or "?", ([], []))[0].append(c)
    for r in requests:
        recent = now - r["at"] < _UNKNOWN_PEER_SECONDS
        if id(r) not in claimed_requests and recent:
            unknown.setdefault(r.get("sender") or r.get("peer") or "?", ([], []))[1].append(r)
    for peer, (mine, asked) in unknown.items():
        targets.append(
            _describe_target(
                session,
                kind=None,
                name=peer,
                connections=mine,
                requests=asked,
                follows=None,
                now=now,
            )
        )

    return {
        "position": compute_position(session) if st.current_track else None,
        "track_end": playback_duration(st) if st.current_track else None,
        "targets": targets,
    }


def _describe_target(
    session: SessionState,
    *,
    kind: str | None,
    name: str,
    connections: list[StreamConnection],
    requests: list[dict],
    follows: str | None,
    now: float,
) -> dict:
    st = session.state
    generation = st.clock.play_generation
    reported = last_reported(name) if kind else {}
    state = reported.get("state")
    problem = reported.get("problem")

    # The newest connection of the stream now playing, else the newest of
    # all: one that ended a moment ago still says how it ended.
    current = [c for c in connections if c.generation == generation]
    connection = (current or connections or [None])[0]

    device = None
    if st.device_reading is not None:
        reading_generation, at, position, reader = st.device_reading
        if reading_generation == generation and reader.lower() == name.lower():
            device = {"position": st.clock.track_start_position + position, "age": now - at}

    # How far the audio sent runs ahead of where the device is now, read off
    # its last position. Only while it plays: a stopped or paused device is
    # not moving through it.
    ahead = None
    sent_end = _audio_end(connection) if connection in current else None
    playing = state is None or state[1] in ("PLAYING", "TRANSITIONING")
    if sent_end is not None and device is not None and playing:
        ahead = sent_end - (device["position"] + device["age"])

    return {
        "type": kind,
        "name": name,
        "follows": follows,
        "state": state[1] if state else None,
        "state_age": now - state[0] if state else None,
        "problem": problem[1] if problem else None,
        "problem_age": now - problem[0] if problem else None,
        "connection": _describe_connection(connection, generation) if connection else None,
        "device": device,
        "ahead": ahead,
        "requests": [
            {
                "ago": now - request["at"],
                "method": request["method"],
                "model": request["model"],
                "range": request["range"],
                "icy": request["icy"],
                "answer": request.get("answer"),
            }
            for request in requests[:_REQUESTS_SHOWN]
        ],
    }


def _audio_end(conn: StreamConnection) -> float | None:
    delivered = conn.audio_delivered()
    return conn.start + delivered if delivered is not None else None


def _describe_connection(conn: StreamConnection, generation: int) -> dict:
    clock = time.monotonic()
    return {
        "current": conn.generation == generation,
        "open": conn.outcome is None,
        "outcome": conn.outcome,
        "age": clock - conn.opened_at,
        "model": conn.model,
        "start": conn.start,
        "bytes": conn.bytes_delivered,
        "last_read": clock - conn.last_handoff,
        "audio_end": _audio_end(conn),
    }
