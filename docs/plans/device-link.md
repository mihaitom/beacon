# Pairing a desktop app with a Beacon server

Built on `feature/device-link`, not released yet. The desktop app bundles its
own connect, so its Stats page only knew what was played on that machine, and
its account settings stopped at that installation. This connects a desktop app
to a Beacon server, so both show the same history and follow the same
settings. The user-facing side is `docs/help/guides/desktop-and-server.md`.

Server-to-server sync is out of scope. Docker refuses to pair (`BEACON_HOSTED`
in `start.sh`): the URL comes from a signed-in listener, and connect would be
making requests wherever one of them pointed it.

## Shape

The server is the truth, the desktop app keeps writing locally.

```
player -> desktop connect -> listens, settings (local, written first)
                               |  unsent rows and fields, whenever reachable
                               v
                          server connect (ON CONFLICT id DO NOTHING)
```

Playing never waits for the network, and what was made offline goes out later.

## Deliberately not synced

| What                                                 | Why                                             |
| ---------------------------------------------------- | ----------------------------------------------- |
| Caches (recommendations, artwork, lyrics, waveforms) | can be recomputed, see `CLAUDE.md`              |
| Cast permissions, Hue, integration key, remote PIN   | bound to a house or an installation             |
| Favourites, ratings, playlists, Navidrome's queue    | already on the media server                     |
| `releaseNotesSeen`                                   | names an app version, and the two run different |

Considered and left out for now: a queue for Jellyfin and Plex, radio stations,
and steering the desktop through the server
(rejected, it would need a channel from the server back to the desktop).

## The key

Made on the server by the signed-in listener, shown once.

- **Which account.** A key belongs to one `accounts` row, so the desktop's own
  spelling of the media server's URL does not matter.
- **Getting past a login.** A forward auth redirects an Electron fetch to a
  login page, so sync has its own prefix, `/device-link/`, which the proxy lets
  through as it does `/party/`. `ng.conf.template` gives it its own location
  without the injected token.
- **No media server login on the server.** The listener's password does not
  go to a second machine.

`<id>.<secret>`: the id finds the row, and only the secret's hash is compared,
in constant time. One per device, with a label and a last-used time, listed
and revocable in the server's Settings. On the desktop it lives in
`server_link.json` (0600) and is never handed back to the renderer. The URL
must be https, except for a private address.

## Two identities

The play history is filed under the account `/config` verified, which prefers
a server id over the URL. The account settings are filed under what the
renderer sends (`auth.serverUrl`). They are different strings on Plex and
Jellyfin, so a key stores both (`SessionState.settings_identity`). The second
is partly claimed by the renderer, and a key outlives the session that made
it, so it is only kept when its name matches the verified one. Without it the
key shares no settings.

## Routes

Key only, no session and no `CONNECT_TOKEN`:

| Route                             | Purpose                                      |
| --------------------------------- | -------------------------------------------- |
| `GET /device-link/info`           | checks the key, says who it is               |
| `POST /device-link/listens`       | at most 500 rows, fields limited as `Listen` |
| `GET /device-link/summary`        | the same answer as `/play-history/summary`   |
| `GET /device-link/charts`         | the same answer as `/play-history/charts`    |
| `PUT /device-link/milestones`     | merged upwards                               |
| `GET/PATCH /device-link/settings` | only `LINKED_FIELDS`, 64 KB                  |

Failed key checks are rate limited per address. Bodies are read only after the
key has passed. `/device-keys` (session) makes and revokes keys, `/server-link`
(session, desktop) pairs.

## Sending

A background task in the desktop's connect, after each recorded play or change
and on a timer, backing off while the server is unreachable. Every pass starts
with `/info`, so an idle desktop still notices a server that went away or a
revoked key. A row is marked sent only after a 2xx.

Only the paired account's `source = 'beacon'` rows go: a desktop can have held
other logins. Pairing clears `sent_at`, since it may be a different server, and
sending a row twice to the same one changes nothing.

Settings go through the existing route: `POST /account-settings` writes locally
and queues the field, `GET` asks the server and lays unsent fields on top. The
renderer knows nothing about any of it, and its "server wins" at login is
unchanged.

