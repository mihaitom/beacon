# Investigations

Every case in here cost more than an afternoon. The point of the folder is
that the next round starts from what was already learned rather than from
zero - **including the theories that were ruled out**, which is the half that
stops the next investigation from re-testing the same five ideas.

Most of it is playback, because playback is the part of Beacon that has to
work and the part that produced the most whack-a-mole: a bug gets found and
fixed, tests get added, coverage stays at 100%, and a few days later
something else in the same area breaks. But the folder is not limited to
playback bugs, and not to bugs at all. Anything that was hard enough to be
worth writing down belongs here - a measurement series, an approach that was
tried and dropped, a decision whose reasoning nobody will reconstruct from
the diff.

Add an entry when a case is understood, whether or not anything was fixed.
For a fixed bug, always answer "why did the test suite not catch this?". A
bug that was found on first look does not need an entry.

Conventions worth keeping:

- **One folder per area, one file per case.** The folder says where it
  happened, the file name what was seen (`ios-next-song-stops-under-lock`),
  not what the cause turned out to be or whether it is fixed - a status in
  the name means renaming the file, and breaking every reference to it, the
  day it changes. A case with several entries gets a folder of its own
  (`casting/mid-track-drop/`).
- **Status goes in the heading or first line of the file, and in front of
  its line below** (`OPEN`, `FIXED`, `CLOSED`, `REFERENCE`), so the list can
  be skimmed instead of opening every file. Open cases come first in each
  section.
- **A change made for a case and taken out again gets a line under "Ruled
  out"**, with its commit and what it did or did not change. An attempt that
  only lives in the git history gets tried a second time.
- **Split 2026-08-24 out of a single long `playback-bugs.md`**, after two
  genuinely distinct root causes (the reverse-proxy 403 and the test-suite
  Sonos-discovery leak) had been tangled together in one entry because they
  share the exact same device-side symptom.

Keep entries anonymous: no IPs, no real speaker or room names ("room A",
"room B").

---

## Phone and browser

Beacon's own player on a phone or in a browser: WebKit, iOS home-screen apps, Chromium's media element.

