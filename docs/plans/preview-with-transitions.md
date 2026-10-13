# Plan: previewing an album or playlist with transitions

Status: built on `development` (2026-10-13), for this device's player and
for casting; plays on desktop, web and iPhone. Not yet tried on every kind
of speaker - see "Still open" at the end. Builds on the mix from
[gapless-and-transitions.md](gapless-and-transitions.md).

## Why

A playlist's name and covers rarely say what it sounds like, and an album
you don't know yet is a commitment of forty minutes. A **preview** button
next to Play plays a short excerpt of a handful of songs, blended into each
other the way the transitions do - about two minutes that give a feel for
the whole thing, like a trailer. If one of them catches, it can be played
from there.

## What the listener gets

- A **Preview** button (`mdi-headphones`) next to Play on the album and
  playlist pages, desktop and mobile. Smart playlists are playlists and get
  it too.
- **Six excerpts of about 20 s** each, crossfaded: roughly two minutes.
  Fewer if the album or playlist has fewer songs.
- While it runs, the player shows the song being previewed, a small
  "Preview 3/6" label, and **Play from here**, which plays the album or
  playlist from that song as an ordinary play. Next and previous jump
  between excerpts; seeking is off.
- The **queue is not touched**, nothing is scrobbled, nothing goes into
  the history, Autoplay is not asked.
- **The end is silence.** After the last excerpt (or Stop), the player shows
  the queue's song again, paused where it was interrupted - pressing Play
  carries on there. Nothing starts by itself.

## Decisions

- **connect plays it, through the mix engine.** It already decodes,
  analyses, blends and serves to this device's player (offset stream, live
  HLS on WebKit) and to speakers. A preview is a mix whose songs are
  excerpts and whose list is fixed. Rejected: preview in the browser - the
  same reasons the mix itself is in connect (no Web Audio on phones, two
  implementations).
- **On speakers too.** The audio needs nothing new there; what does is
  the session state, which every client shares - see "Casting" below.
  Starting a cast, or changing its speakers, ends a preview first: the
  queue's song is what gets cast.
- **Always crossfaded, never gapless.** Independent of the Transitions
  setting - blending is the point. Also for an album, whose songs would
  otherwise join gaplessly as "following on the album".
