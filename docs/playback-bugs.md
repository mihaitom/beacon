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

**Status: root-caused 2026-08-23, and it is ours after all** - though not
where anyone looked for three days. Beacon's *request volume* knocks over an
authorisation middleware in the reverse proxy that its own media fetches
depend on; the middleware then denies everything, both casting streams lose
their source in the same instant, and each speaker stops once its buffer
runs out. Reproduced deliberately at 21:37 by scrolling cover art until it
fell over. See "The mechanism" below; the day's elimination work that led
there is kept after it, because the dead ends are the valuable part.

Everything the earlier entries ruled out stays ruled out - the delivery
format, the copy tier, transport commands, the cloud, WiFi, the devices
themselves. They were all correct and all beside the point: the failure is
in how much traffic this app generates, not in what it sends. Everything downstream of that (which tier, which format, how the
stream is paced, how it is delivered) is therefore ruled out as a cause,
whatever remains interesting about it for other reasons.

**Earlier status, kept because the reasoning was the step before:** on
2026-08-22 the pre-fix build and the current build were run side by side,
each serving a different room from its own process, port and session. Both
lost their device within ten seconds of each other. Two different code bases
cannot share an application bug at the same instant - but they *can* share a
delivery path, which is why that comparison could not exonerate the delivery
path itself. See "The controlled comparison" further down.

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
| 6 | flac copy | 245s | 11s | current build |
| 7 | mp3 copy, 80-minute mix | 4791s | ~1560s | pre-fix build |
| 8 | mp3 copy | 260s | 65s | current build |
| 9 | flac copy | 294s | 67s | ~15s, healthy; pre-fix build |

Rows 6-9 are all of 2026-08-22; 7 and 8 are the controlled comparison below.
Row 9 came in the evening, with only the pre-fix build streaming at all - the
current build had no stream open at that moment.

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
| Beacon issuing a transport command (stop/pause) | Airtight for anything crossing this host's NIC, as of the full-day capture on 2026-08-22 (see "What a full day of SOAPACTION capture adds"). Every non-`Get` UPnP action of the whole day is accounted for: Beacon's own dispatch triples, `SetVolume`, and two `ListAlarms`. At each drop the nearest preceding command is that track's own dispatch, 55-67s earlier, and nothing at the drop itself |
| The Sonos group re-forming | The satellite emitted no events at all; its transport is bound to the coordinator |
| The stream declaring a wrong duration | No Xing/Info header in what ffmpeg emits; duration reaches the device only via DIDL metadata, correctly |
| The session idle reaper | Still ruled out for the drops in this table, but on different evidence than first written: the packet capture shows no `Stop` reaching the speaker at any of them (see "What a full day of SOAPACTION capture adds"). The original reasoning - "the first drop was 14 min into the session" - measured the wrong clock. What matters is time since the session was last *touched*, not since it started, and a long track touches nothing for its whole duration. That reaper did stop a real cast on 2026-08-23; see "A cast stops half an hour into a long track" under Fixed |
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

**Former lead, now closed - the stream-copy tier itself.** Kept for the
reasoning, not as a candidate. Three independent findings close it: a room
stopped the same way while playing through the household's own music service
(no ffmpeg, no copy tier, no `/stream` of ours); the specific track both
2026-08-23 events happened on played four more times on repeat without an
abort; and the aborts split evenly across mp3-copy and flac-copy anyway. The `FORCE_FALLBACK_FORMAT` A/B
described here is therefore no longer worth running as a cause test. The drops were first
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

### The mechanism (2026-08-23, root cause)

**The chain, start to finish:**

1. The backend is configured with the media server's *public* URL, so every
   server-side fetch - audio, cover art, metadata - leaves the host, crosses
   a reverse proxy on another machine, and comes back. A client request that
   the app then proxies onward therefore crosses that proxy **twice**.
2. Each crossing invokes an IP-reputation middleware that asks its own API
   whether the client is banned. Measured cost: **26-50 ms per request**.
3. Scrolling a library view produced **3733 requests in 4.8 minutes** - about
   7500 authorisation lookups, in bursts far above the average. On top of a
   steady baseline: the player polls each active device's volume every 4 s,
   and every open device list polls its own.
4. The middleware's API stops answering in time. The middleware **fails
   closed**: after a 5 s timeout it returns **HTTP 403**. Measured: **4075
   such denials in one hour**, each preceded by
   `An error occurred while checking IP … context deadline exceeded`.
