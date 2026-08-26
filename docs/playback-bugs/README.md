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

Split 2026-08-24 from one long `playback-bugs.md` into one file per bug, after
two genuinely distinct root causes (the reverse-proxy 403 and the test-suite
Sonos-discovery leak) had been tangled together in a single entry because they
share the exact same device-side symptom. If a bug is fixed, its status says
so **in the heading**, not just in the body - skim the list below rather than
opening every file.

---

## Open

- [One device dropping out of a multi-target cast is never surfaced](multi-target-partial-drop-not-surfaced.md) - **OPEN** (code gap unfixed; its original 2026-08-22 trigger is now suspected to be the test-suite leak too)

## Fixed

- [Cast device drops mid-track - symptom, evidence & ruled-out theories](mid-track-drop-symptom.md) (2026-08-26) - **RESOLVED**; shared diagnostic reference for the two causes below plus the general mitigation
- [Auto-advance onto a still-playing device drops the next track silently](auto-advance-still-playing-device.md) (2026-08-26) - reattributed to the test-suite leak below, not an independent mechanism after all
- [Cast device drops mid-track - reverse-proxy 403](mid-track-drop-reverse-proxy-403.md) (2026-08-23)
- [Cast device drops mid-track - test-suite Sonos-discovery leak](mid-track-drop-test-suite-sonos-leak.md) (2026-08-24, test-suite side) - assessed as probably the whole story, not independently wire-confirmed
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
