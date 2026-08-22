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

**Status:** almost certainly not in this codebase. On 2026-08-22 the pre-fix
build and the current build were run side by side, each serving a different
room from its own process, port and session. Both lost their device within
ten seconds of each other, with identical signatures. Two different code
bases cannot share an application bug at the same instant, so the cause lies
outside Beacon - in the Sonos system or the network. See "The controlled
comparison" below.

**Earlier status, kept because the reasoning still applies to the mechanism:**
root cause unknown as of 2026-08-22. Several contributing bugs
were found and fixed along the way (below); none of them was shown to be the
cause. No drop has recurred since those fixes went in, but that is absence of
evidence, not evidence: the bug was never reproducible on demand, so a quiet
stretch proves nothing on its own. A controlled comparison is running instead
- see "Telling the fixes apart" below.

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
| The frontend commanding a stop from a background tab | Two independent checks: no UPnP command reached the speaker, and no `/pause` or `/stop` appears in the backend log at any drop |
| The media-server account in use | Navidrome stores transcoding settings and bitrate caps per (user, client). All players for every user read `max_bit_rate: 0` and `transcoding_id: ''`, so the delivered bytes are identical whichever account streams |
| A device capability mismatch | Those produce an explicit `TransportStatus` error from the device (see the 24/96 FLAC entry below). Every drop reported `TransportStatus` unchanged, i.e. `OK` |
| The speaker rebooting or losing the network | Positively excluded, not merely unobserved: the UPnP subscriptions held the **same SID all day** across renewals, which a reboot would have invalidated, and the event stream runs straight through the drop without a gap. The device was reachable and answering throughout |
| A Sonos alarm taking over playback | `ListAlarms` returns `<Alarms></Alarms>` - none configured |
| The Sonos-SMAPI integration on the same host | Its log holds only its own healthcheck in every drop window |
| Someone using the Sonos phone app | That app queries the SMAPI integration when in use, and its log shows app traffic in exactly one hour of the day - the one where it was deliberately opened to check. Never at a drop. Excludes the app *being used*, not a stop command sent from it |
| A zone-group topology change | Subscribed to `ZoneGroupTopology` on all six players. Topology stayed at `groups=2` throughout; the only broadcasts coincided with the app being opened by hand |
| A firmware version mismatch in the household | The Sub runs 17.2.6 against 18.7 elsewhere, but Sonos publishes that as the separate "legacy system version" track and the app reports everything up to date. A supported state, not a defect |

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

The A/B is cheap: set `FORCE_FALLBACK_FORMAT=1`, which makes
`resolve_output_format()` return `FALLBACK_FORMAT` for everything and skip
the probe, reproducing the pre-copy-tier pipeline exactly. It is an
environment variable rather than a code edit so the two arms can be swapped
with a container restart instead of a rebuild. If the drops stop, the cause
is in what stream-copy emits, and the next question is which property of the
source triggers it. If they continue, the copy tier is exonerated.

### The controlled comparison (2026-08-22, 18:53)

The decisive observation, and the only one made with a control group.

Setup: `53885ca2e407` (the build all five earlier drops happened under) on
port 9071 serving one room; the current build on 8071 serving another. Two
processes, two sessions, two ports, two code bases, one host, one network,
one Sonos household.

    18:53:48  current build   room A   stream cancelled, device STOPPED
    18:53:58  pre-fix build   room B   stream cancelled, device STOPPED

Both signatures identical to the five earlier drops: a clean FIN from the
device with every byte acknowledged, send-queue depth 0 right up to it, no
retransmissions, no SOAP command to either speaker, `TransportStatus`
unchanged (i.e. `OK`), event-loop lag 0.00s. Device traffic on the wire was
steady through the whole window - no gap, no burst.

**An application bug cannot present in two different code bases at the same
instant.** Whatever stops these speakers is outside Beacon.

One detail worth keeping, because it confused the first reading: at the
moment its own stream ended, each device immediately opened a connection to
port **8071** - including the one that had been streaming from 9071. That is
the speaker falling back to a URL still sitting in its Sonos queue from
earlier in the day, receiving a 112-byte HEAD response, and stopping. A
consequence, not the cause.

