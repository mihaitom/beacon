# Device-link code review (temporary)

Temporary working notes - delete this file once the findings are handled.

- Branch: `feature/device-link`, reviewed against `development` (14 commits,
  69 files, `development...HEAD`).
- Scope: the pairing between a desktop app and a Beacon server, the device
  keys, and the public `/device-link/v1/` API.
- Verification run locally: `cd connect && uv run pytest` (4446 passed),
  `ruff check .`, `pnpm type-check`, `pnpm test:unit` (4080 passed),
  `oxlint` / `eslint` without `--fix`, `pnpm format:check`. All green.

Severity is about impact on users, not effort.

## Findings

### 1. Custom themes bleed between accounts (medium)

The self-made themes now follow the account (they are part of
`LINKED_FIELDS`), but they are still stored in the device-wide
`localStorage` key `beacon.theme` (`src/renderer/src/stores/appearance.ts:23`,
written in `persist()` at `:230`). Every other account-following setting is
stored under `accountScopedKey()` (e.g. `stores/transitions.ts:2,71`).

On a shared browser/desktop, signing in as account B after A leaves A's
list in the store. If B's account settings have no `customThemes` yet,
`pullAccountSettings()` calls `shareCustomThemes()`
(`services/accountScopedStores.ts:115-119`), which uploads the current list
- A's themes - into B's account settings (`stores/appearance.ts:219-222`).
B then sees A's themes, and they propagate to B's other devices.

Which theme is *on* being device-wide is intentional and fine. The list is
account data and should be scoped separately (e.g. the list under
`accountScopedKey`, with the active theme id left in `beacon.theme`), or at
minimum the local list should remember which account it belongs to and not be
shared into an account that has none.

### 2. A malformed server address escapes as a 500 instead of a state (medium)

`clean_url()` (`connect/core/server_link.py:125-138`) does not validate the
port or the host beyond `urlsplit(...).hostname`. `_call()`
(`:149-157`) catches `httpx.HTTPError` only, but `httpx.InvalidURL` derives
from `Exception`, not from `HTTPError`.

Confirmed by running the real code:

```text
clean_url("https://host:abc")  -> "https://host:abc"        (accepted)
_call(...)                     -> httpx.InvalidURL           (not caught)
```

So `PUT /server-link` answers 500 instead of `{"error": "invalid_url"}`.
`https://host/#fragment` is also accepted and then fails as
`server_too_old`/`unreachable`, because the fragment silently drops the
`/device-link` path segment.

Fix: touch `parts.port` in `clean_url` (catching `ValueError`), reject a
fragment, and catch `httpx.InvalidURL` in `_call` as `INVALID_URL`
(alternatively `UNREACHABLE`).

### 3. Pairing does not check whose key it is (question, medium if unintended)

`pair()` reads `/info`, which returns `username`, but only stores it for
display as `remote_username` (`core/server_link.py:226-232,252`). Nothing
compares it with the desktop's signed-in account. Pairing account A's
desktop with a key made for account B therefore succeeds and then

- sends A's local plays into B's server history,
- shows B's summary/settings on A's device,
- applies A's local-only settings to B's account.

The test fixture even accepts a differing name (local `alice`, server
`alice-remote`), so the current tests treat this as allowed.

If this is intentional (a key defines the account, whatever the desktop is
signed in as), the guide should say so. If not, compare the names
case-insensitively before writing the link and return `other_account`
(or a new state). A strict comparison may be too strict for Plex, so this
needs a decision rather than a blind fix.

### 4. The server's settings are only applied at the next login (low/medium)

`pair()` fetches the server's settings only to compute which local-only
fields to send (`core/server_link.py:233-243`); the remote values are
discarded. The renderer's `pullAccountSettings()` runs on account change
only, so after connecting, the desktop keeps its old settings until it is
restarted (or the account is changed).

The guide says the opposite: "The first time, plays already on the computer
are sent over, and the server's settings replace the desktop app's wherever
the server has one" (`docs/help/guides/desktop-and-server.md:42-44`).
Either trigger a settings pull after a successful pair (the route could
`account_settings.save` the remote values, as `/account-settings` already
does), or soften the guide.

### 5. The duplicate-play lookup defeats the only index it has (low/medium)

`_is_same_play()` (`connect/core/play_history.py:415-434`) uses
`ABS(ts - ?) < ?`. Confirmed with `EXPLAIN QUERY PLAN`:

```text
... AND ABS(ts - ?) < ?   -> SEARCH listens USING INDEX listens_by_account (account_id=?)
... AND ts BETWEEN ? AND ? -> SEARCH listens USING INDEX listens_by_account (account_id=? AND ts>? AND ts<?)
```

So a 500-row batch runs 500 full scans of the account's history, all while
holding the global `_lock` that also serialises local play recording and
history reads. For a long-lived account this is quadratic work under a
global lock. Rewriting the condition as `ts > ? AND ts < ?` (plus an index
on `(account_id, song_id, ts)` if the planner still prefers it) keeps the
cost proportional to the window.