5. From that moment every request through the proxy is denied - including the
   backend's own media fetches for the *currently casting* streams.
6. Both casting rooms lose their source in the same instant. Each keeps
   playing until its buffer runs out: room B stopped 16 s later, room A 28 s
   later.
7. The speaker then closes the connection (FIN, sometimes RST). **That is the
   consequence, not the cause** - we stopped feeding it.

**The independent witness.** A plain HTTP client, unrelated to the app,
fetching the same media file over the same public path, began receiving 403
at the same moment and kept receiving it every five seconds afterwards. It
had been completing the same fetch in 55 s with status 200 all evening.

**Why the 10-12 second offset between rooms was so consistent:** it is the
difference between the two sources' buffers. Subtracting each one's lead from
its stop time puts the trigger at the same second in every double event -
an arithmetic coincidence noted hours earlier and dismissed, because at the
time nothing was known that could cut both sources at once.

**Why it took three days.** Every local instrument said "healthy", and each
said so correctly:

- The app's own snapshot shows `blocked_for≈0` - because a stalled *source*
  leaves nothing to hand to the device, which looks identical to a healthy
  stream. This value was read the wrong way round for two days.
- The device reports `TransportState=STOPPED` with `TransportStatus` **OK**,
  because from its point of view nothing went wrong.
- No transport command appears on the wire, because none was sent.
- The media server logs no error, because it was never asked.
- The proxy's CPU graph is unremarkable at the moment of failure, because the
  failure is a timeout, not saturation.
- And the proxy writes its access log to a file rather than to its container
  log, so the 403s were invisible in the obvious place.

**What to fix, in order of effect. The first one is the fix; the rest are
improvements.**

1. **Bound how many covers load at once (done, 2026-08-23).** The app relied
   on a browser limit that no longer exists: HTTP/1.1 allowed six
   connections per origin, and that quietly shaped every burst this app has
   ever produced. Over HTTP/2 the browser multiplexes as many requests as it
   is handed, so a list settling with sixty covers on screen sends sixty at
   once. `CoverArt.vue` now holds a process-wide queue of twelve concurrent
   image loads, and a cover that scrolls away while queued gives its place
   up rather than being fetched later. Twelve rather than the old
   six-per-origin browser figure: a cover costs roughly one proxy round trip
   (~106 ms), so a limit of N produces about 10·N requests per second from
   the app and twice that across the proxy, which puts twelve near the
   outage's 142/s peak — but only in bursts that now end when the scroll
   does, where the outage sustained it for minutes.

   A queue alone still only limits *how many start*; what had already
   started ran to the end whether or not anyone was still looking at it. So
   the component no longer lets `<v-img src>` own the request at all: it
   fetches the image itself under an `AbortController` and hands the result
   to `v-img` as an object URL. Leaving the viewport, or having its row
   unmounted by the virtual scroller, now aborts the request on the wire and
   frees its slot immediately. Vuetify's `VImg` renders a plain `<img>`, and
   whether tearing that down cancels the request is up to the browser's
   garbage collector — not something to base a network budget on.

   One exception, deliberately: an image on a foreign host (artist photos
   arrive as pre-signed CDN URLs, radio favicons come from the station's own
   site) sends no CORS headers, so JS may render it but not read its bytes.
   Those keep the plain `<img>` path — uncancellable, but they never touch
   the proxy this is protecting, and they appear a handful at a time rather
   than by the screenful. `SubsonicClient.isProxyUrl()` draws the line.

   Note what none of this is: the settle
   delay added the same day decides *which* covers load, not how many at a
   time, and on its own it did not prevent the outage — the reproduction at
   21:37 ran against a build that already had it.
2. **Generate fewer requests in the background.** The player polls each
   active device's volume every 4 s, and every open device list polls its
   own, because the status stream carries no volume field. A batched
   endpoint, or polling only while a volume control is visible, removes a
   constant baseline.
3. **Optionally, take the proxy out of the server-side path.**
   `NAVIDROME_INTERNAL_URL` sends the backend's own fetches straight to the
   media server on the LAN, which halves the proxy's request volume and
   drops per-request latency from ~106 ms to ~0.5 ms. Worth doing, but it is
   deployment configuration: the app has to behave when it is unset, which
   is what point 1 is for.
