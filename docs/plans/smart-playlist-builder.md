# Plan: a smart playlist builder for Navidrome

Status: implemented 2026-10-11, steps 1-5. Checked in a real browser with
a made-up library, but not yet against a real Navidrome (the test account
in `connect/.env` is rejected) - the login, create and update round trip is
still unseen.

Beacon already recognises smart playlists (Navidrome's and Plex's): they are
labelled, and their song lists are read-only. This plan is the second step:
creating a Navidrome smart playlist and editing its rules from inside Beacon,
instead of writing an `.nsp` file or opening Feishin.

Decided up front:

- **Navidrome only.** Plex builds smart playlists from filter URIs, a
  different model altogether; Jellyfin has none.
- **The password goes to connect once per session** to log into Navidrome's
  own API. connect keeps only the resulting token, in memory.
- **About 15 common fields in the first version.** Every rule Beacon does not
  understand is shown read-only and saved back untouched.
- **`isMissing`/`isPresent` are in**, for the fields Navidrome allows them on.
- **One level of groups** under the top-level all/any, no deeper. A deeper
  tree from an `.nsp` file is kept as an opaque rule.
- **The UI is the point of this feature**, not a form bolted onto an API: an
  editor page of its own with a live preview, not a dialog of dropdowns.

## What Navidrome offers

Read from Navidrome's source (`model/criteria/`, `core/playlists/`,
`server/nativeapi/`), not its docs, which say nothing about the API:

- The rules live only in Navidrome's own REST API, `/api/playlist`
  (`GET`/`POST`, `GET`/`PUT /api/playlist/{id}`), as a `rules` field on the
  playlist. Subsonic's `createPlaylist`/`updatePlaylist` cannot set them.
- That API takes a JWT in `X-ND-Authorization: Bearer ...`, issued by
  `POST /auth/login` with username and **password**. The Subsonic token Beacon
  holds is not accepted. Every response carries a refreshed token in the same
  header.
- Only `name`, `comment`, `public` and `rules` can be set through the API. A
  `PUT` changes only the fields it sends.
- Changing the rules of a playlist imported from an `.nsp` file clears its
  import hash, so **the next library scan re-imports the file and overwrites
  the edit**. The API reports such a playlist with a non-empty `path`.

The rules format (`criteria.go`, `json.go`):

```json
{
  "all": [
    { "is": { "loved": true } },
    { "any": [{ "contains": { "genre": "jazz" } }, { "gt": { "year": 1990 } }] },
    { "inTheLast": { "lastplayed": 30 } }
  ],
  "sort": "-playcount,title",
  "order": "desc",
  "limit": 100,
  "limitPercent": 10,
  "refreshDelay": "1d"
}
```

- Exactly one of `all`/`any` at the top level; groups nest freely.
- A rule is `{operator: {field: value}}` with exactly one field. Keys are
  matched case-insensitively.
- Operators: `is`, `isNot`, `gt`, `lt`, `contains`, `notContains`,
  `startsWith`, `endsWith`, `inTheRange` (value `[from, to]`), `before`,
  `after`, `inTheLast`/`notInTheLast` (days), `inPlaylist`/`notInPlaylist`
  (value `{"id": ...}`), `isMissing`/`isPresent`.
- About 70 fixed fields (`fields.go`), plus every tag and artist role the
  server maps. That is where `artist`, `albumartist` and `genre` come from.
- `sort` is a comma list, each entry optionally `+`/`-`. `random` is a
  pseudo-field.
- `limit` wins over `limitPercent`. `refreshDelay` is a duration string.
- There is no dry run: the matching songs exist only once the playlist is
  saved and read back.

## The first version's fields

| Field                                    | Kind     | Operators offered                                      |
| ---------------------------------------- | -------- | ------------------------------------------------------ |
| title, artist, albumartist, album, genre | text     | contains, notContains, is, isNot, startsWith, endsWith |
| year, rating, playcount, bpm, duration   | number   | is, isNot, gt, lt, inTheRange                          |
| dateadded, lastplayed                    | date     | inTheLast, notInTheLast, before, after                 |
| loved, compilation                       | yes/no   | is                                                     |
| filetype                                 | text     | is, isNot                                              |
| (playlist)                               | playlist | inPlaylist, notInPlaylist                              |

