---
group: connecting
order: 2
---

# Your own apps

## Can I build my own app on top of Beacon?

Yes. A key gives an app of your own access to one account: its listening history, its statistics, what is playing right now and the lyrics of that song, and, if you allow it, playback itself and the library to pick from. It works the same on Navidrome, Jellyfin and Plex.

A key never reaches another account and never changes a setting. What it may do beyond reading is up to you when you make it.

A Beacon server offers this, and so does the desktop app, for apps on its own network. The desktop app's player is its own window; a server's is the music the account casts to speakers.

## What could I build with it?

- A display on your desk, or an e-ink frame, showing the song and its cover
- An overlay for a stream
- A "listening to" status in Discord or a chat
- Karaoke on a television, with the lyrics in time
- A review of your year, or a Grafana dashboard
- A backup of your listening history as a file of your own
- A "listening to" box on your home page
- Buttons by the door or on a tablet: pause, skip, start the morning playlist
- Home automation: [Home Assistant](../guides/home-automation.md) has an integration of its own

## How do I get a key?

Open Settings > Account > Apps and devices, in a browser on the server or in the desktop app, choose **New key** and **Own app**, switch on what the app may do and create the key. It is shown once. Each app gets its own key, and revoking one in the same place cuts off only that app. What a key may do cannot be changed afterwards: make a new one.

| Right                              | Allows                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| Listening history                  | `/history`                                                                          |
| Statistics                         | `/stats`                                                                            |
| What is playing now                | `/now-playing`, `/now-playing/events`, `/now-playing/cover`                         |
| Lyrics                             | `/now-playing/lyrics`, only together with what is playing now                       |
| Steer playback                     | `/player`, `/player/events`, `/player/commands`, `/player/devices`, `/player/cover` |
| Browse the library and start music | `/library/...` and the `play_*` and `queue_*` commands, only together with control  |

A key with the library right carries the login of whoever made it, sealed with the key itself: Beacon cannot read it without the key, and nobody can read it from the key alone. Signing out of Beacon does not end it; revoking the key does. When the media server stops accepting that login, for example after a password change, the library answers 409 `media_login_rejected`: make a new key.

## How does an app call it?

Every address starts with `/device-link/v1`, and every request carries the key as a header:

```
curl -H "X-Beacon-Device-Key: <key>" https://beacon.example/device-link/v1/me
```

`GET /me` works with any key and answers with `username`, `scopes`, `beacon_version`, `player` and `api_version`. `player` is `desktop` or `server`: a desktop app plays on its own computer as well as on speakers, a server only on speakers.

On a server that is the address you open Beacon at. The desktop app is reached at `http://<its computer>:<port>`, both shown in the key dialog; set a fixed port under Settings > Account > Apps and devices so the address stays the same. Its routes answer only while the app runs.

