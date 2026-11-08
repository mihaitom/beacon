# Device-link code review (temporary)

Temporary working notes - delete this file once the findings are handled.

- Branch: `feature/device-link`, already merged into `development` (reviewed at
  `00d20d1d`). Scope: pairing a desktop app with a Beacon server, the device
  keys, the `/device-link/v1/` app API, the background sync, the stats/lyrics
  sharing and the settings UI.
- This is the closing pass after the earlier review
  (`3d73a948`/`18dc680b`). Its findings are fixed; the items below are new.
- Verification run locally: `cd connect && uv run pytest` (4498 passed, 68
  deselected), `ruff check .`; `pnpm test:unit` (4110 passed, 320 files),
  `pnpm type-check`, `oxlint` / `eslint` without `--fix`, `pnpm format:check`.
  All green.

Severity is about impact on users, not effort.

## Findings

### 1. `now_playing`'s report table is shared across threads without a lock (medium)

`core/now_playing.py:41` keeps every reported state in the module-level
`_reports` dict. It is written from FastAPI's threadpool and read from both
the threadpool and the event loop:

- writes: `routes/now_playing.py:56,77` (sync `def` handlers) and
  `routes/device_link.py:448` (`asyncio.to_thread(accept, ...)`);
- reads: `routes/device_link.py:305` (`get_now_playing` is sync `def`, so it
  runs in the threadpool too), plus the SSE poll, cover and lyrics handlers
  on the event loop (`:317-324`, `:401`, `:425`).

`store_report()` iterates `_reports.items()` to drop stale entries while
another thread can insert or delete, and `_candidates()` iterates
`_reports.values()` while a report is being stored. Both raise
`RuntimeError: dictionary changed size during iteration` in practice -
reproduced by hammering `store_report()` and `current()` from separate
threads (7 of 12 workers hit it within five seconds).

Effect: an occasional 500 on `/now-playing/report` (dropped until the next
heartbeat) and on `/device-link/v1/now-playing`, and a broken event stream
for an app. Not data corruption, but a real race.

Fix: one `threading.Lock` in `core/now_playing.py` around all `_reports`
access (take a snapshot of the values under the lock before ranking), and
keep `current()` off the threadpool where possible (make
`get_now_playing` `async def`) so it also stops iterating
`registry.all()` from a worker thread while the loop creates sessions.
The same `registry.all()` copy-vs-insert race exists for
`get_now_playing_cover`'s `_session_of()` but is pre-existing there.

### 2. Two 429s carry no `Retry-After`, contrary to the API text (low)

`apps-and-api.md` says "After too many requests, `Retry-After` says how many
seconds to wait", and the copy-for-an-assistant text repeats "A 429 says how
long to wait in `Retry-After`"
(`src/renderer/src/services/connect/appKeyInstructions.ts:46`).

Only the per-key request limit sets it
(`routes/device_link.py:119`). The failed-key limit (`:102-103`) and the
"too many open streams" answer (`:373-374`) return a bare 429. A screen
that starts a fourth stream therefore cannot tell how long to back off.
Either add the header in both places or soften the docs/wording.

### 3. A successful charts read does not clear an old "unreachable" state (low)

`server_link.charts_for()` (`core/server_link.py:391-402`) notes a failure
state but, unlike `pull_settings()`, `summary_for()` and
`pull_lyrics_offsets()`, never calls `_note_answered()` on success. If the
last failed pass left `unreachable`, a successful window-chart load leaves
Settings showing it until the next summary pull or background pass (up to
the backoff ceiling). In the normal Stats flow the summary load happens
first and hides this, so it is mostly theoretical - but the one-line
asymmetry is easy to close.

### 4. The now-playing reporter is not reset on an account change (low)

`services/playback/nowPlayingReport.ts` keeps `last`, `unwantedIdentity`
and `newestReport` at module level. `resetNowPlayingReport()` exists but is
only used by tests (`:124`); `initAccountScopedStores()` does not call it on
an account change.

Two consequences on a shared desktop when the user changes account while the
same song plays:

- `last` still matches, so no report goes out for the new account until the
  30-second heartbeat;
- if the previous account's apps said "nobody wants this"
  (`unwantedIdentity`), the same song is suppressed for the new account's
  apps until the song changes.

Nothing is misattributed (the server's `post_report`/relay already files by
session account), it is only late/silent. Reset the module state from
`onAccountChange()`, or key the three values by account.

