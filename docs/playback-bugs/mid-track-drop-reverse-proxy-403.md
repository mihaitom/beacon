# Cast device drops mid-track - reverse-proxy 403 (RESOLVED 2026-08-23)

See [the shared symptom/evidence file](mid-track-drop-symptom.md) for the
device-side signature, the full drops table, and the ruled-out list this
entry builds on - this file is the specific mechanism, root-caused after
three days of elimination.

**And it is ours after all** - though not where anyone looked for three days.
Beacon's *request volume* knocks over an authorisation middleware in the
reverse proxy that its own media fetches depend on; the middleware then
denies everything, both casting streams lose their source in the same
instant, and each speaker stops once its buffer runs out. Reproduced
deliberately at 21:37 by scrolling cover art until it fell over.

Everything [the shared file's ruled-out list](mid-track-drop-symptom.md)
covers stays ruled out - the delivery format, the copy tier, transport
commands, the cloud, WiFi, the devices themselves. They were all correct and
all beside the point: the failure is in how much traffic this app generates,
not in what it sends. Everything downstream of that (which tier, which
format, how the stream is paced, how it is delivered) is therefore ruled out
as a cause, whatever remains interesting about it for other reasons.

**Note added 2026-08-24: a second, independent cause was later found for the
identical symptom** - see the
[test-suite Sonos-discovery leak](mid-track-drop-test-suite-sonos-leak.md).
This root cause is not in doubt - it was reproduced deliberately and on
demand - but it was never established as the *only* thing dropping casts, and
the leaking test existed since before this investigation even started. Some
of the drops attributed to this entry in "A day of elimination" and "The
controlled comparison" below were plausibly the other cause instead. Not
resolvable retroactively; noted so this page isn't re-read as a closed case
for every drop it was ever written next to.

**Symptom:** while casting to a Sonos speaker, the device stops mid-track and
never reconnects. The backend marks the session not-streaming after the 10s
grace period and playback is over. Timing is not reproducible.

## The mechanism (2026-08-23, root cause)

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

## A day of elimination (2026-08-23)

The day this stopped being a hunt for a bug in this codebase and became a
process of elimination with instruments. Two genuine events, a control arm
that contains no Beacon at all, and a long list of things that are now ruled
out with evidence rather than argument.

### The two events

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

### The measurement that decided the direction

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

### What is ruled out, and by what

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
| The idle-session reaper | Fixed the same day, twice (see [Fixed](README.md)); both fixes verified in the field afterwards |

### The stimulus protocol, and its complete lack of results

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

### An arithmetic coincidence worth keeping

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

### Infrastructure findings that are real but not the cause

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

### Open threads

1. What reaches both speakers at the same moment without touching the data
   path (see the arithmetic above).
2. The [19.47 s event-loop stall](event-loop-stall-19s.md), still unexplained
   and unrepeated.
3. The 22 HTTP 403s during the request burst.
4. Vendor diagnostics: the speakers' own logs are the one record that would
   say why a player stopped, and they are only readable by the vendor's
   support. After a day of elimination this is a reasonable escalation.

## The controlled comparison (2026-08-22, 18:53)

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

## What a full day of SOAPACTION capture adds (2026-08-22, evening)

A sixth drop that evening (row 9 in [the symptom file](mid-track-drop-symptom.md))
with the capture running all day, and the day's logs read as a whole.

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
dispatch of the track that then dropped, 55-67s earlier. The ruled-out row in
[the symptom file](mid-track-drop-symptom.md) is upgraded accordingly. This
says nothing about phone-to-speaker or cloud traffic, which still never
reaches this NIC.

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

(That env var was removed 2026-08-26. The same arm is now reachable from the
frontend's cast quality setting - see
[the symptom file](mid-track-drop-symptom.md) for what changed and what
didn't. The reasoning above is unaffected; only the switch moved.)

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

## Telling the fixes apart

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