Remaining candidates, none of them reachable from this host:

- A Sonos household-level event - a zone-group topology change, a firmware or
  cloud check-in, a SonosNet reconfiguration. Both affected players are
  members of bonded sets - a stereo pair and a home-theatre group.
- A third-party controller acting on the household. Such traffic goes
  phone-to-speaker across the switch and never reaches this machine's NIC, so
  no capture here can see it.

To take this further, the next instrument would have to capture
`GetZoneGroupState` **responses** rather than just the request names, so a
topology change becomes visible as a content diff. Today's capture filtered
response bodies out.

---

### Telling the fixes apart

Because none of the fixes was *shown* to be the cause, "no drops any more" on
its own cannot say which one mattered, or whether any did. Every intermediate
image is still on the build host as a dangling image, tagged only by build
time, which makes a bisection possible:

| image | built (local time) | first contains |
|---|---|---|
| `53885ca2e407` | 01:48 | nothing - the build all five drops happened under |
| `155c47b76e8d` | 09:30 | `-readrate` pacing, event-loop stall detector |
| `a791772007cb` | 10:23 | disconnect-snapshot fix |
| `ff04bcba4b82` | 10:37 | `-readrate_catchup`, waveform vectorization |
| `0afc784b2ff4` | 12:18 | UPnP transport eventing |
| `99567880ed6a` | 13:52 | device-picker apply model |
| `be97f060553e` | 14:45 | HTTP connection pooling |

The comparison currently running: the pre-fix image serves one room while the
current build serves another, simultaneously, on separate ports. Everything
that produced the useful evidence so far - packet captures, send-queue
polling, UPnP event subscriptions - lives on the host and is
build-independent, so the old build is observed just as well despite carrying
none of the in-app instrumentation.

Keep the room constant when doing this. All five drops happened on the same
speaker pair, so putting the old build there holds hardware, grouping and
network fixed and leaves the code as the only variable.

### Raising the event rate

Waiting through normal listening collects data slowly: roughly one connection
every four minutes. Two levers help, and one that looks helpful does not:

- **Two independent sessions**, one per room, genuinely doubles it. Note that
  joining a second Sonos to an existing session does *not*: `routes/join.py`
  deliberately groups the speakers instead, which leaves exactly one stream
  connection for both rooms.
- **Tracks of 60-120s** are the sweet spot: roughly three times the
  connections per hour of normal listening, with the connection still open
  most of the time.
- **Very short tracks are counterproductive.** Anything shorter than the
  `-readrate_initial_burst` window is delivered in one go, after which the
  connection closes and the device plays from its buffer with nothing open.
  Measured: 0.9-19s of open connection followed by ~15s with none. Since every
  observed drop happened on an open, actively streaming connection, that
  shrinks the exposure it was meant to increase.

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

**Not excluded, and not reachable from here:**

- A third-party controller talking **directly** to the speaker. That traffic
  goes host-to-host across the switch and never reaches the machine running
  Beacon. Closing this needs port mirroring on a managed switch; a consumer
  router's own capture only helps if the speakers are on its WiFi.
- **Control over the Sonos cloud.** Players accept commands through their
  cloud connection - a phone off the local network, a linked service, a
  voice assistant. It fits everything measured: no local packet, both rooms,
  a clean FIN, `TransportStatus` unchanged, because from the device's side
  it *was* a regular stop from an authorised source. No local capture can
  ever show this.
- **Firmware behaviour.** 96.1-79270 (display 18.7) released 2026-08-11 and
  is what every playing device here runs. Its release notes say only "bug
  fixes and improved performance" and list no known issues, and searching
  turns up only the perennial "Sonos randomly stops" threads that exist for
  every version - suggestive of nothing.

  This one is worse than open: it is currently **unfalsifiable**. Confirming
  it would mean dating when these devices actually installed it, since Sonos
  rolls out gradually and the release date is not the install date. The
  router's event log was switched off at the time, so there is no record of
  the reboot an update causes. Do not spend more time on it without a new
  source of that date.

---

### What Beacon does about it (2026-08-22)

