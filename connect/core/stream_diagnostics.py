"""core/stream_diagnostics.py — how a cast stream reaches its device right
now, for Now Playing's overlay while the log level is DEBUG (#56).

What the log says after the fact, live: what each recent /stream
connection has handed its device, in bytes and seconds of audio, and when
the device last took any; where the device last said it was; how far ahead
of it the audio sent runs; and what the device asked for - a HEAD, a byte
range, ICY metadata. A speaker's own diagnostics pages say none of this
(a Sonos on current firmware no longer lists connections or processes), so
this is the only place it can be seen while it happens.
"""

import time

from .older_sonos import stream_mode
from .session import SessionState, compute_position, playback_duration
from .state import list_target_pairs
from .upnp_events import last_reported


def describe_stream(session: SessionState) -> dict:
    st = session.state
    now = time.time()
    clock = time.monotonic()
    generation = st.clock.play_generation

    connections = []
    for conn in reversed(st.recent_streams):
        delivered = conn.audio_delivered()
        connections.append(
            {
                "current": conn.generation == generation,
                "open": conn.outcome is None,
                "outcome": conn.outcome,
                "age": clock - conn.opened_at,
                "model": conn.model,
                "mode": conn.mode,
                "range": conn.byte_range,
                "start": conn.start,
                "bytes": conn.bytes_delivered,
                "last_read": clock - conn.last_handoff,
                "audio_end": conn.start + delivered if delivered is not None else None,
            }
        )

    device = None
    if st.device_reading is not None and st.device_reading[0] == generation:
        _, at, position = st.device_reading
        device = {"position": st.clock.track_start_position + position, "age": now - at}

    targets = []
    for kind, name in list_target_pairs(st.active_delivery):
        reported = last_reported(name)
        state = reported.get("state")
        problem = reported.get("problem")
        targets.append(
            {
                "type": kind,
                "name": name,
                "state": state[1] if state else None,
                "state_age": now - state[0] if state else None,
                "problem": problem[1] if problem else None,
                "problem_age": now - problem[0] if problem else None,
            }
        )

    # How far the audio sent runs ahead of where the device is now, read off
    # its last position. Only while it plays: a stopped or paused device is
    # not moving through it.
    ahead = None
    sent_ends = [c["audio_end"] for c in connections if c["current"] and c["audio_end"]]
    playing = all(t["state"] in (None, "PLAYING", "TRANSITIONING") for t in targets)
    if sent_ends and device is not None and playing:
        ahead = max(sent_ends) - (device["position"] + device["age"])

    return {
        "older_sonos_mode": stream_mode(),
        "position": compute_position(session) if st.current_track else None,
        "track_end": playback_duration(st) if st.current_track else None,
        "connections": connections,
        "device": device,
        "ahead": ahead,
        "targets": targets,
        "requests": [
            {
                "ago": now - request["at"],
                "method": request["method"],
                "model": request["model"],
                "range": request["range"],
                "icy": request["icy"],
            }
            for request in reversed(st.stream_requests)
        ],
    }
