# Plan: online party

Status: built (2026-10-07), not yet checked on a phone. See "Still open" at
the end.

## Why

Party guests today see what plays and steer it with wishes and skip votes,
but the music itself only comes out of the host's speakers or the host's
device, so a party is limited to one room. An online party lifts that:
guests anywhere - at home, on the train, in another office - tap the
headphones button on the party page and hear the music in their own
browser, with the wishes and votes they already have. In the code it is
"listening along" (`listen_kbps`, `/party/api/listen`), which is what a guest
does in it.

## Decision

- **Nothing changes for the host.** They cast or play locally as always. An
  earlier draft made listening along a virtual cast target the host picks
  like a speaker; dropped, because it makes the host change how they play
  for the sake of the guests.
- **Guests get one continuous live stream** of what the host hears, the same
  shape as internet radio. The host picks its quality in the party dialog:
  Off (the default) or AAC at 128, 192 or 256 kbit/s. AAC only, since one
  stream serves every guest and AAC plays everywhere.
- **A listening guest sees what they hear.** The song card, the lyrics and
  the visualizer follow the guest's own audio position, a few seconds behind
  the host. What's next, search, wishes and skip votes stay live, as today.
- **No HLS to start with.** Beacon's radio stream, which has no length
  either, plays steadily on an iPhone, so the same shape should here too.
  The transcode jumps in `docs/investigations/safari-transcode-jumps.md` were
  about tracks of known length.

## The broadcaster

One per party, in connect (`core/party_broadcast.py`):

1. **Follow the host.** It keeps reading what the host hears: song id,
   position, playing or paused. While casting from the cast session
   (`compute_position`, the source `_cast_playback` in `core/party.py`
   already uses), during local playback from the window's snapshot
   (`party.tab_snapshot`, about every 300 ms). It reads the snapshot
   directly, not the guest broadcast with its 1.5 s position threshold. The
   window needs to send nothing new: the half second of uncertainty
   disappears in the guests' buffers.
2. **Decode the song.** One ffmpeg per song decodes it from the media server
   (looked up like `_resolve_track` in `routes/stream.py` does) to raw PCM,
   starting at the host's position, unpaced; the pipe holds it back.
3. **Pace and encode.** connect writes that PCM in real time, by the wall
   clock, into a single encoder that runs for the whole broadcast
   (`-f s16le -i pipe:0`, output through `lossy_encode_args()` in
   `core/streamer.py`). One encode means no encoder gaps at song boundaries,
   and no lead that grows with every song, which chaining `stream_tracks`
   with its `-readrate_initial_burst` per track would cause.
4. **Silence** while the host pauses, between songs, and while a source
   fails. The stream never breaks, so guest connections are never dropped
   for it.