### 5. The v1 contract test covers paths and model fields only (low)

`test_v1_only_ever_grows` (`connect/tests/test_device_link.py:2498`) and
`_shape()` (`:2439`) compare the route paths and the response-model
properties of `device_link_v1_contract.json`. Query parameters, response
codes and security are not compared, so removing `cursor`/`since`/`until`/
`limit` from `/history`, dropping the documented 410, or changing the
`openapi.json`/CORS promises would still pass the "v1 may only grow" guard.
Cheaply extended by also recording the operation's parameters and response
keys in `_shape()`.

### 6. Stale comment in `core/trusted_proxies.py` (low)

The module docstring (`:7`) still says "Only party mode acts on a client's
address today". `routes/device_link.py:100` now uses `client_ip()` for the
per-address key-failure limit as well. Reword the sentence.

### 7. Plain http to a Tailscale / CGNAT address is refused (consideration)

`clean_url()` rejects `http://` unless `_is_private_host()` is true
(`core/server_link.py:154-161,185`), and `_is_private_host` uses
`ip_address(...).is_private`. Python does not count `100.64.0.0/10`
(and so Tailscale's usual `100.x` peer addresses) as private
(`100.100.100.100.is_private` is `False`). A household that reaches its
Beacon server over Tailscale with an `http://100.x` URL gets
`insecure_url`, although that hop is already encrypted by WireGuard.

If Tailscale/ZeroTier is meant to work, accept `is_global is False` (or the
CGNAT range explicitly) as "own network"; if the strict RFC 1918 reading is
deliberate, ignore this.

### 8. Pairing without a settings identity silently syncs no settings (low)

`server_link.pair()` only pulls/pushes settings when the session has a
matching `settings_identity` (`core/server_link.py:290-301`); otherwise the
pairing succeeds but shares no settings. This is the documented Plex/name
mismatch fallback ("Without it the key shares no settings"), but neither
`docs/help/guides/desktop-and-server.md` nor the Settings text mentions
that a successful pairing can still skip settings. A sentence in the guide
(or a state in `status()`) would save a "why are my settings not syncing"
round.

## Checked and found sound

- Key handling: only the hash is stored, constant-time compare, `list`/
  `status` never return the secret, `server_link.json` and the lent API-key
  files are `0600`; a key of another account is refused before anything is
  written (case-insensitive name, tested).
- `scopes` validation and the private/app split: `sync` cannot be combined
  with a read scope, `api_keys`/`lyrics` need their partner, a desktop key
  is refused by `v1`, an app key cannot reach `/settings`, `/listens`,
  `/api-keys` or `/milestones`.
- Middleware order at runtime: party security -> public v1 CORS -> error
  boundary -> `CORSMiddleware`, so a `v1` 500 still reaches a page with
  `Access-Control-Allow-Origin: *`; preflight is answered before the key
  check, non-v1 routes keep their allow list.
- Request/body limits (4 MB listens, 64 KB settings, 500 rows, 500 offsets,
  16 KB report) match nginx's `client_max_body_size 4m` and the desktop's
  batching.
- History: fixed field list, arrival-order `rowid` cursor with
  `history_epoch` 410 handling, no media-server credentials in any `v1`
  response; the duplicate-play lookup uses a range the `(account_id, ts)`
  index can serve.
- Sync semantics: only the paired account's `source = 'beacon'` rows go up,
  a row is marked sent only after 2xx, pending settings/offsets/milestones
  survive a failed send and are not overwritten while in flight, `backfill`
  is cleared only after a fully successful pass, the lent API keys are
  cleared on unpair/refused key, a key entered locally still wins.
- Account scoping: self-made themes moved to `accountScopedKey()` with a
  one-time migration; account switching reloads the theme list, drops the
  pending push timer and must not leak the previous account's list into an
  account with none.
- nginx: `/device-link/` has its own location, clears the injected token,
  `proxy_buffering off` + HTTP/1.1 for the event stream; keepalive (15 s)
  stays well inside the 300 s read timeout.
- All new i18n keys exist in en/de/es/fr/it; the FAQ order is unique.
- Accepted on purpose (from the plan/decisions, not findings): unpairing is
  not limited to the link's account; `GET /server-link` exposes the paired
  URL/username to another account on a shared desktop; pairing compares only
  the verified username; private routes have no per-key request limit
  (a catching-up desktop is not somebody's loop); no BFF/`llms.txt`/MCP.
