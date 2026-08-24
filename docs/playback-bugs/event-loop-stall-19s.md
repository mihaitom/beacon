# An event-loop stall of 19.47s, cause unknown (OPEN)

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

**How to catch it.** Two options, and the cheap one needs no code:

- While it is stalling, dump the stack from outside: `py-spy dump --pid <the
  container's python>` from the host. That names the frame directly, and
  needs only ptrace permission.
- The durable version: a watchdog *thread* - the loop updates a timestamp,
  the thread checks it every 0.5s and dumps every thread's stack once the
  loop has not ticked for N seconds, i.e. while the block is still in
  progress. `monitor_loop_lag()` cannot do this itself: by the time it runs
  again, the culprit has already returned.
