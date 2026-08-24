# Pacing used the container bitrate, not the audio bitrate (RESOLVED 2026-08-22)

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
entirely. `bitrate_bps` and the manual throttle loop were removed. See
[Pacing threw away the lead it had built](fixed-pacing-threw-away-lead.md)
for the regression this fix introduced and its own fix.

**Why tests missed it:** `tests/test_streamer.py` fed a probe fixture where
the container bitrate and the audio bitrate were identical, so the mismatch
case never existed. The code was correct; only the meaning of the number it
parsed was wrong. **Line coverage cannot see that.**