Since the cause is outside this codebase and may not be reachable at all, the
useful thing left was to stop letting it end a session silently. Previously
the grace period expiring set `is_streaming = False` and that was the end of
it: the music stopped, nothing said so, and it was only noticed when someone
missed it.

Now:

- The grace period logs an **error**, not a warning, carrying the full
  `DisconnectSnapshot`. Deliberately loud even though the user-facing side
  papers over it - a quiet recovery would hide the one event worth
  investigating.
- The broadcast is tagged `interrupted`, a one-shot flag on the payload in
  the same shape as the existing `displaced`. It means "this stopped and
  nobody asked for it", which is what distinguishes it from an ordinary stop.
- The frontend raises a clickable toast naming the room; the phone remote
  shows a tappable banner. Both call `POST /resume-interrupted`, which
  re-dispatches the current track from the position the clock reached, using
  the same path `/seek` and `/resume` take.

**Beacon does not resume by itself, and that is the deliberate part.** A
speaker stopping on its own and a person pressing stop on the speaker are
*indistinguishable* from the server: both end in a clean FIN with the device
reporting `TransportState=STOPPED` and `TransportStatus` unchanged. That is
the same ambiguity that makes the bug hard to identify, and it means any
automatic resume would sometimes restart music somebody had just silenced.
Beacon reports what it knows for certain and leaves the judgement to whoever
is listening.

An automatic version was written first, with a cooldown to limit how often it
could fight the user, and then discarded for that reason. If it is ever
revisited, it should be opt-in rather than a default.

---

### AirPlay reports nothing when it dies mid-track

Found 2026-08-22 while checking which cast targets the interruption handling
covers.

Whether a target benefits from any of this depends on **who fetches the
bytes**:

| target | model | covered |
|---|---|---|
| Sonos | pulls `/stream` for the track's duration | yes |
| DLNA | same, via UPnP AVTransport | yes |
| Chromecast | receiver fetches the URL itself | yes |
| AirPlay | downloads the whole track into memory, then plays from the buffer | **no** |

The first three share one code path, so the interruption handling reached
them for free - it lives in `stream_with_completion`, not in anything
Sonos-specific.

AirPlay does not. Its `/stream` connection is opened for the download and
closed *normally* when that finishes, so there is no cancellation to detect,
and playback then runs with no connection open at all. A device dying
mid-track surfaces only here:

    logger.warning(f"[AirPlay:{self.target}] Device disconnected during stream")

A warning and nothing else: no `is_streaming = False`, no broadcast, no
notification. Exactly the silent death this whole entry started from.

**Polling it is not an option, and that is not an oversight.** AirPlay here
uses pyatv's `stream_file`, which pushes raw audio to what is effectively a
dumb sink - there is no transport session to query, so there is no position
to read. `get_position()` was tried and does not work; `SUPPORTS_POSITION`
being absent (so `False` from the base class) reflects the protocol, not
neglect. The position-resync loop therefore never runs for an AirPlay target
either, which is why the other targets' second safety net is missing too.

**But the failure is still observable, from the sending side.** Beacon is the
sender, and a send to a device that has gone away fails - which is exactly
what the handler above already catches and discards into a log line. So a fix
needs no new channel to the device, only a way back into the session:
`AirplayDelivery` holds no reference to it, so raising the same `interrupted`
broadcast needs a callback or an explicit session handle passed in at
construction.

Worth noting for whoever builds it: this signal is *less* ambiguous than the
one the pull-based targets give. A clean FIN cannot be told apart from
somebody pressing stop, which is why Beacon refuses to auto-resume there. A
failed push is a genuine error.

Related, and visible from the same code: AirPlay holds each track entirely in
RAM (`http.get()` on `/stream` into a `BytesIO`). For an 80-minute mix that
is over 100MB per target. It is a deliberate workaround for pyatv's
hardcoded 10s decoder-detection timeout - see the comment in `airplay.py` -
but an expensive one for long tracks.

---

### The copy tier never checks what the device can actually play

Root-caused 2026-08-22, fix outstanding.

**Symptom:** a 24-bit/96 kHz FLAC stopped playback 1.1s after it started.

