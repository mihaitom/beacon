# One device dropping out of a multi-target cast is never surfaced (OPEN)

Not investigated yet, found while planning a two-speaker repro (2026-08-22).
**The code gap below is real and still unfixed regardless of what triggered
it** - kept open as an architectural issue, not a symptom to wait out.

**Likely trigger for the 2026-08-22 observation (the listener's assessment,
2026-08-24): the [test-suite Sonos-discovery leak](mid-track-drop-test-suite-sonos-leak.md).**
The leaking test's unmocked background tasks specifically target room A by
name, which lines up with a two-speaker session silently losing one device
while the other kept going - and the leak already existed by 2026-08-22 (the
leaking test was added 2026-08-20, the room name has been in the suite since
the first commit). Unlike the mid-track-drop rows this wasn't checked against
an exact `pytest` timestamp - there's no log excerpt on record here with a
precise drop time to cross-reference the way [the symptom file's table](mid-track-drop-symptom.md)
does for the later incidents - so this is plausible-by-mechanism, not
timestamp-confirmed. It does explain why this was found on a *planning*
session rather than live listening: planning a repro is exactly when the
test suite gets run repeatedly.

`_mark_disconnected_if_not_reconnected()` gates on
`active_stream_connections == 0`, which is session-wide. That is right for
the session-wide `is_streaming` flag it guards, but it means a session
casting to two devices at once never notices one of them going away: the
count is still 1, so no grace period fires, no `DisconnectSnapshot` is
logged, and nothing tells the user that half their cast is silent.

Consequences worth knowing before relying on the logs: the app-level drop
detector is only meaningful for single-target sessions. Per-device coverage
has to come from UPnP eventing (each renderer reports its own
`TransportState`) or from a packet capture.
