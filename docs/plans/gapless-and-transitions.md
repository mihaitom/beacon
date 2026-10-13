# Plan: gapless playback and DJ-style transitions

Status: built on `feature/transitions` (2026-10-12), for speakers and for
this device's player, WebKit included as a live HLS playlist. Not yet
checked on an iPhone or on real speakers - see "Still open" at the end.

## Why

Every song change used to be a cut with a gap. Locally the one `<audio>`
element got a new `src`; on a speaker every song was a new dispatch (stop,
SetAVTransportURI, play), which costs seconds of silence and cuts off
whatever the speaker had still buffered. Live albums, DJ mixes and
classical movements fell apart, and there was no way to blend one song into
the next.

## Decisions

- **connect mixes, everywhere.** One mix engine in Python/numpy, used for
  casts and for this device's own player. Rejected: mixing in the browser
  with Web Audio. A media element cannot be started sample-accurately (a
  beat-matched kick would flam), phones have no Web Audio graph at all
  (`webAudioAllowed()`, and iOS ignores `audio.volume`), and there would be
  two implementations to keep alike.
- **The DJ way: beatmatch and bass swap.** Both songs' ends are analysed for
  a beat grid; the outgoing song eases into the incoming tempo (up to 8 %,
  double and half tempo included) before the overlap; the basses
  swap on a downbeat, mids and highs fade over several bars. Without a
  trustworthy grid, or with tempos too far apart, the same moves run on a
  clock as an ordinary crossfade.
- **Off stays exactly as it was.** Every handler that existed has at most
  one early branch for a running mix (`session.state.mix`), and the old
  suites run unchanged. The engine is chosen at each manual start; a setting
  changed mid-run applies from the next one.

## The mix

`core/mix_engine.py`. One engine is one run ("epoch"):

- **Decks** decode each song to 44.1 kHz stereo PCM with their own ffmpeg,
  unpaced, buffering up to 20 s. Near a song's end the next one is asked
  for (`next_fn`: queue, repeat, autoplay) and opened.
- **Rendering** runs a fixed lead ahead of the wall clock (15 s for a
  speaker, the same head start a cast track gets; 20 s locally) into a
  `PcmRing` indexed by stream frame (`core/mix_output.py`).
- **Each listener** gets its own encoder fed from the ring, from whatever
  stream time it starts at - so every speaker gets the codec it plays, and
  a reconnect or a second room is served from the ring without restarting
  anything. Rejected: one encoder per mix (a late joiner or a FLAC listener
  would need frame-exact cuts of the encoded stream).
- **A deck that falls behind** is waited for while the lead lasts; only then
  does silence go out, with the song held where it stands - never skipped.
  (Party listen-along skips instead, to stay with its host; a mix must not.)
- **Gain** (ReplayGain) is applied per deck in the mixer, which also gives
  ReplayGain to phones playing a mix.

**Gapless** renders on the byte path: a join is the next song's first
sample after the last one's last, bit-exact. Encoder padding is removed by
ffmpeg's decoders already where the file says how much (LAME header, MP4
edit lists, Opus pre-skip); raw ADTS and MP3 without a LAME header keep a
few milliseconds. A real-ffmpeg test pins the MP3 case.

**Crossfade** renders in float (`core/mix_dsp.py`): every song passes a
three-band linear-phase FIR splitter (180 Hz / 2.5 kHz, 2047 taps, run by
FFT) whose bands add up to the input exactly, delayed by 23 ms. Outside a
transition the same splitter hands back the plain delayed signal from the
same history, so a song never jumps when it starts or stops being split,
and songs that follow each other on an album join through it seamlessly.
Then a soft limiter (correlated kicks add up) and TPDF dither to 16 bit.
Rejected: IIR filters - not vectorisable in numpy without scipy, and a
per-sample Python loop costs a third of real time. Measured cost: 4.5 ms of
CPU per second of audio per deck.

## Planning a transition