## Lyrics corrections

Per song in connect (`core/lyrics_offsets.py`), rather than as one list in the
account settings: those are written whole, so a device holding an older copy
would take back a correction made elsewhere. Zero is kept as a row, so that a
device still holding the old value hears it was undone. The renderer keeps
reading localStorage, and brings it in step at login: the account wins for
songs it knows, and what only this device knows goes up.

## Custom themes

The list follows the account as `customThemes` in the settings, whole, since a
theme is rarely edited on two devices at once. Which theme is on stays with the
device. A theme deleted elsewhere falls back to Beacon on this one.

## API keys

The server's administrator enters the Last.fm and Fanart keys once for everyone
on it, but each desktop app is an installation of its own. Any paired desktop
can borrow them, confirmed device by device when its key is made, and off
unless confirmed, because they end up in a file on that computer. The person
making the key decides, not an administrator: those keys are free and quickly
replaced, and whoever has an account already uses them on the server. Changing
the answer takes a new key. The desktop keeps them apart from a key entered
there, which stays in charge, and gives them back on disconnecting or when its
key is refused.

## What the server decides about incoming rows

- **Time.** Stamped by the desktop's connect. More than a day ahead is dropped.
- **The same play twice.** Same song within `_SAME_PLAY_SECONDS` of a neighbour
  counts once.
- **Imports.** An import only covers what is older than Beacon's first own
  play. A batch that moves that point back cuts the import to match. This can
  drop scrobbles made outside Beacon in the overlap; that is the price of never
  counting a play twice.
- **Milestones.** The first sync is sent as `backfill` and resets them, so the
  next visit sets a silent baseline, as after an import. The desktop's own
  milestones do not go up at pairing for the same reason.

## Reading

While paired, the desktop's `/play-history/summary` answers from the server and
falls back to the local log when it cannot. The Stats page's period charts
(`/play-history/charts`) do the same for their window. Unsent local plays are
added on top of the server's answer, so a song just played counts at once.

## Apps of your own

Built. The specification for whoever writes one is `docs/help/faq/apps-and-api.md`.

The same key, for apps listeners write themselves: a desk display, a stream
overlay, a dashboard. Read only, one account, and it needs a Beacon server: a
desktop app on its own does not offer this.

**In:** listening history, statistics, what is playing now, synced lyrics of
what is playing now.

**Out, on purpose:**

- Library and streams. Other players do that better, and a key has no media
  server login to do it with.
- Reporting plays from outside. A play cannot be deleted, song ids differ per
  player, and players that scrobble can already be imported.
- Steering playback. `/remote/*` with the integration key exists for home
  automation.
- The Last.fm and Fanart keys, the account's settings, cast permissions, Hue,
  and other accounts.

### What a key may do

A key has a list of scopes, chosen when it is made and checked per route:

| Scope         | Allows                                                     |
| ------------- | ---------------------------------------------------------- |
| `sync`        | everything the desktop app uses today                      |
| `api_keys`    | `GET /device-link/api-keys`, only together with `sync`     |
| `history`     | `/v1/history`                                              |
| `stats`       | `/v1/stats`                                                |
| `now_playing` | `/v1/now-playing`, its event stream and its cover          |
| `lyrics`      | `/v1/now-playing/lyrics`, only together with `now_playing` |

A key is a desktop's or an app's, never both: `sync` cannot be combined with a
read scope. The Settings section is "Apps and devices". Making a key starts with
Beacon desktop app (today's form, with today's switch for the API keys) or
Own app (one switch per read scope, all off). The list shows what each key may
do. A different answer takes a new key, as for the API keys.

Migration 5 replaces `may_read_api_keys` with `scopes`: every existing key
becomes `sync`, those with the right `sync,api_keys`.

### Routes

All under `/device-link/v1/`, so no new exception in anybody's reverse proxy,
and with the same `X-Beacon-Device-Key` header. The routes outside `v1` stay
private to the desktop app and may change with it; `v1` may only grow.