**Cause:** `resolve_output_format()` picks the stream-copy tier purely on the
source *codec*. Sample rate and bit depth are never looked at, so a FLAC is
handed to the renderer untouched whatever its format. Sonos supports FLAC only
up to 24-bit/48 kHz, and said so itself through UPnP eventing:

    ERROR_UNSUPPORTED_FREQ: 9,0,Bad,<host:port>,<stream url>,96000,0

**The obvious fix does not work.** Falling back to the existing
lossless-reencode tier keeps the sample rate, because its arguments are
`["-acodec", "flac", "-f", "flac"]` with no `-ar`. Re-encoding 96 kHz FLAC to
FLAC yields 96 kHz FLAC and the device rejects it again. A real resample is
needed.

**Limits are per device class**, so this wants declared capabilities rather
than one hardcoded cap: Sonos tops out at 24/48, Chromecast Audio handled
24/96, AirPlay is typically 16/44.1, DLNA varies per renderer.
`BaseDelivery` already carries `SUPPORTS_POSITION` as a class attribute, so
the pattern exists.

**Not related to the drops above**, and worth keeping separate: this produces
an explicit device-reported error, while every drop reported `TransportStatus`
unchanged. It is also how that distinction was established at all - the first
non-`OK` transport status ever seen in this investigation.

---

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

### Picking a second device dropped the first one (2026-08-22)

**Symptom:** adding a speaker to a running cast silently removed the one
already playing. It kept going to the end of the current track - its stream
connection was still open - and from the next track only the newly picked
device played.

**Cause:** the desktop picker applied its selection with `castTo()`, which
goes to `/play` and *replaces* the target set, even though its button read
"+N more". `/join` is the primitive that appends
(`routes/join.py` - and for two Sonos speakers it groups them rather than
opening a second stream).

The mobile picker and the phone's remote control already treated their
checkboxes as a desired end state; only the desktop was incremental. A
comment in `services/remoteControl/commands.ts` even described the
inconsistency without anyone reading it as a bug.

**Fix:** one shared `playbackStore.applyTargets()` that reconciles instead of
replacing, used by all three surfaces. Additions are applied before removals,
deliberately: the reverse order empties the target set in between, and an
empty set is not a neutral intermediate - it hands playback straight back to
the local speakers. That asymmetry (checking a box staged a change, unchecking
one took effect immediately) is what made switching devices unusable.

**Why tests missed it:** the existing test asserted `castTo()` was called with
the selected devices, which is exactly the buggy behaviour, written down as
the expectation.

### Connection reuse was claimed but not achieved (2026-08-22)

**Symptom:** browsing a large library was slow, and a burst of requests could
overrun the host's DNS resolver hard enough to break playback (see the entry
below).

**Cause:** two separate versions of the same mistake. The media adapters
called `httpx.get()`/`httpx.post()`, the module-level convenience functions,
which build a client, resolve DNS, do a TLS handshake, make one request and
discard all of it - 13 call sites. And `routes/proxy.py`, which *had* been
migrated to a shared client and carried a long comment explaining why,
constructed it with httpx's defaults: at most 20 of up to 100 connections kept
alive, expiring after 5s. A library view scrolling past hundreds of covers
exceeds that immediately, so the surplus closed after each request and was
rebuilt for the next.

**Fix:** a shared pooled client for the adapters (`media/http_client.py`) and
explicit limits on the proxy's client, sized for the workload it actually
sees.

**Lesson worth keeping:** "it uses a pooled client" and "it actually reuses
connections" are not the same claim. The proxy's comment described the first
and was believed to mean the second.

### A slow media-server lookup froze streaming, and a transient one ended it (2026-08-22)

**Symptom:** casting stopped dead mid-session. The log showed a 4.71s event
loop stall, `Auto-advance: track ... not found: [Errno -3] Try again`, and
`Track finished — marking stream complete` — with a full queue still waiting.

