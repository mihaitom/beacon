# Plan: AudioMuse-AI integration

Status: phases 1 to 3 built 2026-11-28 on `feature/audiomuse`, tried
against a real AudioMuse-AI v3.7.4 with one Navidrome server, not yet used
at length in the app. The code is `connect/core/audiomuse.py` and
`routes/audiomuse.py`, and on the renderer side
`services/connect/audiomuse.ts`, `stores/audiomuse.ts`,
`services/playback/skips.ts`, `services/playback/sonicActions.ts`,
`stores/playback/queue.ts` (Autoplay, path), `stores/playback/radio.ts`
(radios, mood mix), `composables/sonicHomeShelves.ts`,
`components/home/MoodMixes.vue`, `components/library/SonicSearchSection.vue`,
`SearchSongsSection.vue`, `SonicSimilarArtists.vue` and
`components/settings/AudioMuseSection.vue`.

## What it is for

AudioMuse-AI analyses the audio of a library itself and answers "what
sounds like this" from that analysis instead of from tags or listening
data. A Navidrome with the AudioMuse plugin already answers
`getSimilarSongs2` with it, so Beacon's Song Radio, Artist Radio and
Autoplay use it today without knowing. What that path cannot do:

- **Choose the method per request.** The plugin picks one method for the
  whole Navidrome installation, in Navidrome's own config.
- **Seed from more than one song.** `getSimilarSongs2` takes one id;
  Autoplay therefore continues from the last queued song only.
- **Anything beyond similarity**: a path between two songs, search by
  sound ("calm piano") or by what the lyrics are about, similar artists by
  sound.
- **Jellyfin and Plex.** AudioMuse supports both, but their own similar-songs
  endpoints do not use it (Plex has no plugin at all).

So the integration is connect talking to AudioMuse's own HTTP API directly,
optional, with today's behaviour as the fallback whenever it is not
configured, not reachable, or does not know a song.

## The API, as measured

Auth is `Authorization: Bearer <API_TOKEN>` (AudioMuse's `API_TOKEN`,
meant for exactly this kind of caller). Ids going in and coming out are the
media server's own ids: AudioMuse keeps content hashes internally and
translates both ways (`app_server_context.py` upstream). With several
servers configured there, `server=<name or id>` picks which one's ids are
meant; without it, the default server's.

| Endpoint                               | What it does                                                        | Time (10 results) | Body  |
| -------------------------------------- | ------------------------------------------------------------------- | ----------------- | ----- |
| `GET /api/similar_tracks`              | nearest neighbours of one song, optional mood filter                | 0.10 s            | 4 KB  |
| `POST /api/hyperbolic/similar`         | same in the hyperbolic index; `mode` `similar` / `roots` / `niche`  | 0.15 s            | 4 KB  |
| `POST /api/alchemy`                    | ADD/SUBTRACT any number of songs/artists, `temperature` for variety | 0.08 s            | 22 KB |
| `GET /api/find_path`                   | a path of songs from A to B                                         | 0.30 s            | 43 KB |
| `POST /api/clap/search`                | free-text search by sound                                           | 3.0 s             | 4 KB  |
| `POST /api/lyrics/search/text`         | free-text search by lyrics meaning                                  | 1.6 s             | 4 KB  |
| `GET /api/similar_artists`             | artists by sound, with their ids                                    | 0.03 s            | 1 KB  |
| `GET /api/mood_centroids`              | mood clusters, usable as seeds for `similar_tracks`                 | 0.03 s            | 34 KB |
| `GET /api/servers`, `GET /api/version` | server registry (secrets masked), version                           | -                 | -     |

Each result row has `item_id`, `title`, `author`, `album`, a distance or
similarity, and descriptive extras (`top_genre`, `top_mood`, tempo, key).
**No duration, cover art, track number or album id**, so a row is not a
song Beacon can queue. Alchemy and path rows also carry embedding vectors,
which is where their size comes from.

The endpoints have no version prefix and the project releases about once a
week, so the client has to read only the fields it needs and tolerate
everything else.

## Decisions

- **Connect is the only caller.** The token stays on the server, the
  renderer and the party page never see AudioMuse, and connect owns the
  fallback. The same reasoning as for every other external service.
