# Playback bug log

Playback is the part of Beacon that has to work. It is also the part that has
produced the most whack-a-mole: a bug gets found and fixed, tests get added,
coverage stays at 100%, and a few days later something else in the same area
breaks. This file exists so that each round leaves something behind besides a
commit.

This is a record of what was already learned, including the dead ends - not a
task list. **The ruled-out list on an open entry is the most valuable part**;
it is what stops the next investigation from re-testing the same five
theories.

Add an entry when a playback bug is understood, whether or not it is fixed.
For a fixed one, always answer "why did the test suite not catch this?".

---

## Open

### Cast device drops a healthy stream mid-track

**Status:** root cause unknown as of 2026-08-22. Several contributing bugs
were found and fixed along the way (below); none of them was the cause.

**Symptom:** while casting to a Sonos speaker, the device stops mid-track and
never reconnects. The backend marks the session not-streaming after the 10s
grace period and playback is over. Timing is not reproducible.

**What the device actually does,** established by packet capture and by
subscribing to its own UPnP eventing:

- It sends a clean TCP **FIN**, never an RST, and has **ACKed every byte** we
  sent. There is no loss, no reset, no dead network path.
- Its own AVTransport event reports `TransportState=STOPPED` with
  `TransportStatus` unchanged, i.e. still `OK`. From the device's point of
  view nothing went wrong. It believes it is finished.
- A Sonos also FINs the connection on an ordinary pause, so a device-side FIN
  means "the transport stopped", not "the connection broke". **The connection
  close is a consequence, not the cause.**

**Observed drops**, all on the same stereo-paired Sonos, always on the group
coordinator:

| # | source | duration | dropped at | lead in flight at drop |
|---|---|---|---|---|
| 1 | mp3 copy, ~4 MB embedded cover | 411s | 270s | ~80s (pacing bug, see below) |
| 2 | mp3 copy, 320 kb/s | 255s | 164s | unknown (pre-instrumentation) |
| 3 | flac copy | 370s | 59s | ~9-15s, healthy |
| 4 | mp3 copy, 200 kb/s VBR, 80-minute mix | 4791s | 238s | ~0s, exhausted |
| 5 | mp3 copy, 320 kb/s | 225s | 11s | ~15.5s, healthy |

No pattern in absolute time, position in the track, track length, or codec.
Both the mp3-copy and flac-copy tiers are affected.

**Ruled out** (with the evidence, so these need not be re-tested):

| theory | how it was excluded |
|---|---|
| A second Beacon instance interfering | A drop occurred after that container had been removed entirely |
| Another Sonos-integrating service on the same host | Its log held only its own healthcheck; no traffic to the players appeared in the capture |
| Buffer starvation | Several drops happened with a full ~15s lead in flight |
| The event loop starving the socket | `loop_lag_30s`/`loop_lag_120s` were 0.00-0.01s at every drop |
| TCP backpressure / device stopped reading | Send-queue depth 0 and `blocked_for` ~0.01s right up to the FIN |
| Network trouble | Clean FIN, all bytes ACKed, retransmitted bytes ~0.03% |
| Beacon issuing a transport command (stop/pause) | A capture of host-to-speaker traffic showed only read calls (`GetVolume`, `GetPositionInfo`, `GetZoneGroupState`) in normal operation. Note the per-drop check was narrower than the baseline one, so treat this as strong rather than airtight |
| The Sonos group re-forming | The satellite emitted no events at all; its transport is bound to the coordinator |
| The stream declaring a wrong duration | No Xing/Info header in what ffmpeg emits; duration reaches the device only via DIDL metadata, correctly |
| The session idle reaper | `SESSION_IDLE_TIMEOUT` is 30 min; the first drop was 14 min into the session |
| AudioAnalyzer blocking the stream generator | `feed()` is non-blocking (unbounded queue), so it cannot stall it |
| Embedded cover art / the bitrate factor below | A track whose factor was 1.006 dropped just the same |

