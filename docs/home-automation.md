# Home automation

Beacon's desktop app can be watched and controlled by Home Assistant or any
other automation tool, through the same HTTP interface the phone remote
uses. This page is for whoever writes such an integration.

Beacon ships no Home Assistant integration of its own. What it provides is a
key that survives restarts, a fixed address, and an mDNS announcement.

## Setting it up

In the desktop app, **Settings > Advanced > Home automation**:

1. **Create key.** The key is shown once. It stays valid across restarts
   until it is revoked or replaced by a new one. It works whether or not the
   phone remote is switched on.
2. **Fixed port** (optional). Without one, the app picks a free port on
   every start. With one, it uses that port, unless something else holds it
   at start, in which case it falls back to a free port and says so in the
   same place. The environment variable `BEACON_PORT` sets it too and wins
   over the setting.

Only the desktop app offers this. The web/Docker build has no desktop
playback to control.

## Finding Beacon: mDNS

While a key exists, Beacon announces itself as `_beacon._tcp.local.`, with
its current address and port. The announcement is withdrawn when the key is
revoked, and follows the machine to a new address.

TXT properties:

| Key       | Value                                                           |
| --------- | --------------------------------------------------------------- |
| `id`      | Stable per installation. Use it as the unique id of the device. |
| `version` | Beacon's version                                                |
| `path`    | Where the API lives: `/remote/`                                 |

An integration that follows the announcement keeps working when the port
changed. mDNS does not cross subnets or VLANs; set a fixed port for those
setups.

## Authentication

Every request carries the key, either as a header or, for an `EventSource`
that cannot set headers, as a query parameter:

```
X-Remote-Password: <key>
GET /remote/events?password=<key>
```

| Status | Meaning                                                    |
| ------ | ---------------------------------------------------------- |
| 401    | Wrong key (while the phone remote is on)                   |
| 404    | Wrong key (while the phone remote is off), or revoked      |
| 503    | The desktop app is not running. Show the device as offline |
| 504    | The app did not answer in time                             |

## State

`GET /remote/state` returns the current snapshot. `GET /remote/events` is a
server-sent event stream: the snapshot once on connect, then again on every
change, with a comment line as heartbeat every 15 seconds.

The fields an integration is likely to need:

| Field               | Meaning                                                       |
| ------------------- | ------------------------------------------------------------- |
| `playing`           | `true` while playing                                          |
| `position`          | Seconds into the current track                                |
| `duration`          | Length of the current track in seconds                        |
| `volume`            | Local volume, 0 to 1                                          |
| `device_volume`     | Volume of the one speaker being cast to, 0 to 100, else null  |
| `shuffle`, `repeat` | `repeat` is `off`, `all` or `one`                             |
| `current_song`      | `id`, `title`, `artist`, `album`, `duration`, `cover_art_id`  |
| `radio`             | `name`, `now_playing` while a station plays, else null        |
| `queue`             | Songs, same shape as `current_song`; `queue_index` is current |
| `casting`           | The speakers being cast to, each with `type` and `name`       |
| `session_id`        | Needed for cover art, see below                               |

Ignore `cover_art_url` and `favicon_url`: they carry the phone remote's own
password and are null while it is off. Build the cover URL from
`cover_art_id` instead:

```
GET /remote/cover-art?id=<cover_art_id>&session=<session_id>&password=<key>
```

## Commands

`POST /remote/command` with `{"type": "...", "payload": {...}}`. It returns
once the app has carried the command out.

| Type          | Payload                       |
| ------------- | ----------------------------- |
| `play`        | none; does nothing if playing |
| `pause`       | none; does nothing if paused  |
| `toggle-play` | none                          |
| `next`        |                               |
| `previous`    |                               |
| `seek`        | `position` in seconds         |
| `volume`      | `volume`, 0 to 1              |
| `shuffle`     | toggles                       |
| `repeat`      | cycles off, all, one          |
| `play-song`   | `songId`                      |
| `play-album`  | `albumId`                     |
| `queue-jump`  | `index`                       |
| `cast-stop`   | stops casting                 |

The phone remote's library browsing (`/remote/songs`, `/remote/albums`,
`/remote/playlists`, `/remote/radio-stations`, `/remote/devices`) accepts
the key as well.

## Compatibility

The fields and commands above are the ones Beacon keeps stable for
integrations. The snapshot carries more, for the phone remote's own use;
those can change between releases without notice.
