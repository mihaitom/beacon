# Does a speaker play a stream that never ends? (OPEN, 2026-10-12)

**Status: first Sonos run invalid (harness bug, fixed), rerun pending.** Needed before transitions can be called done
on speakers - see [the plan](../plans/gapless-and-transitions.md).

## The question

With transitions on, a speaker is handed one stream for a whole run of
songs instead of one song at a time. It is dispatched as a track (plain
`http://`, DIDL class `audioBroadcast` on Sonos), not as a station, because
a track keeps the device's position reports the playback clock is
calibrated against (the radio scheme reports a flat 0.00 s, see
[radio-buffering-window.md](radio-buffering-window.md)). What is not
known, per device class:

1. Does it play such a stream for an hour and more, without stopping at
   some length it assumed?
2. Does its reported position keep counting past an hour, and stay within a
   second of the wall clock?
3. Does it take an endless **FLAC** stream (no length in STREAMINFO)? This
   decides `CONTINUOUS_FLAC_OK` per delivery class in `delivery/*.py`;
   without it a mix goes out as AAC 256 or MP3 320.
4. Does it matter whether it was told no length or a long fake one? AirPlay
   takes a different path for each (no length: pyatv fetches the URL itself;
   a length: connect reads and pushes the stream).
5. Pause for five minutes, then resume; a second room joining mid-stream.

## How to measure

Start something on the speaker normally, then (debug log level, which is
what registers `/debug/*`):

    curl -X POST "http://<connect>/debug/play-endless?fmt=flac&duration=none" \
         -H "X-Connect-Token: <token>" -H "X-Connect-Session: <session>"

`fmt` is `mp3`, `aac` or `flac`; `duration` is `none` or `long`; `file`
picks a file from `BEACON_TEST_AUDIO_DIR` instead of the beep. The stream
is paced like a cast track (15 s head start, then real time) and loops
forever. Every 15 s connect logs, per device:

    [endless] <device>: wall=612.31s device=611.05s drift=-1.26s

A drift that stays flat is a pass; one that grows, a position that stops or
resets, or `[endless] … stream closed after … bytes` before you stopped it
is a fail. Leave each combination at least an hour.

## Results

| Device     | mp3 | aac | flac | none vs long | pause 5 min | 2nd room |
| ---------- | --- | --- | ---- | ------------ | ----------- | -------- |
| Sonos      |     |     |      |              |             |          |
| Chromecast |     |     |      |              |             |          |
| DLNA       |     |     |      |              |             |          |
| AirPlay    |     |     |      |              |             |          |

### Sonos, run 1 (2026-10-12) - invalid after 10 minutes

mp3, aac and flac, `duration=none`, an hour each, position polled every
15 s. All three went to `STOPPED` at exactly 600 s. That was the harness,
not the speaker: the beep is 600 s long and was looped by ffmpeg from
`/debug/test-tone.wav`, which serves no byte ranges, so `-stream_loop`
could not rewind and ffmpeg ended the stream ("Stream ends prematurely at
44"). `/debug/test-radio` had the same ten-minute limit. Both now loop a
local copy of the tone.

What the first 600 s do show: Sonos took all three formats, endless FLAC
without a length included, and the position stayed within -0.1 to +0.9 s
of the wall clock (Sonos reports whole seconds, so that is its
resolution). Says nothing yet about the hour mark.
