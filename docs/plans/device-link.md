# Syncing the play history between installations

Not built yet. The desktop app bundles its own connect, so its Stats page only
knows what was played on that machine, and a server install only knows what
was played through it. This plan connects a desktop app to a Beacon server, so
both show the same history.

Storage is ready for it: every listen has a random `id`
(`connect/core/play_history.py`), so a play stays the same play on another
machine and sending it twice changes nothing.

## Shape

The server is the truth, the desktop app keeps writing locally.

```
player -> desktop connect -> listens (local, written first)
                               |  unsent rows, in batches, whenever reachable
                               v
                          server connect -> listens (ON CONFLICT id DO NOTHING)
```

Playing never waits for the network, and plays made offline go out later.
Docker and web installs change nothing: they already write to the server.
Server-to-server sync is out of scope, and only the play history syncs.

## Pairing

In Settings the desktop app gets a server URL and a sync key. The key is made
on the server, by the logged-in listener, and is shown once.

The key decides everything the URL cannot:

- **Which account.** The account key today is server type + media server URL +
  username. A desktop app reaching Navidrome by LAN address and a server
  reaching it by domain would count as two people. A key belongs to exactly
  one account row on the server, so the desktop's own spelling of the URL does
  not matter.
- **Getting past the login in front of the server.** A reverse proxy with
  forward auth redirects an Electron fetch to a login page. Sync gets its own
  prefix, `/play-history-sync/`, which the proxy can let through as it does
  for `/party/`. That prefix then has to be safe on its own, by the same
  standard as `docs/help/guides/party-over-the-internet.md`.
- **No media server login on the server.** The desktop app does not need to
  hand the listener's password to a second machine.

Rules for the key:

- Long and random. The server stores a hash and compares in constant time.
- One per device, with a label and a last-used time, listed in Settings on the
  server and revocable there.
- On the desktop it lives in connect's data directory the way `core/api_keys.py`
  keeps installation keys, and is never handed back to the renderer.
- The URL must be https, except for a private address.

## Routes (server)

Authenticated by the key alone, not by a session or `CONNECT_TOKEN`:

| Route                               | Purpose                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| `POST /play-history-sync/listens`   | a batch of at most 500 rows, fields limited as `Listen` |
| `GET /play-history-sync/summary`    | the same answer as `/play-history/summary`              |
| `PUT /play-history-sync/milestones` | merged upwards, as today                                |

Session-authenticated, for the Settings page on the server:

| Route                                | Purpose      |
| ------------------------------------ | ------------ |
| `GET/POST /play-history/sync-keys`   | list, create |
| `DELETE /play-history/sync-keys/:id` | revoke       |

Failed key checks are rate limited per address.

## Storage (schema version 2)

- `sync_keys` (server): `id`, `account_id`, `key_hash`, `label`, `created_at`,
  `last_used_at`
- `listens.sent_at` (desktop): null until the server has acknowledged the row
- The URL and key on the desktop stay out of this database, next to the other
  installation settings

## Sending

A background task in the desktop's connect. It runs after each recorded play
and on a timer, backs off while the server is unreachable, and sends only
`source = 'beacon'` rows with `sent_at IS NULL`, oldest first. A row is marked
sent only after a 2xx.

The first sync is the same loop over the whole local log.

## What the server has to decide about incoming rows

- **Time.** `record()` stamps plays itself so a wrong client clock cannot damage
  the log. Here the time has to come from outside. It was stamped by the
  desktop's connect, and the server rejects anything more than a day in the
  future.
- **The same play twice.** Different ids on two devices are normally two real
  plays. The server still applies `_SAME_PLAY_SECONDS`, comparing song and time
  against its neighbours in the log, for the case of one play reported through
  both paths.
- **Imports.** An import is kept only where it is older than Beacon's first own
  play. Own plays arriving from a desktop can move that point back, and the
  import would then overlap them. The server applies the same rule again after
  a batch that moves it. This can drop scrobbles made outside Beacon in the
  overlap; that is the price of never counting a play twice.
- The desktop stops offering an import while paired. Its local imported rows
  are not sent.

## Reading

While paired, the desktop's `/play-history/summary` answers from the server and
falls back to the local log when the server is unreachable. Unsent local plays
are added on top of the server's answer, so a song just played counts at once.

Milestones are saved in both places. They only ever merge upwards, which is
what stops a moment from being celebrated twice.

## Steps

1. `sync_keys`, the key routes and their Settings section on the server
2. The `/play-history-sync/` routes, including the checks above
3. Pairing in the desktop's Settings, with a clear state: connected, last sync,
   wrong key, unreachable
4. Sending and the first sync
5. Reading from the server with the fallback
6. Help page for the reverse proxy exception, next to the party guide

## Open questions

- **Admin view.** A key only speaks for its own account, so the desktop's admin
  picker stays as it is in the first version. Letting it list the server's
  accounts needs the admin flag noted when the key is made, and a way for that
  to end when the server stops considering the account an admin.
- **Leaving a server.** Unpairing keeps the local log as it is. Whether the
  desktop should keep a copy of what only the server knows is undecided; so far
  it does not.
- **Deleting.** There is no way to delete a single play today. If one comes, it
  needs tombstones to survive a sync.
