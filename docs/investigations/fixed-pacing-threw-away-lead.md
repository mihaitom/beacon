# Pacing threw away the lead it had built (RESOLVED 2026-08-22)

**Symptom:** a contributing factor to a drop where the device had no buffered
audio left at all.

**Cause:** `-readrate 1` is a ceiling with no floor. ffmpeg reads at exactly
real time and therefore never regains a lead it has lost, so any one-off stall
permanently shortens the device's buffer for the rest of that track.

This was a regression introduced by the fix documented in
[Pacing used the container bitrate, not the audio bitrate](fixed-pacing-used-container-bitrate.md).
The hand-rolled throttle it replaced caught up *incidentally*: it slept only
while already more than `LOOKAHEAD_SECONDS` ahead, so falling behind simply
meant it stopped sleeping and ran flat out until the lead was restored.

**Fix:** `-readrate_catchup 2` in `core/streamer.py`'s `_READRATE_ARGS`.

**Lesson:** when replacing hand-written logic with a library or tool feature,
enumerate what the old code did *accidentally*. Behaviour nobody wrote down is
still behaviour something depended on.
