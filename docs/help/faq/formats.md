---
order: 4
---

# Formats and converting

## Do I need ffmpeg installed?

No. Both the Docker image and the desktop app bring their own build - an audio-only one, about a tenth the size of a full ffmpeg, built from the same recipe for both (see [build/ffmpeg/README.md](../../../build/ffmpeg/README.md)). Setting `FFMPEG_PATH` points Beacon at your own build instead. Should it ever be missing - a build packaged without it, or a development checkout with no ffmpeg on PATH - the connect log says so on startup and casting fails.

## What actually gets sent to a speaker, and when is it converted?

Sonos, Chromecast and DLNA pull the audio from Beacon over HTTP, so Beacon decides what shape it arrives in. (AirPlay is pushed to rather than pulling, via pyatv, but gets the same prepared stream; only a live radio URL goes to the device untouched.)

The rule is **change as little as possible, and never in a way that makes the stream bigger and worse.** For each track, the first of these that applies wins:

1. **A quality limit you set**, if the track is above it. Settings -> Playback caps what gets sent. Being a cap is the whole point: a 128kbps file under a "MP3 320" limit is left alone, because re-encoding it would lose quality _and_ produce a larger stream. Only a track above the limit is brought down to it.
2. **Sent as it is**, if the speaker plays that format. Nothing is decoded or re-encoded and nothing is lost - a 320kbps MP3 arrives as exactly that MP3.
3. **Repacked to FLAC**, if the track is lossless but in a wrapper the speaker will not open. Every bit is kept, only the container changes.
4. **Re-encoded to 192kbps MP3**, when none of the above fits. The last resort, and the one format every device here plays.

Steps 2 and 3 depend on the speaker, and this is the whole of that difference:

| Plays      | MP3 | AAC | FLAC | Ogg Vorbis | Opus |
| ---------- | --- | --- | ---- | ---------- | ---- |
| Chromecast | yes | yes | yes  | yes        | yes  |
| Sonos      | yes | yes | yes  | yes        | no   |
| DLNA       | yes | yes | yes  | yes        | no   |
| AirPlay    | yes | no  | yes  | yes        | no   |

Which lands sources in three groups. Already in the table: MP3, AAC, FLAC, Ogg Vorbis and Opus, sent as they are wherever the row says yes. Lossless but not in the table, so repacked to FLAC: ALAC, WAV, AIFF, APE, WavPack, TTA, Shorten, WMA Lossless and DSD. Everything else, re-encoded to MP3: WMA, Musepack, MP2 and anything unrecognised.

Three things are worth knowing because they surprise people:

- **Opus is only sent untouched to a Chromecast.** A Sonos accepts an Opus stream and then plays silence rather than refusing it, and nothing downstream can notice that, so Beacon does not try. An Opus file becomes MP3 there. This is separate from Beacon being able to _encode_ to Opus, which it does for any device that plays it.
- **ReplayGain rules out step 2.** Adjusting the volume means decoding the audio, and a track sent as it is never gets decoded. With ReplayGain on, a track that would have been passed through is re-encoded instead.
- **A speaker's sample-rate and bit-depth limits apply on top of all of this.** A 96kHz/24-bit FLAC sent to a device that stops at 48kHz is resampled down rather than sent and cut off a second in. DSD is brought down the same way: it decodes to 352.8kHz, which nothing plays, so it lands at 88.2kHz - the same conversion a DSD player makes.

The whole decision, for this app's own player, radio and transitions too, is in [What gets converted, and why](../reference/transcoding-decisions.md).

## And in Beacon's own player?

Same idea, one step shorter, because there is no speaker to negotiate with - only the browser. Settings -> Playback has its own limit for this, separate from the casting one:

1. **Converted, whatever the setting says**, if the browser cannot decode the file at all. On "Original" it is repacked to FLAC rather than re-encoded, so nothing is lost; only where even FLAC is refused does it become MP3 or AAC. This is what makes an ALAC, APE, WavPack, AIFF or DSD library playable in a browser at all.
2. **Brought down to your limit**, if the track is above it. A lossless track always is, whatever number the limit names.
3. **Played as it is**, otherwise.

MP3, AAC and Opus are offered as limits here, and which of them you are shown depends on the browser: Beacon asks it what it can decode rather than assuming, because the answer differs. Safari has no Ogg decoder, so Opus is not offered there and an Ogg Vorbis or Opus _file_ is converted for it - the same file plays untouched in Chrome or Firefox. Both limits are stored per device, so a phone on mobile data and a desktop on the LAN can be set differently.

## Why is a surround track quieter than everything else?

Folding five or more channels into two costs level, and that fold happens whenever the audio has to be stereo: on every cast, since no cast target here plays surround (a Sonos answers a multichannel FLAC with silence rather than an error), and in this app's own player at every quality setting except "Original".

**Nothing in Beacon turns anything down.** It is ffmpeg's own default downmix, which scales the mix so that even fully correlated channels cannot clip. Measured on decorrelated pink noise: -4.7 dB for quad, -7.7 dB for 5.0, -7.6 dB for 5.1, -9.9 dB for 7.1. It depends on the channel layout and on nothing else, so the same figure applies to quiet and loud material alike.

"Original" in this app's own player keeps every channel and leaves the folding to the browser, which does not apply that normalisation - which is why the same file can sound right there and noticeably quieter when cast. Sending it at full level was measured rather than dismissed: it lands exactly on the clipping point for material that is not really a surround mix, so ffmpeg's default stays. [investigations/multichannel-flac-silent-on-sonos.md](../../investigations/multichannel-flac-silent-on-sonos.md) has the numbers.
