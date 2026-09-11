# A cast stops half an hour into a long track (RESOLVED 2026-08-23)

The clearest self-inflicted version of
[Cast device drops mid-track](mid-track-drop-symptom.md)'s own symptom, found
by running the app against a control arm overnight: playback stopped
mid-track with no cause visible in the app's own reasoning, and was logged
as a device drop.

**Symptom:** an 80-minute mix cast to a Sonos, with no Beacon window open
anywhere, stopped 31 minutes in. The log reports the usual "Cast device
dropped its connection and did not come back within 10s", with a healthy
snapshot: `blocked_for=0.01s`, `loop_lag_30s=0.00s`, 58 MB delivered over
1856s.

**Proven on the wire**, which is the only reason it wasn't filed as another
mystery drop:

    00:27:50.133 UTC  Out →  the room-A coordinator:1400   SOAPACTION: AVTransport:1#Stop
    00:27:50.970 UTC  In  ←  the room-A coordinator        FIN on port 7071

We stopped the speaker; the device closed the stream 840ms later. The
direction is not ambiguous.

**Cause:** `reap_once()` treats a session as idle purely on `last_seen`, and
nothing about casting touches that once a track is under way. The /events
heartbeat needs a client with the app open, and each GET /stream connection
touches the session exactly once - when the device opens it, i.e. once per
*track*. A track longer than `SESSION_IDLE_TIMEOUT` therefore ages its own
session past the timeout while it is audibly playing. The mix started at
01:56:54, the reaper (60s cadence) fired at 02:27:50, exactly 30 minutes
later, and stopped the delivery.

Nothing about this is Sonos-specific or format-specific. Any target, any
tier, any track over 30 minutes, whenever nobody has the app open - which is
precisely the "start a long set in the evening and close the laptop" case.

**Fix:** a session that is still streaming is never reaped, whatever
`last_seen` says. Paused casts count as streaming too - somebody may come
back to one, and stopping the device under them is the same rudeness one step
later. The device-ownership check documented in
[A session being reaped stopped a speaker somebody else was using](fixed-session-reap-stopped-someone-elses-speaker.md)
still applies to sessions that have genuinely stopped.

**Why the test suite didn't catch it:** the reap tests set up a stale session
and asserted it gets cleaned up, which is what the code was written to do.
None of them described a session that is *busy*, because "idle" was never
stated as anything but a timestamp comparison - the test suite encoded the
same assumption as the code. The behaviour also cannot appear in a fast test
without either a 30-minute wait or the timeout being treated as an input,
which nothing did.

**Note for reading old logs:** this makes any drop of a track longer than 30
minutes suspect, in both directions. Check whether a `[Sonos:<room>] stopped`
line appears in the same second in the *same* instance's log, and whether the
capture shows a `Stop` on the wire.


## Addendum 2026-09-11: the pause half of that fix needed a bound

The exemption above was written as "paused counts as streaming", with no
limit, and `is_streaming` is never cleared on `/pause` - so a paused session
was not reaped at all, however long ago anyone last touched it. Observed in
production: paused at 17:01 with the app then closed, the Sonos still claimed
and the session still whole at 22:17, five hours later. The reaper looked
dead from the outside; it was running and skipping that session every 60s.

A paused cast now keeps its device for `PAUSED_IDLE_TIMEOUT` (2h, env-
overridable) measured against the same `last_seen` - `/pause` is itself a
request and touches it, so "idle since" already means "paused since" once
the clients are gone. Past that it is reaped like any other stopped session,
device-ownership check included.