- **Configuration** follows `core/api_keys.py`: `audiomuse` joins
  `SERVICES` (the key file is `audiomuse_api_key.txt`, as for Last.fm and
  Fanart, env `AUDIOMUSE_API_KEY`), plus the base URL (env `AUDIOMUSE_URL`,
  otherwise `audiomuse_url.txt` next to it). Entered in a section of its own
  under Settings > Advanced (address, token, and whether connect reaches it
  and found this login's server there), admin-only on Docker/web like the
  other keys. Lent to a paired desktop with the address alongside the key
  (`urls` in device-link's `/api-keys`). A linked desktop app gets it
  through device-link like the other shared keys, so a desktop installation
  does not have to be set up twice.
- **Which AudioMuse server is Beacon's** is decided once, from
  `GET /api/servers`: the entry whose type and URL match the media server
  the session is logged in to. One match: use its name as `server` (or leave
  it out if it is the default). No match: the integration is off for that
  session, because ids from another server would hydrate to the wrong songs
  or to nothing. URLs are compared by host and port after normalising, since
  AudioMuse and Beacon may well reach the same server under different
  names; an explicit override in the settings covers what that misses.
- **Connect hydrates the results into real songs** before returning them:
  `getSong` for each id through the same media layer the proxy uses, so it
  works unchanged for Navidrome and both bridges. In parallel with a small
  cap, ids that fail are dropped (a song analysed but since removed, or not
  mapped on this server). Vectors and the 2D projection are thrown away on
  connect's side; the renderer gets plain Subsonic `Child` objects.
- **Fallback is per request, not per setting.** Not configured, not
  reachable (short timeout, about 2 s: a desktop app outside the home
  network must not hang Autoplay), an error, or a seed AudioMuse has not
  analysed: the caller gets today's `getSimilarSongs2`. The renderer does not
  need to know which one answered.
- **Read-only.** Nothing in AudioMuse is written: no playlists created
  there, no anchors or saved radios. What Beacon makes from the results is
  a queue, or a playlist on the media server through the existing path.
- **AudioMuse 3.7.0 or newer**, checked once via `/api/version` when the
  configuration is read. Older versions count as not configured, with a
  line in the settings saying why, rather than being called on a guess.
- **No new settings for the user to understand.** As with
  `AUTOPLAY_BATCH_SIZE`, Autoplay uses the better method by itself when it
  is available instead of offering a select of algorithm names.

## Phase 1: Autoplay and the radios

The one with the clearest effect, touching only connect and
`stores/playback/`.

- **Autoplay seeds from the queue, not from one song.** Alchemy with the
  last five queued songs as ADD, and the last ten songs skipped in this
  listening session as SUBTRACT. AudioMuse's own default `temperature`
  already samples rather than taking the nearest songs, so it is not set;
  worth revisiting if long sessions turn out to circle. Today's seed walk
  (`AUTOPLAY_SEED_ATTEMPTS`, `autoplayExhaustedSeedIds`) stays for the
  fallback path.
- **Skips are recorded** (`services/playback/skips.ts`): a song left via
  Next before the point where it would scrobble counts as skipped; one that
  ended on its own never does. Kept in
  memory for the session only; it is a hint for the next top-up, not a
  rating, and it is never sent to the media server.
- **Song Radio** goes through connect's endpoint with `similar_tracks`,
  AudioMuse's plain neighbours, with today's call as the fallback. Not the
  hyperbolic index: whether that sounds better is the open listening
  question below, and until it is answered Song Radio should sound like the
  plugin's on Navidrome, while Jellyfin and Plex gain it for the first time.
- **Artist Radio**: Alchemy with the artist as an ADD item (`type:
artist`), which takes the artist's whole sound instead of the media
  server's tag-based guess.
- **One added entry, "Discovery Radio"** (de "Entdeckungs-Radio", named
  like "Song Radio" so the two read as a pair): `hyperbolic/similar` in
  `niche` mode, songs that sound related but sit further out. It sits
  directly below Song Radio in every song menu (`SongRow.vue`,
  `SongContextMenu.vue`, `QueueDrawer.vue`, `SongInfo.vue`,
  `MobileSongActionSheet.vue`), not where Song Radio is a single button
  (player toolbar, Home hero, Now Playing, mobile transport), where a second
  button would crowd out the first. Unlike the radios it has **no fallback**:
  without AudioMuse it would just be Song Radio a second time, so the entry
  is hidden, and a failing request shows an error like Song Radio's
  instead of quietly playing something else. `roots` (the opposite) is
  left out until someone asks for it; two entries that differ by an
  adjective nobody can predict is one too many.
- **Availability** is `stores/audiomuse.ts`, not `services/capabilities.ts`
  (which is a table per server type): asked right after login, kept five
  minutes (a "no" thirty seconds), refreshed in the background. Autoplay and
  the radios read what is known without waiting for it, so without
  AudioMuse they ask the media server in the same tick as before. Only the
  Discovery Radio entry depends on it; the radios and Autoplay just get
  better.
- **Which AudioMuse server** is found by a probe rather than by URL alone:
  connect asks AudioMuse for a song on each candidate server (right type,
  same address first) and looks its id up on the session's media server;
  the same title under the same id is the match. That covers a
  reverse-proxied name and never picks a server whose ids mean other songs.

Connect side:

```
core/audiomuse.py          client, config, server mapping, hydration
routes/audiomuse.py        GET  /audiomuse/status
                           POST /audiomuse/mix   {method, add[], subtract[], n, exclude[]}
```

`exclude` is the queue's ids, so the over-fetching that
`autoplayCandidateCount()` does today for `getSimilarSongs2` happens on
connect's side and the renderer gets the batch it asked for.

## Phase 2: path and search

- **"Path to this song"** (`queuePathTo()`): from what is playing to the
  chosen song via `find_path`, at most `PATH_STEPS` (8) songs between them,
  played right after the current one; what was queued carries on after
  the path. A later copy of the chosen song in the queue is taken out, so
  it is not heard twice. In the song menus of song tables, the context
  menu, the queue and the phone's song sheet; not in the player's own song
  menu, which is the song already playing. Offered only for a library song
  other than the one playing (`canPathTo()`). Duplicates of a recording on
  different albums are filtered by title and artist, like every result.
- **Search by sound and by lyrics** (`SonicSearchSection.vue`): two
  sections under the ordinary results, desktop and phone, only with
  AudioMuse. Each waits 600 ms for typing to settle (the phone searches as
  it is typed), only the newest answer is shown, and a section without
  results or with a failed search is not shown at all. The empty state no
  longer says "nothing found" while one of them has results. Measured 1.2
  to 3 s per query, so connect gives these a 20 s timeout instead of the
  short one made for Autoplay.

## Phase 3: Home and artist page

- **"Sounds like you"** shelf on Home, desktop and phone: Alchemy
  over five random picks of Home's top songs (the catalogue's play counts),
  those top songs themselves left out, 30 songs; Reroll draws other seeds.
  Five rather than all fifteen: a blend of everything averages into the
  middle of the library. Deliberately not AudioMuse's `sonic_fingerprint`,
  which reads listening history from the media server and wants the user's
  media-server password in the request.
- **Mood mixes** on Home, right under the recently played albums: one
  coloured tile per mood AudioMuse knows, a fixed six (happy, relaxed,
  party, danceable, sad, aggressive - Beacon's own order and names; a mood it has no name for is left out). A click plays 50
  songs around one of the mood's centroids, picked at random weighted by
  its song count, so the same mood sounds different the next time. The
  centroids' top tags ("rock, metal, alternative") are not shown: they
  describe genres inside a mood, not something to choose between. The
  centroid list is cached for an hour (it changes only with a new
  analysis). Measured 0.08 s for 50 songs.
- **Similar artists by sound** on the artist page, desktop (card shelf at
  the end) and phone (rows after the albums): `similar_artists` with the
  artist's id, hydrated with `getArtist`. AudioMuse also names artists it
  has no id for on the server (featured credits), which have no page and
  are left out. The artist page had no similar-artist block before; the
  ListenBrainz lookup feeds only Home's Discover (artists not in the
  library). Measured 0.17 s for 12.

## Not planned

AI chat playlists, the music map, clustering (its playlists already land on
the media server as ordinary playlists), song recognition by microphone,
AudioMuse's own crossfade/transition endpoints (Beacon has its own
transitions), and anything that writes into AudioMuse.