- **OPEN** [An iPhone stops at the end of a song while locked (home-screen app)](phone-and-browser/ios-next-song-stops-under-lock.md) - 2026-10-25, not reproduced; intermittent on one phone over two car journeys, reconstructed from scrobble gaps. Has the audio-session attempt of 2026-10-10, the "natural end closes the session" theory ruled out on the development phone, and the `loop` workaround known elsewhere, not built
- **OPEN** [Pause, then play from an iPhone's lock screen stays silent (home-screen app)](phone-and-browser/ios-pause-then-play-silent-under-lock.md) - 2026-10-10, WebKit bug 243258; works in a Safari tab, fails installed to the home screen. Has the trace showing the handlers run and the media pipeline is what is held, and two theories ruled out (the audio-session declaration, re-registering the lock-screen handlers)
- **FIXED** [A transcode on an iPhone jumps back to its start every ~45 seconds](phone-and-browser/safari-transcode-jumps-to-start.md) (2026-09-15) - WebKit appends each re-fetched block of a stream with no length. Has the three response shapes tested on the phone (only a known length plays), why Range handling and Navidrome's transcoding cannot help, and which HLS segment formats iOS and Chromium each accept. Safari on a Mac is unchecked
- **FIXED** [A dropped stream resumed from the wrong place, and play could not restart it](phone-and-browser/byte-resume-replays-the-stream.md) (2026-10-14) - Chromium reopens a dropped length-less stream's URL by itself with a byte `Range`, which connect served as the stream from its start again. Has the measurement of what Chromium sends and how it takes a 416
- **FIXED** [The phone's volume slider ignored drags](phone-and-browser/mobile-volume-slider-ignores-drags.md) - six attempts, five on the wrong cause; Vuetify's `VSlider` binds its touch handling passively and loses a real finger's drag to the page scroll, which no emulator shows. The phone uses a native range input since

## Casting

Sonos, AirPlay, Chromecast and DLNA, and what connect hands them.

- **OPEN** [Does a speaker play a stream that never ends?](casting/endless-stream-on-speakers.md) - 2026-10-12; endless FLAC settled for AirPlay and Sonos 2026-10-14, the rest not measured yet; what transitions need from Sonos, Chromecast, DLNA and AirPlay (an endless stream dispatched as a track, its position, endless FLAC), and the debug endpoint built to measure it
- **OPEN** [One device dropping out of a multi-target cast is never surfaced](casting/multi-target-drop-not-surfaced.md) - shelved 2026-08-28 (code gap unfixed; its original 2026-08-22 trigger is now suspected to be the test-suite leak too, and it has not happened since - to be picked up if it ever becomes a real problem, see the file for why there is no small fix)
- **FIXED** [Old Sonos models stop reading a stream (Play:3, first-generation Playbar)](casting/sonos-stops-reading-the-stream.md) (2026-10-24) - a Sonos stopped reading a stream 30-45 seconds in and took what it had for the whole track. Not the older models it was blamed on: the server sits in two networks, Beacon handed the speakers its address in the wrong one, and the router between saw only half of each connection and dropped it. Every device now gets the address in its own network, and everything built for the older models on the way (radio framing, unpaced model list, whole/paced/file setting) is rolled back. Has every theory ruled out on the way (chunked encoding, pacing, the speaker's buffer, a file fetched by range), the comparison with the station, and two bugs found on the way (a room name with a space, a VBR track stalling the cast)
- **FIXED** [A surround FLAC reaches a Sonos as silence](casting/sonos-silent-on-surround-flac.md) (2026-09-13) - the same blind spot one capability further on: channel count. Has the two wrong theories (the empty STREAMINFO of a piped re-encode, and 24 bit) measured and ruled out, plus why a soundbar with surround satellites refuses it too and why the MP3 quality setting made the path look healthy
- **FIXED** [The copy tier never checks what the device can actually play](casting/copy-tier-ignores-device-limits.md) (2026-08-24)
- **FIXED** [AirPlay reports nothing when it dies mid-track](casting/airplay-dies-silently.md) (2026-08-26) - the RAM-buffering half of that entry is fixed with it
- **FIXED** [A cast stops half an hour into a long track](casting/cast-stops-after-30-minutes.md) (2026-08-23)
- **FIXED** [A session being reaped stopped a speaker somebody else was using](casting/session-reap-stops-another-users-speaker.md) (2026-08-22)
- **FIXED** [Picking a second device dropped the first one](casting/second-device-drops-the-first.md) (2026-08-22)

### A cast drops mid-track (`casting/mid-track-drop/`)

One symptom, two causes that were tangled together for days. Start with the symptom file.

- **FIXED** [Cast device drops mid-track - symptom, evidence & ruled-out theories](casting/mid-track-drop/symptom-and-ruled-out-theories.md) (2026-08-26) - shared diagnostic reference for the two causes below plus the general mitigation
- **FIXED** [Cast device drops mid-track - reverse-proxy 403](casting/mid-track-drop/reverse-proxy-403.md) (2026-08-23)
- **FIXED** [Cast device drops mid-track - test-suite Sonos-discovery leak](casting/mid-track-drop/test-suite-sonos-leak.md) (2026-08-24, test-suite side) - assessed as probably the whole story, not independently wire-confirmed; days of ordinary use since, with no recurrence of the symptom (checked 2026-08-28)
- **FIXED** [Auto-advance onto a still-playing device drops the next track silently](casting/mid-track-drop/auto-advance-onto-playing-device.md) (2026-08-26) - reattributed to the test-suite leak above, not an independent mechanism after all

## Streaming and the playback clock

connect's stream pipeline: pacing, reconnects, track ends, the event loop.

- **FIXED** [A track's end was never reported, and playback never finished](streaming/track-end-never-reported.md) (2026-09-05) - two `/play` for one gesture bumped the clock's generation past the stream still feeding the device, so nothing ever set `ended`
- **CLOSED** [An event-loop stall of 19.47s, cause unknown](streaming/event-loop-stall-19s.md) (2026-08-26, closed on the trigger side - the stalled frame itself was never isolated, see the file)
- **FIXED** [Every cast track ended a fraction of a second early](streaming/track-end-cut-short.md) (2026-08-25)
- **FIXED** [Resuming an old interruption seeked past the track's own end](streaming/resume-seeks-past-track-end.md) (2026-08-24)
- **FIXED** [A mid-track reconnect restarted the track and poisoned the clock](streaming/reconnect-restarts-the-track.md) (2026-08-23)
- **FIXED** [Pacing threw away the lead it had built](streaming/pacing-throws-away-its-lead.md) (2026-08-22)
- **FIXED** [Pacing used the container bitrate, not the audio bitrate](streaming/pacing-uses-container-bitrate.md) (2026-08-22)
- **FIXED** [Waveform computation blocked the event loop](streaming/waveform-blocks-event-loop.md) (2026-08-22)
- **FIXED** [Disconnect snapshot fired on ordinary pauses](streaming/disconnect-snapshot-on-pauses.md) (2026-08-22)
- **FIXED** [Connection reuse was claimed but not achieved](streaming/connection-reuse-not-achieved.md) (2026-08-22)
- **FIXED** [A slow media-server lookup froze streaming, and a transient one ended it](streaming/slow-media-lookup-freezes-streaming.md) (2026-08-22)

## Radio

- **OPEN** [The radio visualizer never lined up with the cast audio](radio/visualizer-out-of-sync-when-casting.md) - feature switched off again 2026-09-07; the picture is fed the relay's live edge while the device plays ~13s behind it, which is not a clock offset and cannot be corrected as one. Read it before trusting any note dated before 2026-09-05 - the instrument itself was broken until then, and the overlay's delta reads ~0 for exactly this failure
- **OPEN** [The buffering bar outlasts the sound (relayed Sonos)](radio/buffering-bar-outlasts-the-sound.md) - partly fixed 2026-09-10; the reference point is measured now, the window's length is still an ICY-derived upper bound used as a reading. Has the measurement showing the relay feeds a late-joining device at exactly 1x, and the probe (`BEACON_RADIO_BUFFER_PROBE=1`) built to replace the guess
- **FIXED** [The radio list gets the household banned](radio/station-logos-get-the-household-banned.md) (2026-09-03) - the same proxy ban reached a second time, by uncacheable 404s from the station-logo route rather than by cover-art volume

## Transitions

Gapless, crossfade and DJ mixes.

- **OPEN** [Beatmix on pop, classic rock and hip hop](transitions/beatmix-pop-rock-hip-hop.md) - 2026-10-17; the stumbling beat measured (classic rock 17 ms median flam against 6 ms on house), and it is beat-to-beat timing, not grid drift - a local grid is ruled out. The mush is not measured yet. Has the probe (`connect/scripts/beatmix_probe.py`) that renders a pair through the real engine with a click track

## Media servers

Navidrome, Jellyfin and Plex, and the bridges in front of the last two.

- **OPEN** [Neither bridge can address one copy of a song listed twice](media-servers/playlist-duplicate-not-addressable.md) - 2026-09-12; server behaviour, not a bridge bug. Jellyfin 12 reports `PlaylistItemId` identical to the item's own `Id`, so removing one copy takes both (and reordering a playlist with a duplicate is unreliable for the same reason); Jellyfin 10.9 keeps the ids distinct but refuses to hold a duplicate at all; Plex likewise silently refuses to add a song the playlist already holds, so an undo cannot bring a second copy back. Navidrome is fine. Has the measurements and what was ruled out
- **REFERENCE** [Jellyfin 10.9 next to Jellyfin 12](media-servers/jellyfin-10.9-vs-12.md) - 2026-09-12; what the two generations answer differently, measured side by side. 10.9.11 is supported and the live suite passes against it, with one narrow gap: it reads lyrics only from a sidecar `.lrc`, never out of the media file's own tags (that came in 10.10). Has the route inventory and what turned out _not_ to differ

## Interface

- **OPEN** [The queue drawer's first-ever reveal does not animate](interface/queue-drawer-first-reveal-not-animated.md) - `appear` tried again and reverted 2026-09-07, behaviour in the app unchanged. Read it before the next attempt: the browser-test harness does not reproduce the bug, and two timing mechanisms are dead ends there
- **CLOSED** [Which photo edges to continue](interface/backdrop-edge-fill-thresholds.md) - 2026-09-27, question dropped; the detail-page backdrop used to judge whether a photo's edge was calm enough to continue. Tuning that against 1180 labelled samples hit its limit; continuing every edge into the photo's background (or main) colour made the question unnecessary. Has why sampling must run in Electron (headless Chromium judges a dozen photos differently) and why an average colour was wrong

## Tools and method

- **REFERENCE** [Instrumentation](instrumentation.md) - what's built into the app and what's scripted on the media host
- **REFERENCE** [Method notes](method-notes.md) - things that repeatedly turned out to matter while chasing these