`isMissing`/`isPresent` ("has no value"/"has a value") are offered only on
artist, albumartist, genre (tags and roles) and album, bpm (nullable
columns). On any other field Navidrome answers them with an error
(`persistence/criteria_sql.go`, `missingExpr`), so the field list has to
know which is which rather than offering them everywhere.

Sorting: any of these fields, or random, ascending or descending. A sort
Beacon cannot express (several fields, say) is kept as it is and shown
as-is. Limit: a number of songs, or none. Refresh: never set by Beacon
unless the user picks it; an existing value is kept.

## Connect

- **`POST /navidrome/session`** `{password}` logs into
  `{internal_url}/auth/login` with the session's verified account name, and
  keeps the token on `SessionState`. The password itself is not stored.
  Refused for a session that is not a Navidrome one.
- **`/navidrome/api/playlist`** and **`/navidrome/api/playlist/{id}`**
  (`GET`, `POST`, `PUT` only) forward to Navidrome with the token, keep the
  refreshed token from each response, and answer a `403` with the detail
  `navidrome_login_required` when the frontend has to log in (again). Not
  a 401: the frontend reads any 401 from connect as its own session having
  lapsed and signs the user out of Beacon. Navidrome's own refusals come
  back as a `detail` too, since a bare 403 makes the frontend back off all
  polling (`pollGate.ts`). The token reaches nothing else of Navidrome's
  API, least of all user administration. (Other paths under the prefix fall
  through to `routes/proxy.py`'s older catch-all to the same API, which
  never attaches it.)
- Whether the server is Navidrome is not tracked anywhere yet. OpenSubsonic
  servers say so in every response (`type: "navidrome"`), so the `ping` at
  `/config` can record it on the session, and the frontend gets it as a
  capability.
- Tests: the login (right body, password not kept, failure), the token
  reaching nothing but the playlist endpoints, token refresh, an expired
  token, a non-Navidrome session.

## Frontend

### The rules model

- **`services/navidrome/smartRules.ts`**: Navidrome JSON in, an editable
  tree out, and back. A rule Beacon does not know (field, operator, value
  shape, or a group nested deeper than one level) becomes an opaque node
  holding the original JSON. Every top-level key it does not use is kept.
  This is the part where a bug destroys someone's playlist, so it gets
  round-trip tests: unknown rules, mixed-case keys, nested groups,
  `limitPercent`, multi-field sorts, `refreshDelay`.
- **`services/navidrome/preview.ts`**: evaluates the same tree against the
  catalogue Beacon already holds in memory (`libraryStore.allSongs`), for the
  live preview below. It is an estimate and says so; Navidrome's result
  after saving is the real one. Every rule answers yes, no or "cannot
  tell", and songs nobody can place are counted apart rather than guessed.
  "Cannot tell" comes from opaque rules, from a playlist whose songs are
  not loaded, and from the album artist and compilation flag, which `Song`
  deliberately does not carry (the artist arrays and full genre lists were
  kept off it for memory; see `RawSongDetail` in `subsonic/types.ts`). The
  genre is a song's first one, the artist is read from its credit string.
- **`services/navidrome/client.ts`**: the connect calls above. "Login
  required" re-sends the stored password once without asking. With no stored
  password (a login taken over from Remote, say), the editor asks for it.

### The editor

Its own page, not a dialog: `/playlists/smart/new` and
`/playlists/:id/rules`. Building a playlist means trying a rule, seeing
what it does and adjusting it, and that needs room for the rules and their
result side by side. A dialog has room for one of the two.