4. **Make the middleware fail open, or exempt LAN clients.** An
   authorisation layer whose *failure mode* is to deny an entire household's
   music is the wrong trade-off for a home network. Infrastructure, not
   application — but it is what turns a burst of requests into an outage
   instead of a slow page.

**Why the test suite could never have caught this:** nothing here is wrong in
isolation. The request rate is legitimate, each request is correct, the
backend's fetches are correct, and the proxy's behaviour is a deliberate
security choice. The defect only exists in the *combination*, at a scale that
appears when a person scrolls a large library while music is casting.

### A day of elimination (2026-08-23)

The day this stopped being a hunt for a bug in this codebase and became a
process of elimination with instruments. Two genuine events, a control arm
that contains no Beacon at all, and a long list of things that are now ruled
out with evidence rather than argument.

#### The two events

    Event 1                              Event 2
    12:08:19  room B  STOPPED            17:47:27  room B  STOPPED
    12:08:29  room A  STOPPED            17:47:38  room A  STOPPED

Room A was served by Beacon (mp3/flac copy tier). Room B was served by the
household's own music-service integration (an SMAPI bridge reading from the
same media server) - no Beacon in that path at all: not the stream, not the
pacing, not the format, not the transport commands. Both rooms stopped about
ten seconds apart, twice, in the same order.

A third event at 08:59 hit room B alone after nearly six hours of unattended
playback. That the queue had genuinely looped rather than ended is visible in
the event log: the same track URI plays at 08:09 and again at 08:59.

#### The measurement that decided the direction

For event 2 we have the abort from two independent vantage points, on the
same clock:

    17:47:38.229    the speaker sends TCP RST to our stream socket   (packet capture, media host)
    17:47:38.2335   the upstream fetch through the proxy ends        (reverse-proxy access log)

Event 1 shows the same ordering, 3 ms apart. **The device aborts first; our
whole chain unwinds behind it.** The upstream fetch only ends because the
response generator is cancelled and ffmpeg goes with it.

That single measurement removes an entire class of explanations: nothing
upstream - not the media server, not the reverse proxy, not its rate limiter,
not the network path - can be the trigger, because all of it was still
healthy when the speaker pulled the plug. The source had delivered 17.9 MB in
40 seconds, status 206, no errors, no delay.

It also re-interprets a value that had been read the wrong way round for two
days: `blocked_for` in `DisconnectSnapshot` measures how long the connection
was blocked *handing a chunk to the device*. A stalled **source** produces
nothing to hand over, so it reads ~0 - identical to a perfectly healthy
stream. `blocked_for≈0` therefore never was evidence against source
starvation. The millisecond ordering is what actually settles it.

#### What is ruled out, and by what