- **No tempo stretch.** Easing into the next tempo takes 8 bars, which is
  most of a 20 s excerpt, and a preview should sound like the songs do.
  Instead: a short overlap of about 4 s, aligned on downbeats with the bass
  swap when both beat grids are confident and the tempos are within 0.5 %,
  otherwise an ordinary crossfade of the same length (one setting, see
  `core/preview.py`'s `OVERLAP_SECONDS`). Unstretched, two grids
  drift apart by the tempo difference: 0.5 % is 10 ms by the swap, 2 s in -
  just under the 12 ms at which the transitions plan found kicks start to
  flam. Many songs share a tagged tempo (120, 128), so this is not rare.
- **Which songs:** evenly spread over the list in its own order (not
  random), so a preview of the same playlist is the same preview, and both
  ends of an album are in it. Songs under 45 s (interludes, skits) are left
  out unless nothing else is left. The app picks them
  (`services/playback/preview.ts`), not connect: it holds the songs anyway
  and has to show them, and a playlist of a thousand songs need not be sent
  to have six of them played.
- **Which part of a song:** the loudest 20 s window between 20 % and 80 %
  of its length, by the waveform connect already computes - usually the
  chorus or the drop, which is what tells you most. If the waveform fails,
  from 35 %. A brickwalled master peaks near full scale almost throughout;
  windows within 0.02 of the loudest count as equal, and the one nearest
  40 % is taken. An excerpt that is beatmixed in starts on its first
  downbeat; otherwise where it was picked, faded in.
- **Not while party guests would hear it:** guests listening along read
  the mix of the window hosting the party, or the cast's. The button is
  disabled while this window hosts one, and while casting during one.
- **Six excerpts of 20 s; Play from here starts the song from its
  beginning.**

## connect

### Excerpts in the mix

`MixItem` gets an excerpt: `start: float = 0.0` and `end: float | None =
None`, plus a property `until` (`end`, or `duration` without one). The
engine reads `until` everywhere it now reads `duration` as "where the song
stops": the remaining time before asking for the next song, the latest
moment a crossfade can start, the planner's `SongFacts`, and the analysis
windows in `_make_plan()` (`_analysis_windows()`: an excerpt is analysed
within its own bounds only - a downbeat found past its end would plan a
transition into audio its deck never has).

`SongFacts` carries the start too, so a plan made without an analysis (a
crossfade on the metadata) brings the incoming excerpt in at its start, and
the timeline says so. Found on the way: a gapless join marked the next song
at position 0 rather than where its deck opened - invisible while every
song started at 0.

The deck opens at `item.start`. `decode_cmd()` gets `-t` for an excerpt, so
the deck simply finishes at its end. The fades - in over 0.5 s, out over
2 s, so the first excerpt does not start mid-note and the last does not
stop mid-note - are the mixer's (`_take_float()`), not an ffmpeg `afade`:
the bundled ffmpeg is built from a fixed list of components, and with a
filter missing from it every decode failed and the preview was silent on
the server and in the packaged app, while it played with a system ffmpeg
in development. `test_ffmpeg_contract.py` now reads the mix's decoders too.
In between the fades sit under the crossfade lanes, where they change
nothing audible. Deck positions are already `start + consumed`, so the
timeline marks song positions, and the player bar's position and waveform
show where in the song the excerpt is.

### The planner

`Settings` gets `preview: bool`. With it, `follows_on_album()` is not asked
(never gapless), `stretch_for()` is not used, and a beatmix needs tempos
within 0.5 % and keeps to the shorter overlap. Everything else - sound
bounds, beat grids, lanes, the bass swap - stays as it is.

### Choosing excerpts

`core/preview.py`: `pick_excerpt(peaks, duration, length=20) -> (start,
end)`, pure, and `PreviewSongs`, which turns the list into excerpts one at
a time. The first song's waveform is decoded before the run starts (under a
second locally, more on a small host - measure); the rest in `next_fn`
while the previous excerpt plays, which has 20 s for it.

### The route

`POST /stream/local/preview/{player}` with the songs (id, duration, gain,
album/disc/track, bpm - the same shape as `MixSong`) and the index to start
at. It starts a run in `core/local_mixes.py` like a mix, with a `next_fn`
that walks the fixed excerpt list and ends after the last, and answers the
same `{epoch, timeline, end, rendered, next_committed}` - so the audio and
HLS URLs, the timeline poll, pause and stop are the existing ones. The
timeline's `queue_index` is the index into the preview's list.

### Casting

`routes/mix_cast.py`, behind `POST /preview` (start, or move to another
excerpt) and `POST /preview/end`. The session gets a `CastPreview`
(`AppState.preview`, `core/preview.py`): the excerpt list, which one plays,
and a snapshot of what it interrupted - the track, its gain and format,
its position, and whether it was playing in a mix. A second preview
replaces the list and keeps the snapshot.

- The preview is a run like any other (`restart()`), dispatched once.
  `new_mix()` builds a preview run while one is set, so a resume, a
  resume after an interruption and a reconnect all stay in the preview.
- `follow()` moves `preview.index` instead of `queue_index`; the queue is
  left exactly where it was, and queue edits wait for after the preview
  rather than being handed to its run. Seeking does nothing.