```
+--------------------------------------------------------------------------+
|  [backdrop: blurred cover of the preview's top album, crossfading]       |
|  SMART PLAYLIST                                                          |
|  Late-night jazz_                  (the name, in the serif, editable)    |
|  142 songs . 9 hr 12 min . from your library                             |
+------------------------------------------+-------------------------------+
|  Songs matching [all v] of these         |  PREVIEW                      |
|                                          |  [cover][cover][cover][cover] |
|  (genre)  Genre   contains   Jazz    x   |  Kind of Blue - Miles Davis   |
|  (heart)  Loved   is         [heart] x   |  Blue in Green - ...          |
|  (clock)  Last played  not in the last   |  ...                          |
|                        [30] [days v] x   |  and 130 more                 |
|  +-- any of ---------------------------+ |                               |
|  |  (cal) Year  between [1955]-[1965] x| |                               |
|  |  (star) Rating  at least [****]    x| |                               |
|  +-------------------------------------+ |                               |
|  [+ Condition]  [+ Group]                |                               |
|                                          |                               |
|  ORDER & SIZE                            |                               |
|  Sorted by [Last played v] [newest v]    |                               |
|  At most [100] songs  .  Refresh [daily v]                               |
+------------------------------------------+-------------------------------+
|                                   [Cancel]  [Save smart playlist]        |
+--------------------------------------------------------------------------+
```

What makes it more than a form:

- **Rules read as a sentence.** Operators are worded per kind of field,
  not as `gt`/`lt`: "at least", "before", "in the last 30 days", "has no
  value". The field picker is a menu grouped by what the field is about
  (the song, listening, the file) with an icon per field, not a bare
  autocomplete.
- **Every value gets the control its kind deserves.** Stars for a rating,
  the heart for loved, two year fields with a dash for a range, a number
  plus days/weeks/months/years for "in the last" (saved as days), a
  playlist picker with covers for "in playlist". Text values suggest what
  the library actually holds, with a song count each ("Jazz . 412"),
  while still taking anything typed.
- **The preview answers while the rules are being written**, debounced:
  the count and length in the header, a cover mosaic of the albums it
  draws from, the first songs. The backdrop follows the preview's top
  album with the usual 0.6s crossfade, so changing a rule visibly changes
  the page. An empty result says which rule emptied it.
- **Starting points instead of a blank page.** A new smart playlist opens
  with a few presets as chips: recently added, never played, not heard in
  a long while, favourites, a decade, songs without a genre. One click
  fills the rules, which are then edited like any others.
- **Groups look like groups.** A group is an inset panel with its own
  all/any switch and an amber hairline down its left edge, not an
  indentation level.
- **An opaque rule is visible, not hidden**: a row with a lock, its JSON in
  readable form, "kept as it is", deletable but not editable.
- **Desktop only.** Decided after the first draft: a page this dense does
  not fit a phone, so the phone shell has no way in. A narrow desktop
  window stacks the preview under the rules instead.
- Motion: rows enter and leave with the queue's 0.3s/0.2s, everything else
  0.15s; reduced motion turns both off.

Everything is built from the existing parts where they exist
(`DetailHeader`'s backdrop, `.beacon-panel`, `.panel-title`, Vuetify's
`v-menu`, `v-autocomplete`, `v-btn-toggle`, `v-rating`), so the page looks
like Beacon rather than like a plugin. Read `docs/styleguide.md` before
building any of it, and add the editor's own decisions to it afterwards.

### Entry points

- "Smart playlist" beside "New" on the desktop playlists page.
- "Edit rules" on your own smart playlist's page. For a playlist from an
  `.nsp` file the page says the file will win at the next library scan and
  shows the rules read-only.
- i18n for every field, operator and preset, in all five locales.

### Tests

The rules model and the preview evaluator thoroughly (they compute); the
page on behaviour: adding and removing a rule, the value control following
the operator, an opaque rule surviving a save, a preset filling the rules,
the password prompt. Layout only where jsdom cannot answer (the preview
beside the rules or under them, in a browser test).

## Order

1. Connect: session login and the forwarding route, with tests.
2. `smartRules.ts` with its round-trip tests, and `preview.ts`.
3. Client and capability.
4. The editor page and its entry points, checked in a real browser at a
   wide and a narrow width.
5. Changelog, the style guide, and `docs/` for the password going to
   connect.

## Open questions

- Whether presets should also be offered on an existing playlist ("add
  'never played' to this").
