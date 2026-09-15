# A transcode on an iPhone jumps back to its start every ~45 seconds

**Status: fixed 2026-09-15 (HLS for WebKit)**, checked on the phone the same day
with the real implementation: aac 192k, mp3 128k and opus 128k each played
through. Open: Safari on a Mac, see the end.

## Symptom

On an iPhone (Safari and the installed PWA alike), a song played at any quality
other than "Original" played its first minute or two and then started over -
first reported as "jumps back to its beginning about a third of the way
through", later as "audible jumps". The scrub bar kept counting on: a 284 s
track was at 360 s when the app finally reloaded it.

"Original" was never affected: the media server answers with a real length.

## What the phone actually does

connect's log for one track (aac 192k, started at 37.6 s, no other client):

```
19:49:10  from 37.6s, range bytes=0-1   <- Safari's probe
19:49:10  from 37.6s                    <- no Range header
19:49:50  from 37.6s                    <- no Range header
19:50:34  from 37.6s
19:51:20  ...every 44-46 s until the track changed
```

- Every request is the same URL. The app's own reconnects build a new URL from
  the current position (`urlForPosition`), so these are Safari re-fetching,
  not the app.
- 44 s of this stream is almost exactly 1 MiB. Safari reads in 1 MiB blocks.
- Once the `bytes=0-1` probe was answered with a plain 200 (no length, no
  `Accept-Ranges`), Safari never sent a Range header again. Each next block
  is a GET from byte 0, and what comes back is **appended**, not skipped to
  the offset Safari had reached.
- The arithmetic fits the reload exactly: 7 blocks of 42.3 s plus 28 s into
  the eighth, from 37.6 s, is 361.7 s. The app reported 360.8 s.

## Ruled out

- **Non-deterministic encoding.** If a re-fetch from byte 0 produced different
  bytes, splicing at the offset would glitch. Checked on the server's own
  ffmpeg: the same command gives identical checksums every run (three from
  37.6 s, two from 0). It is deterministic - and irrelevant, since Safari
  does not splice.
- **Answering Range requests on a length-less stream** (the first fix,
  commit 466ace1): re-encode, discard up to the requested byte, reply 206.
  Correct in itself, and never reached - Safari sends no Range after the
  probe. Removed again.
- **Answering the probe with `206 bytes 0-1/*`,** so Safari would believe
  ranges work. Tested with a throwaway server on the phone (the same file in
  three response shapes): Safari took `/*` exactly like no length at all,
  showed "Live Broadcast", fetched without Range and jumped the same way.
- **Transcoding in Navidrome instead.** Its transcodes carry no length either;
  "Estimate Content Length" declares a guess, and aac/opus miss any bitrate
  guess by several percent in both directions (this track: +3.3 % over
  nominal, other material down to -13 % - see ALLOWED_BITRATES in
  connect/routes/local_stream.py). A wrong length is truncation or padding.
  It would also do nothing for Jellyfin or Plex.
- **Chromium.** Its plain-stream path is unaffected (measured earlier: it
  holds ~9.5 MiB of a length-less stream and plays through an 18 s outage).

## What works

The third shape on the test page, a **known total length** with ordinary
byte ranges: Safari asked for `bytes=0-<last>` once and played through. So
WebKit needs a length - which no transcode has before its encode finishes.

HLS gives WebKit a length without anyone knowing byte sizes: a VOD playlist
lists the track's duration up front, segment by segment. Measured with a
prototype on the phone (iOS 18.7), one continuous ffmpeg whose fragmented-MP4
output is split at its fragments, every variant played "from 0:00" across the
segment joins without a click and "from 3:50" to a clean `ended`:

| Segments | iOS 18.7 | Chromium 152 (Electron 44) |
| --- | --- | --- |
| aac in fMP4 | plays | plays |
| flac in fMP4 | plays | plays |
| opus in fMP4 | plays (although `canPlayType` says no) | plays |
| mp3 in fMP4 | "Media failed to decode" | CHUNK_DEMUXER_ERROR_APPEND_FAILED |
| mp3 as packed audio (frames + ID3 timestamp) | plays | CHUNK_DEMUXER_ERROR_APPEND_FAILED |

Safari fetched every segment as fast as the encode produced them.

Also learned on the way: a prototype that spawned ffmpeg from a server started
as a background job in an interactive shell showed only a spinner - ffmpeg
reads the terminal for its interactive keys and gets stopped (`T`) by
SIGTTIN. connect never has a terminal, but the HLS encoder passes
`stdin=DEVNULL` regardless.

## The fix

- connect: `/stream/local/{id}/hls/index.m3u8` plus its segments
  (connect/core/hls.py, routes in connect/routes/local_stream.py). One ffmpeg
  per stream, segments of whole encoder frames spooled to a temp file, mp3
  as packed audio, a seek closes the encode it replaced.
- Frontend: `prefersHls()` in services/streamQuality.ts - WebKit only. Chromium
  has native HLS as well (Electron 44 answers "maybe") but refuses mp3
  segments, and its plain stream works, so it keeps that.
- Bundled ffmpeg: the `mp4` muxer is new in the recipe.
- The Jellyfin and Plex bridges now forward a track's Content-Length on
  "Original" as the Navidrome proxy always did. They had dropped it for every
  binary response since an image endpoint's wrong length crashed one; Safari's
  range probe still got the total from Content-Range, so whether that path
  was affected was never checked.

## Why the test suite did not catch it

The suite tested the response connect sends, and that response was correct
HTTP. The failure is how WebKit's media loader consumes a response with no
length, which only a real WebKit shows - jsdom has no media loader, and the
browser-test layer runs Chromium.

## Not checked: Safari on a Mac

A Mac has a fine pointer, so the audio engine routes the element through Web
Audio there (see `webAudioAllowed()` in services/audioEngine.ts) - on a phone it
does not. WebKit has a history of `createMediaElementSource()` giving silence
for HLS sources. No Mac was available to check whether that still holds; if
it does, a transcode on a Mac would play silent rather than jump.