## Tests

- **pytest, against recorded responses** of the endpoints above (trimmed,
  ids made up): tolerant parsing, hydration dropping unknown ids, server
  mapping (one match, none, several AudioMuse servers, default vs. named),
  fallback on timeout/401/404, vectors not forwarded, `exclude` honoured.
- **jsdom:** Autoplay asks connect's mix endpoint with queue seeds and skips,
  and still tops up when it fails; a skip is recorded before the scrobble
  point and not after it.
- Checked by mutation like the rest: break the fallback, the exclusion, the
  skip threshold, and the suite has to go red.

## Assumed, not verified

- **Jellyfin and Plex ids** are taken to be what the bridges hand the
  renderer (Jellyfin item id, Plex rating key), since that is what
  AudioMuse's providers for those servers read. Only Navidrome was measured.
  If the assumption is wrong somewhere, hydration drops the ids it cannot
  find and an empty result falls back to `getSimilarSongs2`, so the failure
  is "no better than today", not wrong songs. A first report from a Jellyfin
  or Plex user is the place to check. Not tested on purpose: the analysis
  instance serves a Navidrome that is used daily, and adding test servers
  to it is not worth the risk to that database.

## Open before building

- **Whether Song Radio's switch to the hyperbolic index sounds better**
  than the plugin's choice at all; a blind A/B listen before it replaces
  anything.
