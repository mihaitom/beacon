# Plan: speakers shared between a desktop app and its server

Status: planned (2026-11-14), not built.

## Why

Every connect keeps its own record of which session holds which speaker
(`core/claims.py`). That is what shows "in use by" in the device list, what
answers `device_in_use`, and what the takeover dialog is built on. It only
knows its own sessions.

A desktop app and a Beacon server in the same house see the same speakers,
but not each other's claims. While the server casts to a speaker, the desktop
lists it as free and plays to it without asking; what the server's session
then does is unknown (see "Measure first"). The other way round the same.
The rule just settled for apps, "an app never takes a speaker over"
(`player_desktop._refuse_held_speakers()`, `player_server._move()`), also
stops at the edge of one connect.

A desktop paired with a server (`core/server_link.py`) already has a channel
to it and a key that says whose it is. The claims can travel over it.

## Measure first

Before building, per speaker type (Sonos, AirPlay, Chromecast, DLNA): the
server casts to a speaker, then the desktop plays to the same one. Record:

- Does the server's session notice (transport event, stream connection
  dropped, nothing at all), and how long does it take?
- Does it try to recover, e.g. reconnect and take the speaker back?
- The same the other way round.

The result decides how much the "taken" message below has to carry: a
safety net for something the speakers already report, or the only way the
losing side learns of it. Results go into `docs/investigations/casting/`.

## Decision

### Who talks to whom

Only the desktop opens connections, as everywhere in the link: a server
cannot reach a desktop behind NAT or on another network. The server is the
hub. Two desktops paired with the same server see each other's claims
through it.

Only a key with the `sync` scope (a paired desktop app) takes part. App keys
do not report claims, and see the merged result through `/player/devices`'s
`in_use_by` as before.

### What travels

A claim is `(type, name, holder)`: the speaker, and who to show as holding
it ("alice" on the server, "alice on desktop-a" from a desktop, the label
built from the account and the desktop's host name).

Speakers are matched by type and name. Two homes can both have a speaker
called "Living room", so a desktop away from home could see a claim for a
speaker that only has the same name. Where the scan already carries a stable
id (Sonos UID, Chromecast UUID, DLNA UDN, AirPlay identifier), match on that
instead and send it along; check what `_scan_devices()` keeps today before
building. A desktop only applies remote claims to speakers it found itself.

### Desktop to server

- `PUT /device-link/claims` (sync key): the desktop's full current set,
  idempotent. Sent on every change of the local registry (a change hook on
  `ClaimRegistry`) and every 30 s while the desktop holds any claim.
- The server keeps them per key, in memory, and drops a set after 90 s
  without a refresh, so a laptop closed mid-cast does not hold a speaker
  forever.
- Unpairing or revoking the key drops its set at once.

### Server to desktop

- `GET /device-link/claims/events` (sync key, server-sent events): the
  server's own claims plus every other desktop's, never the asking one's
  own. A full set on connect and on every change, keepalive as
  `/player/events` does.
- Open while the desktop is paired and connected, reconnecting with the
  link's backoff. While the server cannot be reached, the desktop works on
  its local claims alone, as today, and remote claims it had expire after
  the same 90 s.

### Using them

`ClaimRegistry` learns a second kind of holder: a remote one, which has a
label but no local session. `owner_of()` and the conflict checks in
`claim()`/`claim_many()` see both, so every path that answers
`device_in_use` today (the cast routes, the device list's `in_use_by`, the
v1 player, the phone remote's device list) covers the other instance without
changes of its own.

### Taking over

A takeover (`force=True`, after the dialog) of a speaker a remote holder has:

1. The local side claims it and plays, as for a local takeover.
2. It tells the other side the speaker is gone: desktop to server
   `POST /device-link/claims/taken {type, name}`; server to desktop a
   `taken` event on the claims stream.
3. The losing side calls `displace_target()` on its own session that holds
   it, exactly as for a local takeover. The listener there gets the usual
   "taken over" message.

Each side only ever stops its own sessions. The message carries one fact,
"this speaker is no longer yours", the same one the speaker itself may
already report. It is not a way to steer the desktop from the server in
general (which stays out, see `plans/device-link.md`).

Cast permissions apply on the server's side: a desktop key whose account
may not cast on the server cannot displace a server session either
(`cast_permissions.authorize()` for the key's account). Otherwise a blocked
account could empty the speakers through a desktop.

## Decided (2026-11-14)

- **The desktop is told to stop**, but only for the one speaker somebody took
  over (point 3 above). Nothing else on the desktop is steered from the
  server.
- **Holders are shown by name** on the desktop too, as on the server.
- **Apps still never take a speaker over.** No `force` field on v1: with
  claims shared, the 409 `device_in_use` simply covers the other instance's
  casts as well. Only a person, through the takeover dialog, takes over.

## Tests

- `ClaimRegistry` with remote holders: conflict, expiry, a remote set
  replaced as a whole, the local holder winning nothing it did not claim.
- The routes: a sync key only, an app key refused; a set dropped on revoke
  and unpair; the events stream never sends a desktop its own claims.
- Takeover in both directions, with `displace_target()` called on the
  holding session only; refused for an account that may not cast.
- The desktop's client: pushes on change and on the heartbeat, falls back to
  local-only while the server is away.

## How to check it

With a desktop paired to a server and a speaker of each type:

- Cast from the server; the desktop's device list shows the speaker in use by
  the server's account within a few seconds, and playing to it asks first.
- Take it over from the desktop; the server's browser shows the loss, its
  session does not take the speaker back.
- The same the other way round, and with two desktops on one server.
- Close the laptop mid-cast; the server shows the speaker free within about
  90 s.
- A desktop on another network with a speaker of the same name: no claim
  shows up for it.
