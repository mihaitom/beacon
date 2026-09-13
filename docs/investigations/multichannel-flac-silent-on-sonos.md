# A surround FLAC reaches a Sonos as silence (RESOLVED 2026-09-13)

Found and fixed 2026-09-13, the same day it was first seen - in here anyway,
because two plausible readings of the evidence were measured against real
hardware and both were wrong. That list is the useful half of this entry.

**Symptom:** a freshly downloaded 24-bit/96 kHz FLAC would not play on a Sonos.
The stream-info panel read "FLAC, 48 kHz - Gerätelimit", the speaker never
opened a connection, and no sound came out. The same track at the MP3 320
quality setting played fine.

**Cause:** the file is 5-channel. Nothing in the streamer had ever looked at
the channel count, so a multichannel source was handed to the speaker as-is
and the speaker refused it:

    ERROR_UNSUPPORTED_FORMAT: 8,0,On the Run,<host:port>,<stream url>,,0

This is the same class of bug as
[copy-tier-device-limits.md](copy-tier-device-limits.md) - a device
capability the tier selection never checked - and it hid behind that fix:
sample rate and bit depth had been added, so the source was already being
re-encoded for the rate, and the log line explaining the re-encode read as
if the whole problem were understood.

## The theories that were wrong

Both were tested against a real speaker rather than reasoned about, and both
are worth writing down because they are the obvious readings of the evidence:

- **The FLAC header.** Re-encoding into a pipe means ffmpeg cannot seek back
  to rewrite STREAMINFO (`unable to rewrite FLAC header`), so the stream
  carries total-sample count, frame sizes and MD5 all zero, while the
  stream-copy tier passes the source file's complete header straight
  through. With no `Content-Length` either, the speaker has no way to know
  how long the audio is. Plausible, and wrong: a 48 kHz/24-bit FLAC with an
  empty STREAMINFO plays perfectly.
- **24 bit.** Also wrong, and ruled out by the same measurement.

A third, offered mid-investigation and worth keeping for the shape of the
mistake: that a Beam with surround satellites would play the 5-channel
stream where a single Era 100 could not. It does not. A speaker set that
plays surround from a TV still will not decode a multichannel FLAC out of
an HTTP URI. Measured on both.

## The measurements

A small HTTP server on the development machine serving connect's own
`stream_tracks()` output, dispatched over UPnP exactly as `delivery/sonos.py`
does, then reading `get_current_transport_info()` once a second:

| source                    | Era 100 | Beam + satellites |
| ------------------------- | ------- | ----------------- |
| 48 kHz/24-bit stereo, empty STREAMINFO | plays | plays |
| 48 kHz/24-bit stereo, full STREAMINFO  | plays | -     |
| 48 kHz/16-bit stereo, empty STREAMINFO | plays | -     |
| 96 kHz/24-bit **5.0**, resampled to 48 kHz | refused | refused |
| 44.1 kHz/16-bit **5.0**, stream-copied     | -       | refused |
| 96 kHz/24-bit 5.0, resampled **and** `-ac 2` | plays | -    |

The fifth row is the one that widened the fix: a multichannel source was
already silent on the plain copy tier, with no resampling involved at all,
so this is not a fault in the resampled tier specifically.

## The same blind spot in the local player

Measured on a phone 2026-09-13 against the released 1.3.0, and the answer
splits three ways:

| setting  | what the browser got | result |
| -------- | -------------------- | ------ |
| Original | 5-channel FLAC, untouched | plays |
| MP3      | stereo (libmp3lame has no surround mode, so ffmpeg folds it) | plays |
| AAC      | 5.0 ADTS | plays |
| Opus     | 5.0 Ogg  | **silent** |

`routes/local_stream.py` called `lossy_encode_args()` with no channel count,
so aac and opus both kept the surround they were handed. Only Opus actually
failed on it.

Worth separating from the cast side, because the reasoning is different and
mostly is not about decoding at all. There is no device here declaring a
limit; the argument is the listener's. Every one of those settings exists to
make the stream *smaller*, and spreading a deliberately capped bitrate over
five channels spends it on channels the phone folds together anyway - so AAC
"working" was still the setting failing at its one job. The lossy branch
therefore always folds to stereo (`_LOCAL_MAX_CHANNELS`), which fixes silence
for Opus and wasted bitrate for AAC; the lossless branch deliberately does
not, since "Original" has to stay true of every bit and the same measurement
says it plays.

`browserPlays()` in `services/streamQuality.ts` cannot help here either: it
asks `canPlayType()`, which answers about container and codec and knows
nothing about channel counts. A browser that decodes FLAC but not
multichannel FLAC would answer yes and then play silence.

## The downmix is 7.7dB quieter, and that is left alone

Noticed by ear on the 1.3.0 measurement above: of the settings that played,
MP3 was audibly quieter than AAC and Original on the same 5-channel track.
It is the only one of the three being folded to stereo, and folding costs
level.

**Nothing here chose that level.** It is ffmpeg's default: swresample scales
the mix coefficients so that even fully correlated channels cannot clip,
which for 5.0 is `1 + 0.707 + 0.707 = 2.414`, i.e. -7.7dB. No gain stage in
this codebase is involved, which is worth stating outright - the obvious
first guess on hearing it is that Beacon turned something down.

How much depends on the layout and on nothing else: the scaling is a fixed
property of the mix matrix, so the same figure applies to quiet and loud
material alike. Measured on decorrelated pink noise, mean volume:

