# An iPhone stops at the end of a song while locked (home-screen app)

**Status: OPEN - not reproduced (2026-10-25).** Reported twice from the same
phone, never seen on the development phone. Related to, but not the same as,
[pause then play from the lock screen](ios-pwa-lock-screen-resume.md): there
the listener paused; here nobody touched anything and the next song simply
did not start.

## Symptom

Beacon installed to the home screen of an iPhone, playing on the phone itself
(no cast), screen locked, on a long car journey over mobile data. Now and then
a song ends and the next one does not start until somebody unlocks the phone
and presses play. A transcode (AAC 192k, so WebKit's HLS path), served by an
instance that fetches the files from a media server at another site.

## What the logs show

The instance's container logs were gone (recreated for an update), and its
reverse proxy logs only 4xx/5xx. The journeys were reconstructed from the
media server's scrobble table instead: Beacon scrobbles at half a song (at
most 240 s in), so the time between two scrobbles minus the two half-songs is
the gap at the change of song.

| Journey | Version | Changes of song | Normal gap | Stuck              |
| ------- | ------- | --------------- | ---------- | ------------------ |
| 1       | 1.8.0   | ~50             | ~4 s       | ~12, 20 s to 8 min |
| 2       | 1.8.0   | 16              | ~4 s       | ~7, up to 3.5 min  |

- It is intermittent: the very first change of song of journey 1 stuck, while
  later a dozen in a row went through.
- Some of the shorter "stuck" gaps may be a song skipped before its half,
  which looks the same in this data.
- Both journeys ran 1.8.0 (journey 2 was thought to be 1.9.0, but the
  instance was only updated the day after).
- Journey 1 also had five HTTP 500 on HLS segments
  (`/stream/local/<id>/hls/<n>.m4s`). Without connect's log the cause is
  unknown. One candidate in `core/hls.py`: a waiter woken by `Encode.close()`
  finds its segment in `_offsets` and reads from the already closed spool.
  Not reproduced. A failed segment would stop that song, not explain the
  other stuck changes.

## In Beacon's own code

Without transitions, `ended` → `advanceOnSongEnd()` → `startLocalSongDirectly()`
→ `engine.play()` runs without a single `await` in 1.8.0, so the next source
is set inside the `ended` handler. Phones play without a Web Audio graph
(`webAudioAllowed()` in `audioEngine.ts`), so a suspended `AudioContext` is not
it either.

## Ruled out / tried

- **`navigator.audioSession.type = 'playback'`** (10.10, commit `9e76b22`,
  added for exactly this report, removed two hours later in `48dabfb` as
  having no effect on `<audio>`). Whether this symptom was retested after
  the removal was not written down. jellyfin-web does the same (PR 8211), but
  for its Web Audio normalisation path, which Beacon does not use on phones.
- **"Every natural end closes the audio session"** (the explanation behind
  the `loop = true` workaround described for another music web app, see
  below). Tested 2026-10-25 on the development iPhone, home-screen app,
  current development build, transcode over HLS, screen locked, over mobile
  data: ~25 changes of song in 15 minutes with a playlist of very short
  songs, none stuck. The proxy log shows each next song requested the moment
  the previous one ended and all its segments fetched within a second. If the
  session closed on every natural end, every one of those would have stuck.

## Known elsewhere

- [WebKit bug 261858](https://bugs.webkit.org/show_bug.cgi?id=261858) (open
  since 2023): home-screen app, iOS 16 and 17, the next song does not start
  after `ended`, while `ended` and `canplay` fire and the page runs. Works in
  a Safari tab and on iOS 15. Also 221413 and 261554 (iOS 17.2.1 on).
- [Navidrome #1802](https://github.com/navidrome/navidrome/issues/1802): the
  same report for its web UI, closed without a fix ("use a native app").
  airsonic-refix creates a new `Audio()` per song and does nothing special
  for it either.
- [A write-up for another music PWA](https://dev.to/amsyeung/getting-my-iphone-music-app-to-keep-playing-on-the-lock-screen-91f):
  `audio.loop = true` so the element never ends, the jump back to 0 detected
  in `seeking` as the end of the song, and pause → new `src` → play inside
  that handler. Not built: the premise did not hold on the development phone
  (above), and it would change how every song ends on WebKit.

## Still open

- The iOS versions of the two phones. 261858 is version-dependent.
- The reporting phone's path on the development phone: against the
  reporter's instance, normal-length songs, 20-30 minutes locked over mobile
  data. Not stuck there either would point at that phone or its iOS version.
- If it is ever caught live: a temporary trace into connect's log, as in
  [the lock-screen resume case](ios-pwa-lock-screen-resume.md), to see
  whether the new source gets as far as `loadstart`.