- Its end - the last excerpt heard, or `/preview/end` - is `end_preview()`:
  the snapshot comes back as the state a paused `/play` leaves (a paused
  mix of the queue's song, or the song itself with the clock frozen), so
  `/resume` dispatches from there as it would after any pause. The speaker
  is paused only for a stop; at the natural end its stream has already run
  out. A preview the speaker refuses ends the same way.
- `/play` ends a preview, and so does `/play-url`, which until now did not
  even end a running mix: its `follow()` went on moving `current_track`
  through the mix's songs while the station played.
- The status carries `preview: {song_ids, index, resume_at}`, and
  `next_locked` is false meanwhile - the queue's next song is not
  settled by a preview.

## The app

### Store

`stores/playback.ts` has a preview overlay, modelled on how a radio
station sits over the queue:

- state `preview: { songs, picks, index, resumeAt } | null` - the whole
  album or playlist, which of its songs play, where the preview is, and
  where the queue's song was.
- `startPreview(songs)`: notes `resumeAt` (a second preview keeps the
  first one's), leaves a station that was playing, starts the run through
  `LocalMixPlayer.startPreview()` (other endpoint, same handling as a mix).
- `followLocalMix()` in a preview moves `preview.index` and `localPosition`
  and nothing else - no `localMixSongBegan()`, so no queue index, no
  scrobble, no Autoplay.
- `currentSong` returns the previewed song, so the player bar, Now Playing,
  lyrics and the lock screen show it without changes of their own.
  `queuedSong` stays the queue's. The ~24 readers of `currentSong` get
  audited once: scrobbling, persisting (a preview is never persisted - a
  reload is back on the queue's song), cast handoff, the party snapshot,
  remote-control status.
- Next and previous (`playNext()`/`playPrevious()`) start a new run from
  that excerpt; next after the last ends the preview. Seeking does
  nothing. A resume after a long pause starts the same excerpt over.
- `playFromPreview()`: `playSongList(songs, picked index)`, an ordinary
  start from the song's beginning.
- `endPreview()`: on Stop, on the run's end, and when connect lost it - the
  queue's song is loaded paused at `resumeAt`.
- Anything started (`startCurrent()`, a station) replaces a preview;
  starting a cast ends it first (`applyTargets()`).
- While casting the same actions go to connect instead of the local mix,
  and every client takes the preview up from the status
  (`adoptCastPreview()`), leaving it alone while a request of its own is
  on its way. One taken up from another client knows only the previewed
  songs (`whole: false`), so it offers no Play from here. Nothing is
  scrobbled from a status that carries a preview - before this client has
  taken it up, its positions would otherwise count towards the queue's
  song. When the speakers go, this device goes back to the queue's song
  where the preview interrupted it.

### UI

- `components/library/PreviewButton.vue` in `AlbumDetailView.vue` and
  `PlaylistDetailView.vue` (a tonal pill beside Play) and their mobile
  counterparts (an icon beside the play button).
- `components/player/PreviewStatus.vue`, the "Preview 3/6" label and Play
  from here: above the title in the desktop player bar (`SongInfo.vue`),
  above the waveform on the phone's Now Playing
  (`MobileTransportControls.vue`). The waveform is not draggable meanwhile.
- i18n keys in all five locales.

## Tests

- **pytest:** `test_preview.py` (the loudest window, intro and outro left
  out, the brickwall tie, fallback, short and unknown lengths, the list
  walked and ended); excerpts in the engine on fake decks, gapless and
  crossfaded (opened at their start, timeline positions in the song,
  blended as album neighbours); `decode_cmd()`'s cut and fades, and a
  real-ffmpeg test that they land; the planner's preview mode; the route;
  casting in `test_mix_cast.py` (over the queue, resume stays in it, no
  seek, queue edits for later, stop and natural end back to the queue's
  song for both kinds of session, a second preview, a refused one, a
  `/play` and a station ending it).
- **vitest:** `playback.preview.test.ts` (queue untouched, no scrobble or
  sync, next/previous and the end, back to the queue's song paused, Play
  from here, replaced by a play, no seek, the long-pause restart, never
  persisted, a failed start, and the same through connect while casting,
  taken up from the status); `pickPreviewSongs`;
  `LocalMixPlayer.startPreview()`; both components.
- Each checked by breaking the code it covers.

## Still open

- **By ear:** whether the 4 s downbeat-aligned overlap without stretch
  holds up mid-song (two full choruses on top of each other are denser
  than an outro and an intro), whether 0.5 % is the right tolerance on
  real material, and whether the loudest window finds the part that tells
  you most. If the blend doesn't hold, a shorter plain crossfade for every
  pair is the fallback.
- **Startup time** on the smallest host: the first song's waveform and
  analysis before anything is heard.
- **Speakers:** a preview is a new dispatch per skip, like any manual
  skip in a mix - how long Sonos, Chromecast and DLNA take to start each
  excerpt, and whether a device minds the stream ending after two minutes.
