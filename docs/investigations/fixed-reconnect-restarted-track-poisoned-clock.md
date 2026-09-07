# A mid-track reconnect restarted the track and poisoned the clock (RESOLVED 2026-08-23)

**Symptom, as it reached the user:** the app looked broken rather than merely
quiet. The position jumped, the progress bar disagreed with what was audible,
lyrics and the visualizer drifted with it, and playback appeared stuck. The
only way out from the UI was a hard reload plus skipping to the next track.

**The chain**, all of it in one log window, triggered by
[the 19.47s event-loop stall](event-loop-stall-19s.md):

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

**Attempted and reverted (2026-08-24):** a flat magnitude cap on the
backward `change` (`_resync_position_once()`, mirroring
`MAX_PLAUSIBLE_POSITION_LEAD`) turns out unable to separate the two cases
that matter - see
[Auto-advance onto a still-playing device drops the next track silently](auto-advance-still-playing-device.md)
for the full reasoning (its own corruption, `change=-7.38s`, is smaller than
a `change=-40s` case that must still recalibrate normally, so no single
threshold value can separate them).

**Why the test suite didn't catch it:** the reconnect path was covered -
there is a test for `is_streaming` being revived by a bare reconnect - but
none asserted *which position* a reconnect is served from. The offset was
treated as an input to a connection rather than as behaviour worth pinning,
so the code and its tests shared the same blind spot.