| Candidate | Ruled out by |
|---|---|
| Beacon's delivery path (format, pacing, `/stream`) | Room B stops the same way with no Beacon in its path |
| Any transport command from the LAN | Full-day SOAPACTION capture: no `Stop` at any event; nearest command is that track's own dispatch, 55-86 s earlier |
| Cloud control (voice assistants, remote apps, the speaker vendor's cloud) | Every speaker and both voice assistants had their internet access blocked at the router from 15:00 on. Event 2 happened anyway |
| WiFi association loss, DFS channel change | The router logs 5 GHz de/registrations for other devices that day; the speakers never appear. They held their link through both events |
| Group/topology change | Topology broadcasts follow the stops by 18-29 s; they are consequence, not cause |
| The specific file or the copy tier | The track both events happened on played four more times on repeat afterwards without a single abort |
| Our own multicast load | Deliberate stress: 183 SSDP searches/min for seven minutes, versus a 23-30/min baseline. Nothing happened |
| Client activity in the app | Seven separate stimuli over 2.5 hours (see the protocol below), none of them produced an event |
| Reverse proxy, media server, rate limiter | The millisecond ordering above; and the rate limiter was never even reached (peak 142 req/s against an average of 100/burst 400 - and no 429 in the logs) |
| The idle-session reaper | Fixed the same day, twice (see Fixed); both fixes verified in the field afterwards |

#### The stimulus protocol, and its complete lack of results

With both rooms playing and the household cut off from the internet, each
step was applied with at least fifteen minutes between them and the exact
time recorded:

| Step | Stimulus | Result |
|---|---|---|
| Baseline | no client connected anywhere | 44 min quiet |
| 2 | phone woken, browser open, app not opened | 24 min quiet |
| 3 | login on the casting instance, same URL as the event | 15 min quiet |
| 3.5 | login with the other URL spelling, creating a second session | 20 min quiet |
| 3.6 | login on the second instance, same account | quiet |
| 3.7 | cold login in a private window, visualizer open, device picker open | quiet |
| 3.8 | second account, device picker open | quiet |
| 4 | two device pickers open at once, 183 SSDP searches/min | quiet |
| 5 | heavy library scrolling, 142 requests/s, ~1300 requests | quiet |

The one pattern that survives the day is temporal and weak: both genuine
events followed a period of user interaction (a login five minutes before,
a login-plus-scrolling burst three minutes before). Every attempt to
reproduce that deliberately failed.

#### An arithmetic coincidence worth keeping

Subtracting each source's buffer from its stop time puts the two rooms'
"trigger" at the same second, twice:

    room A stops 17:47:38, minus ~15 s of stream lead   -> 17:47:23
    room B stops 17:47:27, minus ~5 s of bridge buffer  -> 17:47:22

    room A stops 12:08:29, minus ~15 s                  -> 12:08:14
    room B stops 12:08:19, minus ~5 s                   -> 12:08:14

That is what a single upstream interruption would look like - which the
millisecond ordering rules out. Either the buffer figures are coincidence, or
something reaches both speakers at one moment without touching the data path.
It is the sharpest unexplained observation of the day.

#### Infrastructure findings that are real but not the cause

Worth fixing on their own merits, and worth knowing when reading timings:

- **Every server-side media fetch leaves the host and comes back.** The
  backend is configured with the media server's public URL, which resolves to
  a reverse proxy on a *different* machine. Each request therefore crosses
  the network twice and passes the proxy's middleware chain. Measured: 106 ms
  to first byte via the public route versus 0.5 ms locally, a factor of 200.
  `NAVIDROME_INTERNAL_URL` exists precisely for this and was not set.
- **Every proxied request pays a ~30 ms authorisation round trip** to the
  proxy's IP-reputation middleware. During the scrolling stimulus that meant
  several hundred such calls per second, which is where the proxy host's CPU
  spikes come from.
- **Each cover-art request traverses the proxy twice** - once from the
  browser to the app, once from the app to the media server - so client-side
  request bursts are doubled before they reach the media server.
- **22 unexplained HTTP 403s** appeared on the app's router during the
  scrolling burst. Not the rate limiter (no 429s), not the reputation
  middleware (it logged 200 for every lookup), and the app's own token
  rejection returns 401. Unresolved.

#### Instruments now in place

For whoever picks this up next - all of these run on the media host unless
noted:

- Full-payload packet capture of both rooms' stream ports, 40×100 MB ring
  (~17 h of history at the observed rate), with the two newest files frozen
  automatically when an abort is detected.
- A control stream: a plain HTTP client pulling the same media file over the
  same public path, rate-limited to roughly real time, logging every fetch's
  duration and status. If it is cut at the same instant as a speaker, the
  path is implicated; if it survives, the speaker is.
- Connection-level capture (SYN/FIN/RST) for both stream ports, and a
  control-traffic capture filtered to UPnP SOAPACTION/NOTIFY lines.
- UPnP transport-event subscriptions for both room coordinators, which record
  a room's `STOPPED` regardless of who is playing to it.
- A watchdog that reports any speaker that stops and does not resume within
  45 s, and a push notification for both that and app-detected aborts.

#### Open threads

1. What reaches both speakers at the same moment without touching the data
   path (see the arithmetic above).
2. The 19.47 s event-loop stall, still unexplained and unrepeated (its own
   entry below).
3. The 22 HTTP 403s during the request burst.
4. Vendor diagnostics: the speakers' own logs are the one record that would
   say why a player stopped, and they are only readable by the vendor's
   support. After a day of elimination this is a reasonable escalation.

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

### What a full day of SOAPACTION capture adds (2026-08-22, evening)

A sixth drop that evening (row 9 above) with the capture running all day, and
the day's logs read as a whole.

**The signature is unchanged.** 20:38:10 local, `flac (copy)`, 67s into a
294s track, a healthy ~15s lead, 11.25 MB acknowledged, the device sending
FIN first, `TransportState=STOPPED` with no `TRANSITIONING` and
`TransportStatus` unchanged, then the 10s grace period. Nothing here is new
except the count.

**No local transport command exists, and now that is measured rather than
sampled.** The capture keeps every `SOAPACTION` line to and from the players
for the whole day. Filtering it to non-`Get` actions yields only Beacon's own
dispatch triples (`Stop`/`SetAVTransportURI`/`Play`), `SetVolume`, and two
`ListAlarms`. At every one of the day's four drops the nearest command is the
dispatch of the track that then dropped, 55-67s earlier. The ruled-out row
above is upgraded accordingly. This says nothing about phone-to-speaker or
cloud traffic, which still never reaches this NIC.

**The copy tier is neither implicated nor exonerated - it is unmeasured.** Of
95 track dispatches that day across both builds, 60 were `mp3 (copy)` and 35
`flac (copy)`. **Zero** used the fallback tier, and `FORCE_FALLBACK_FORMAT`
was set on neither container: the A/B this file calls the strongest open lead
has never actually been run. Drops split 2 and 2 across the two copy tiers, so
they do not separate the tiers either.

At four drops per 95 tracks, one comparable listening day on the fallback tier
is a decisive experiment rather than a suggestive one: ~4 drops expected,
observing none puts it at roughly p = 0.02.

**"Outside Beacon" is broader than "in the Sonos system".** The controlled
comparison excludes *application logic* - two code bases cannot share a bug at
the same instant. It does not exclude anything the two processes have in
common, and that list is longer than it first appears: the same host and NIC,
the same network, the same ffmpeg copy output from the same library, the same
Sonos household, and the same SSDP behaviour (the 8s discovery sweep is in
both builds, and running two instances doubles it). The pending
`FORCE_FALLBACK_FORMAT` A/B tests exactly one of those shared layers - what
the byte stream looks like - which is why it stays the best next step even
after the comparison. Caching the resolved SoCo device would test another.

Checked and not supported: whether drops line up with Beacon's own SSDP
sweeps. Only one drop falls inside the capture's window (it started 17:04
UTC), 2.2s after the preceding sweep at a ~8s cadence, which shows nothing.
Re-testing this needs the capture to have been running well before the drop.

