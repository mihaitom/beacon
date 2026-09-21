# Cast permissions - concept

**Built 2026-09-21.** This is the design record for TODO.md's "Serveradmins
bestimmen, wer auf welche Geraete casten darf", kept so the decisions do not
have to be re-derived from the code later. The code is
`connect/core/cast_permissions.py`, `connect/routes/cast_permissions.py`, the
enforcement points in `/play`, `/play-url`, `/join` and `/claim`, and
`src/renderer/src/components/settings/CastPermissionsSection.vue`.

The goal, as the maintainer put it: an admin shares their Beacon with other
people, but household outsiders should not be able to grab the speakers.
That is a **server-wide policy**, not a per-device matrix: an account that
may not cast can still browse, play locally and use everything else, it
just cannot cast to any device. The policy has three parts, all
server-wide:

- a **mode** - `allowlist` (the listed accounts may cast) or `blocklist`
  (the listed accounts may not);
- a **default for accounts not on the list** (`default_allow`), which is
  also what a brand-new account gets, since a new account is simply one
  that is not on the list yet;
- the **list** itself.

Per-device granularity is deliberately deferred; the storage below is
shaped so it can be added later without a migration.

The feature only makes sense in the Docker/web build. The desktop build
spawns its own connect per start with a fresh token and exactly one user
(see `src/main/index.ts`), so there is nobody to restrict and the settings
surface must not appear there at all.

Written 2026-09-21 against Beacon 1.2.x.

## The honest framing: this is a policy, not a security boundary

Everything below enforces an administrative rule among the people sharing
one deployment. It is not a wall against someone who holds the shared
token, and the plan should not pretend otherwise. Two facts from the code
decide that:

- `require_token` (`core/auth.py`) checks **one instance-wide**
  `CONNECT_TOKEN`, which nginx injects on every same-origin request (see
  `ng.conf.template`). On the HTTP level every user is the same caller.
- The session id is **client-asserted and not a secret**. The renderer
  computes it as a plain FNV-1a hash of
  `normalizedServerUrl::serverType::(userId|username)`
  (`services/connect/session-id.ts`) and sends it as `X-Connect-Session`.
  Anyone who knows a target account's server URL, type and username can
  compute that id and send it. The backend has no other way to tell who is
  asking.

Device claims (`core/claims.py`) already rest on exactly this trust: a
session is whoever it says it is. Cast permissions inherit it. Making this
a real boundary would mean per-account credentials or per-account tokens
instead of the instance-wide one - a separate, much larger change, and one
that would touch every route. Recorded here so nobody reads the rules file
as stronger than it is.