A web page on any address may call these routes directly. If Beacon sits behind a forward-auth such as Authentik, `/device-link/` has to be let past it, see [Behind a login](../guides/desktop-and-server.md#behind-a-login).

## What can go wrong?

| Status | Meaning                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 401    | Wrong or revoked key                                                                                    |
| 403    | This key does not have the right for that route or command, or the account may not cast                 |
| 404    | Nothing to show: no song is playing, it has no cover, or no such album, playlist or station             |
| 409    | The player cannot do that now (see [the player](#how-do-i-control-playback)), or `media_login_rejected` |
| 410    | The history cursor has expired, start again without one                                                 |
| 422    | A parameter makes no sense, or a command misses what it needs                                           |
| 429    | More than 120 requests a minute, 600 images a minute, or 3 open streams, for this key                   |
| 502    | The media server or a speaker did not do it                                                             |
| 503    | The desktop app's window is not connected                                                               |
| 504    | The desktop app did not answer in time                                                                  |

After too many requests, `Retry-After` says how many seconds to wait.

## How do I read the listening history?

`GET /history` answers with `items`, `next_cursor` and `more`.

| Parameter | Meaning                                      |
| --------- | -------------------------------------------- |
| `limit`   | 1 to 500, default 100                        |
| `cursor`  | `next_cursor` of the previous answer         |
| `since`   | Only plays from this time on, in UTC seconds |
| `until`   | Only plays up to this time, in UTC seconds   |

Each item has `id`, `ts` (UTC seconds), `source` (`beacon`, or the service it was imported from), `song_id`, `title`, `artist`, `artist_id`, `album`, `album_id`, `genre` and `duration`.

Plays come **in the order they arrived, not the order they were played.** A desktop app that was offline delivers plays that are days old, and this way an app following along still gets them. Keep `next_cursor` and ask with it again later: the answer holds only what is new. To show plays by date, sort by `ts` yourself.

A cursor expires with a 410 when plays were removed, which happens when an import is replaced. Forget what you have and read from the start.

## What is in the statistics?

`GET /stats` answers with:

| Field        | Meaning                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `total`      | Plays in the record                                                                                                                          |
| `live_since` | When Beacon's own record began, UTC seconds, null before the first play                                                                      |
| `top`        | `songs` and `albums` with `title`, `artist`, `album_id`, `plays`; `artists` with `name`, `artist_id`, `plays`; `genres` with `name`, `plays` |
| `milestones` | `plays`, `hours`, `streak`, `records` as of the last visit to the Stats page; null before the first visit and after an import                |
| `timestamps` | Every play in UTC seconds, oldest first                                                                                                      |

There is no current streak: a day depends on the listener's time zone, which only your app knows. Work it out from `timestamps`.

## How do I find out what is playing?

`GET /now-playing` answers `{"playing": false}` when nothing is, and otherwise:

```json
{
  "playing": true,
  "paused": false,
  "kind": "song",
  "source": "cast",
  "devices": ["Living room"],
  "song": { "id": "", "title": "", "artist": "", "album": "", "duration": 214 },
  "radio": null,
  "position": 31.4,
  "at": 1762632000.123
}
```

`source` is `cast` while it plays on a speaker, named in `devices`, and `local` when a browser, phone or desktop app plays it itself. `position` is in seconds and was correct at `at`, in UTC seconds. While not paused, carry it forward yourself instead of asking again.

For a station, `kind` is `radio`, `song` and `position` are null, and `radio` has `station` and `title`. The title is what the station sends, usually "Artist - Title", and null during an advert.

When several things play at once, you get what can be heard before what is paused, then a cast before a device playing by itself, then the one started last.

After playing stops on a browser or phone without saying so, for example with a laptop closed, it counts as playing for up to 90 seconds more.

## How do I follow along without asking all the time?

`GET /now-playing/events` is a stream of server-sent events: the same answer as `/now-playing` once at the start, and again on a new song, pause, resume, seek or stop. Lines starting with `:` are keepalives, about every 15 seconds. The stream ends when the key is revoked.

```
curl -N -H "X-Beacon-Device-Key: <key>" https://beacon.example/device-link/v1/now-playing/events
```

A browser's `EventSource` cannot send the header. Read the stream with `fetch`, or ask `/now-playing` every few seconds.

## How do I get the cover?

`GET /now-playing/cover` answers with the image of the song playing now, and with a 404 for radio or a song without one. The address stays the same from song to song, so fetch it again when the song changes. For a song only the desktop app is playing, it needs somebody signed in to that account on the server.

## How do I get the lyrics?

`GET /now-playing/lyrics` answers for the song playing now, and with a 404 for radio or when nothing plays:

```json
{
  "song_id": "",
  "synced": true,
  "lines": [{ "time": 12.5, "text": "" }],
  "offset": -0.7
}
```

`offset` is the correction made for this song in Beacon. A line is reached once `position - offset >= time`. With `synced` false, every `time` is 0 and the text has no timing. A song with no lyrics found has no `lines`.

These are the lyrics Beacon finds by itself. Lyrics somebody picked by hand in Beacon's own panel do not reach an app. There is no search, on purpose: every lookup tells the lyrics services what somebody listens to.

## How do I control playback?

`GET /player` describes the player this key steers. It is there when `available` is true: on a server always, on the desktop app while its window is open and signed in with the key's account.

| Field                           | Meaning                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `state`                         | `playing`, `paused` or `idle`                                                              |
| `source`                        | `cast` on speakers, `local` on the desktop app itself, null when idle                      |
| `song`                          | `id`, `title`, `artist`, `album`, `duration`, `cover_art_id`; null for radio               |
| `radio`                         | `station` and `title` for a station                                                        |
| `position`, `at`                | As for `/now-playing`: carry `position` forward from `at` while playing                    |
| `volume`                        | 0 to 1: the speaker's when one plays, otherwise the desktop app's own; null when not known |
| `shuffle`, `repeat`, `autoplay` | `repeat` is `off`, `all` or `one`                                                          |
| `queue`, `queue_index`          | The whole queue as songs, and where in it the player is                                    |
| `devices`                       | The speakers playing, as `type` and `name`                                                 |
| `interrupted`                   | A speaker dropped out; `resume_interrupted` picks it back up                               |
| `party`                         | `running`, `guests`, `listeners`, `listen_kbps` on the desktop app; null otherwise         |
| `commands`                      | What the player takes right now                                                            |

On a server, a queue that was never shown in a browser fills its titles in over a few seconds; until then an entry has only its `id`.

`GET /player/events` streams the same answer at the start and on every change except the position moving on, like `/now-playing/events`.

`POST /player/commands` takes one command as JSON and answers once it has been carried out:

```
curl -H "X-Beacon-Device-Key: <key>" -H "Content-Type: application/json" \
  -d '{"type": "volume", "volume": 0.3}' https://beacon.example/device-link/v1/player/commands
```

| Command                             | Takes                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `play`, `pause`, `next`, `previous` | nothing                                                                                                               |
| `seek`                              | `position` in seconds                                                                                                 |
| `volume`                            | `volume`, 0 to 1, on every speaker playing                                                                            |
| `shuffle`, `autoplay`               | `on`: what you want, not a toggle                                                                                     |
| `repeat`                            | `mode`: `off`, `all` or `one`                                                                                         |
| `queue_jump`                        | `index` in `queue`                                                                                                    |
| `devices`                           | `devices`: the speakers to play on, the whole set. Empty plays on the desktop app itself, or stops a cast on a server |
| `resume_interrupted`                | nothing, desktop app only                                                                                             |
| `play_song`, `play_song_radio`      | `song_id`                                                                                                             |
| `play_album`                        | `album_id`                                                                                                            |
| `play_playlist`                     | `playlist_id`, optionally `start_index`                                                                               |
| `play_radio`                        | `station_id`                                                                                                          |
| `queue_next`, `queue_add`           | `song_id`                                                                                                             |

`previous` starts the song again when it is more than five seconds in. A speaker somebody else plays on stays theirs, on the desktop app as on a server: picking it answers 409 `device_in_use`, no takeover. `GET /player/devices` lists the speakers with `type`, `name`, `in_use_by` (somebody else playing on it) and `needs_pairing`; `?rescan=true` searches the network again, which takes a few seconds. `GET /player/cover` is the cover of the song in the player, or the station's logo.

**On a server**, the player is the account's music on speakers, chosen like `/now-playing` chooses. Commands without something cast answer 409 `nothing_playing`. A `play_*` command plays on the speakers already playing, and with nothing cast it needs `devices` to start on, otherwise 409 `no_speaker`. Music started from an app plays in the account's own session, so a browser signed in with that account shows it. Shuffle, repeat and autoplay reach a browser open on that cast; repeat at the end of the queue is carried out only by a browser that is open.

**On the desktop app**, commands go to its window, which acts on them as if clicked there.

## How do I browse the library?

With the library right, an app can look up what to play, through Beacon and with the login the key carries:

| Route                                   | Answer                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /library/songs?search=`            | `items`: songs; with `offset` and `limit`                                            |
| `GET /library/albums`                   | `items`: albums by name, or matching `search`; with `offset` and `limit` (up to 500) |
| `GET /library/albums/{id}`              | `album` and its `songs`                                                              |
| `GET /library/playlists`                | `items`: playlists with `song_count`                                                 |
| `GET /library/playlists/{id}`           | `playlist` and its `songs`                                                           |
| `GET /library/radio-stations`           | `items`: stations with `home_page_url`                                               |
| `GET /library/radio-stations/{id}/logo` | The station's logo, at least `size` pixels when it has one that large                |
| `GET /library/cover/{cover_art_id}`     | A cover, at `size` pixels                                                            |

Images have a limit of their own, so a list showing every cover at once does not use up the 120 requests.

## Can an AI assistant write the app for me?

Yes. Everything above is also available as a machine-readable description, which needs no key and holds no data:

```
https://beacon.example/device-link/v1/openapi.json
```

The quickest way: right after creating a key, use **Copy instructions for an AI**. It copies your server's address, what this key may read and the rules below. It never copies the key: give that to your app yourself, and keep it out of the chat and the code.

If you write the prompt yourself, these are the things a description does not say:

- History comes in the order plays arrived, not the order they were played. On a 410, forget what you stored and start again.
- Carry `position` forward from `at` while not paused, instead of asking every second.
- A browser's `EventSource` cannot send the key: read `/now-playing/events` with `fetch`.
- A lyric line is reached at `position - offset >= time`.
- Ignore fields you do not know, and wait as long as `Retry-After` says after a 429.
- Commands say what is wanted (`"on": true`), they do not toggle. Check `commands` before offering one.

## Will an update break my app?

Not within `v1`: existing fields keep their meaning, and new ones may appear, so ignore what you do not know. The other addresses under `/device-link/` belong to the desktop app and can change with any release.

## Why does it not stream music?

Music is better fetched straight from your media server. Navidrome, Jellyfin and Plex all have their own interface for that, and going through Beacon would only add a stop on the way.

A key that only reads is still the safest to put in a script: give control and the library only to an app that needs them.