**Two things to know before reading the captures again:**

- The ctrl capture retains only timestamps plus `SOAPACTION` and `NOTIFY`
  request lines - no bodies at all (`grep DIDL` over the whole 92 MB log:
  zero hits). The `GetZoneGroupState` **response** instrument this file asks
  for above therefore still does not exist, and the 4262 `ZoneGroupState`
  hits are all request lines.
- The players' connections to port 8099 right after a drop are the
  monitoring's own UPnP NOTIFY receiver (`/tmp/sonos_events2.py`), not a
  third-party service. Three players also rejected `SUBSCRIBE` with HTTP 503
  at 18:18:29 UTC, so a gap in the event log is not by itself evidence that
  nothing happened.

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

### Auto-advance onto a still-playing device drops the next track silently

Not investigated yet — one occurrence, 2026-08-24, prod.
Distinct from "Cast device drops a healthy stream mid-track" above: that one
drops a stream that had already delivered real audio; this one never starts
audio at all.

**Symptom:** queue auto-advanced from "SIDEPIECE — Cry for You" to "Royal
Gigolos — California Dreamin" on room A's Sonos. No sound from the new track
ever played (confirmed by the listener). Backend reported the usual
10s-grace-period drop.

**Ruled out:** the already-documented reverse-proxy/cover-art-storm cause
(see "The mechanism" above). The reverse proxy's access log and its
IP-reputation middleware's log are clean for the entire window — no 403s, no
elevated request rate, ordinary background traffic only (`device-volume`
polling, one lyrics/cover-art burst of normal size for a track change).

