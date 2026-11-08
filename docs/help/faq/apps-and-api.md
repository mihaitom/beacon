---
order: 9
---

# Your own apps

## Can I build my own app on top of Beacon?

Yes, if you run a Beacon server. A key gives an app of your own read access to one account: its listening history, its statistics, what is playing right now and the lyrics of that song. It works the same on Navidrome, Jellyfin and Plex.

The app can only read. It cannot start music, change a setting or reach another account. A desktop app that is not connected to a server has no such interface, though what it plays reaches the server's once it [is connected](../guides/desktop-and-server.md).

## What could I build with it?

- A display on your desk, or an e-ink frame, showing the song and its cover
- An overlay for a stream
- A "listening to" status in Discord or a chat
- Karaoke on a television, with the lyrics in time
- A review of your year, or a Grafana dashboard
- A backup of your listening history as a file of your own
- A "listening to" box on your home page

## How do I get a key?

Open Beacon on the server in a browser, go to Settings > Account > Apps and devices, choose **Own app**, switch on what the app may read and create the key. It is shown once. Each app gets its own key, and revoking one in the same place cuts off only that app. What a key may read cannot be changed afterwards: make a new one.

| Right               | Allows                                                        |
| ------------------- | ------------------------------------------------------------- |
| Listening history   | `/history`                                                    |
| Statistics          | `/stats`                                                      |
| What is playing now | `/now-playing`, `/now-playing/events`, `/now-playing/cover`   |
| Lyrics              | `/now-playing/lyrics`, only together with what is playing now |

## How does an app call it?

Every address starts with `/device-link/v1` on your Beacon server, and every request carries the key as a header:

```
curl -H "X-Beacon-Device-Key: <key>" https://beacon.example/device-link/v1/me
```

`GET /me` works with any key and answers with `username`, `scopes`, `beacon_version` and `api_version`.

A web page on any address may call these routes directly. If Beacon sits behind a forward-auth such as Authentik, `/device-link/` has to be let past it, see [Behind a login](../guides/desktop-and-server.md#behind-a-login).

## What can go wrong?

| Status | Meaning                                                                    |
| ------ | -------------------------------------------------------------------------- |
| 401    | Wrong or revoked key                                                       |
| 403    | This key does not have the right for that route                            |
| 404    | Nothing to show: no song is playing, or it has no cover                    |
| 410    | The history cursor has expired, start again without one                    |
| 422    | A parameter makes no sense                                                 |
| 429    | More than 120 requests a minute, or more than 3 open streams, for this key |

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

## Will an update break my app?

Not within `v1`: existing fields keep their meaning, and new ones may appear, so ignore what you do not know. The other addresses under `/device-link/` belong to the desktop app and can change with any release.

## Why can it not play music or control Beacon?

Other players already do that well, and a key that can only read is safe to put in a script. To control the desktop app from home automation, there is the [Home automation API](../reference/home-automation-api.md).
