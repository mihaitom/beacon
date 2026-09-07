# Cast device drops a healthy stream mid-track - symptom, evidence & ruled-out theories (RESOLVED 2026-08-26)

Shared diagnostic reference for two confirmed causes that produce the
identical device-side signature and were, for a while, chased as one bug:

- [reverse-proxy 403](mid-track-drop-reverse-proxy-403.md) - **RESOLVED 2026-08-23**
- [test-suite Sonos-discovery leak](mid-track-drop-test-suite-sonos-leak.md) - **RESOLVED 2026-08-24 (test-suite side)**

**Assessment as of 2026-08-24 (the listener's call, not independently
wire-confirmed):** every mid-track drop ever recorded here now has a
plausible attributed cause - the older ones to the 403 middleware, and every
recent one (rows 10-14) to the test-suite leak, which lines up 5 for 5. Kept
at "probably" rather than "resolved" for this file specifically because nothing
here rules out a third, still-undiscovered mechanism the way the 403 fix was
independently confirmed by deliberate reproduction - this one's confidence
rests entirely on timing correlation plus a plausible mechanism, not a
packet-level demonstration that the read-only SOAP burst is what makes the
device let go. Downgrade back to open the moment a mid-track drop recurs with
no `pytest` run anywhere near it.

**Graduated to RESOLVED 2026-08-26:** the quiet period held - no recurrence
since the 2026-08-24 assessment above. Still resting on the same timing
correlation, not a packet-level proof; downgrade this file the moment a
mid-track drop turns up again.

The ruled-out list below stays useful regardless of how this resolves - it is
what stops a future recurrence from re-testing the same fifteen theories.

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
| 6 | flac copy | 245s | 11s | current build |
| 7 | mp3 copy, 80-minute mix | 4791s | ~1560s | pre-fix build |
| 8 | mp3 copy | 260s | 65s | current build |
| 9 | flac copy | 294s | 67s | ~15s, healthy; pre-fix build |
| 10 | mp3 copy, 320 kb/s, ~950KB embedded cover | 222s | 141s | not measured; 6.28MB delivered over 141.8s, position matched wall clock exactly, loop_lag=0.00 |
| 11 | mp3 copy, 320 kb/s | 267s | 106s | ~15s typical; 4.87MB delivered over 106.7s, loop_lag=0.00 |
| 12 | mp3 copy, 320 kb/s ("Dominica") | 180s | 124s | 5.52MB delivered over 122.9s; 22:05:54, `pytest -q` full suite started 22:05:22 (32s before) |
| 13 | mp3 copy, 320 kb/s ("Armin van Buuren — Waiting for the Night") | 184s | 155s | 6.82MB delivered over 155.3s; 22:56:23, `pytest -q` full suite started 22:55:47 (35s before, pre-fix conftest.py) |
| 14 | mp3 copy, 320 kb/s ("Armin van Buuren — Es Vedrà") | 197s | 35s | 1.98MB delivered over 34.5s; 23:00:53, coincides with the listener's own manual `pytest -q` run (pre-fix conftest.py) rather than one from this session |

Rows 12-14 are 2026-08-24, the same evening as rows 10-11 - see the
[test-suite Sonos-discovery leak](mid-track-drop-test-suite-sonos-leak.md)
file. All five mid-track drops that evening line up with a full backend test
run within about half a minute, four run by the assistant and one run
manually by the listener while reproducing the correlation deliberately.

Rows 6-9 are all of 2026-08-22; 7 and 8 are the controlled comparison - see
[the reverse-proxy 403 file](mid-track-drop-reverse-proxy-403.md#the-controlled-comparison-2026-08-22-1853).
Row 9 came in the evening, with only the pre-fix build streaming at all - the
current build had no stream open at that moment. Rows 10-11 are 2026-08-24,
21:14 and 21:47 - production, running the 2026-08-23 build (see
[Instrumentation](instrumentation.md); nothing unreleased was deployed at the
time). Reverse-proxy/middleware logs for both windows are clean - not the
already-fixed 403 cause.

**The same-track correlation noted here earlier did not hold up.** Row 10
("Royal Gigolos") and the auto-advance drop documented separately
([Auto-advance onto a still-playing device drops the next track silently](auto-advance-still-playing-device.md))
happened on the same track, twice within 45 minutes - which read as a real
lead at the time. A deliberate replay of that exact track less than 25
minutes later played to completion with no issue at all (207.4s produced,
clean auto-advance to the next track). Row 11, an hour later, dropped a
*third*, unrelated track ("Toni Braxton — Un-Break My Heart"). Three drops,
three different tracks, one of them proven not to reproduce on demand -
this is the general, still-unexplained pattern from the rest of this entry,
not a file-specific one. Kept as a worked example of why n=2 needs a third
data point before it's trusted (see "Beware n=1 correlation" in
[Method notes](method-notes.md)) - the embedded-cover-art probe for row 10 is
still on record above in case a real per-file trigger turns up some other way.

