# PARTLY FIXED - Old Sonos models stop reading a cast stream (Play:3, first-generation Playbar)

**Open since 2026-10-17, partly fixed 2026-10-19/20** (#56). Reported
against 1.8.0 and 1.9.0 as "tracks keep restarting": on a Play:3 (model
`ZPS3`, firmware 86.10) the track jumped back to its start about every 50
seconds, audibly, and Beacon's position ran on past the track's length. A
first-generation Playbar (`ZPS9`, same firmware) turned out to do the
same. The Play:3 had played whole tracks with feishin-connect. Newer Sonos
models here never showed it.

Where it stands:

- **Fixed:** ordinary tracks. Both models get the stream unpaced
  (`delivery/sonos.py`'s `_UNPACED_MODELS`, recognised by the model the
  speaker names at the end of its user agent,
  `Linux UPnP/1.0 Sonos/86.10-81100 (ZPS3)`). A day of normal listening
  on the Play:3 ran clean apart from the two cases below.
- **Open:** a track larger than about 14 MiB (6 minutes of a 320 kb/s
  MP3, about 2 minutes of CD-quality FLAC), radio through Beacon's relay,
  and very likely a transitions mix. All three hit one of the two limits
  below.
- **Under test:** whether announcing the stream the way Music Assistant
  and AirConnect do changes the speaker's behaviour (see "The lead being
  tested").

## What the speaker does

Measured over about a dozen runs of debug logs from the reporter, with the
diagnostic logging added for this case (live ffmpeg stderr, bytes and
"last read" per `/stream` connection, the speaker's own play mode and
duration). The speaker has two separate limits, and either one ends the
track the same way:

**1. It reads a connection for about 45 seconds of wall time, then never
again.** The rate does not matter:

| Delivery | Read for | Then |
|---|---|---|
| Paced 1x after a 15s head start (Beacon's normal pacing) | 40-48s | plays out about a minute, stops |
| Paced 1.1x after a 60s head start (`CAST_STREAM_PACING=gentle`, Music Assistant's pacing) | 43-45s | plays out about 100s, stops |
| Live radio through Beacon's relay | 40-50s | `ERROR_BUFFERING`, Beacon redispatches, same again |

The connection stays open, the delivered byte count freezes and "last
read" only grows from there. Around the same moment the speaker sends a
`HEAD` for the stream, and in one run it reported `ERROR_LOST_CONNECTION`
over UPnP while Beacon was still delivering. The stop comes after
roughly the same _time_ at very different byte counts (0.98 MB on a
low-bitrate track, 2.1-2.35 MB at 320 kb/s), so this limit is not a buffer
filling up.

The Playbar behaves the same: two paced runs, reading stopped at 48s and
43s, `STOPPED` at 56s and 51s.

**2. Sent unpaced, it reads up to about 14 MiB, then never again.**
Measured on three long tracks: 14,614,528, 14,746,245 and 14,753,792 bytes,
at which point ffmpeg was still producing. The speaker plays out what it
holds (6:02 and 6:10 into 320 kb/s tracks of 6:57 and 7:44), reports
`STOPPED` at position 0 and asks for nothing more. Beacon waits out the
track's nominal length, then advances: a couple of minutes of silence.
Every track up to 13.64 MB played through. Unpaced, a 5-minute track
arrives in 6-19s, well inside limit 1.

**Both limits together** explain everything seen so far: unpaced, a track
works as long as it fits in 14 MiB. Paced, nothing works past about 45
seconds of reading.

With Repeat on in the Sonos app (`play_mode=REPEAT_ALL`) and a queue of one
track, the speaker plays its buffered start again without fetching
anything. That replay is the audible jump of the original report. Without
Repeat the track simply stops early.

The speaker reports `CurrentTrackDuration=0:00:00` for every Beacon
stream, except with a declared `Content-Length`, where it reports the
length it worked out from the byte count (`0:03:24` for a 8,180,849-byte
remainder at 320 kb/s).

## The fix so far

Beacon paces every cast stream to real time after a 15s head start
(`-readrate 1`, see `core/streamer.py`'s `_READRATE_ARGS`). That runs
straight into limit 1. Sent unpaced, a normal track is in the speaker
within seconds. Pacing stays for every other model: it exists because a
fully delivered stream leaves the connection idle for minutes, which
dropped connections before (see
[mid-track-drop-symptom.md](mid-track-drop-symptom.md)).

**Why feishin-connect worked:** it never paced, and it transcoded
everything to 192 kb/s MP3, where 14 MiB lasts about 10 minutes. Beacon
copies the original (320 kb/s here), so limit 2 starts at 6 minutes. A
track over 10 minutes would very likely have stopped in feishin-connect
too. That was never tested.

## What is still open

- **Long tracks** under the model list, through limit 2.
- **FLAC.** Sonos gets FLAC copied (`PLAYABLE_CODECS` includes it), and
  14 MiB of CD-quality FLAC is about 2 minutes. The reporter's library is
  MP3, so none of the logs has it, but the model list as it stands would
  cut a FLAC track short early.
- **Radio through the relay**, through limit 1. A live stream cannot be
  sent unpaced.
- **A transitions mix**, for the same reason: the mix engine paces it in
  real time and it never ends. Not tested on these models yet.

## The lead being tested

Music Assistant (with a provider of its own for S1-era Sonos) and
AirConnect (tested on a Play:1, with an endless real-time stream) both
play on these models. Besides pacing, both announce the stream
differently from Beacon:

| | Beacon | Music Assistant, for a track |
|---|---|---|
| `upnp:class` | `audioBroadcast`, for every track | `musicTrack` |
| `<res duration>` | none | the track's length |
| protocolInfo | `http-get:*:audio/mpeg:*` | with `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=0150...` |
| HTTP headers | none of these | `transferMode.dlna.org: Streaming`, `contentFeatures.dlna.org` |

Music Assistant announces radio and its continuous stream as
`audioBroadcast` with the streaming flags (`0170...` in the metadata,
`8170...`, sender paced, in the header). AirConnect's issue #582 reports
that a wrong (1ms) duration made some Sonos firmware treat a stream as
finished almost immediately, and sends 24h for a live one. The
`audioBroadcast` class in Beacon came along with the code inherited from
feishin-connect and was never a decision of its own.

The speaker sending `HEAD` as if the track were about to end, and
reporting no duration, fits the theory that it decides how to read the
stream from that announcement. Music Assistant's pacing alone (limit 1,
second row) did not help, but that run kept Beacon's announcement.

`CAST_STREAM_METADATA=dlna` announces streams the way Music Assistant
does. For a track it sends the whole track's length even when the stream
resumes part-way in: a stream that ends before its announced length just
ends, while one announced shorter than it runs gets cut off. The runs
asked for:

1. `dlna` alone (unpaced through the model list): a 7:44 track to the
   end, then radio for 3 minutes.
2. `dlna` plus `CAST_STREAM_PACING=gentle`, Music Assistant rebuilt
   completely: the same.
3. `dlna` with transitions on, across a few songs.
4. Only if radio still drops in 1: radio with "Play radio straight from
   the station", so the speaker reads the station's own server. Of limited
   value: that station is https, and a failure there could just as well be
   old firmware and TLS.

What follows from each outcome:

- **Run 2 plays through:** Music Assistant's approach for every Sonos. The
  model list and the unpaced stream go, and limit 2 with them.
- **Only run 1 plays through:** keep the announcement and the model list,
  and fit long tracks under limit 2 (below).
- **Neither:** fit long tracks under limit 2, and on these models
  recommend radio straight from the station.

Fitting under limit 2 means: for these models, a track that would come
out larger than about 13 MiB gets an MP3 at a bitrate that fits, FLAC
included. That is a workaround for a speaker that leaves no other way,
and it gets audibly worse for very long tracks (an hour-long set would be
around 30 kb/s).

## Ruled out

- **The reverse proxy in front of the music server.** A run with
  `NAVIDROME_INTERNAL_URL` pointing straight at the server, past the proxy,
  behaved exactly the same.
- **ffmpeg's connection to the music server dropping and replaying the
  file from its start.** Reproduced against a proxied server here without a
  single reconnect, and the reporter's live ffmpeg stderr never showed one.
- **A Xing/Info header with a wrong length.** ffmpeg writes none when
  muxing mp3 to a pipe.
- **Beacon restarting the track.** One connection for the whole run, no
  reconnect, no second GET.
- **A full buffer, for the paced case.** See the byte counts under limit
  1. The unpaced case does have one (limit 2): an earlier version of this
  entry ruled a full buffer out altogether, which was wrong.
- **A lead that does not grow.** With Beacon's 1x pacing the speaker's
  lead holds at 15s, and Music Assistant's comments argue a pace just
  above real time keeps a player's buffer growing. 1.1x after 60s stopped
  at the same 45 seconds.
- **Chunked transfer encoding.** A paced run with a declared
  `Content-Length` (no chunking) failed the same way.
- **Missing Content-Length and byte ranges, for the paced case.** The
  `HEAD` and Sonos's own documentation (a speaker may send `HEAD` for the
  Content-Length and resume with a `Range`) suggested the Play:3 wanted to
  fetch in blocks. Answered paced with a constant-bitrate encode, a
  declared length and 206 ranges (`CAST_STREAM_BYTE_RANGES=on`, the scheme
  of `routes/local_stream.py`), it never sent a `Range`, reported
  `ERROR_LOST_CONNECTION` and restarted as before. **Not settled for the
  unpaced case:** the unpaced byte-range run (Playbar and both Play:3) had
  no track over 14 MiB, so the speaker never needed the rest. Given the
  paced run, a `Range` there is not expected.
- **The `Invalid HTTP request received.` warnings as the speaker asking
  for more.** They come in pairs every 32s. Not one appeared during hours
  of the Play:3 playing alone, including both runs that hit limit 2. They
  began in the second of the first dispatch to room B (the Playbar's
  group, with two Sonos One), at intervals of 4, 8, 16, then 32 seconds,
  and carried on whatever was or was not playing: a client retrying
  something that never succeeds. Not HTTP at all, or Beacon would log it
  as a request. The sender is not identified yet; `core/http_diagnostics.py`
  now logs its address and first bytes.

## The diagnostic switches

All three are still in the code and default to how casting normally
works. Each one overrides the model list, so a run tests every device the
same way; they go when the case is settled.

- `CAST_STREAM_PACING=gentle` - 1.1x after a 60s head start.
- `CAST_STREAM_BYTE_RANGES=on` - unpaced, constant-bitrate 320 kb/s MP3,
  declared length, 206 ranges. Wins over `gentle` when both are set.
- `CAST_STREAM_METADATA=dlna` - Music Assistant's announcement (above).
  Combines with either.

An earlier pair (`CAST_STREAM_PACING=off` and a paced
`CAST_STREAM_BYTE_RANGES`) was added for the first runs and removed with
the first fix.

## Found on the way

- **Credentials in the logs.** The debug log's ffmpeg command carried the
  Subsonic `u`/`t`/`s` of the media server, and logs get attached to public
  issues. Every log line is masked now (`core/log_redaction.py`).
- **Another speaker taking over under `CAST_STREAM_BYTE_RANGES`** got the
  track from where the first speaker's connection had begun, not from the
  current position. Fixed in the switch.

## Related

- [safari-transcode-jumps.md](safari-transcode-jumps.md) has the same
  symptom on an iPhone, a jump back to the start about every 45 seconds,
  with a different cause: WebKit appending each re-fetched block of a
  stream with no length.
- [continuous-stream-on-devices.md](continuous-stream-on-devices.md) is
  what transitions need from each device class. These models are a case
  it does not cover yet.
- Music Assistant: `music_assistant/helpers/upnp.py` (the metadata),
  `controllers/streams/constants.py` (the pacing, and why it is there).
  AirConnect: issue #582 and the README's `http_length` options.

## Why the suites did not catch it

Pacing is a delivery speed and the announcement is a hint, and no test
models a device with an opinion about either. Every Sonos used in
development reads a paced, unannounced stream without complaint, so
nothing short of the old hardware could show it.
