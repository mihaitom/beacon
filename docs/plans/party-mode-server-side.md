# Plan: party mode that survives a locked phone

Status: steps 1 to 3 done (2026-10-07), the rest planned.

## Why

A party lives in the browser tab that started it (`docs/party-mode.md`,
"Things to know"). Every guest wish, search and album lookup is relayed to
that tab, which answers it out of its own playback store, and the tab's
keepalive is what keeps the party alive: connect ends it after 90 seconds
without one (`core/party.py`'s `reap_stale_party`, `KEEPALIVE_TIMEOUT`).

On a desktop that is fine, a background tab keeps running. A phone does not:
iOS Safari suspends a page shortly after the screen locks, Android Chrome
throttles and then freezes background tabs. Hosting from a phone - the
obvious thing to do at a party, with the music cast to the speakers - ends
the party about a minute and a half after the phone is put away, and wishes
fail from the moment it locks.

While casting, connect already owns what matters: the queue
(`session.state.queue`, song ids), advancing it at the end of a track
without any tab (`routes/stream.py`'s `_advance_or_end`), and telling every
client about it (`build_status_dict`, adopted by the app in
`stores/playback.ts`'s `reconcileFromStatus`). The party can sit on top of
that instead of on top of the tab.

## Decision

Two paths, chosen per party by what is playing:

- **Casting: connect hosts.** Wishes, withdrawals, search, album lookup,
  skip votes, the guest snapshot and the party's liveness are all answered
  by connect from the cast session. The host's tab can sleep, be closed, or
  be a phone in a pocket.
- **Local playback: the tab hosts**, as today. The music comes out of that
  device, so it has to stay awake anyway.

Guests see no difference between the two. The host sees which one is in
effect in the party dialog (see "Host UI" below).

## What moves to connect, for the casting path

| Today (tab)                                                     | Casting path (connect)                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keepalive from the tab every few seconds, 90 s timeout          | The party lives as long as the host's cast session does (`registry.get(host_session_id)` exists and is casting); the tab keepalive no longer matters   |
| Guest snapshot built from the tab's `/remote/state` pushes      | Built from the cast session: `build_status_dict()` plus song metadata (see "Song metadata")                                                            |
| `party-wish`: `stores/party.ts` `wish()` + `wishInsertIndex()`  | `core/party.py`: the same rules (limit, duplicate, radio) and the same turn-taking, inserted into `st.queue` under `session.play_lock`, then broadcast |
| `party-withdraw`                                                | Removed from `st.queue` server-side, same checks (own wish, not yet playing)                                                                           |
| `songs-request` / `albums-request` / `album-request` to the tab | connect asks the media server itself through `session.media` (`search3`, `getAlbum`; the Jellyfin and Plex bridges answer these already)               |
| Skip vote reaching the threshold sends `next` to the tab        | connect advances the cast itself, the same way the end of a track does                                                                                 |
| Lyrics pushed by the tab (its match and offset)                 | The tab's pushed lyrics while it is awake; otherwise connect's own `/lyrics/auto` match for the song, no offset                                        |
| Artist background from the tab's Fanart.tv pick                 | connect's Fanart.tv lookup and cache (`routes/fanart.py`) for the playing artist                                                                       |

Unchanged on both paths: everything guest-facing in `routes/party.py`
(URLs, cookies, CSP, rate limits, `TRUSTED_PROXIES`), the guest page itself.

## The parts that need care

### Who owns the requests

Today the tab holds the list of wishes, each pointing at its queue entry by
object identity (`stores/party.ts`, `PartyRequest.song`). On the casting
path connect holds it, with each request tied to a queue position it keeps
current through its own inserts and removals.

The tab can still edit the queue while awake - the host reorders, removes a
wish, adds songs - and sends the whole queue with `/queue`. Positions then
have to be carried over. Rather than diffing song ids (ambiguous for a song
queued twice), `/queue` gains an optional parallel list of request ids per
entry, which the tab fills from the requests connect sent it in the status.
An entry without one is not a wish, one whose request id disappeared was
removed by the host.

The tab's own `requests` become a mirror of connect's while casting, not a
second source.

### A tab waking up with an old queue

When the phone wakes, its tab still holds the queue from before it slept.
If it pushed that with `/queue` before adopting the newer one from the
status, every wish made in between would be gone.

The existing ordering covers this if connect takes part in it: a wish
inserted server-side sets `session.play_seq` to the current time in
milliseconds, the same clock the app's `seq` uses
(`services/connect/playback.ts`). A `/queue` the tab built before that
carries an older seq and is dropped as superseded; the tab then adopts the
status like any change from another client sharing the session.

To verify on a device, not assume: that the tab really adopts first on
wake (`reconcileFromStatus` before any `syncCastQueue`), on iOS and Android.

### Song metadata

`st.queue` holds ids. Guests need title, artist, album, duration and cover
for the current song and the next 100. connect has to look them up
(`getSong`, through the bridges for Jellyfin and Plex) and keep a small
cache keyed by song id, since the same queue is shown over and over. The
cover goes through the existing `remember_cover()` / `/party/api/cover`.

### Switching paths mid-party

- **Local to casting** (the host starts a cast): connect takes over the
  requests the tab hands it with the next `/queue`, then answers on its own.
- **Casting to local** (the cast ends while the tab is awake): the tab takes
  the requests back from the status and answers as today.
- **The cast ends while the tab sleeps:** nothing is playing and nobody can
  answer. The party ends, as it does today when the host goes away; guests
  get the existing "no party right now" page.

## Host UI

- The party dialog says which path is in effect: "Runs on the Beacon server
  while you cast - this device may lock" / "Keep this window open - the
  music plays here".
- On a phone, starting a party without a cast is allowed but says so
  plainly; the mobile app bar's party button (added on 2026-10-06, not yet
  committed) depends on this plan.

## Order of work

1. **connect: liveness and snapshot from the cast session.** The party
   survives a sleeping tab and guests keep seeing now playing and what is
   next. Wishes still go to the tab and fail while it sleeps. Shippable on
   its own and the part to measure on a phone first. _Done:_ `core/party.py`
   follows the host's cast session (`_follow_cast`) and builds the guest
   snapshot from it (`rebuild`); song titles come from what the tab has
   shown so far (`songs`), so a song it never saw is left out until step 2.
   Not yet measured on a phone.
2. **connect: song metadata lookup** with its cache, used by 1. _Done:_ a
   queue song nothing has named is looked up with the media client's
   `get_track` (`PartyState._look_up`); one the server cannot find is not
   asked about again.
3. **connect: search and album lookup** from the media server. _Done:_
   `core/party_library.py`, Navidrome directly and Jellyfin/Plex through
   the bridges' new `call()`; `routes/party.py` uses it while the host
   casts and relays to the window otherwise. Songs a guest finds are
   remembered, so they have titles once wished for.
4. **connect: wishes, withdrawals and skip votes** on the cast queue, with
   `play_seq` and the request ids in `/queue` and the status.
5. **App: mirror connect's requests while casting**, hand them over when the
   path switches.
6. **Lyrics and backdrop fallbacks** for a sleeping tab.
7. **Host UI** and `docs/party-mode.md`.

## Tests

Backend, thoroughly (CLAUDE.md): turn-taking and limits ported 1:1 from the
`wishInsertIndex` tests, the `play_seq` race (a wish between a stale
`/queue` being built and arriving), request ids surviving a host reorder,
each path switch, a skip vote advancing a cast with no tab, the bridges
answering the new lookups. Frontend: the mirror and the hand-over in
`stores/party.ts`.

On a device, before calling it done: host on an iPhone and an Android
phone, cast, lock for ten minutes while guests wish, skip and withdraw; then
unlock and check the queue in the app.

## Out of scope

- Hosting with the tab asleep during local playback - the music stops then
  anyway.
- Radio while casting: wishes stay paused as today.