5. **Catch up.** On every new host state: a different song, or a position
   more than about 2 s off, restarts the decoder at the host's position;
   otherwise it runs on its own. Near the end of a song it opens the next
   one in the queue (cast: the session queue; local: the snapshot's queue)
   so the change is seamless. If the host goes somewhere else after all, the
   catch-up rule handles it.
6. **Fan out.** The encoder's output goes to every guest through the fan-out
   half of `core/radio_relay.py`: a queue per listener, the 6 s burst buffer,
   a slow listener only losing their own chunks, `None` for the end, and the
   orphan watch. That half moves into its own module
   (`core/audio_fanout.py`), which radio keeps using unchanged.

The broadcaster runs only while someone listens: it starts with the first
listener and stops 90 s after the last one left, as the radio relay does. A
quality change restarts the encoder; guests reconnect on their own.

## The timeline: which song a guest hears

The broadcaster counts the samples it has written, which gives **stream
time**. It keeps a timeline with one entry per jump (song change, seek,
pause): stream time from, song id, song position from, playing. The fan-out
tags each chunk with the stream time of its first ADTS frame (1024 samples
per frame, length from the frame header), so the start of a new listener's
burst has a known stream time.

- The guest opens `/party/api/listen?c=<random connection id>`. connect
  records that connection's start time `T0`, and the guest fetches it from
  `/party/api/listen/start?c=...`, since an `<audio>` element can't read
  response headers.
- Heard stream time is `T0 + audio.currentTime`; the timeline turns that into
  the song and position the guest hears. The timeline reaches guests over the
  existing live updates (`/party/api/events`), the last two minutes or so.
- To check on a device, not assume: that `currentTime` starts at 0 for a live
  stream on iPhone and Android, and stays right across stalls.

## Guest page

- A "Listen along" button, shown only when the host has turned it on. The tap
  is what browsers require before sound, and keeps the rule that nothing
  plays without someone asking.
- A small live player that holds the connection through a stall and then
  reconnects, following the behaviour of `holdsConnection` in
  `services/audioEngine.ts`. Rebuilt, not imported: the guest page carries no
  playback code from the app.
- While listening, `party/store.ts` follows the heard position instead of the
  host's `position`/`position_at`, and `guestSource.ts` hands it to the song
  card, the lyrics and the "next up" corner. The store keeps the last two or
  three current songs with their lyrics, so the one being heard is still
  there after the host has moved on.

## Visualizer

The broadcaster attaches an `AudioAnalyzer` (`core/audio_analysis.py`) to its
own output: a lossy fan-out subscription as the source, stream time as the
clock, the way `_start_radio_analyzer` in `core/visualizer_feed.py` does it.
Frames carry their stream time and the guest shows them by its heard time.
A side effect: listening guests get the visualizer during the host's local
playback too, which has none for guests today.

## Host

- A fourth choice in the party dialog's rules: "Listen along", Off or AAC
  128/192/256. It goes through `PartySettings` in `stores/party.ts`, the
  enable and settings requests in `routes/party.py` and `Settings` in
  `core/party.py`, like the existing three.
- The dialog shows how many guests are listening and the rough upload
  (listeners times bitrate: ten at 192k is about 2 Mbit/s).

## Security and limits

- `GET /party/api/listen` sits under `/party/` with the rest, bound to the
  guest cookie, at most two audio connections per guest (a reconnect may
  overlap the old one) and a total cap like `MAX_VISUALIZER_STREAMS`.
- The stream checks `party.guest_alive` as the visualizer stream does:
  removing a guest, renewing the link or ending the party cuts the sound.
- The existing Content-Security-Policy already allows it (`media-src` falls
  under `default-src 'self'`), and the bundled nginx already passes `/party/`
  through unbuffered.
- Guests never see the media server's stream URL.

## Radio

While the host plays a station, the broadcaster decodes a subscription to
the session's radio relay instead of a song: a timeline entry without a song
position, the title from the station's metadata. A step of its own after the
first.

## ffmpeg

The encoder reads raw PCM, and the bundled ffmpeg has the `s16le` muxer but
not the demuxer. It goes into `build/ffmpeg/required-components` first (see
`build/ffmpeg/README.md`); the backend suite and `scripts/verify-ffmpeg.sh`
fail until the recipe catches up.

## Open questions

- **CDN terms.** Proxying continuous audio through a free CDN plan (e.g.
  Cloudflare) may break its terms; not checked. Fallback: serve only the
  stream from a hostname that bypasses the CDN.
- **Rights.** Streaming a library over the internet to people outside the
  household is legally a different thing from a party in one room. A
  decision for whoever runs it, but worth stating in `docs/party-mode.md`
  when this ships.
- **Sync between guests.** Not needed: nobody hears anyone else.
- **A phone hosting local playback with the screen locked** stops the music
  anyway, out of scope as in `party-mode-server-side.md`.

## Order of work

1. Move the fan-out out of `RadioRelay` into `core/audio_fanout.py`; the
   radio tests stay green unchanged.
2. Add the `s16le` demuxer to the ffmpeg recipe.
3. The broadcaster: following cast and window, decoder, real-time pacing,
   encoder, silence, catch-up, opening the next song early, the timeline.
4. `/party/api/listen` and `/listen/start`, the limits, the host setting.
5. Guest page: the button, the live player, the heard position in the song
   card and the lyrics.
6. The visualizer from the broadcaster's own output.
7. Radio.
8. `docs/party-mode.md` and the changelog.

## Tests

Backend, thoroughly (CLAUDE.md): catch-up on song change, seek, pause and a
switch between casting and local playback, with a fake clock; the timeline
mapping including a new listener's burst; silence while paused; a seamless
song change; the endpoint's cookie check, limits and a removed guest losing
the sound; the setting. Frontend: heard position to song and lyrics in the
guest store.

On a device, before calling it done: listen along on an iPhone and an
Android phone over mobile data, check the lyrics across a song change, and
with the screen locked.

## Still open

Built as described above, with two differences: the visualizer's bands are
computed from the PCM the broadcaster writes anyway rather than by an
`AudioAnalyzer` on its output (exact stream times, no second decode), and a
station is decoded from its own address rather than from the session's radio
relay, which a host listening "directly from the station" does not have.

What has not happened yet, and decides whether it is done:

- **On a device:** listening along on an iPhone and an Android phone over
  mobile data - a song change, lyrics sync, the visualizer, the lock screen.
  In particular whether `audio.currentTime` starts at 0 and stays right
  across stalls, which the heard position is built on.
- **The host on a sleeping phone during local playback** stops the music and
  with it the stream, as before.