**Row 11 is the first drop in this whole investigation with a live packet
capture running across it** (see [Instrumentation](instrumentation.md) for
the new always-ready setup). Confirms, on the wire rather than inferred from
log ordering: the device sends a clean FIN to Beacon's stream
port at 19:47:29.954 UTC, the same second its own UPnP eventing reports
`state=STOPPED`. No RST, nothing from Beacon's side first - the device
aborts, Beacon's chain unwinds behind it, exactly as
[the reverse-proxy 403 file's "The mechanism" section](mid-track-drop-reverse-proxy-403.md)
established for the original incident. Adds a confirmed instance to a
pattern that was previously only established for that one investigation,
without pointing to a new cause.

**Also checked and not confirmed:** the listener happened to open Navidrome's
own web player and start the same track independently (checking whether a
mistagged file was the file's fault or Beacon's, unrelated to reproducing
this) about 2 seconds before row 11's drop - a second, independent stream of
the same file from the same media-server user account, briefly overlapping
Beacon's own. `navidrome-bonob-1`'s log (the one process on this host with
any Sonos-facing path outside Beacon) shows nothing but its own 30s
healthcheck across the whole window - no local channel found connecting the
two. Genuinely n=1 and not a deliberate test, so this is not a lead to
act on, only a coincidence worth having on record: if a *deliberate* repeat
of "cast a track, then start the same track in Navidrome's own player"
reproduces a drop, that would be the first reliably-triggerable repro this
file has ever had.

No pattern in absolute time, position in the track, track length, or codec.
Both the mp3-copy and flac-copy tiers are affected. Four of the nine dropped
within the first ~70s of a track, which is more than a uniform distribution
over a ~250-300s track would give, but n=9 and this is not currently
actionable.

**Ruled out** (with the evidence, so these need not be re-tested):

| theory | how it was excluded |
|---|---|
| A second Beacon instance interfering | A drop occurred after that container had been removed entirely |
| Another Sonos-integrating service on the same host | Its log held only its own healthcheck; no traffic to the players appeared in the capture |
| Buffer starvation | Several drops happened with a full ~15s lead in flight |
| The event loop starving the socket | `loop_lag_30s`/`loop_lag_120s` were 0.00-0.01s at every drop |
| TCP backpressure / device stopped reading | Send-queue depth 0 and `blocked_for` ~0.01s right up to the FIN |
| Network trouble | Clean FIN, all bytes ACKed, retransmitted bytes ~0.03% |
| Beacon issuing a transport command (stop/pause) | Airtight for anything crossing this host's NIC, as of the full-day capture on 2026-08-22 (see [the reverse-proxy 403 file](mid-track-drop-reverse-proxy-403.md)). Every non-`Get` UPnP action of the whole day is accounted for: Beacon's own dispatch triples, `SetVolume`, and two `ListAlarms`. At each drop the nearest preceding command is that track's own dispatch, 55-67s earlier, and nothing at the drop itself. **Scope caveat added 2026-08-24: this only ever captured the production container's own NIC** - a read-only `GetPositionInfo`/discovery burst from a *different* host on the same LAN (see the [test-suite Sonos-discovery leak](mid-track-drop-test-suite-sonos-leak.md)) would not appear in it and was never ruled out by this capture |
| The Sonos group re-forming | The satellite emitted no events at all; its transport is bound to the coordinator |
| The stream declaring a wrong duration | No Xing/Info header in what ffmpeg emits; duration reaches the device only via DIDL metadata, correctly |
| The session idle reaper | Still ruled out for the drops in this table, but on different evidence than first written: the packet capture shows no `Stop` reaching the speaker at any of them. The original reasoning - "the first drop was 14 min into the session" - measured the wrong clock. What matters is time since the session was last *touched*, not since it started, and a long track touches nothing for its whole duration. That reaper did stop a real cast on 2026-08-23; see [A cast stops half an hour into a long track](fixed-cast-stops-after-30-minutes.md) |
| AudioAnalyzer blocking the stream generator | `feed()` is non-blocking (unbounded queue), so it cannot stall it |
| Embedded cover art / the bitrate factor | A track whose factor was 1.006 dropped just the same |
| The frontend commanding a stop from a background tab | Two independent checks: no UPnP command reached the speaker, and no `/pause` or `/stop` appears in the backend log at any drop |
| The media-server account in use | Navidrome stores transcoding settings and bitrate caps per (user, client). All players for every user read `max_bit_rate: 0` and `transcoding_id: ''`, so the delivered bytes are identical whichever account streams |
| A device capability mismatch | Those produce an explicit `TransportStatus` error from the device (see [The copy tier never checks what the device can actually play](copy-tier-device-limits.md)). Every drop reported `TransportStatus` unchanged, i.e. `OK` |
| The speaker rebooting or losing the network | Positively excluded, not merely unobserved: the UPnP subscriptions held the **same SID all day** across renewals, which a reboot would have invalidated, and the event stream runs straight through the drop without a gap. The device was reachable and answering throughout |
| A Sonos alarm taking over playback | `ListAlarms` returns `<Alarms></Alarms>` - none configured |
| The Sonos-SMAPI integration on the same host | Its log holds only its own healthcheck in every drop window |
| Someone using the Sonos phone app | That app queries the SMAPI integration when in use, and its log shows app traffic in exactly one hour of the day - the one where it was deliberately opened to check. Never at a drop. Excludes the app *being used*, not a stop command sent from it |
| A zone-group topology change | Subscribed to `ZoneGroupTopology` on all six players. Topology stayed at `groups=2` throughout; the only broadcasts coincided with the app being opened by hand |
| A firmware version mismatch in the household | The Sub runs 17.2.6 against 18.7 elsewhere, but Sonos publishes that as the separate "legacy system version" track and the app reports everything up to date. A supported state, not a defect |

**Former lead, now closed - the stream-copy tier itself.** Kept for the
reasoning, not as a candidate. Three independent findings close it: a room
stopped the same way while playing through the household's own music service
(no ffmpeg, no copy tier, no `/stream` of ours); the specific track both
2026-08-23 events happened on played four more times on repeat without an
abort; and the aborts split evenly across mp3-copy and flac-copy anyway. The
`FORCE_FALLBACK_FORMAT` A/B described here is therefore no longer worth
running as a cause test. The drops were first noticed after
`resolve_output_format()` gained the `-acodec copy` tiers. Before that every
track was re-encoded to a uniform MP3 192k CBR stream, and the simpler
upstream this backend derives from still does exactly that and has never
shown this bug. Stream-copy instead hands the device the source's own
frames: VBR, 48 kHz, free-format or unusual frame headers, an ID3 tag inline,
FLAC whose STREAMINFO cannot state `total_samples` on a piped stream. Any of
those could plausibly make a renderer decide it has reached the end of the
content - which is exactly what the device reports (`STOPPED`, status `OK`,
full buffer).

The A/B was cheap: set `FORCE_FALLBACK_FORMAT=1`, which made
`resolve_output_format()` return `FALLBACK_FORMAT` for everything and skip
the probe, reproducing the pre-copy-tier pipeline exactly. It was an
environment variable rather than a code edit so the two arms could be
swapped with a container restart instead of a rebuild. If the drops stopped,
the cause was in what stream-copy emits, and the next question would have
been which property of the source triggers it. If they continued, the copy
tier was exonerated.

**`FORCE_FALLBACK_FORMAT` no longer exists (removed 2026-08-26).** It was
replaced by the quality settings in the frontend, which do the same thing
more precisely: setting the cast ceiling to mp3 192 forces every source
above it through the same re-encode, per session and with no restart, while
leaving the local player alone. The one thing the env var did that the
setting does not is skip the probe — nothing here ever depended on that.

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
from never put on a speaker. Since fixed for cast sessions themselves (device
resolution is cached, see `delivery/sonos.py`'s `_get_device()`) - what
remained unguarded was *test* code reaching the same call, see the
[test-suite Sonos-discovery leak](mid-track-drop-test-suite-sonos-leak.md).

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

Since a device can stop for reasons outside this codebase, and that may not
always be reachable at all, the useful thing was to stop letting it end a
session silently. Previously the grace period expiring set
`is_streaming = False` and that was the end of it: the music stopped, nothing
said so, and it was only noticed when someone missed it.

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