**What the app's own log shows**, in order:

    20:31:09  [position-resync] device=176.00s wall=176.42s ...       (still finishing the old track)
    20:31:09  [upnp] room A state=PLAYING uri=.../stream/e3384330   (old track, same session URL)
    20:31:09  [delivery] Sonos:room A transport state before dispatch: PLAYING
    20:31:09  [delivery] Sonos:room A → play: .../stream/e3384330  (same URL — SonosDelivery.play() calls device.stop() first, since state=PLAYING)
    20:31:09  [stream] Auto-advanced to Royal Gigolos — California Dreamin
    20:31:10  [upnp] room A state=PLAYING uri=.../stream/e3384330
    20:31:10  [streamer] [ffmpeg] Stream cancelled (Track 1)              (old track's ffmpeg torn down)
    20:31:10  [upnp] room A state=STOPPED uri=.../stream/e3384330  (device stops itself, same second)
    20:31:17  [position-resync] device=0.00s wall=8.08s ... offset -0.70s -> -8.08s
    20:31:20  ERROR [stream] Cast device dropped its connection ... | position=0.0s delivered=622802B over wall=0.5s

`stream_url()` is session-scoped, not per-track — the same URL carries every
track in a session, which is why the device is already mid-fetch of it when
auto-advance fires. `_dispatch_queued_track()` (routes/stream.py) still
calls `target.play()` unconditionally, the same call a fresh `/play` makes,
and `SonosDelivery.play()` (delivery/sonos.py) calls `device.stop()`
whenever transport state isn't already STOPPED — including here, where it's
PLAYING the exact URL about to be reissued. The device flips PLAYING ->
STOPPED in the same second and never recovers; delivered bytes (622KB over
0.5s) confirm essentially nothing reached it.

**Not a deterministic bug**: the identical sequence (`transport state before
dispatch: PLAYING` on an auto-advance, same session URL, `device.stop()`
called) appears 14 other times in the same 6h log window today alone, all of
them succeeding without incident — e.g. 15:24:04, immediately followed by a
clean calibration and normal position-resync ticks. If this is real, it's a
narrow race between our own stop()+SetAVTransportURI+Play cycle and the
device's own in-flight handling of the connection it's already reading from,
not something that reproduces on every auto-advance.

**Also encountered while chasing this, and worth separating out**: a
genuinely unrelated, expected event initially looked like a second instance
of the same thing — a device the *user* paused directly (not through
Beacon) shows up identically in the log to an unexplained drop (clean FIN,
`TransportStatus` unchanged, resync reads the frozen position as an
"external position change"). That ambiguity is deliberate/already documented
(see "What Beacon does about it" below) — don't mistake a manual device-side
stop for a repro of this entry.

**Secondary, confirmed-real finding along the way:** `_resync_position_once()`
(routes/playback.py) has no guard against the device having actually
stopped/paused before trusting a `get_position()` reading as a legitimate
external seek — visible above at 20:31:17, where the already-stopped
device's stale `0.00s` reading gets read as "external position change" and
corrupts `position_offset` by -7.38s. Doesn't cause a drop by itself (this
one was already broken by then) but pollutes the diagnostic picture whenever
a drop coincides with a resync tick, and would show as a visible position/
lyrics/visualizer jump if the device recovered on its own instead of timing
out. Fixing it cleanly needs either an extra transport-state round trip in
the resync loop (device.get_current_transport_info(), a second SOAP call per
8s tick) or feeding core/upnp_events.py's (currently deliberately log-only)
push events back into playback state — both real design decisions, not
attempted here.

