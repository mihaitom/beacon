# An event-loop stall of 19.47s, cause unknown (RESOLVED 2026-08-26, by absence)

2026-08-23, 00:49, on one instance while casting. One occurrence, not seen
again over the following night.

    00:48:46  resync healthy: device=32.00s wall=33.01s delta=-1.01s
    00:49:13  [loop] Event loop blocked for 19.47s
    00:49:13  [ffmpeg] Stream cancelled (Track 1)
    ...      (the reconnect chain that followed is documented separately, see
              "A mid-track reconnect restarted the track and poisoned the clock")

**Why it matters even though it happened once:** nothing is serviced for that
long, a cast device's open `/stream` socket included. The device gave up and
reconnected, which is how a stall on our side turns into a stopped speaker.
It is also the same class of hiccup `-readrate_catchup` exists to recover
from (see core/streamer.py), only two orders of magnitude larger.

**What it was not:**

- Not request-driven: the log has no line at all between 00:48:46 and
  00:49:13, so nothing was being served.
- Not the host: a second instance on the same machine, idle, running the same
  detector (`core/loop_health.py`), logged nothing in that window. CPU
  starvation would have shown in both.
- Not device discovery, which was the *other* stall found the same evening
  (1.71s, fixed - see delivery/lazy_import.py): no scan ran here.

**The trigger is known**, which is the most useful thing about this entry:
the operator was starting a different room from the Sonos app at that moment,
via a music-service integration that has nothing to do with this process. The
household topology never changed (`groups=2` throughout), so whatever reached
this process did so as ordinary UPnP or mDNS traffic, not as a regrouping.

That makes it a **reproduction recipe** rather than a one-off: cast to a room
from Beacon, then start or stop another room from the Sonos app, and watch
for a `[loop] Event loop blocked` line.

**Ruled out by reading the code**, so a repro attempt doesn't re-check them:
the UPnP NOTIFY endpoint (routes/upnp.py) caps the body it will read and only
parses that; SUBSCRIBE/renew go through `asyncio.to_thread`
(core/upnp_events.py); every Sonos call resolves its device in a thread too
(`SonosDelivery._get_device`). None of those is on the loop.

**How to catch it.** From outside, while it is stalling: `py-spy dump --pid
<the container's python>` from the host. That names the frame directly, and
needs only ptrace permission - no code in this repo at all.

**A built-in watchdog thread was considered and dropped (2026-08-26).** The
shape was a plain thread outside the loop: the loop updates a timestamp,
the thread checks it every 0.5s and dumps every thread's stack once the loop
has not ticked for N seconds - i.e. while the block is still in progress,
which `monitor_loop_lag()` can never do, because by the time it runs again
the culprit has already returned.

It is dropped anyway, because naming the frame is not the part that is
missing. What a stall actually does to playback is leave the device's
position reading rewound, and that reading is not separable from a rewind
somebody triggered on the device - the same ambiguity documented in
[Auto-advance onto a still-playing device](auto-advance-still-playing-device.md),
"Attempted and reverted", where no threshold could split the two cases
either. So the watchdog would add a permanently running thread and a burst
of log output to a process that streams audio, and still leave the decision
it was supposed to inform unmade. `py-spy` above produces the same frame on
demand, with nothing to maintain, for a stall seen exactly once.

**Closed 2026-08-26, on the trigger rather than the frame.** The specific
line in our own process that blocked for 19.47s was never isolated - the
three theories above were only *ruled out*, not replaced with a positive
one. What closes this is the trigger side instead: no repeat since
2026-08-23 despite ordinary multi-room use, consistent with this needing the
same rare combination (an active cast plus another room being started/
stopped from the Sonos app at that moment) that only coincided once. If it
recurs, `py-spy` above is still the way to actually name the frame - that
part of the investigation was never finished, only judged not worth a
permanent watchdog for a single occurrence.