**Cause:** two of them at one call site. `_advance_or_end()` called
`session.media.get_track()` directly, and the media adapters are synchronous
HTTP clients, so the call ran **on the event loop**: for its whole duration
nothing else was serviced, every open `/stream` socket included. Usually
milliseconds and invisible. The sibling call `get_stream_url()` was already
wrapped in `asyncio.to_thread()` twice in the same file; this one was simply
missed. `routes/playback.py`'s `/play` handler had the identical omission.

Separately, a *transient* lookup failure was treated as "there is nothing
left to play" and ended the session outright.

**Trigger, reproduced:** scrolling ~15k tracks in the library view. Every
request re-resolves the media server's hostname (Python does not cache DNS),
which overran the host's systemd-resolved stub until it returned `EAI_AGAIN`.
One of those failures landed on an auto-advance.

**Fix:** both lookups moved onto a thread, and the auto-advance lookup now
retries a small, bounded number of times before concluding the queue is done
— bounded because it runs while holding `play_lock`.

**The burst itself had its own cause.** The media adapters called
`httpx.get()`/`httpx.post()`, the module-level convenience functions, which
build a client, resolve DNS, do a TLS handshake, make one request and discard
all of it. `routes/proxy.py` had already been migrated away from that exact
pattern; the adapters were missed. They now share one pooled `httpx.Client`
(`media/http_client.py`), so a burst reuses connections instead of
re-resolving per call.

That fix is correct but probably was not what produced this particular
burst: cover art and library browsing go through the proxy, not the
adapters. The proxy pooled — with httpx's defaults, which cap keepalive at
20 of up to 100 connections and expire them after 5s. A library view
scrolling past hundreds of covers exceeds that immediately, so the surplus
closed after every request and was rebuilt, DNS lookup included, for the
next one. Its limits are now sized for that workload. Worth remembering
that "it uses a pooled client" and "it actually reuses connections" are not
the same claim.

Worth knowing alongside it: `SERVER_INTERNAL_URL` being unset routes every
library call out through the public hostname and a reverse proxy rather than
straight to the media server, which makes each of those calls more expensive
again. Setting it is complementary, not an alternative.

Caching DNS inside the app would have been the wrong layer — it leaves the
TCP and TLS setup per request, which costs more than the lookup. The
Electron-only app this backend grew out of never had the problem at all: its
renderer talked to the media server through Chromium, which pools connections
and caches DNS on its own.

**Why tests missed it:** an inline call and a threaded one behave identically
in a test suite — nothing else is competing for the loop. The bug only exists
under concurrency, and only shows up as *latency*, never as a wrong result.
Found by the event-loop stall detector, not by a test.

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
  problem. Log-only by design; it feeds nothing back into playback. This is
  what turned "the device stopped" into "the device says
  `ERROR_UNSUPPORTED_FREQ ... 96000`", and equally what lets a drop reporting
  `TransportStatus` *unchanged* be told apart from one reporting an error.

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
  instrumentation actually fires before trusting its quiet. This happened
  three times in one day: an invalid regex that would have died silently, a
  capture filtered to the wrong port, and a "clean" test window during which
  nothing was actually casting.
- **Check that the experiment is running before reading its result.** A
  scroll-load test was evaluated as passing before anyone noticed no cast was
  active at the time.
- **Do not build statistics on a handful of events.** Five occurrences with no
  measured denominator do not support a rate, and a rate is what a
  probability would need. "It used to happen in most listening sessions and
  has not since" is the honest form; anything with a percentage in it is not.
- **Prefer positive exclusions to absent signals.** "We saw no reboot" is
  weak; "the UPnP subscription kept the same SID across every renewal, which
  a reboot would have invalidated, and the event stream has no gap" is
  strong. Several theories were closed today only because the instrumentation
  could show the thing was *still true*, not merely that nothing appeared.
- **Say when a hypothesis has become unfalsifiable, and then stop.** The
  firmware theory fits every observation and cannot be tested, because
  dating the install needs a log that was switched off. That is not a lead
  in reserve; it is a place to stop spending time until a new source of
  evidence exists.
- **Absence is a weak result, so design for comparison instead.** Waiting for
  a rare, unreproducible bug to *not* happen can never be conclusive. Running
  the pre-fix build beside the current one, same room, same tooling, is worth
  more than any amount of quiet.
