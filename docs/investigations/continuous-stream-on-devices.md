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
| Sonos      |     |     | ok   |              |             |          |
| Chromecast |     |     | no†  |              |             |          |
| DLNA       |     |     | no†  |              |             |          |
| AirPlay    | ok  | n/a | ok\* |              |             |          |

† Not measured, and left lossy on purpose - see "Chromecast and DLNA"
below.

\* AirPlay's FLAC is not a device answer, see below. AAC never reaches
AirPlay: pyatv's decoder has none, so `PLAYABLE_CODECS` leaves it out.

### AirPlay (2026-10-14) - FLAC settled without the device

The speaker never sees the format connect sends: pyatv fetches the
stream, decodes it with miniaudio and sends the speaker ALAC. Question 3
is therefore one about miniaudio, and it answers it: an endless FLAC
from the mix encoder, through pyatv's URL path (the one a mix takes,
`duration=None`), opens in 0.1 s and decodes in real time without a
break (30 s by hand, 5 s in
`tests/test_delivery_classes.py::test_airplay_decodes_an_endless_flac_mix`).
`AirPlayDelivery.CONTINUOUS_FLAC_OK` is set on that.

On a real device: a beatmix as MP3 320 to an Apple TV, from a server
instance, played through - so the mix's first bytes arrive inside the 10 s
pyatv's URL path allows. Nothing measured past that, so questions 1, 2 and
5 are still open for AirPlay (its position is pyatv's send counter, not
the device's report).

Then a device run, 2026-10-14, with a standalone script rather than
`/debug/play-endless` (a quiet 440 Hz tone through the mix encoder, FLAC,
no length; the dispatch exactly as the delivery class does it): an Apple TV
(gen 3, RAOP) for 617 s, the send position a flat -0.41 s behind the wall
clock throughout (the start-up), one connection, first bytes after 0.07 s.

Ruled out on the way: an AirPort Express (gen 2, firmware 7.8.1) did not
answer RTSP `SETUP` from the development machine, paired or not - pair-verify
succeeded, then 10 s of silence. That is before any audio, so not the
format: `SETUP` comes before any track, so a plain one would meet the same
silence (not tried). A matter of that machine or that device, not of mixes.

### Chromecast and DLNA (2026-10-14) - left on AAC 256, on purpose

`CONTINUOUS_FLAC_OK` is a promise for a whole delivery class, and for
these two no measurement on one device could make it:

- **Chromecast.** Google promises FLAC (up to 96 kHz/24 bit) only for
  Chromecast Audio, Google Home and Home Mini
  ([Cast supported media](https://developers.google.com/cast/docs/media));
  for the video Chromecasts and Google TV it lists none, and Emby's docs
  even say only Chromecast Audio plays FLAC. The class covers both kinds.
  Nothing in the docs on a stream without a length either.
- **DLNA.** Not a kind of device but any MediaRenderer at all, each with
  its own decoder. One that passes says nothing about the next.

What the docs do settle, for everyone: a FLAC STREAMINFO with total
samples 0 means "length unknown" and is valid
([flac-dev](https://lists.xiph.org/pipermail/flac-dev/2003-January/001178.html)) -
so a refusal is a gap in that decoder, not a broken stream.

What would change it: a per-device answer rather than a per-class flag
(a Chromecast reporting itself as an audio model, a renderer's own
GetProtocolInfo), and a run on such a device. Discovery already reads a
Chromecast's model name (`delivery/manager.py`), but nothing decides on it
yet; AAC 256 is the cost.

### Sonos, run 2 (2026-10-14) - endless FLAC, 10 minutes

Same script as the AirPlay run, dispatched as delivery/sonos.py dispatches
a mix (plain `http://`, DIDL `audioBroadcast`), with connect's 15 s head
start. The speaker probed first - one GET closed after ~120 KB, then a
second GET and a HEAD - and then held that one connection for 616 s,
`PLAYING` at every poll. Its position advanced exactly 15 s per poll; the
apparent drift slid from -0.1 to -1.0 s and back, which is the whole
seconds Sonos reports sampled at a slowly moving offset, not a trend that
10 minutes can show. `SonosDelivery.CONTINUOUS_FLAC_OK` is set on this. The
hour mark (questions 1 and 2) is still open, for every format alike.

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
