# A track's end was never reported, and playback never finished (RESOLVED 2026-09-05)

**Symptom, as it reached the user:** a cast track played to its end normally
and then nothing happened. The visualizer bars froze on the last frame they
had been given, the app still showed the track as playing, and the position
kept climbing past the end of it. Noticed while testing Plex with Autoplay
off; nothing about it is Plex-specific, and with Autoplay on it is invisible.

**The chain.** Two plays of the same track, 45 seconds apart, one healthy and
one not, in the same log window:

    # first play — healthy
    20:38:16  [ffmpeg] All tracks streamed
    20:38:16  [stream] FFmpeg done early — waiting 15.2s for playback to finish
    20:38:31  [stream] Track finished — marking stream complete
    20:38:32  [visualizer] Analysis stopped
    20:38:32  [upnp] room A state=STOPPED

    # second play — the same track, started again
    20:39:16  [play] ... (229s) → target=sonos:room A seq=1788633556624
    20:39:16  [play] ... (229s) → target=sonos:room A seq=1788633556767
    20:42:52  [ffmpeg] Track 1 produced 3681104 bytes in 215.2s wall
    20:42:52  [ffmpeg] All tracks streamed
    20:43:07  [upnp] room A state=STOPPED
    20:43:10  [position-resync] wall clock already at/past track end
              (wall=232.68s, duration=229s) ... — ignoring
    20:55:20  [position-resync] ... (wall=963.02s, duration=229s) ... — ignoring

1. **Two `/play` requests, 143ms apart.** The `seq` values are millisecond
   timestamps, so that is the gap between them. Both were accepted: each
   carries a newer seq than the one before, which is exactly what the
   supersede check is for, and neither is stale.

   The gesture behind it: fast repeated clicking on the track list, which
   fires *two* `dblclick` events (clicks 1+2 and 3+4), and the list starts a
   track on `dblclick` (`SongRow.vue`). Not a second code path -
   `playSongList()` calls `startCurrent()` exactly once - and not a single
   double-click either, which fires once. Worth stating, because "two /play
   for one track" reads like a bug in the dispatch chain, and it is not.
2. **Each accepted `/play` bumps `clock.play_generation`.** The device,
   already being fed, did not reopen its connection — so the stream generator
   that kept delivering bytes carried the *older* generation while the clock
   had moved on.
3. **At the end, that generator declined to say so.** `_advance_or_end()`
   (`routes/stream.py`) opens with
   `st.is_streaming and not st.clock.is_paused and st.clock.play_generation
   == my_generation` and returns silently otherwise. That guard is right —
   it stops a superseded stream from declaring the end of a track that is no
   longer playing — but here the superseded stream *was* the one playing.
   Note what is missing from the second block above: no `FFmpeg done early`,
   no `Track finished`, no `Analysis stopped`.
4. **`st.track_ended` therefore stayed false**, so `ended` never appeared in
   any status broadcast. The frontend advances (or stops) purely on that flag
   while casting — `endedEdge` in `stores/playback.ts` — so `isPlaying`
   stayed true, and with it the visualizer's own `mode`, which is what left
   the bars frozen (`AudioVisualizer.vue` settles them only in `idle`).
5. **`is_streaming` stayed true too**, so the position-resync loop never
   self-terminated. It kept polling a stopped speaker every 8 seconds,
   correctly recognising each reading as "likely already finished" and
   correctly doing nothing about it — for as long as the session lived.

**Fixes, one per end of the chain:**

- **The duplicate dispatch** (`stores/playback.ts`): `startCurrent()` now
  drops a second start of the same song while the first `/play` is still in
  flight. A duplicate cannot be an intent — the first request has not reached
  the backend yet, so there is nothing to restart. It has to sit ahead of
  `startCurrentGuard.begin()`: a duplicate that got as far as that guard
  would invalidate the dispatch it duplicates, which then reports "superseded"
  and unwinds the queue index with it.
- **The backstop** (`routes/playback.py`): `_finish_orphaned_track()`, called
  from the resync loop, closes out a track when the wall clock is more than
  `ORPHANED_TRACK_GRACE_SECONDS` (20s) past its duration *and* no stream
  connection is open. Both together cannot describe a track that is still
  playing. This is deliberately not a fix for the double dispatch: it is the
  answer to "nobody reported the end", whatever the reason, and it is what
  turns this class of bug from permanent into a 20-second delay.

The guard in `_advance_or_end()` was left alone. From inside that generator,
"superseded but still feeding the device" and "superseded and replaced" are
indistinguishable, so it cannot be taught to tell them apart — which is why
the backstop lives outside it.

**Why tests missed it:** the two-`/play`-for-one-song case had no test at
either end. The frontend's own guards around `startCurrent()` were built for
a *different* song taking over (`startCurrentGuard`) and for a stale SSE tick
landing mid-dispatch (`localSongChangeGuard`) — both correct, and both blind
to the same song being dispatched twice. On the backend, every test of
`_advance_or_end()` supplied a matching generation, so the early return was
only ever exercised as the intended "an older stream must stay quiet" case,
never as "the older stream is the only one there is". Coverage was complete
through both paths the whole time.

**What would have found it sooner:** the missing `Track finished — marking
stream complete` line. A healthy track always logs it. Its absence, next to a
device that has stopped and a resync loop that keeps running, is the whole
diagnosis — but only once a healthy play is in the same log window to compare
against.