| Route                     | Answer                                                   |
| ------------------------- | -------------------------------------------------------- |
| `GET /me`                 | `username`, `scopes`, `beacon_version`, `api_version`    |
| `GET /history`            | plays in order of arrival, see below                     |
| `GET /stats`              | `total`, `live_since`, `top`, `milestones`, `timestamps` |
| `GET /now-playing`        | see below; `{"playing": false}` when nothing is          |
| `GET /now-playing/events` | server-sent events, one on each change                   |
| `GET /now-playing/cover`  | the image, through connect's existing artwork cache      |
| `GET /now-playing/lyrics` | `song_id`, `synced`, `lines`, `offset`                   |

`/me` takes any key. Scope missing is a 403, a wrong key a 401, too many
requests a 429. A desktop refuses an app's key when pairing.

Limits to start from: 120 requests a minute and 3 open event streams per key.

### History

`GET /history?cursor=&since=&until=&limit=` (at most 500, default 100). Each
item: `id`, `ts`, `source` (`beacon` or the import it came from), `song_id`,
`title`, `artist`, `artist_id`, `album`, `album_id`, `genre`, `duration`.

**Ordered by arrival, not by time played.** A desktop that was offline delivers
plays dated days ago, so a dashboard paging by `ts` would never see them.
`next_cursor` is `rowid` based; asking again with it returns only what is new.

**Rows can also go away.** An import can be fetched again, and a desktop batch
can cut one back. `rowid` is also reused once the newest rows are gone. So
`accounts` gets a `history_epoch`, raised whenever rows are removed, and the
cursor carries it: a cursor from an older epoch answers 410, and the app starts
over.

No `cover_art_id`: with no session behind a key, no route could use it.

### Statistics

`/play-history/summary`'s data under a field list of its own: `top.songs` and
`top.albums` have `title`, `artist`, `album_id`, `plays`; `top.artists` `name`,
`artist_id`, `plays`; `top.genres` `name`, `plays`. `milestones` is what the
Stats page last saw, null before its first visit and after an import. No current
streak: only the client knows the listener's time zone, which is why
`timestamps` is there. `milestones` has the best streak reached.

### What is playing now

The one part that needs new plumbing, because connect does not know all of it:

| Playing on                   | Known to the server today                             |
| ---------------------------- | ----------------------------------------------------- |
| A cast started on the server | yes, per session, and sessions name their account     |
| A browser or phone, locally  | no: `/lights/local` has an id only, and only with Hue |
| The desktop app              | no: that is another connect                           |

Built in that order, each usable without the next:

1. **Casts.** `registry.all()` filtered by the key's account.
2. **Local playback.** A report from the renderer to connect, with title,
   artist, album and duration, independent of the lights. On each change (song,
   play/pause, seek) plus every 30 seconds, since connect carries the position
   forward. A report older than 90 seconds counts as gone.
3. **Desktop.** Its connect passes the same report to the server over
   `PUT /device-link/now-playing` (`sync`).

With several at once: what can be heard before what is paused, then a cast
before a device playing by itself, then the one that started last. A window
tells connect through `POST /now-playing/report`, and the answer says whether
any app wants to know: told no, it stays quiet until the next song. So an
account with no such key costs one request per song. A browser leaves its casts
out, since connect knows those; the desktop reports them with their `devices`.

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

