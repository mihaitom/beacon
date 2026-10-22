# OPEN - Old Sonos models stop reading a stream (Play:3, first-generation Playbar)

**Open since 2026-10-17, partly fixed 2026-10-19/20, chunked encoding found
and fixed 2026-10-21, that fix measured as not enough 2026-10-22** (#56).
Reported against 1.8.0 and 1.9.0 as "tracks keep restarting": on a Play:3 (model `ZPS3`, firmware 86.10) the track jumped
back to its start about every 50 seconds, audibly, and Beacon's position
ran on past the track's length. A first-generation Playbar (`ZPS9`, same
firmware) did the same. Newer Sonos models here never showed it.

**Status:** Beacon answers a Sonos the way an internet radio server does
(see "The fix"), and on the reporter's Play:3 that changed nothing for an
unpaced stream: it still stops reading after 30-37 seconds (see "What the
framing fix did"). Ordinary tracks play through because they arrive in that
time; longer ones stop early. The combination the station that plays to the
end actually has, close-delimited _and_ paced, has never run from Beacon on
these speakers, and neither has a file the speaker may fetch in parts - the
way Sonos documents for a file (see "What Sonos documents"), and the one an
Era 100 was seen to use, fetching the rest by range after a seek and a pause
(see "The file mode on a real speaker"). Settings → Advanced offers both
(core/older_sonos.py, see "Three ways to send a song"), so the reporter can
try them without touching the container, and with the log level at Debug,
Now Playing shows the stream as it goes (see "Watching it happen").

## What the framing fix did (2026-10-22)

A full day of the fixed build on the Play:3, no switches, debug logging.
The build was the right one: a room with a space in its name reported its
events in it, a fix from the same commit. Every track that reached the
speaker within about 35 seconds played through, the largest 14.1 MiB in
35.6 s. Every one that did not, stopped:

| Track                 | Received    | Last read |
| --------------------- | ----------- | --------- |
| 400 s                 | 14.16 MiB   | 36.7 s    |
| 462 s                 | 14.26 MiB   | 36.4 s    |
| 384 s                 | 14.09 MiB   | 34.7 s    |
| 573 s                 | 13.61 MiB   | 30.8 s    |
| Playbar, three tracks | 4.6-5.1 MiB | 30-38 s   |

The same picture as the chunked, unpaced runs before (29-37 s): the buffer
fills in about 20 s, the speaker then reads at the rate it plays, in 200 KiB
steps, and about 35 s in it stops for good, plays out what it has, and is
stopped at 0:00. On the Playbar the buffer is full after a few seconds, so
there anything longer than about 2 minutes at 320 kb/s stops.

**What was overlooked:** the station that played 43 minutes was paced (15 s
burst, then 1x) as well as close-delimited. The fix shipped close-delimited
with the unpaced model list kept as a safety net, a combination that was
never observed to work for a long track. "Close-delimited, pacing makes no
difference" (see "The fix") was an assumption, not a measurement.

**What speaks against pacing being all of it:** run 5 (2026-10-19) was paced
and not chunked (a Content-Length with `Accept-Ranges: bytes`), and the
speaker stopped reading at about 37 s with `ERROR_LOST_CONNECTION`. That was
a file to the speaker rather than a stream (see "Why chunked encoding had
been ruled out"), so it does not settle it. Left between Beacon and the
station if paced does not play through: the station came over https and
sent `icy-metaint`. Whether a Sonos asks for ICY metadata on `/stream` is
now in the connection's log line (`icy-metadata 1`).

**Ruled out on the way:** the position polling every 8 s. Beacon polls a
station played straight from its server too (core/radio_position.py).

## Three ways to send a song

What an older model gets is Settings → Advanced's choice, "whole" by default
(core/older_sonos.py, delivery/sonos.py's `older_model_mode()`):

- **whole**: as fast as ffmpeg makes it, the radio framing. What played
  every ordinary track through and stops the long ones (above).
- **paced**: 15 s ahead, then 1x, the radio framing - the station's way.
- **file**: an MP3 at a constant 320 kb/s with a Content-Length,
  `Accept-Ranges: bytes` and 206 for a range, announced like every other
  stream as an `audioBroadcast` (as a `musicTrack`, the Sonos app showed it
  as "No content", see below). A Range maps onto a second through the
  bitrate (routes/stream.py's `_byte_range_for()`), a range past the end gets
  a 416, and ffmpeg pads a source that runs short with silence (`apad`,
  `-t`), so the body always reaches the length it promised. The length is the longer of the probed and
  the listed one: a VBR file without a Xing header can be off either way,
  and padding costs a few seconds of silence where cutting would cost the
  song's end.

Why "file" is worth a try although run 5 (paced, with ranges) stopped: no
run ever sent a file _unpaced_ with a track larger than the speaker's
buffer. Every sign fits a speaker that means to fetch the rest by range:
without a length it sends a HEAD 25-70 s before it runs dry, with one (the
byte-range runs) it never did; it stops reading but keeps the connection
open; and Sonos documents players fetching a file in several requests. No
range request past byte 0 appears in any log so far - but none of those
runs offered one for a file it could not hold whole.

## What Sonos documents

Sonos's own developer docs ("Streaming basics" and "Playback on Sonos" on
docs.sonos.com, written for music services; the archived partner pages of
2015-2020 say no more about HTTP) describe two kinds of content: individual
files, and internet radio streams over Icecast2's ICY protocol. For a file:

- "The Sonos player uses repeated HTTP GET requests to obtain the encoded
  audio data", and "the data may not fit into the local buffer and multiple
  GET requests may be required to play the song", for "some encodings like
  MP3 and MP4". It does not cache the whole file first.
- Every further GET carries a `Range`; a partial answer must be a 206, and
  a range that cannot be served a 416.
- "Your service must return an accurate Content-Length", and "in some
  situations, Sonos players may send a HEAD request to get the
  Content-Length header."
- A VBR MP3 needs a TOC in its Xing header, or seeking in it does not work.

That reads like the behaviour measured above: a speaker that stops reading
once its buffer is full, keeps the connection, and shortly before it runs
dry sends a HEAD - by the docs, to learn the length it needs for the next
ranged GET. A track sent without a length has no answer to give it, so it
stops. The "file" mode is the documented way, and answers a range past the
end with 416 as asked (a browser on the local path gets the whole body
instead). What the docs do not settle is the timing: why a paced stream
with chunked encoding stopped being read at about 40 s too, with its buffer
far from full.

## The file mode on a real speaker (2026-10-22)

Tried on an Era 100 with the mode switched on for its model for the test,
a 68-minute track, transitions off (a mix gets no length and stays a
broadcast). First announced as a `musicTrack` with its duration:

- It took the file as offered: a GET without a range, 200 with the
  Content-Length, the duration in its metadata and `X_DLNA_SeekTime` among
  its transport actions. It loaded about 45 MB (19 minutes) in 17 s, then
  read on at the rate it played, in 192 KiB blocks - the Play:3's pattern
  with more memory.
- A seek to 40:00 (sent over UPnP; the Sonos app showed "No content" and
  no seek bar for the item, with or without a `cdudn` desc in its DIDL)
  brought a GET from the start, dropped at once, then
  `Range: bytes=95993856-`, exactly 40:00 at 40,000 bytes a second.
- Paused from the Sonos app, it dropped the connection 6 s later. On play
  it sent the same pair, the range at `bytes=142770176-`: 3569 s, where the
  audio it held ended (sent up to 3593 s, played up to 2469 s).

Then announced as an `audioBroadcast` like every other stream, the HTTP
answer unchanged: the Sonos app showed title and artwork again (as a
`musicTrack` it had shown "No content" and dropped the artwork - probably
because it looks for a track in the speaker's own queue, which Beacon does
not use), and the
speaker behaved the same: the connection dropped 4 s into a pause, and on
play `Range: bytes=45056000-` from where its audio ended; a seek to 40:00
fetched `bytes=95993856-` again.

So a speaker that is answered with a length fetches the rest by range when
it needs it, as documented, whatever the item is announced as. Two bugs this turned up, both fixed before release: the
GET from the start re-based the file onto the clock's position, so the
range played two and a half minutes off (a file now belongs to its device
for the generation, and a speaker taking over gets one of its own); and a
dropped connection could count as an interruption, which would have
refused the range on play (a file's connection no longer does).

## Watching it happen

With the log level at Debug, Now Playing shows how the cast stream reaches
its speaker (components/player/CastStreamDebugOverlay.vue, fed by
GET /stream-diagnostics, core/stream_diagnostics.py): what the newest
connection has handed over, in MiB and as far as it reaches into the song by
ffmpeg's own count; the read rate and "STALLED" once an open connection has
not been read for 10 s; the speaker's last reported position and state;
the buffer ahead of it; and its latest requests - HEAD, a range, ICY
metadata.

The speaker's own diagnostics pages cannot show this. On current firmware
(checked on a Beam, 97.2) `:1400/status` lists only the software version,
WLAN status, `ifconfig`, SonosNet's spanning tree and device info;
`/status/tcp`, `top`, `netstat`, `dmesg` and `perf` answer empty and
`/tools.htm` with 403.

## Chunked encoding

uvicorn sends every response that has no Content-Length with chunked
transfer encoding, and Beacon's cast streams have none: a track's length is
not known before ffmpeg has produced it, and a station or a mix has no end.
An old Sonos reads such a chunked stream for 30 to 45 seconds, then stops
reading it without closing the connection, plays out what it has, and
takes that for the whole track. With Repeat on in the Sonos app and a queue
of one track, it then plays its buffered start again - the jump of the
original report.

The same Play:3 plays an internet radio station for as long as it runs. A
station's server answers with an HTTP/1.0 status line, no Content-Length
and no chunking: the body simply ends where the connection closes. That is
the framing a Sonos now gets from Beacon.

## The comparison with the station

The reporter's run with "Play radio straight from the station" played one
station for 43 minutes on the Play:3, and on the Playbar grouped with it,
without a gap. Set against Beacon's own paced track stream on the same
speaker, which died after 40-46 seconds in every run:

|                 | Beacon's paced track          | The station                                    |
| --------------- | ----------------------------- | ---------------------------------------------- |
| Dispatched as   | plain `http://` URI           | plain `https://` URI                           |
| DIDL-Lite       | `audioBroadcast`, no duration | the same, from the same code                   |
| Delivery        | 15s burst, then 1x            | about 15s burst, then 1x (measured with curl)  |
| Status line     | `HTTP/1.1 200 OK`             | `HTTP/1.0 200 OK`, also to an HTTP/1.1 request |
| Body framing    | `Transfer-Encoding: chunked`  | none: ends with the connection                 |
| `Accept-Ranges` | not sent                      | `none`                                         |
| ICY headers     | not sent                      | `icy-name`, `icy-br`, `icy-metaint`            |
| Result          | stops reading after about 40s | 43 minutes, no gap                             |

Same speaker, same dispatch path, same announcement, same pacing. What
differs is the HTTP response, and of that, the framing is what other
projects ran into on the same hardware:

- **Music Assistant, support issue #5100** (Play:3 and ZP80, S1): with its
  default profile or with chunked encoding "it dies between 38-46
  seconds"; with a forced Content-Length "it seems to play the more of or
  the whole song". Its default sends no length, which aiohttp turns into
  chunked encoding for an HTTP/1.1 request, so both failing profiles were
  chunked. The speaker evidently sent HTTP/1.1: that chunked profile raises
  for an HTTP/1.0 request, and nothing was said about an error.
- **The author of AirConnect**, on the Sonos community forum (2016,
  "Chunked encoding transfer and MP3?"): chunked encoding works with FLAC
  and WAV, "does not work with MP3 and I can't see the reason why". His
  workaround was a large fake Content-Length. AirConnect's default today is
  "no content-length" (HTTP/1.0, close-delimited), which its #582 shows
  playing on a Play:1 with firmware 86.6.

The ICY headers alone are not what made the station work: Beacon's relay
sends them too (to a device that asks for ICY metadata), and the relay died
after about 40 seconds like every other chunked stream. Whether the framing
works without them was never observed, though, which is why a Sonos now gets
`icy-name` as well (see "The fix").

## What the speaker does with a chunked stream

Measured over about a dozen runs of debug logs from the reporter, with the
diagnostic logging added for this case (live ffmpeg stderr, bytes and "last
read" per `/stream` connection, the speaker's own play mode and duration).
"Last read" is when uvicorn last took a chunk, so it stops as soon as the
speaker stops reading; with an unpaced copy whose ffmpeg never finished,
nothing else could have stopped it.

- **It reads for 30-45 seconds of wall time, then never again.** Paced at
  1x after 15s: last read at 38-46s. Paced at 1.1x after 60s: last read at
  about 40s with about 64s buffered, far from full. Unpaced: last read at
  29-37s. A 14:23 track at 128 kb/s: last read at about 40s with 13.0 MB
  received and only 0.77 MB left, still arriving at about 190 KB/s.
- **Before that, its buffer can fill.** The Play:3 holds about 14 MiB, the
  Playbar about 4 MiB (about 100s at 320 kb/s); once full, it reads in 64-128
  KiB blocks at the rate it plays. The "14 MiB limit" of the earlier
  analysis was this buffer filling inside the reading window, not a limit
  of its own.
- **It never closes the connection.** It stays open with the byte count
  frozen, in one run for over an hour, until something else ends it.
- **Near the end of what it has, it sends a `HEAD`** (25-70 seconds before),
  and then plays out and reports `STOPPED` at position 0. It sends the
  `HEAD` even when it has the whole track.
- **A relayed station** fails the same way: about 50s into the first
  connection the speaker reconnects by itself, about 41-44s into each
  further one it reports `ERROR_BUFFERING`.
- **It reports `CurrentTrackDuration=0:00:00`** for a stream announced
  without a duration.

## Why chunked encoding had been ruled out

The earlier analysis listed chunked encoding as ruled out, on the strength
of one run (`CAST_STREAM_BYTE_RANGES=on`, paced) that sent a Content-Length
and still stopped at about 37 seconds, with `ERROR_LOST_CONNECTION`. That
run did not compare chunked with a plain stream. It also sent
`Accept-Ranges: bytes`, which offers a file to fetch in parts (Sonos
documents its players fetching a file in several GET requests with a
`Range`), so it compared chunked with a file. The speaker stopped reading
that one too and never came back for the rest, which leaves open why - the
announcement said broadcast, and the paced delivery had left it only 15s of
audio - but it says nothing about a stream with neither a length nor
chunking, which no run before the station run had.

## The fix

- `core/http_protocol.py`: a response that sets `CLOSE_DELIMITED` goes out
  with an HTTP/1.0 status line, no Content-Length, no Transfer-Encoding and
  `connection: close`, and the connection closes when the body ends. It is
  mixed into uvicorn's own request cycle, for httptools and h11 alike,
  through the protocol class main.py already used for logging invalid
  requests. Any other response is untouched.
- `delivery/sonos.py`'s `stream_headers()`: a Sonos, recognised by its user
  agent, gets that framing, `Accept-Ranges: none` and the stream's name in
  `icy-name` on `/stream` and the radio relay, GET and HEAD. A mix goes
  through `/stream` too. `icy-name` closes the one difference to the
  station the evidence cannot rule out: the station sent it, and so did
  the Music Assistant responses that played on a Play:3, which carried no
  ICY metadata. Neither does Beacon's track stream: a station adds that
  only when asked, and Music Assistant sends none with a single track.
- The announcement stays an `audioBroadcast` without a duration, which is
  what the station run used and what every one of these streams is to a
  Sonos: nothing to seek in or fetch again in parts.
- The unpaced model list (`ZPS3`, `ZPS9`) stays. The assumption was that
  close-delimited, pacing makes no difference to these speakers, and that
  unpaced, which already played ordinary tracks through on them, was a
  safety net. Measured on 2026-10-22: it is not (see "What the framing fix
  did"). Settings → Advanced can now send them a song paced, or as a file
  (see "Three ways to send a song").
- The diagnostic switches are gone: `CAST_STREAM_PACING=gentle`,
  `CAST_STREAM_BYTE_RANGES=on` and `CAST_STREAM_METADATA=dlna`.

## Ruled out

- **The reverse proxy in front of the music server.** A run with
  `NAVIDROME_INTERNAL_URL` pointing straight at the server behaved the
  same.
- **ffmpeg's connection to the music server dropping.** Not once in the
  reporter's live ffmpeg stderr.
- **A Xing/Info header with a wrong length.** ffmpeg writes none when
  muxing mp3 to a pipe.
- **Beacon restarting the track.** One connection per track, no second GET.
- **Pacing, with a chunked stream.** Unpaced, paced at 1x and paced at 1.1x
  after 60s all stopped after 30-45s of reading. Paced _and_ close-delimited
  has not run from Beacon yet (see "What the framing fix did").
- **The size of the speaker's buffer.** It stops reading far from full
  (paced runs, the long 128 kb/s track).
- **The announcement.** `CAST_STREAM_METADATA=dlna` (a `musicTrack` with
  its duration, DLNA flags in the metadata and the headers) changed
  nothing, on both models: the speaker showed the duration and stopped
  reading at the same point.
- **A length with byte ranges, paced** (see "Why chunked encoding had been
  ruled out").
- **The `Invalid HTTP request received.` warnings as the speaker asking
  for more.** They were the Playbar's own UPnP events (below).

## Found on the way

- **A track whose audio ended before its listed length stalled the cast.**
  The end of a track was scheduled off its listed length, and a device
  stopping well before that was taken for a rewind to 0:00, recalibrated
  every 8 s, and never advanced. A VBR MP3 without a Xing header is listed at
  what its bitrate suggests (one here: 455 s listed, about 433 s of audio),
  and a seek into one lands near the asked-for second, not on it. The guard
  meant to catch a finished track compared the stream's own elapsed time
  with the track's length, so after any seek it never applied. Fixed: ffmpeg
  reports the audio it wrote (`-progress`), the track ends where that ends
  (core/session.py's `playback_duration()`), and the guard compares in the
  track's own frame.

- **Every event from a room with a space in its name was rejected.** The
  callback URL handed to a speaker carried the room name as it was, so its
  `NOTIFY` request line read like `NOTIFY
/upnp/events/sonos/avtransport/Dining Room HTTP/1.1`, which httptools refuses
  ("Expected HTTP/, RTSP/ or ICE/"). Those were the warnings in pairs every
  32s from room B: one per subscription, retried by the speaker. Such a room
  never reported a transport error, a change of volume made elsewhere, its
  repeat setting, or the failure the radio relay recovers from. Fixed: the
  name is percent-encoded, and the route takes a name with a slash in it.
- **uvicorn chunks a response for an HTTP/1.0 client too**, a protocol
  violation. Not acted on: Sonos sends HTTP/1.1, and nothing seen here
  sends HTTP/1.0.
- **A HEAD said `Content-Length: 0`**, Starlette's length of its empty
  body, which for a stream reads as empty. The close-delimited framing drops
  it for a Sonos; other devices still get it.
- **A connection a speaker stops reading holds its ffmpeg until the speaker
  lets go of it**, which on these models was an hour and more. Not fixed:
  with a stream the speaker reads to the end, it should not arise.
- **Credentials in the logs.** The debug log's ffmpeg command carried the
  Subsonic `u`/`t`/`s`, and logs get attached to public issues. Every log
  line is masked now (`core/log_redaction.py`).

## Why the suites did not catch it

The framing sits below everything the tests look at: the test client parses
chunked encoding itself and hands a test the plain body, so no test ever
saw how a response leaves the server. `tests/test_http_protocol.py` now
feeds a request into uvicorn's protocol and reads the bytes it writes. The
event bug hid the same way: a test client percent-encodes a space in a URL
by itself, a speaker does not, so `tests/test_upnp_events.py` now parses
the request line the way the server does.

## Related

- [safari-transcode-jumps.md](safari-transcode-jumps.md): the same symptom
  on an iPhone, a jump back to the start about every 45 seconds, with a
  different cause: WebKit appending each re-fetched block of a stream with
  no length.
- [continuous-stream-on-devices.md](continuous-stream-on-devices.md): what
  transitions need from each device class.
- Music Assistant support #5100; the Sonos community thread "Chunked
  encoding transfer and MP3 ? (a technical question)"; AirConnect's README
  (`http_length`) and its #582; Sonos's "Streaming basics"
  (docs.sonos.com/docs/streaming-basics), "Playback on Sonos"
  (docs.sonos.com/docs/playback-on-sonos) and, archived from 2020,
  "Supported audio formats" (the Xing TOC, ICY for radio).
