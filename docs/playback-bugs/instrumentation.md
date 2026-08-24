# Instrumentation

Built into the app, always on:

- `core/loop_health.py` - measures event-loop stalls continuously and warns
  above 1.0s. `peak_lag(window)` annotates other log lines.
- `routes/stream.py`'s `DisconnectSnapshot` - on a real drop, logs position,
  `blocked_for` (how long the connection sat inside a single handoff), bytes
  delivered over wall time, loop lag, and the live connection count.
- `core/upnp_events.py` + `routes/upnp.py` - subscribes to a Sonos/DLNA
  renderer's AVTransport eventing and logs any device-reported transport
  problem. Log-only by design; it feeds nothing back into playback state.
  This is what turned "the device stopped" into "the device says
  `ERROR_UNSUPPORTED_FREQ ... 96000`" (see
  [The copy tier never checks what the device can actually play](copy-tier-device-limits.md)),
  and equally what lets a drop reporting `TransportStatus` *unchanged* be
  told apart from one reporting an error.

Scripted and ready to start on demand, `~/navidrome/beacon-repro-monitor.sh`
on the media host (`start`/`stop`/`status`/`reset-logs`/`snapshot [label]`,
`sonos-stats`, `help` for the rest) - wraps the packet capture below plus
beacon's own log and the two ad hoc log-based instruments
(`sonos_events2.py`, `control-stream.log`, both still running from the
original 2026-08-22/23 investigation) into one place, and `snapshot` copies
all of it into a fresh timestamped folder under `~/beacon-repros/` in one
call. Built 2026-08-24 after nearly missing a drop's capture window; use it
instead of re-deriving the tcpdump invocation by hand each time. Does not
reach the reverse-proxy host - no SSH trust from the media host
to that one - grab those logs separately.

`sonos-stats` is a new vantage point found the same day: each player exposes
`http://<ip>:1400/support/review` on the LAN, unauthenticated - not the
`/status/*` pages the rest of this section already tried (empty stubs on
this firmware), but a different, undocumented endpoint that returns real
`ifconfig`-style interface counters for every player in the household in one
response. One drop's device (`br0`, not the `ath0` radio interface - the
drops are at the bridge) showed **RX dropped=679833** at the time of that
drop, a cumulative counter of unknown window (since boot? since a periodic
reset? - unconfirmed). The command tracks a baseline per player and prints
the delta since the last call, specifically so a before/after pair
bracketing a real drop can say whether this counter actually *spikes* across
one or is just steady background noise from ordinary household multicast
traffic - not yet established either way. If it does spike, that reopens the
"network trouble" theory
[the symptom file](mid-track-drop-symptom.md) ruled out early on - that
finding was about *this host's own capture* seeing clean ACKed traffic,
which says nothing about loss on the speaker's own last hop.

Ad hoc on the server during an investigation, all of which earned their keep:

- `tcpdump` on the stream port filtered to SYN/FIN/RST - answers who closed a
  connection and how.
- `tcpdump` on all traffic between the server and the speaker except the audio
  port - answers whether anything commanded the device.
- An `ss`-based poller recording send-queue depth once a second - answers
  whether the device had stopped reading before it dropped.
- A standalone UPnP event listener subscribed to **`ZoneGroupTopology`,
  `AlarmClock` and `GroupManagement`** on every player, not just the two
  coordinators. This is the only way to see a household-level action taken
  by somebody else: the household pushes a topology document to every
  subscriber whenever grouping changes, whoever caused it, so a third-party
  controller becomes visible without ever seeing its packets. Bonded
  satellites and subs refuse `AVTransport` subscriptions with a 503 - that
  is expected, they have no transport of their own - but accept the other
  three.

Practical notes for whoever sets these up again:

- Cover every player and every port. Both were nearly missed: the captures
  were scoped to one room's two IP addresses when a second room started
  streaming, and to one port when a second instance came up on another. A
  filter that is one address too narrow looks exactly like "nothing
  happened".
- Write phase markers into the capture files (`===== PHASE n =====`) whenever
  the setup changes. Reconstructing afterwards which window had which
  configuration is otherwise guesswork.
- `ss -i` prints both `retrans:cur/total` and `bytes_retrans:N`. A regex for
  `retrans:` matches the tail of the second one first, which once turned 2803
  retransmitted *bytes* into an alarming-looking 2803 retransmitted segments.
- The host and the container can be in different time zones. Here the host
  wrote UTC and the app log local time, a constant two-hour offset between
  the packet captures and everything else.
