"""core/device_reports.py — the last transport state and problem each cast
device reported, for Now Playing's stream diagnostics
(core/stream_diagnostics.py).

Each protocol hears it its own way: a Sonos over AVTransport eventing
(core/upnp_events.py), a DLNA renderer on the poll it already gets
(delivery/dlna.py), a Chromecast through its media status listener
(delivery/chromecast.py). Read-only from everywhere else: nothing decides
playback on it.
"""

import time

# By the device's label, as {"state" | "problem": (when, what)}.
_last_reported: dict[str, dict[str, tuple[float, str]]] = {}


def note_state(label: str, state: str) -> None:
    _last_reported.setdefault(label.lower(), {})["state"] = (time.time(), state)


def note_problem(label: str, problem: str) -> None:
    _last_reported.setdefault(label.lower(), {})["problem"] = (time.time(), problem)


def last_reported(label: str) -> dict[str, tuple[float, str]]:
    """{"state": (when, state), "problem": (when, problem)}, either missing
    until the device has reported one."""
    return dict(_last_reported.get(label.lower(), {}))