**Strongest open lead - the stream-copy tier itself.** The drops were first
noticed after `resolve_output_format()` gained the `-acodec copy` tiers.
Before that every track was re-encoded to a uniform MP3 192k CBR stream, and
the simpler upstream this backend derives from still does exactly that and has
never shown this bug. Stream-copy instead hands the device the source's own
frames: VBR, 48 kHz, free-format or unusual frame headers, an ID3 tag inline,
FLAC whose STREAMINFO cannot state `total_samples` on a piped stream. Any of
those could plausibly make a renderer decide it has reached the end of the
content - which is exactly what the device reports (`STOPPED`, status `OK`,
full buffer).

The A/B is cheap and decisive: make `resolve_output_format()` return
`FALLBACK_FORMAT` unconditionally, deploy, and play a few dozen tracks. If the
drops stop, the cause is in what stream-copy emits, and the next question is
which property of the source triggers it (compare the codec/sample-rate/VBR
shape of tracks that dropped against ones that did not). If they continue, the
copy tier is exonerated and this entry can move to the ruled-out table.

**Open lead - Beacon re-runs SSDP discovery every 8 seconds.**
`SonosDelivery._get_device()` calls `soco.discover()`, a full network-wide
SSDP M-SEARCH, and has seven call sites: `play`, `pause`, `resume`, `stop`,
`get_position`, `get_volume`, `set_volume`. Because the position-resync loop
calls `get_position()` roughly every 8s, a cast session broadcasts a discovery
sweep at that rate for its entire duration, each one also blocking a thread
for the discovery timeout. Visible in packet captures as repeated multi-second
SSDP bursts. Not shown to cause the drops, but it is a real defect on its own
(the resolved device should be cached and only re-discovered when it goes
missing), and it is the kind of load the simpler upstream this backend derives
from never put on a speaker.

**Not excluded:**

- A third-party controller (a phone app, another service) talking **directly**
  to the speaker. That traffic goes host-to-host over the switch and never
  reaches the machine running Beacon, so a capture there cannot see it.
- Sonos firmware behaviour around chunked HTTP without `Content-Length`.

---

## Fixed

### Pacing threw away the lead it had built (2026-08-22)

**Symptom:** a contributing factor to a drop where the device had no buffered
audio left at all.

**Cause:** `-readrate 1` is a ceiling with no floor. ffmpeg reads at exactly
real time and therefore never regains a lead it has lost, so any one-off stall
permanently shortens the device's buffer for the rest of that track.

This was a regression introduced by the fix below. The hand-rolled throttle it
replaced caught up *incidentally*: it slept only while already more than
`LOOKAHEAD_SECONDS` ahead, so falling behind simply meant it stopped sleeping
and ran flat out until the lead was restored.

**Fix:** `-readrate_catchup 2` in `core/streamer.py`'s `_READRATE_ARGS`.

**Lesson:** when replacing hand-written logic with a library or tool feature,
enumerate what the old code did *accidentally*. Behaviour nobody wrote down is
still behaviour something depended on.

### Pacing used the container bitrate, not the audio bitrate (2026-08-22)

**Symptom:** on tracks with large embedded cover art, the stream ran far ahead
of real playback. A 411s track finished in 316s, leaving the device's HTTP
connection completely idle for the remaining 95s - exactly the condition the
pacing feature had been added to eliminate.

**Cause:** `_BITRATE_RE` read ffmpeg's `Duration: ..., bitrate: N kb/s`
summary line. That is the **container** bitrate, cover art included, while the
bytes being counted are audio-only (`-vn` strips the attached picture). On a
track with a ~4 MB PNG cover that was 397 kb/s against 320 kb/s of real audio,
so the throttle over-delivered by 24% and the lead grew ~0.24s per second
instead of holding at 15s.

**Fix:** let ffmpeg pace itself against real input timestamps -
`-readrate 1 -readrate_initial_burst 15`. There is no bitrate left to get
wrong, and it covers the tiers the old throttle could not: FLAC's stream line
carries no bitrate at all, and the lossless-reencode tier opted out of pacing
entirely. `bitrate_bps` and the manual throttle loop were removed.

**Why tests missed it:** `tests/test_streamer.py` fed a probe fixture where
the container bitrate and the audio bitrate were identical, so the mismatch
case never existed. The code was correct; only the meaning of the number it
parsed was wrong. **Line coverage cannot see that.**