| layout | default `-ac 2` | `-rematrix_maxval 1000` | attenuation |
| ------ | --------------- | ----------------------- | ----------- |
| quad (4 ch) | -23.1 dB | -18.4 dB | -4.7 dB |
| 5.0 (5 ch)  | -24.9 dB | -17.2 dB | -7.7 dB |
| 5.1 (6 ch)  | -24.9 dB | -17.3 dB | -7.6 dB |
| 7.1 (8 ch)  | -26.2 dB | -16.3 dB | -9.9 dB |

Note what these two columns are: ffmpeg's normalised downmix against the
*unnormalised* one, not the source against the fold. The first framing is
the one that matters, because a browser folding the same file for itself
does not apply the normalisation - which is exactly why "Original" and AAC
sounded right on the phone while MP3 did not.

Undoing it was measured rather than dismissed, on peak level:

| source | default | full level |
| ------ | ------- | ---------- |
| 5.0, all channels identical, loud (pathological) | -1.9 dBFS | **0.0 dBFS** |
| 5.0, decorrelated channels (a real mix) | -11.5 dBFS | -3.8 dBFS |

So full level is safe for material that is actually a surround mix, and
lands exactly on the clipping point for material that is not. Left at
ffmpeg's default by the maintainer's decision (2026-09-13), on the reasoning
that too quiet is recoverable with the volume control and clipping is not
recoverable at all. Worth knowing before someone "fixes" the quietness
later: it is the intended state, not an oversight, and the cost of changing
it is measured above.

## Why MP3 looked like it worked

The listener's quality ceiling was set to MP3 320 during the first test, and
that plays. Not because the lossy path was doing anything right: libmp3lame
has no surround mode, so ffmpeg inserts a downmix by itself. `aac` and
`opus` both encode surround happily, so the same source at an AAC or Opus
ceiling would have reached the same speaker as silence by a different route.
Anything that decides a channel count has to say so explicitly.

## The fix

- `delivery/base.py`: `BaseDelivery.MAX_CHANNELS: int | None`, `None` by
  default, alongside the existing `MAX_SAMPLE_RATE_HZ`/`MAX_BIT_DEPTH`.
- Per class, all `2`: Sonos from the measurements above, Chromecast
  confirmed the same day against a real one (it refuses a 5-channel FLAC
  too, and its 96 kHz ceiling means the copy tier hands it the file
  untouched - so the channel cap is the only thing between a surround track
  and silence there), AirPlay because AirPlay 1's audio stream is stereo
  ALAC by definition, and DLNA measured too - a renderer that had already
  been resampled to 48 kHz still played nothing until the downmix was there.
- `core/state.py`: `audio_capability_limits()` returns a third value, the
  most restrictive channel count across every active delivery.
- `core/streamer.py`: `SourceInfo` gained `channels`, parsed off the same
  probe line as sample rate and bit depth (`_parse_channels`, which reads
  every layout name ffmpeg prints as well as its `N channels (FL+FR+...)`
  fallback, and never guesses). `_resample_plan()` became
  `_device_fit_plan()` returning a `DeviceFitPlan`, and adds `-ac` the same
  way it already added `-ar` and `-sample_fmt`. `lossy_encode_args()` takes
  the downmix too, so the quality-ceiling tier cannot route around it.
- The stream-info panel names the source's channel count for a surround
  source, and the target's whenever a downmix happened. Stereo is not named
  on either row: it is what almost everything is.

## A separate gap found while verifying this: `/join` never re-resolves

`routes/join.py` hands a device joining a running cast the URL and content
type of `session.state.current_output_format` - the format `/play` resolved
for whoever was already playing. It never recomputes
`audio_capability_limits()` across the widened set, so the most restrictive
device only wins if it was there at dispatch time.

Seen live: a Chromecast (96 kHz ceiling, so a 24/96 source reaches it on the
copy tier untouched, with no probe line logged at all) followed by a DLNA
renderer joining, which then received 96 kHz/24-bit despite `DlnaDelivery`
declaring 48000. Picking that same renderer directly would have resampled it.

Older than the channel cap and independent of it - it applies to sample rate
and bit depth (and to the joiner's codec list) exactly the same way.

Fixed alongside, with the audible cost deliberately confined: `/join` now
compares what the target set can take before and after the newcomer, and
only when that changes does it re-resolve the source and re-dispatch every
target from the current position, the way `/seek` already does. A join that
tightens nothing - a second Sonos next to a first - never probes and never
interrupts anything. The reservation path (joining a paused session) adopts
the narrower format without dispatching at all, since the `/resume` that
follows replays the whole set anyway.

The comparison is on capabilities rather than on the resolved format, which
is what keeps the ordinary join free: two target sets with the same limits
and the same codec list cannot resolve to different formats, so there is
nothing to learn from an ffmpeg probe that would cost ~150ms on every
device someone adds.

**Why the test suite didn't catch it originally:** same answer as the fix
this one extends. `resolve_output_format()` had no concept of a channel
limit to violate; the tier selection was correct for the information it had.
The new tests cover the copy tier being ruled out by channel count alone, a
downmix and a resample together, mono never being upmixed toward the cap, an
undetected channel count being left alone, no declared cap leaving surround
untouched, the lossless-reencode tier downmixing too, the quality ceiling
downmixing, and every channel layout string ffmpeg prints.