`core/transition_planner.py`, a pure function. With crossfade on, the next
song is asked for 90 s before the end; the last 65 s of the outgoing song
and the first 60 s of the incoming one are decoded at 11025 Hz mono and
analysed (`core/beat_analysis.py`, ~0.1 s of CPU for 30 s of audio):

- sound bounds (-60 dBFS), so silence at either end is skipped;
- a beat grid: spectral-flux onset envelope (hop 5.8 ms), tempo by
  autocorrelation weighted towards the server's BPM tag or 120, period and
  phase by folding the envelope (two passes, parabolic peak), confidence
  from the fold's sharpness and whether both halves agree, downbeat as the
  beat class with the most kick (4/4 assumed). On synthetic material: tempo
  within 0.1 BPM, phase within 3 ms. Without a BPM tag, 174 BPM drum & bass
  comes out as 87 - still on the beat, just counted in halves.

A **beatmix** needs both grids at confidence 0.5 or more and a stretch
within 8 %. Its overlap is the most whole bars (1-16) that fit its own
length setting (`beatmix_seconds`, 12 s by default, apart from the
crossfade's 4 s: lined up on the beat, a blend can run longer before it
turns to mush), ending on the last downbeat with music; the incoming
song's first downbeat lands on the overlap's first. First half: incoming
mids and highs rise (equal-power), its bass stays out. Downbeat at half:
the basses swap in 15 ms. Second half: outgoing mids and highs fall.

The stream runs at the incoming tempo through the overlap: the **outgoing**
song eases into it over the 8 bars before (`core/timestretch.py`, WSOLA,
±9 ms search) and holds it to the end; the incoming song is never
stretched. That was the other way round at first - the incoming song
stretched through the overlap and eased back over 8 bars - and whatever
trace the stretch leaves then sat on the song that had just taken over,
for its first ~30 s. Now it sits on the song on its way out, and from the
swap on the new song is sample for sample what was decoded. WSOLA starts
mid-song primed with the last frames played (`Wsola.prime()`): at rate 1 it
reproduces its input exactly, so the ease begins without a seam. A plan
that arrives after its ease should have begun becomes an ordinary
crossfade over the same stretch, and a queue change during the ease waits
for the next song, as during the overlap.

The search width is a trade: at ±5 ms the bass could not be lined up and
mids and highs pumped at the 43 Hz hop rate ("a voice through a fan"); at
±12 ms the pumping is gone but kicks flam. At ±9 ms the pumping measures at
ffmpeg atempo's level on real music, and beat-matched kicks on bare clicks
land within 9 ms of each other; the test holds them inside 12 ms, where a
flam starts to be heard.

A **crossfade** is the same lanes on a clock; songs following each other on
an album (same album, next track) are always **gapless**. If the analysis
has not answered by the last moment a crossfade can start, it goes ahead on
the metadata; if a plan arrives for a moment already played, it fades from
where the song is.

The **timeline** (`core/mix_timeline.py`) says which song plays from which
stream frame, at which position and rate - marked at the swap, every second
while the outgoing song eases into the new tempo, at holds and at the end. Positions on
a crossfade are marked 23 ms late, by the splitter's delay.

## Casting

`routes/mix_cast.py`. With `transitions` in /play the session gets a mix:

- The speaker is dispatched once, to the session's usual `/stream` URL,
  with no length. Song changes happen inside the stream; `follow()` moves
  `current_track`/`queue_index` when the listener actually hears them and
  reports the end.
- The clock counts **stream time** - what the speaker reports - and
  `compute_position()` maps it through the timeline. Calibration, resync and
  reconnects work unchanged in those units; resync's two guards against a
  song's own end are skipped, and so is the orphaned-track backstop.
- Anything by hand starts a new run: seek, skip, party skip, resume, and
  resuming after an interruption. The speaker holds 15 s of the old run, so
  a change inside it would be heard that late. A pause freezes the mix.
- Format: `resolve_mix_format()` - the quality ceiling if one is set, else
  FLAC where the delivery class declares `CONTINUOUS_FLAC_OK` (none does
  until measured), else AAC 256 or MP3 320. The stream-info panel names the
  reason (`transitions`).