### Waveform computation blocked the event loop (2026-08-22)

**Symptom:** 2.53s during which nothing at all was serviced, including the
casting device's open `/stream` socket. Triggered by an 80-minute mix
(52.8M samples).

**Cause:** `_compute_peaks()` used `max()`/`min()` over `array.array` slices.
Those look like bulk C operations but iterate via the iterator protocol,
boxing **every sample** into a Python int. Worse, the caller's
`asyncio.to_thread()` gave no protection at all: boxing ints holds the GIL for
the entire duration, so the "background" thread stalls the loop just as
thoroughly as inline code would.

The docstring explicitly claimed the opposite ("C-speed", "run via
asyncio.to_thread() out of caution"), which is why it survived review.

**Fix:** vectorized with numpy. Verified byte-identical output across eight
edge cases (empty input, odd byte count, fewer samples than buckets, the int16
minimum, an uneven remainder, silence) and **178x faster**; extrapolated, that
turns 2.12s into 0.012s for the mix above.

**Why tests missed it:** the output was always correct. Only the runtime was
the bug. `tests/test_waveform.py` now carries a guard that times
`_compute_peaks` against a boxed pass over the same data, so the threshold
adapts to the machine instead of being a flaky wall-clock bound.

**Lesson:** `asyncio.to_thread()` only helps for work that releases the GIL.
Moving GIL-bound CPU work onto a thread changes nothing.

### Disconnect snapshot fired on ordinary pauses (2026-08-22)

**Symptom:** every pause produced `Device dropped /stream mid-track` in the
log, burying the rare real event the instrumentation existed to catch.

**Cause:** the snapshot was logged at the moment of cancellation, where it is
genuinely unknowable whether a device dropped out or one of our own handlers
closed the connection: the connection count still includes this connection
(its `finally` has not run yet) and `clock.is_paused` may not be set yet.

**Fix:** capture the numbers at cancellation (they describe that instant) but
carry them into `_mark_disconnected_if_not_reconnected()` and log them only on
the branch that has already concluded it was a real drop. This reuses the
existing, correct decision instead of inventing a second one.

---

### One device dropping out of a multi-target cast is never surfaced

Not investigated yet, found while planning a two-speaker repro (2026-08-22).

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

---

## Instrumentation

Built into the app, always on:

- `core/loop_health.py` - measures event-loop stalls continuously and warns
  above 1.0s. `peak_lag(window)` annotates other log lines.
- `routes/stream.py`'s `DisconnectSnapshot` - on a real drop, logs position,
  `blocked_for` (how long the connection sat inside a single handoff), bytes
  delivered over wall time, loop lag, and the live connection count.
- `core/upnp_events.py` + `routes/upnp.py` - subscribes to a Sonos/DLNA
  renderer's AVTransport eventing and logs any device-reported transport
  problem. Log-only by design; it feeds nothing back into playback.

Ad hoc on the server during an investigation, all of which earned their keep:

- `tcpdump` on the stream port filtered to SYN/FIN/RST - answers who closed a
  connection and how.
- `tcpdump` on all traffic between the server and the speaker except the audio
  port - answers whether anything commanded the device.
- An `ss`-based poller recording send-queue depth once a second - answers
  whether the device had stopped reading before it dropped.

---

## Method notes

Things that repeatedly turned out to matter while chasing these:

- **Measure, do not infer.** Every real finding here came from a number, not
  from reading code. Two theories in one investigation looked compelling and
  were wrong; each was killed by a single measurement.
- **Beware n=1 correlation.** "The only track that dropped was also the only
  one with a big cover" was a real observation and a wrong conclusion. The
  next drop had a factor of 1.006.
- **A confident comment is not evidence.** Both the pacing bitrate and the
  waveform threading were wrong *and* documented as correct. Where a comment
  explains why something is safe, that is a place to check, not to trust.
- **100% coverage cannot catch a wrong meaning or a slow implementation.**
  Both major fixes here were bugs where the code did exactly what it said.
- **Silence is not success.** A monitor with a broken filter, or a lapsed UPnP
  subscription, looks exactly like "no problems occurred". Verify that
  instrumentation actually fires before trusting its quiet.
