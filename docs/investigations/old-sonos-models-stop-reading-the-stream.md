# FIXED - Old Sonos models stop reading a chunked stream (Play:3, first-generation Playbar)

**Open since 2026-10-17, partly fixed 2026-10-19/20, root cause found and
fixed 2026-10-21** (#56). Reported against 1.8.0 and 1.9.0 as "tracks keep
restarting": on a Play:3 (model `ZPS3`, firmware 86.10) the track jumped
back to its start about every 50 seconds, audibly, and Beacon's position
ran on past the track's length. A first-generation Playbar (`ZPS9`, same
firmware) did the same. Newer Sonos models here never showed it.

**Status of the fix:** Beacon now answers a Sonos the way an internet radio
server does. That this framing plays through on these speakers is measured
on the reporter's own Play:3 (below), and that Beacon's responses now look
exactly like that on the wire is covered by tests against both of uvicorn's
HTTP implementations. The fixed build itself has not played on those
speakers yet: no further test runs were asked of the reporter. If a long
track, a relayed station or a mix still stops on one of them, this file
goes back to open, and the unpaced model list (see "The fix") is what still
holds ordinary tracks together.

## Root cause

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

## The comparison that settled it

The reporter's run with "Play radio straight from the station" played one
station for 43 minutes on the Play:3, and on the Playbar grouped with it,
without a gap. Set against Beacon's own paced track stream on the same
speaker, which died after 40-46 seconds in every run:

| | Beacon's paced track | The station |
|---|---|---|
| Dispatched as | plain `http://` URI | plain `https://` URI |
| DIDL-Lite | `audioBroadcast`, no duration | the same, from the same code |
| Delivery | 15s burst, then 1x | about 15s burst, then 1x (measured with curl) |
| Status line | `HTTP/1.1 200 OK` | `HTTP/1.0 200 OK`, also to an HTTP/1.1 request |
| Body framing | `Transfer-Encoding: chunked` | none: ends with the connection |
| `Accept-Ranges` | not sent | `none` |
| ICY headers | not sent | `icy-name`, `icy-br`, `icy-metaint` |
| Result | stops reading after about 40s | 43 minutes, no gap |

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
- The unpaced model list (`ZPS3`, `ZPS9`) stays. Close-delimited, pacing
  makes no difference to these speakers, and unpaced is what already played
  ordinary tracks through on them, so it is the safety net until a long
  track has played through on the fixed build.
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
- **Pacing.** Unpaced, paced at 1x and paced at 1.1x after 60s all stopped
  after 30-45s of reading, and the station is paced like Beacon.
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
  (`http_length`) and its #582; Sonos's "Streaming basics" on a player
  fetching a file in several requests.