- Accepted: the speaker's own app keeps showing the first song of a run.
  Dispatching as a radio station (`x-rincon-mp3radio://` with ICY titles)
  would update it but loses the position reports the clock is calibrated
  against.

## This device's player

`routes/local_mix.py`, `core/local_mixes.py`, `services/playback/localMix.ts`.
A mix per tab (`player` id - a session is a login, shared by devices). The
tab sends the songs from the current one on, in play order (repeat-all's
wrap included), and keeps them current on every queue change. The element
plays `/stream/local/mix/{player}/audio?epoch&from` as an offset stream
(`playFrom`), so its position is stream time and a reconnect asks for the
same run from where it was; the timeline is polled every 2 s. A song that
begins is taken up like a started one (index, scrobble, autoplay) without
starting anything. A pause freezes the mix; after two minutes a resume
starts a new run, since the decoders' connections to the media server may
have been dropped meanwhile. If connect cannot start a mix, the song plays
on its own as before.

Formats: Original becomes FLAC (it is always an encode now), anything else
as set.

**WebKit** cannot play a stream without a length (it re-fetches 1 MiB
blocks from byte 0 and appends them,
[safari-transcode-jumps.md](../investigations/safari-transcode-jumps.md)),
and a mix never has one. So a WebKit tab gets the same run as a live HLS
playlist, `/stream/local/mix/{player}/hls/index.m3u8?epoch` (`core/mix_hls.py`):
type EVENT, listing every segment of the run from its first, growing as
segments are made, closed with `EXT-X-ENDLIST` when the mix ends. One
encoder per run and quality reads the ring from stream time 0, cut by
`core/hls.py`'s splitters (fMP4; mp3 as packed audio) and spooled for the
run's life. It is not counted as a listener, so a closed tab's mix is still
reaped. The element's clock is stream time from the run's start, as with
the offset stream; the tab seeks to 0 once the player has media, since a
live playlist may start near its live edge and Safari hangs on a seek made
earlier. The mix's length is never taken for the song's (`mixStream` in the
audio engine).

## Party listen-along

While the host hears a mix - cast (`AppState.mix`) or in their window
(`core/local_mixes.py`, named in the window's snapshot as `party_mix`:
player, run, stream time) - the guests' broadcaster decodes nothing itself:
it reads the mix's ring from where the host is in its stream
(`core/party_broadcast.py`'s `MixSource`), so guests hear the same
transitions. Song changes, holds and rate steps come from the mix's
timeline, marked where they fall in the guests' stream. A seek or skip is a
new run, which the broadcaster follows like any other jump of the host's.

## ffmpeg

Nothing new in the build: PCM in and out (`s16le` muxer and demuxer) and
all encoders were already there, and splitting, stretching and limiting run
in numpy. Plan B for the stretch, if WSOLA ever fails a listening test, is
`atempo` driven by `asendcmd`; rubberband is out (a static librubberband on
three platforms, still out of process).

## Still open

- **Real speakers.** Whether Sonos, Chromecast, DLNA and AirPlay play an
  endless stream for an hour, keep counting their position, and take FLAC
  that never ends: `POST /debug/play-endless` measures it, see
  [continuous-stream-on-devices.md](../investigations/continuous-stream-on-devices.md).
  Its result sets `CONTINUOUS_FLAC_OK` per class.
- **WebKit on the device** (iPhone, Safari): the live HLS playlist is built
  and tested against a real ffmpeg, not yet on a phone. To check there:
  playback starts at the run's start rather than the live edge, a song
  change inside the mix shows, a pause and a resume, a skip (a new run), the
  end of the queue, and what the lock screen shows - WebKit hands it the
  element's clock, which is the mix's stream time, and a live playlist may
  be shown as a live broadcast.
- **Listening.** House 120 into 128, drum & bass into half-time, hip-hop,
  pop with tempo drift, a live recording - and WSOLA at the edges of its 8 %.
- **CPU** on the smallest host: two decks decoding, one of them stretched,
  during a beatmix.