`position` is correct at `at`; the app carries it forward. For radio, `kind` is
`radio`, `song` and `position` are null, and `radio` has `station` and `title`
(the station's own "Artist - Title", null during an advert).

`devices` is a list because a cast can be grouped. The event stream asks once a
second rather than subscribing, since playing can start in a session that does
not exist yet when the stream opens. It sends the state at the start and then
on a new song, pause, resume, seek or stop, not as time passes.

**A list of fields, never `build_status_dict()`.** That carries the queue and
stream diagnostics, and `cover_art_url` holds the media server's credentials in
its query string on Subsonic. The same goes for the event stream: it does not
forward `session.event_bus`.

**Event streams.** Header only, no `?key=`, unlike `/remote/events`: this key
crosses the internet and URLs end up in proxy logs. A browser app reads the
stream with `fetch` or polls. A stream that stays open has to do two things a
request gets for free: look the key up again on every keepalive, so revoking
ends it, and count as use, or the green light goes out while it runs.

**Cover.** Needs a signed-in session of that account on the server to reach the
media server, so with nobody signed in there, playing on the desktop answers
404 and the app shows its own placeholder.

### Lyrics

Only for what is playing now, not by search: a free search would turn the key
into a proxy to the lyrics providers, and each lookup tells them what somebody
listens to. Uses `auto_for_party()`, so a song the app asks about shares the
cache with everybody else, and adds the account's correction from
`lyrics_offsets`, returned as `offset` and not baked into `lines`.

A line counts as reached at `position - offset >= time`, as in Beacon's own
panel. A song with no lyrics found answers 200 with no `lines`; nothing playing,
or radio, answers 404.

This is the automatic match. A listener who picked other lyrics by hand in
Beacon sees those there, and the app the automatic ones.

### Reaching it

- **nginx:** `location /device-link/` has `proxy_buffering off`, as `/party/`
  does. The event stream's keepalive stays well inside nginx's read timeout.
- **CORS:** `/device-link/v1/` answers any origin (`*`, no credentials, nothing
  here uses cookies), from a middleware outside the error boundary, so a crash
  reaches a page as a 500. A preflight is answered before the key check, since
  it cannot carry one. Only `v1`: the other routes keep their allow list.
- **Limit:** 120 requests a minute per key, on `v1` only: a desktop catching up
  sends more than that and is not somebody's loop.

### For AI assistants

Somebody writing such an app today has an assistant write it, so the routes
describe themselves:

- `GET /device-link/v1/openapi.json`, without a key, because an assistant has to
  read it before anyone hands it one. Built from the `v1` routes alone; connect's
  own OpenAPI stays off. The routes have real response models, so the description
  cannot drift from what they answer.
- `connect/tests/device_link_v1_contract.json` is what `v1` has promised: a test
  fails when a route or field in it goes or changes. New ones are allowed.
- Settings offers to copy instructions for a new app key. The function building
  them does not take the key: a chat with an assistant leaves the house.

Not built: `llms.txt` and an MCP server, which would say the same thing again.

### Documentation

A new page, `docs/help/faq/apps-and-api.md`, linked from the Settings section:
how to get a key, every route with its scope, fields, errors and limits, a
`curl` example, the rule that `v1` only grows, and what can be built with it:

- a desk display or e-ink frame showing the song and cover
- a stream overlay
- a Discord or chat status
- karaoke on a television
- a yearly review, or a Grafana dashboard
- a personal backup of the history as a file
- a "listening to" box on a home page

`faq/privacy.md`'s "Who can see what I listen to?" gets a sentence: a key with
these rights tells that app live what is playing.

### Order of work

1. Scopes, migration, checks on the existing routes, `/me`, the Settings form.
2. `/history` with `history_epoch`, `/stats`.
3. nginx, CORS, limits.
4. `/now-playing` and its events for casts, with cover.
5. Local reports, then the desktop's.
6. `/now-playing/lyrics`.
7. The FAQ page, `faq/privacy.md`, `CHANGELOG.md`.

### How to check it

- Each route with a key lacking its scope, a revoked key, no key, and another
  account's key. A desktop key must not read `v1`, an app key must not reach
  `/settings`, `/listens` or `/api-keys`.
- History: a late delivery appears after the cursor; a repeated import answers 410.
- No response from `v1` contains a media server credential, tested against a
  session whose cover URL has one.
- Revoking ends an open event stream.
- Two accounts on one server never see each other's playback.
- Breaking each of these in a copy turns the suite red.
- The nginx rule and an event stream through it on a real image, which needs
  the maintainer's build.

## Open

- **Admin view.** A key only speaks for its own account, so the desktop's admin
  picker stays as it was. Listing the server's accounts needs the admin flag
  noted on the key, and a way for it to end when the server stops considering
  the account an admin.
- **Leaving a server.** Unpairing keeps the local log. What only the server
  knows is not copied down.
- **Deleting.** There is no way to delete a single play today. If one comes, it
  needs tombstones to survive a sync.