**Next step if this recurs:** capture a packet trace across the recurrence
(see the Instrumentation section below for what's proven useful before) —
specifically whether SetAVTransportURI lands on the wire while the device's
existing GET to the same URL is still open, and whether the device's FIN/RST
precedes or follows our own `device.stop()` SOAP call. One occurrence isn't
enough to change `_dispatch_queued_track()`/`SonosDelivery.play()` against a
call pattern that otherwise works.

---

### An event-loop stall of 19.47s, cause unknown

2026-08-23, 00:49, on one instance while casting. One occurrence, not seen
again over the following night.

    00:48:46  resync healthy: device=32.00s wall=33.01s delta=-1.01s
    00:49:13  [loop] Event loop blocked for 19.47s
    00:49:13  [ffmpeg] Stream cancelled (Track 1)
    ...      (the reconnect chain that followed is under Fixed below)

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

---

## Fixed

### A mid-track reconnect restarted the track and poisoned the clock (2026-08-23)

**Symptom, as it reached the user:** the app looked broken rather than merely
quiet. The position jumped, the progress bar disagreed with what was audible,
lyrics and the visualizer drifted with it, and playback appeared stuck. The
only way out from the UI was a hard reload plus skipping to the next track.

**The chain**, all of it in one log window, triggered by the 19.47s stall
above:

    00:49:13  [stream] Reconnect while already streaming — offset=0.00s vs elapsed()=59.03s, drift=+59.03s
    00:49:13  [ffmpeg] new invocation, no -ss: the track from its beginning
    00:49:13  [upnp] room A state=STOPPED
    00:49:13  [position-resync] external position change — device=0.00s wall=60.35s, offset -1.02s -> -60.35s
    00:49:22  [position-resync] external position change — device=0.00s wall=68.68s, offset -60.35s -> -68.68s
    00:49:23  [stream] Cast device dropped its connection ... loop_lag_30s=19.47s

1. The device gave up on the stalled connection and re-requested the URL.
2. `routes/stream.py` served it `offset = clock.resume_offset`, which the
   *first* connection of that dispatch had already consumed and reset to 0.
   So the speaker got the track from 0:00 while the session's clock stood at
   59s. The `TEMPORARY` diagnostic block in that file existed to find out
   whether this case was real; it was, and this was its first full capture.
3. The resync then read device=0.00s against wall=60.35s as a deliberate seek
   on the speaker - the case `_resync_position_once()` exists to follow - and
   calibrated `position_offset` to -60.35s, then -68.68s.
4. `elapsed()` was then wrong by a minute, and everything downstream reads
   from it: displayed position, lyrics sync, the visualizer's frame pacing,
   `seconds_until()`'s auto-advance scheduling.

**Fix**, two parts, both in the "device reopened this on its own" branch:

- A connection for a `play_generation` that has already been served audio
  (`AppState.streamed_generation`) is a reconnect, and is served from
  `PlaybackClock.stream_restart_position()` - the raw wall position, without
  `position_offset`, since the device is about to re-incur its own startup
  buffering. A fresh dispatch still gets its own `resume_offset`, which is
  what keeps a slow device's first connection from being served from wherever
  the clock crept to while it was connecting.
- `PlaybackClock.restream_from()` re-bases `track_start_position` when that
  audio actually starts flowing. The device's own position counter restarts
  with the new stream, and `elapsed_since_stream_start()` is the frame it is
  compared against - without this, step 3 happens anyway.

**Still open, as defence in depth:** the resync's backwards correction is
unbounded, while the startup path bounds the forwards one
(`MAX_PLAUSIBLE_POSITION_LEAD`). Nothing should be able to drag
`position_offset` by a whole track position in one step, whatever the device
reports.

**Why the test suite didn't catch it:** the reconnect path was covered -
there is a test for `is_streaming` being revived by a bare reconnect - but
none asserted *which position* a reconnect is served from. The offset was
treated as an input to a connection rather than as behaviour worth pinning,
so the code and its tests shared the same blind spot.

### A cast stops half an hour into a long track (2026-08-23)

The clearest self-inflicted version of this file's own symptom, found by
running the app against a control arm overnight: playback stopped mid-track
with no cause visible in the app's own reasoning, and was logged as a device
drop.

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
later. The device-ownership check below still applies to sessions that have
genuinely stopped.

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

### A session being reaped stopped a speaker somebody else was using (2026-08-22)

Not a drop, but it produces one: the same "cast device dropped its connection"
error, with no cause visible in the affected instance at all. Worth reading
before chasing a drop that happened while more than one Beacon instance was
running.

**What happened:** at 22:01:30 a session in one instance was reaped after
`SESSION_IDLE_TIMEOUT`, and `reap_once()` called `stop()` on the delivery it
still held from a cast that had ended over an hour earlier. That speaker
belonged to a *different* Beacon instance by then, which was mid-track on it.
The victim instance saw its stream cancelled with nothing to explain it - no
request, no error - and reported a drop 10s later. The only trace was a single
`[Sonos:room A] stopped` line in the *other* container's log.

Cross-instance claims cannot catch this: `core/claims.py` is per process, and
two instances share nothing but the speakers themselves. Session ids don't
even differ between them - they are derived from the media-server login, so
the same user gets the same id everywhere.

**Fix:** `reap_once()` now stops a device only when the session still believes
it is streaming *and* the device still reports our own stream URL (our port,
our session id) as what it is playing - `BaseDelivery.current_uri()`, with
Sonos/Chromecast/DLNA implementations and `None` ("can't say", stop as before)
for AirPlay.

**Why the tests didn't catch it:** the existing reap test asserted that the
delivery gets stopped, which was the whole of the intended behaviour as
written. Nothing described *whose* device it was, because until a second
instance existed on the same network the question could not come up.

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