What _is_ verified: `/config` runs `media.ping()` and only sets
`session.authenticated` afterwards (`routes/devices.py`), and the bridges
resolve the real user from the credential, ignoring a passed-in name
(`test_jellyfin_reports_the_accounts_admin_rights` calls `get_user` with
`"whoever"` and still gets the token's user back). That verified identity
is what the rules attach to - not `session.display_name`, which comes from
the request body's `username` field and is pure display text.

## What "who" means

The allow-list holds **verified usernames of the casting session**:

- `server_type` and `server_url` - which media server the session
  authenticated against.
- `username` - resolved from the credential, never from the request body.

`/config` is the only place a session becomes authenticated, so it is the
natural place to resolve this once and keep it on `SessionState`:

- Add a small resolved identity to `SessionState` (for example
  `account_server_type`, `account_server_url`, `account_username`,
  `account_is_admin`), set in `configure()` **after** `media.ping()`
  succeeds.
- Resolve it through a new helper in `media/` that dispatches like
  `routes/proxy.py` does: Jellyfin -> `jellyfin_bridge.get_user`, Plex ->
  `plex_bridge.get_user`, Subsonic -> `media.call("getUser.view", ...)`.
  For Subsonic the client-supplied username has to go in as the query
  parameter (the endpoint needs one, and Navidrome only answers about the
  caller's own account), but only the **returned** username is trusted.
- If the lookup fails, keep the account unverified: it has no rules and is
  therefore unrestricted (see the default below). Do not guess.

Optional side effect worth taking: point `session.display_name` at the
verified username too, so "in use by" shows the real account instead of
whatever the client typed. Same value in the common case, harder to spoof
in the uncommon one.

## Where the account list comes from

The picker offers every account that has ever authenticated against this
server through this Beacon, plus the server's own list where it will
actually answer. There is no free-text entry: an account this Beacon has
never seen cannot be picked.

That is not a gap for the stated goal. The allow-list means "these may
cast, everyone else may not", so the admin lists the household, and every
other account - including one this Beacon has never seen - is blocked once
the list is non-empty.

- **Every server type**: the accounts recorded at `/config` from the
  verified username (`core/cast_permissions.py`'s `known_accounts`, kept in
  the rules file under `known`). This is the one list that works uniformly,
  since no provider Beacon speaks to can be enumerated the same way. It
  persists across restarts and outlives a session being reaped.
- **Jellyfin**: additionally `GET /Users` (RequiresElevation), which
  returns accounts that have never signed in here too. The bridge maps
  `getUsers.view` -> `/Users` (`media/jellyfin_bridge.py`), and
  `GET /cast-permissions` calls it.
- **Subsonic / Navidrome**: the OpenSubsonic spec says an admin's
  `getUsers.view` returns every user, so it is asked. **Navidrome does not
  implement that**: verified in its own source (`server/subsonic/users.go`)
  from v0.50 through master, `GetUsers` returns
  `[]responses.User{buildUserResponse(loggedUser)}` — the calling user
  alone, for admins too. A one-entry answer is therefore indistinguishable
  from a genuine one-account server, and `GET /cast-permissions` treats it
  as "no usable list". A spec-compliant server that answers with more than
  one user gets `lists_users: true` and its real list.
- **Plex**: the media server has no user list of its own - that lives at
  plex.tv (`/api/v2/home/users`, `shared_servers`) and needs the **account
  token**, which `PlexClient` does not hold and `/config` does not receive
  today. Worse for the same reason, `plex_bridge.get_user` does not resolve
  the name at all: it echoes `params["username"]`
  (`media/plex_bridge.py:437`), so there is no verified username to match a
  rule against. Plex sessions stay unrestricted and the settings section is
  not offered for them. Pulling Plex in properly is a separate change to
  the Plex login path (pass the account token, resolve the name through
  plex.tv) and is out of scope here.

A later change could get Navidrome's real list by logging in to its native
API with the account password (which the renderer holds for silent restore)
and reading `/api/user`; that adds a second auth path, sends the password
to connect, and would only help one server type, so it is not done here.

The list is a convenience for the admin UI. The rule still matches the
username resolved from the casting session's own credential, not whatever
the list says.

## The rules store

A new module `core/cast_permissions.py`, one JSON file under
`CONNECT_DATA_DIR` next to `radio_stations.json` and
`account_settings.json`.

**It must not live in `account_settings.json`.** That route
(`routes/account_settings.py`) takes `server_type`, `server_url` and
`username` as query parameters and is gated only by `require_token`, so any
client can read and write **any account's** settings. Authorization data
there would let every user grant themselves permission. The cast-permission
routes must derive the server from the session and verify the writer is an
admin, and the file must be written only server-side.

Shape, per server:

```json
{
  "servers": {
    "jellyfin|media.example": {
      "mode": "allowlist",
      "default_allow": false,
      "accounts": ["alice", "bob"]
    }
  },
  "known": {
    "jellyfin|media.example": ["alice", "bob", "rita"]
  }
}
```

- Outer key: `server_type|normalized_server_url`.
- `servers[key].mode`: `allowlist` (listed may cast) or `blocklist`
  (listed may not). An unknown value falls back to `allowlist`.
- `servers[key].default_allow`: what accounts not on the list get, and so
  what a brand-new account gets.
- `servers[key].accounts`: the list. A nested `devices` key can be added
  later for per-device exceptions without touching the outer shape.
- `known[key]`: every account seen at this Beacon for that server, written
  by `/config` (see "Where the account list comes from"). Observation, not
  configuration — `set_policy` preserves it, and `record_account` leaves an
  unreadable file alone rather than moving it aside, so recording can never
  be the write that loses the rules.
- **No server entry means the server was never configured and everyone may
  cast.** This is the update migration: an existing instance has no file,
  and reading "nothing configured" as "nobody may cast" would silently
  switch casting off for the whole deployment on update. Same reasoning as
  the radio-stations migration item in TODO.md. An **empty list is not the
  same thing**: it is a real configuration (allowlist + empty blocks
  everyone but admins, a lockdown; blocklist + empty blocks nobody). That
  is why the entry is written even when the list is empty, and only its
  absence means "open".
- Admins of that server are always allowed, listed or not. Rationale: an
  admin cannot lock themselves out of the deployment they manage, and there
  is no separate break-glass path otherwise. Decision point - if admins
  should be subject to the policy too, this is the line to change.

URL normalization: the rule key must be the _same_ for `http://host` and
`https://host` (the frontend adopts `resolved_url` after `/config`, but a
second session logging in over the other scheme would otherwise hash to a
different server and miss the rules). Reuse the frontend's rule from
`services/connect/session-id.ts`'s `normalizeServerUrl` (strip scheme and
trailing slash, lowercase the authority, drop a default port) as a small
backend helper. `core/account_settings.py` does not normalize today; that
is a separate inconsistency and not part of this change.

Read/write with the same care `account_settings.py` uses: a
`threading.Lock` around read-modify-write (routes are sync `def`), and
write-to-temp + `os.replace()` so an interrupted write cannot take the
whole file down.

## Enforcement

Backend-side, in the cast routes, not in the frontend - filtering the
picker is cosmetic, and `/play` and `/play-url` are reachable with the same
shared token directly.

The check belongs next to the claim check, where the target has just been
resolved:

- `routes/playback.py`'s `/play`
- `routes/playback.py`'s `/play-url`
- `routes/join.py`'s `/join` (both the dispatch and the paused-reservation
  path)
- `routes/join.py`'s `/claim`

