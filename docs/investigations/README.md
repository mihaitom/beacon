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

Two conventions worth keeping:

- **Status goes in the heading, not just the body** (`fixed-`, `OPEN`), so
  the list below can be skimmed instead of opening every file.
- **One file per case.** Split 2026-08-24 out of a single long
  `playback-bugs.md`, after two genuinely distinct root causes (the
  reverse-proxy 403 and the test-suite Sonos-discovery leak) had been tangled
  together in one entry because they share the exact same device-side
  symptom.

Keep entries anonymous: no IPs, no real speaker or room names ("room A",
"room B").

---

## Open

- [The buffering bar outlasts the sound (relayed Sonos)](radio-buffering-window.md) - **PARTLY FIXED 2026-09-10**; the reference point is measured now, the window's length is still an ICY-derived upper bound used as a reading. Has the measurement showing the relay feeds a late-joining device at exactly 1x, and the probe (`BEACON_RADIO_BUFFER_PROBE=1`) built to replace the guess
- [The radio visualizer never lined up with the cast audio](radio-visualizer-cast-sync.md) - **OPEN, feature switched off again 2026-09-07**; the picture is fed the relay's live edge while the device plays ~13s behind it, which is not a clock offset and cannot be corrected as one. Read it before trusting any note dated before 2026-09-05 - the instrument itself was broken until then, and the overlay's delta reads ~0 for exactly this failure
- [Neither bridge can address one copy of a song listed twice](playlist-duplicate-entries.md) - **OPEN 2026-09-12**; server behaviour, not a bridge bug. Jellyfin 12 reports `PlaylistItemId` identical to the item's own `Id`, so removing one copy takes both (and reordering a playlist with a duplicate is unreliable for the same reason); Jellyfin 10.9 keeps the ids distinct but refuses to hold a duplicate at all; Plex likewise silently refuses to add a song the playlist already holds, so an undo cannot bring a second copy back. Navidrome is fine. Has the measurements and what was ruled out
- [The queue drawer's first-ever reveal does not animate](queue-reveal-first-open.md) - **OPEN**; `appear` tried again and reverted 2026-09-07, behaviour in the app unchanged. Read it before the next attempt: the browser-test harness does not reproduce the bug, and two timing mechanisms are dead ends there
- [One device dropping out of a multi-target cast is never surfaced](multi-target-partial-drop-not-surfaced.md) - **OPEN, shelved 2026-08-28** (code gap unfixed; its original 2026-08-22 trigger is now suspected to be the test-suite leak too, and it has not happened since - to be picked up if it ever becomes a real problem, see the file for why there is no small fix)

## Fixed

- [A track's end was never reported, and playback never finished](fixed-track-end-never-reported.md) (2026-09-05) - two `/play` for one gesture bumped the clock's generation past the stream still feeding the device, so nothing ever set `ended`
- [Cast device drops mid-track - symptom, evidence & ruled-out theories](mid-track-drop-symptom.md) (2026-08-26) - **RESOLVED**; shared diagnostic reference for the two causes below plus the general mitigation
- [Auto-advance onto a still-playing device drops the next track silently](auto-advance-still-playing-device.md) (2026-08-26) - reattributed to the test-suite leak below, not an independent mechanism after all
- [Cast device drops mid-track - reverse-proxy 403](mid-track-drop-reverse-proxy-403.md) (2026-08-23)
- [The radio list gets the household banned](radio-favicon-4xx-ban.md) (2026-09-03) - the same proxy ban reached a second time, by uncacheable 404s from the station-logo route rather than by cover-art volume
- [Cast device drops mid-track - test-suite Sonos-discovery leak](mid-track-drop-test-suite-sonos-leak.md) (2026-08-24, test-suite side) - assessed as probably the whole story, not independently wire-confirmed; days of ordinary use since, with no recurrence of the symptom (checked 2026-08-28)
- [The copy tier never checks what the device can actually play](copy-tier-device-limits.md) (2026-08-24)
- [An event-loop stall of 19.47s, cause unknown](event-loop-stall-19s.md) (2026-08-26, closed on the trigger side - the stalled frame itself was never isolated, see the file)
- [AirPlay reports nothing when it dies mid-track](fixed-airplay-silent-death.md) (2026-08-26) - the RAM-buffering half of that entry is fixed with it
- [Every cast track ended a fraction of a second early](fixed-track-end-cut-short.md) (2026-08-25)
- [Resuming an old interruption seeked past the track's own end](fixed-resume-seeked-past-track-end.md) (2026-08-24)
- [A mid-track reconnect restarted the track and poisoned the clock](fixed-reconnect-restarted-track-poisoned-clock.md) (2026-08-23)
- [A cast stops half an hour into a long track](fixed-cast-stops-after-30-minutes.md) (2026-08-23)
- [A session being reaped stopped a speaker somebody else was using](fixed-session-reap-stopped-someone-elses-speaker.md) (2026-08-22)
- [Pacing threw away the lead it had built](fixed-pacing-threw-away-lead.md) (2026-08-22)
- [Pacing used the container bitrate, not the audio bitrate](fixed-pacing-used-container-bitrate.md) (2026-08-22)
- [Waveform computation blocked the event loop](fixed-waveform-blocked-event-loop.md) (2026-08-22)
- [Disconnect snapshot fired on ordinary pauses](fixed-disconnect-snapshot-fired-on-pauses.md) (2026-08-22)
- [Picking a second device dropped the first one](fixed-picking-second-device-dropped-first.md) (2026-08-22)
- [Connection reuse was claimed but not achieved](fixed-connection-reuse-not-achieved.md) (2026-08-22)
- [A slow media-server lookup froze streaming, and a transient one ended it](fixed-slow-media-lookup-froze-streaming.md) (2026-08-22)

## Reference

- [Instrumentation](instrumentation.md) - what's built into the app and what's scripted on the media host
- [Method notes](method-notes.md) - things that repeatedly turned out to matter while chasing these
- [Jellyfin 10.9 next to Jellyfin 12](jellyfin-10.9-vs-12.md) - 2026-09-12; what the two generations answer differently, measured side by side. 10.9.11 is supported and the live suite passes against it, with one narrow gap: it reads lyrics only from a sidecar `.lrc`, never out of the media file's own tags (that came in 10.10). Has the route inventory and what turned out *not* to differ
