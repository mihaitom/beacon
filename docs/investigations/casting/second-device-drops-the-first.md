# Picking a second device dropped the first one (RESOLVED 2026-08-22)

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
