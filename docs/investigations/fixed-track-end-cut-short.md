# Every cast track ended a fraction of a second early (RESOLVED 2026-08-25)

**Symptom:** reported live - remote playback "ends a tick too early, maybe
half a second". Tracks that fade out or end in silence sounded fine; tracks
that stop abruptly sounded cut off, every single time. Nothing in the logs,
no drop, no error: the next track simply started while the current one still
had audio left.

**Cause:** two independent shortfalls, stacking, both on the path that
decides when a track is over. Neither is a race - they applied to every
track equally.

1. **The wait loop stopped half a second short.** `_fire_track_end()`
   (routes/stream.py) waits out the difference between "FFmpeg has sent
   everything" and "the device has actually played it", polling the clock so
   a mid-wait recalibration is picked up. That loop broke out at
   `remaining <= 0.5`, and its caller skipped the wait entirely for
   `wait <= 0.5`. Whatever is left at that moment is audio the device is
   *still playing*, and what follows the break is `_advance_or_end()`, which
   hands the device a new URI - cutting the current track off mid-note. The
   0.5 looks like a "close enough" guard but is a straight subtraction from
   every track's tail.
2. **The duration it counted down to was truncated.** The countdown target
   was `current_track.duration`, i.e. the music server's metadata, which is
   whole seconds (`media/base.py`'s `Track.duration` is an `int`; the
   Jellyfin and Plex adapters build it with `int(ms / 1000)`, truncating).
   A 183.61s track was treated as 183s. That is another ~0.5s of tail lost
   on average, up to a full second.

**The clock itself was not the problem** - worth stating, since it is the
first thing to suspect. `PlaybackClock.seconds_until()` already corrects for
the device's startup buffering (`position_offset`), and
`_fire_track_end()`'s poll loop already re-reads it so a live recalibration
lands. Both were doing their job; they were just being asked to count down
to the wrong number, and then cut off early anyway.

**Fix:**

- `_TRACK_END_TOLERANCE` (0.05s) replaces both 0.5s thresholds - only as
  large as it takes for the loop to terminate. Sleeping the remainder is
  free: the sleep was already `min(remaining, POSITION_RESYNC_INTERVAL)`, so
  a short remainder is slept exactly rather than rounded up to a poll.
- `_probe_source()` (core/streamer.py) now also reads the container's
  `Duration: HH:MM:SS.ff` line - hundredths of a second, measured off the
  file itself - into `SourceInfo.duration`, carried on `OutputFormat.
  source_duration` through every tier including the fallbacks (how long the
  audio is doesn't depend on which encoder handles it). No extra work: that
  probe already runs for every dispatch to pick the output format.
- `_playback_duration()` prefers the measured length, falling back to the
  metadata figure when nothing was probed (forced/probe-failed tiers, radio)
  or when the two disagree by more than 5s, which would mean the probe
  measured something else entirely.

**Why the test suite didn't catch it:** the wait loop had a test, and it
passed for the wrong reason - it fed the loop a "0.3s remaining" reading as
its final poll and asserted the loop then ended the track, i.e. the
half-second cut was written into the test as the expected behaviour rather
than being questioned. Nothing anywhere asserted a relationship between the
countdown target and the real audio length; `Track.duration` being a
truncated int was visible in the type but never load-bearing in a test. Both
gaps are the same shape: the tests checked that the mechanism ran, not that
the number it ran on was right.
