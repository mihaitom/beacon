# What gets converted, and why

Four things decide whether audio is converted before it reaches an ear: what
the source is, where it is going, what the listener asked for under Audio
quality, and — when casting — what that particular device can decode. Nobody
can play through every combination by hand, which is how a station arriving
as AAC ended up leaving as MP3 for a listener who had asked for nothing at
all (fixed 2026-09-06, see the tables below).

This is the map. Each row is what the code actually does, read out of it
rather than assumed; the last section lists where the map and the code still
disagree.

## The three deciders

| Path                              | Decided in                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| A library track, played here      | `plan()` in `src/renderer/src/services/streamQuality.ts`                               |
| A library track, cast to a device | `resolve_output_format()` in `connect/core/streamer.py`                                |
| A radio station, either way       | `relay_format_for_target()` + `_device_output_args()` in `connect/core/radio_relay.py` |

They answer the same question with different information, and only the
middle one knows what the target device can decode.

## A. A library track, played in this app

Read top to bottom; the first row that matches wins.

| Source                                       | Setting        | Result                      | Told as               |
| -------------------------------------------- | -------------- | --------------------------- | --------------------- |
| anything                                     | Original       | untouched                   | -                     |
| a format this browser cannot decode          | any conversion | converted to the chosen one | `browser_unsupported` |
| lossless (flac, wav, alac, ape, wv, aiff, …) | any conversion | converted to the chosen one | `quality_limit`       |
| bitrate above the chosen number              | any conversion | converted to the chosen one | `quality_limit`       |
| everything else                              | any            | untouched                   | -                     |

Two things worth knowing about this table:

- **"Below the limit" is left alone even when the format differs.** MP3 at
  128 with AAC 192 chosen stays MP3: the setting is a ceiling, not a target,
  and re-encoding one lossy format into another only loses.
- **Above the limit, a lossy source is re-encoded lossily.** That is the one
  place the app knowingly does a second lossy pass, because the point there
  is the bandwidth, not the format.

Whether the browser can decode something is asked of the browser
(`canPlayType`), not looked up in a list — which is why an Ogg file counts
as playable in Chrome and not in Safari.

## B. A library track, cast to a device

| Situation                                         | Result                       | Told as              |
| ------------------------------------------------- | ---------------------------- | -------------------- |
| the probe could not say what the source is        | MP3 fallback                 | `probe_failed`       |
| above the quality ceiling that was set            | re-encoded to the chosen one | `quality_limit`      |
| the device does not list the source's codec       | MP3/AAC fallback             | `codec_not_castable` |
| source past the device's sample rate or bit depth | resampled FLAC, or fallback  | `device_limit`       |
| ReplayGain is on and the source would be copied   | re-encoded                   | `replay_gain`        |
| lossless in a container no device takes           | re-encoded to FLAC           | `lossless_container` |
| nothing recognised it                             | MP3 fallback                 | `codec_unknown`      |
| none of the above                                 | copied untouched             | -                    |

The chosen format is narrowed to what the device declares
(`PLAYABLE_CODECS` per delivery class): Opus asks for AAC on anything but a
Chromecast, and AAC asks for MP3 on AirPlay. The order of the fallback is
efficiency, not preference — AAC first, then MP3 — and Opus is never
_chosen_ for somebody who did not pick it.

## C. A radio station

A station is relayed rather than transcoded per track, and the relay's own
repertoire is MP3 and AAC only. Opus asks for AAC: a station is already
lossy, and a second lossy pass into Opus gains nothing back.

| Station arrives as                | Setting  | Result                             | Told as                  |
| --------------------------------- | -------- | ---------------------------------- | ------------------------ |
| MP3                               | any      | copied                             | -                        |
| AAC                               | Original | copied, where the target takes AAC | -                        |
| AAC                               | AAC      | copied                             | -                        |
| AAC                               | MP3      | re-encoded to MP3                  | `relay_mp3_only`         |
| anything else                     | any      | re-encoded to AAC, else MP3        | `relay_mp3_only`         |
| above the ceiling                 | any      | re-encoded down to it              | `quality_limit`          |
| the device refused the raw stream | any      | re-encoded                         | `device_rejected_stream` |

"Original" aims at AAC wherever the target takes it. That reads oddly until
you see that aiming at a format is what _stops_ a station already in it from
being converted — before this, Original converted an AAC station to MP3.
Picking MP3 by hand still forces MP3, which is the escape hatch for a device
whose declared codecs turn out to be optimistic.

## What the listener is shown

The stream-info panel names the reason from the same key the decision
returned — the ten in the tables above, each with a sentence and a
two-word form, in all five languages. A key it has no wording for shows no
row at all rather than a raw identifier.

Radio is the exception worth remembering: `transcoding` is true for a cast
station either way as bookkeeping, so the panel only calls it a conversion
for the three reasons that really are one (`device_rejected_stream`,
`quality_limit`, `relay_mp3_only`).

## Where this is still uneven

- **"Original" skips the browser check.** `plan()` returns early for
  Original, before asking whether the browser can decode the source at all.
  An ALAC or WavPack file — or an Ogg one in Safari — is handed over
  untouched and stays silent, where every other setting would have rescued
  it. Defensible (Original means original, and the Settings text says so),
  but it is the one case where the app knows the answer and does not act on
  it.
- **AirPlay is assumed not to decode AAC.** `AirPlayDelivery.PLAYABLE_CODECS`
  lists mp3, flac and vorbis, so every AAC source is converted on the way to
  one. If that is too pessimistic for real hardware, it costs a needless
  re-encode on every AAC track. Worth one listening test rather than a
  reading of the spec.
- **`relay_mp3_only` no longer only means MP3.** The relay produces AAC too,
  so the key name is a leftover. Internal only: the sentence the listener
  reads says "converted for the device", which is still true.

_Written 2026-09-06 while reviewing the transcoding paths end to end. Change
the code and this file goes stale; it is a map, not a contract._