### 6. Successful pulls do not clear an old "unreachable" state (low)

`pull_settings()`, `summary_for()` and `pull_lyrics_offsets()`
(`core/server_link.py:292-305,318-329,342-355`) call `_note(e.state)` on
failure but never `_note(CONNECTED)` on success. Opening Settings after the
server comes back still shows "unreachable" until the next background pass
(up to the backoff ceiling). Add `_note(CONNECTED)` after the successful
call.

### 7. Whitespace-only key label is stored empty (low)

`NewKey.label` uses `min_length=1`, then the route stores
`new_key.label.strip()` (`connect/routes/device_link.py:531-536`). `"   "`
passes validation and becomes an empty label in the list. Use
`StringConstraints(strip_whitespace=True, min_length=1)` or reject after
stripping.

### 8. The 3-stream limit can be raced past (low)

`get_now_playing_events()` checks `_open_streams[...] >= 3` at
`:363`, while the counter is incremented inside the generator at `:318`.
Between the route's check and the first `__anext__`, concurrent opens all
see the old count. It also means the limit is only approximate; keep the
increment atomic with the check (or reserve a slot in the route and give it
back in the generator's `finally`).

### 9. Unpairing does not require the link's account (low)

`DELETE /server-link` (`connect/routes/server_link.py:45-48`) unpairs
whatever installation-wide link exists, without comparing the calling
session's account with the link's account. On a shared desktop, another
signed-in account can disconnect the pairing (and `GET /server-link` exposes
that account's `url`/`remote_username`/`unsent`). If multi-account desktops
are in scope, check `is_linked(_own(session))` or return `other_account`.

### 10. Pending push queues survive an account switch (low)

`services/lyrics/lyricsOffsets.ts` keeps `unsent`/`pushTimer` at module
level (`:17-18`), and `stores/appearance.ts` keeps `pushTimer` at module
level (`:28`). A correction/theme change made just before switching
accounts can be flushed with the *new* account's session (1 s / 800 ms
window), writing it to the wrong account. Reset these queues on account
change (`onAccountChange`) or capture the account key when queueing.

Related: `flush()` clears `unsent` before the request resolves
(`lyricsOffsets.ts:52-58`), so a failed send loses the queued change; the
local storage still holds it and a later `pullLyricsOffsets()` re-uploads
`onlyHere`, but an undo (`0`) is lost and other devices never hear it.

### 11. Corrupt-but-valid `server_link.json` can raise KeyError (low)

`_read()` only checks `isinstance(link, dict)` (`core/server_link.py:86-95`).
A hand-edited file missing `account` (or `key`) reaches `_account_of()` /
`_call()` and raises `KeyError`/`TypeError` from `GET /server-link` (`500`)
and from the sync loop (logged every pass). Validate the required shape in
`_read()` and treat a bad file as "not paired".

### 12. Migration chain carries a step that never applies to a release (low)

Migrations 3 and 4 (`_KEY_RIGHTS_SCHEMA`, `_KEY_SCOPES_SCHEMA`,
`core/play_history.py:97-108,286-292`) exist only for databases created
during this unreleased branch: they add `may_read_api_keys`, then add
`scopes`, copy the flag, and drop the column. Every database from a released
version starts at `user_version = 1` and skips straight to creating
`device_keys`, so these two steps only add work (and a `DROP COLUMN`
requirement, SQLite >= 3.35) for no released data. Folding `scopes` into
`_DEVICE_LINK_SCHEMA` would be cleaner before the first release; dev
databases can be reset.

### 13. Overlapping report ticks (low)

`services/playback/nowPlayingReport.ts:80-103` runs from a 1 s interval and
from a watcher, both async. Two ticks can overlap; a late `wanted: false`
answer from an older song clears `last` after a newer tick has already set
it, causing an extra request on the next tick. Not fatal (the server's
`store_report` is idempotent), but a per-tick guard or a request generation
counter would keep it clean.

## Checked and found sound

- Key handling: only the hash is stored, comparison uses
  `secrets.compare_digest`, `list`/`status` never return the key, `0600` on
  `server_link.json` and the lent API-key files.
- Middleware order was verified at runtime: `party security` -> `public CORS`
  -> `error boundary` -> `CORSMiddleware`, so a 500 from `v1` does reach a
  page with `Access-Control-Allow-Origin: *` (matches the comment and the
  test).
- The 4 MB listen-body limit matches nginx's `client_max_body_size 4m`.
- The migration chain from a released `user_version = 1` database is covered
  by `test_an_existing_log_survives_the_upgrade`.
- `v1` responses contain no media-server credentials; only a fixed field list
  is exposed (`_HISTORY_FIELDS`, `_SONG_FIELDS`).
- No Vuetify utility classes in the new components; scoped styles used.
- All new i18n keys exist in all five locales; help page order is unique
  (`faq/apps-and-api` 9, `reporting` 10).
- Stream revocation/keepalive and per-key request counting work as
  documented; the SSE semantics in the FAQ match the code.
