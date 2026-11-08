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
falls back to the local log when it cannot. Unsent local plays are added on top
of the server's answer, so a song just played counts at once.

## Open

- **Admin view.** A key only speaks for its own account, so the desktop's admin
  picker stays as it was. Listing the server's accounts needs the admin flag
  noted on the key, and a way for it to end when the server stops considering
  the account an admin.
- **Leaving a server.** Unpairing keeps the local log. What only the server
  knows is not copied down.
- **Deleting.** There is no way to delete a single play today. If one comes, it
  needs tombstones to survive a sync.
