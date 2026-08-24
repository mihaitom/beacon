# Resuming an old interruption seeked past the track's own end (RESOLVED 2026-08-24)

**Scope, to be explicit about it:** this is a fix to the *recovery path* -
what happens after a device has already dropped and someone asks Beacon to
pick it back up. It does not touch, and does not explain, why the device
dropped in the first place - that's the still-open
[Auto-advance onto a still-playing device drops the next track silently](auto-advance-still-playing-device.md)
entry (and the larger
[Cast device drops mid-track](mid-track-drop-symptom.md) investigation
elsewhere in this log). Before this fix, an interruption's *recovery* was
silently broken on top of the interruption itself; now the recovery works,
the interruption does not.

**Symptom:** after the auto-advance drop above, waiting a while before
tapping the "Resume" toast produced an HTTP 200, no error anywhere, and no
audio at all - the device accepted the dispatch and simply had nothing to
play.

**Cause:** `PlaybackClock.elapsed()` has no notion of `is_streaming` and is
documented as such ("not clamped to track duration - callers... should clamp
themselves") - it just keeps advancing with wall-clock time from
`play_start_time` regardless of whether anything is actually playing.
`_mark_disconnected_if_not_reconnected()` (routes/stream.py) flipped
`is_streaming` to `False` on a real drop but never froze the clock, so for
however long the interruption then sat unresolved, `elapsed()` kept growing
past the track's own duration. `_resume_after_interruption()` read that live
value straight into `seek_to()` - on a 222s track, dropped a few seconds in
and resumed 10 minutes later, that seeks FFmpeg's `-ss` to 600+s on a 222s
file. FFmpeg answers a seek past EOF with an empty stream, not an error, so
the whole chain (dispatch, SetAVTransportURI, Play) reports success while
delivering nothing.

**Fix:** `_mark_disconnected_if_not_reconnected()` now captures
`compute_position()` (duration-clamped) *before* flipping `is_streaming`,
then calls `clock.pause()` with it - the same freeze `/pause` already uses,
reusing a primitive that was already correct rather than inventing a second
notion of "stopped". `_resume_after_interruption()` now calls `clock.resume()`
(the same path a real `/resume` takes: un-pauses, bumps `play_generation`,
re-zeroes `track_start_position`) instead of reading `elapsed()` fresh, with
a duration-clamping fallback kept for defense in depth in case some other
path ever reaches this function with the clock still unfrozen.

**Why the test suite didn't catch it:** the existing resume-after-
interruption test started the clock with `start(0.0)` and called the resume
function immediately afterward, so `elapsed()` was still near zero either
way - there was no test where meaningful real time (simulated or otherwise)
separated the drop from the resume, which is the entire gap this bug lived
in. `PlaybackClock.elapsed()`'s own "not clamped, callers should clamp
themselves" contract was documented but never checked at this call site.
