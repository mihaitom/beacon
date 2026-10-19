# fixed - A Sonos Play:3 restarts every track about every 50 seconds

**Fixed 2026-10-19** (#56). Reported against 1.8.0 and 1.9.0 as "tracks
keep restarting": on a Play:3 (model `ZPS3`, firmware 86.10) the track
jumped back to its start about every 50 seconds, audibly, and Beacon's
position ran on past the track's length. The same speaker had played whole
tracks with feishin-connect. Newer Sonos models here never showed it.

## What the speaker does

Measured over five runs of debug logs from the reporter, with the
diagnostic logging added for this case (live ffmpeg stderr, bytes and
"last read" per `/stream` connection, the speaker's own play mode and
duration):

1. The Play:3 opens one `/stream` connection and reads it for about 40-48s.
2. It then stops reading. The connection stays open, the delivered byte
   count freezes and "last read" only grows from there.
3. Around 45s it sends a `HEAD` for the stream, and in one run it reported
   `ERROR_LOST_CONNECTION` over UPnP, although the connection was open and
   Beacon was still delivering.
4. It plays out what it holds, about a minute of audio counting the 15s
   head start, and treats the track as ended.
5. With Repeat on in the Sonos app (`play_mode=REPEAT_ALL`) and a queue of
   one track, it plays its buffered start again without fetching anything.
   That replay is the audible jump. Without Repeat, the track would simply
   stop early.

It stops after roughly the same _time_ every run, at very different byte
counts (0.98 MB on a low-bitrate track, 2.1-2.35 MB at 320 kb/s), so this
is not a full buffer.

## The cause

Beacon paces every cast stream to real time after a 15s head start
(`-readrate 1`, see `core/streamer.py`'s `_READRATE_ARGS`). The Play:3
gives up on a stream that arrives that slowly. Sent unpaced
(`CAST_STREAM_PACING=off`, a diagnostic switch for this case), the whole
330s track went out in 19s and the speaker played it and the next two
through. feishin-connect never paced, which is why it worked there.

The fix sends the stream unpaced to the models listed in
`delivery/sonos.py`'s `_UNPACED_MODELS`, recognised by the model the
speaker names at the end of its user agent
(`Linux UPnP/1.0 Sonos/86.10-81100 (ZPS3)`). Pacing stays for everything
else: it exists because a fully delivered stream leaves the connection idle
for minutes, which dropped connections before (see
[mid-track-drop-symptom.md](mid-track-drop-symptom.md)). Only the Play:3 is
confirmed; the reporter's other speakers (a first-generation Playbar, two
Sonos One) were not tested at the time of writing. Searching turned up no
public description of this behaviour for any model.

Not fixed: a transitions mix is paced by the mix engine itself and is an
endless stream, so it cannot be sent unpaced. A Play:3 on a mix is untested.

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
- **A full buffer.** See the byte counts above.
- **Missing Content-Length and byte ranges.** The `HEAD` and Sonos's own
  documentation (a speaker may send `HEAD` for the Content-Length and
  resume with a `Range`) suggested the Play:3 wanted to fetch in blocks.
  Answered with a constant-bitrate encode, a declared length and 206
  ranges (`CAST_STREAM_BYTE_RANGES=on`, the scheme of
  `routes/local_stream.py`), it never sent a `Range` at all, reported
  `ERROR_LOST_CONNECTION` and restarted as before.

Both diagnostic switches were removed with the fix.

## Related

[safari-transcode-jumps.md](safari-transcode-jumps.md) has the same symptom
on an iPhone, a jump back to the start about every 45 seconds, with a
different cause: WebKit appending each re-fetched block of a stream with no
length.

## Why the suites did not catch it

Pacing is a delivery speed, and no test models a device with an opinion
about one. Every Sonos used in development reads a paced stream without
complaint, so nothing short of the old hardware could show it.
