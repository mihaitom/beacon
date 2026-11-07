# Plan: equalizer

Status: built 2026-11-07 on `feature/equalizer`, reworked the same day after
a first try (toolbar button, presets of one's own, live with transitions on);
not yet tried at length on real speakers. Kept as the design record, so the decisions below do not have to
be re-derived from the code. The code is `connect/core/equalizer.py`, its
uses in `core/streamer.py`, `routes/stream.py`, `routes/mix_cast.py`,
`routes/join.py`, `core/mix_output.py` and `/play` + `/equalizers` in
`routes/playback.py`, and on the renderer side `services/equalizer.ts`,
`stores/equalizer.ts`, `services/audioEngine.ts` and
`components/equalizer/`.

## What it is for

Mostly the speaker, not taste: a cheap DLNA box, a Chromecast on small
active speakers or a TV, a kitchen radio without bass. Those have no tone
control of their own, and the only place Beacon can correct them is the
stream it sends. On the desktop it is the "these headphones are too
bright" case. That decided the shape: **one curve per output**, not one for
everything - a bass boost for the kitchen must not reach the living room.

## Decisions

- **Ten octave bands, ±12 dB, a few presets.** Bass/treble alone would have
  been simpler, but whoever goes looking for an equalizer expects bands;
  parametric is beyond what this app is for.
- **Every band is the RBJ peaking biquad**, which is what Web Audio's
  `BiquadFilterNode` and ffmpeg's `equalizer` filter both are, so a curve
  sounds the same locally and on a speaker. The bands travel to connect as
  numbers (frequency, gain, Q) and are defined only in
  `services/equalizer.ts`. Both sides work out the response with the same
  formula; a test on each side pins the same reference numbers, and one
  backend test plays sines through the real ffmpeg and checks they come out
  at the level the formula says.
- **Headroom is automatic**: the curve is lowered by the highest point of
  its combined response, not by its highest band, since neighbouring boosts
  add up between them. A boosted curve plays a little quieter; it never
  clips.
- **This device's curve stays on this device** (localStorage, per account),
  because it is about what is plugged in here. **A speaker's curve follows
  the account** (account settings, `speakerEqualizers`, keyed `type:name`),
  because it has to be the same whichever device starts the cast. Per
  account rather than per installation: two people may want a speaker to
  sound different, and it needs no permission question.
- **Phones and tablets have no local equalizer**, for the reason they have
  no local ReplayGain: the Web Audio graph is deliberately absent there so
  playback survives a screen lock. Speakers' curves work from a phone.
- **Casting: the curve rules out the copy tier**, like ReplayGain. Unlike
  ReplayGain, a FLAC source stays lossless where the device plays FLAC - an
  equalizer is turned on to make a speaker sound better.
- **One button in the player, for whatever is playing.** The first version
  had this device's curve under Settings and each speaker's in the device
  picker; trying it, the curve being changed was not the one being heard.
  The toolbar button now opens the curve of the current output: the speaker
  being cast to (a switcher when there are several), otherwise this device.
  On a phone it sits in the app bar and only while casting, since the phone
  itself has no curve.
- **Presets of one's own** are saved by name, follow the account
  (`equalizerPresets`) like the speakers' curves, and are shared by every
  output: a curve is a curve, whichever speaker it was made for.
- **Per device, not per dispatch.** Several speakers share one stream
  format, but each device's connection gets its own processing, so each gets
  its own curve. Connections are told apart the way the stream diagnostics
  do it (address, or the `sender` parameter for AirPlay). A Sonos group is
  fetched by its coordinator, so the coordinator's curve is what the group
  hears.
- **Without transitions, a change applies from the next song**: each song
  is its own ffmpeg, and a running ffmpeg's filters are fixed. "Apply now"
  restarts the song where it is with an ordinary `/play`.
- **With transitions on, a change is heard live.** The mix runs one encoder
  per listener for as long as the mix lasts, so an ffmpeg filter there would
  have been fixed until the next `/play` - the first version had exactly
  that, and nothing changed while a song played. Instead the PCM is filtered
  in numpy on its way into the encoder (`LiveEqualizer`), the curve asked
  anew for every block, and a change crossfaded over one block (0.1 s) so a
  slider never clicks. The filter is a minimum-phase FIR (4096 taps)
  designed from the biquads' magnitude through the real cepstrum: IIR
  cannot be vectorised in numpy without scipy, and a linear-phase FIR would
  delay everything by half its length, heard as a jump when it is switched
  in or out. Within 0.4 dB of the biquads everywhere; 2048 taps lost almost
  2 dB of a +12 dB band at 31 Hz. A test plays sines through both paths
  and checks they agree. "Live" still means after the speaker's buffer -
  the mix is rendered ahead, and the speaker plays what it holds first.
  ffmpeg's own live control (zmq/sendcmd) was not worth a second build
  dependency.

## Left out on purpose

- **Radio while casting.** The relay is one ffmpeg with one output per
  session, and stations are usually copied untouched; per-speaker curves
  would mean one encoder per speaker and re-encoding every station.
- **Sonos' own bass/treble/loudness.** Live and without re-encoding, but only
  two bands and also changed by the Sonos app. One behaviour for every
  speaker won.
- **Party listeners, Remote Control, Home Assistant.** Not in the first
  version.