A helper, say `core/cast_permissions.authorize(session)`, answers a single
question - "may this account cast at all on its server" - and refuses the
whole dispatch when it may not. Call it before claiming, so a refused
dispatch never claims a device and then has to release it. Since the policy
is server-wide, no per-target walk is needed; `list_target_pairs()` stays
out of this.

The answer is `is_allowed()`: admins always pass; an unconfigured server
passes everyone; otherwise a listed account gets the mode's answer and an
unlisted one (including an account whose username could not be verified)
gets `default_allow`.

Not in scope for this check:

- `/pause`, `/resume`, `/seek`, `/stop`, `/device-stop` operate on the
  already-resolved target set. A rule change mid-session does not
  retroactively stop playback; it is re-checked on the next dispatch.
- The remote control (phone) drives the desktop session through the same
  session, so it is governed by the desktop account's rules - correct, it
  is the desktop that casts.

Response shape, mirroring `device_in_use` (`core/session.py`) and
`delivery_failed` (`delivery/errors.py`) so the frontend can tell it apart:

```json
{ "error": "cast_forbidden", "account": "guest" }
```

Frontend: add `cast_forbidden` to the error union in
`services/connect/types.ts` and a `connect.error.castForbidden` key in all
five locales, phrased as "this account may not cast to speakers on this
server".

## Display filtering

`/discover` (`routes/discovery.py`) and the remote's `/devices`
(`routes/remote.py`) should hide every cast target from an account that may
not cast at all, so the picker does not offer a choice that will be
refused. One exception:

- A device currently claimed **by this session** stays visible, so a rules
  change cannot hide a device that is still playing for you.

The filter is presentation only; the enforcement above is what actually
matters.

## Admin surface

New routes, admin-only:

- `GET /cast-permissions` - the session's own server's `accounts`, `mode`
  and `default_allow`, plus `suggested_accounts` and `lists_users` for the
  picker (see "Where the account list comes from").
- `PUT /cast-permissions` - replace that server's `accounts`, `mode` and
  `default_allow`.

Both derive the server from the session, never from query parameters, and
both check `session.account_is_admin`. `is_admin` is cached on the session
from `/config`; a media server changing the flag takes effect at the next
login, which is acceptable.

"Admin" is always admin _of one server_. Sessions of different servers can
live on one connect instance, and a Navidrome admin must not govern
Jellyfin users. Rules are therefore scoped per `(server_type, server_url)`,
and the write route refuses when the session's server has no matching
scope.

## Frontend

A Settings section, shown only when all of these hold:

- there is no `window.api` (Docker/web build - same test
  `composables/useIsMobileWeb.ts` uses),
- the session's server type is Subsonic or Jellyfin (Plex has no user list
  to populate it, see above), and
- `authStore.isAdmin === true` (already resolved through
  `/rest/getUser.view`, see `stores/auth.ts`'s `resolveAdminRole()`).

Follow the capability pattern rather than one-off checks: add a
`castPermissions` capability to `services/capabilities.ts`, and let the
component's own web-build check handle the `window.api` half. Unlike the
other admin-gated capabilities, this one requires a _definite_ admin:
`isAdmin === null` leaves it off, because the save route 403s for a session
whose admin flag was never resolved and a section that cannot work should
not be offered.

The section shows one "Who may cast?" select with the four states the
(mode, default_allow) pair can be in — everyone / only the listed accounts /
everyone except the listed accounts / nobody except administrators — plus a
multi-select of account chips offered from `GET /cast-permissions`'s
`suggested_accounts` (see "Where the account list comes from"; there is no
typing). The list is hidden for "everyone"/"nobody", where it has no
effect. A line under the select spells out the resulting rule, since not
every choice is obvious at a glance, and `lists_users: false` adds a note
that only accounts that have signed in here are listed. Saving does a
`PUT /cast-permissions` with the pair behind the chosen state.

i18n: new keys in all five locales.

## Testing

- `core/cast_permissions.py`: unconfigured means open; allowlist blocks
  unlisted and lets listed through; blocklist the reverse; an empty
  allowlist locks down; an unverified username lands on the default; admin
  bypass; normalization collapsing http/https; atomic write; and the
  "unreadable file must not be overwritten" path that
  `account_settings.py` already covers.
- Enforcement: one test per route (`/play`, `/play-url`, `/join`,
  `/claim`) that a forbidden account is refused and **not** claimed, and
  that a listed account passes.
- Admin route: a non-admin session is refused; a session of a different
  server cannot edit another server's rules.
- `jellyfin_bridge.getUsers.view` maps `/Users` and a non-admin gets the
  server's own refusal through.
- Frontend: the section is hidden without `window.api`, for Plex and for
  `isAdmin === false`; each of the four choices maps to the right
  (mode, default_allow) pair on load and on save; a save sends the expected
  payload. Per `CLAUDE.md`, do not pin down copy or element counts.

## Not in scope

- A real security boundary (per-account credentials/tokens). This is a
  policy among cooperative users, as stated at the top.
- Per-device allow-lists (the matrix). The `accounts` key leaves room for a
  nested `devices` map later.
- Plex support; it needs the account token in the login path first.
- Per-user volume limits or scheduling.
