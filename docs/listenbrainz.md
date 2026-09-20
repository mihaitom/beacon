# ListenBrainz: two features, one API

ListenBrainz is MetaBrainz's open listening-history service, built on
MusicBrainz MBIDs. It is not a media server and holds no library, which is
the first thing to get out of the way: it cannot be a "bridge" in the sense
`connect/media/jellyfin_bridge.py` and `plex_bridge.py` are bridges. Those
translate Subsonic-shaped `/rest/*` calls into the real API of a *media
server* a session is backed by. ListenBrainz has nothing to serve a
`search3` from, so there is no request to translate. It belongs next to
`connect/core/lastfm.py` and `core/recommendations.py`, as a source of
*names* (or MBIDs) that the renderer matches against whatever library the
session already has.

Two features are worth having, and they are independent:

- **A. A second provider for the playlist builder.** The same dialog that
  fills a playlist from Last.fm charts or a listening history, fed from
  ListenBrainz instead. Smaller than Last.fm, not bigger (see the table).
- **B. A personalized shelf on Home.** Collaborative-filtering
  recommendations from the listener's own ListenBrainz history. This is
  the one Last.fm cannot offer, and it is the reason to bother.

A and B are **built** (2026-09-20). B landed as the artist-shelf variant:
the recommended recordings are counted per credited artist, ranked, and
shown as artists not already in the library, reusing
`SimilarArtistsShelf.vue` and the existing Deezer/links enrichment. This
file is kept so the decisions do not have to be reconstructed from a diff.

## What the Last.fm feature already established

`core/lastfm.py` returns plain `{title, artist, mbid}` names;
`src/renderer/src/services/library/lastfmMatcher.ts` turns those into
songs the library owns; `LastfmPlaylistDialog.vue` is the two-step
"found / not found" UI on top. The matcher and the dialog are
source-agnostic — they never learn where a name came from. Only the
backend call differs, so a ListenBrainz provider is a new `core/` module,
a new route, a new `services/connect/` client, and a source switch in the
existing dialog. The expensive half is already written.

## A. The playlist builder

Built: `connect/core/listenbrainz.py` (queries and the batched metadata
resolve), `connect/routes/listenbrainz.py` (`GET /listenbrainz/tracks`),
`src/renderer/src/services/connect/listenbrainz.ts`, and a source switch in
the existing `LastfmPlaylistDialog.vue`, reached by its own button on the
Playlists page. The matcher, the result step and playlist creation are
shared unchanged.

| Last.fm op          | ListenBrainz                                                       | Notes                                                       |
| ------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `charts` (global)   | `GET /1/stats/sitewide/recordings?range=`                           | direct                                                      |
| `charts` (country)  | —                                                                   | ListenBrainz has no country charts                          |
| `genre` / tag       | `GET /1/lb-radio/tags`                                              | LB Radio's own tag endpoint; the `/1/explore` wrapper needs a token |
| `artist`            | `GET /1/lb-radio/artist/{artist_mbid}`                              | popularity is token-gated now; sorted by `total_listen_count` |
| `mytop`             | `GET /1/stats/user/{user}/recordings?range=`                        | username only, same as Last.fm                              |
| — (new)             | `GET /1/cf/recommendation/user/{user}/recording`                    | the CF feed, below; gives only MBIDs                        |

The `range` values are `week`, `month`, `quarter`, `half_yearly`, `year`,
`all_time` (plus `this_week`/`this_month`/`this_year`), so the period picker
maps but its labels differ from Last.fm's.

The honest summary: only the country charts have no ListenBrainz
equivalent, so this is close to Last.fm's set. It is worth doing for anyone
whose history lives in ListenBrainz, and the CF row is the one that adds
something Last.fm cannot.

The sitewide chart needs one correction the API does not do itself. It is
literally what the whole userbase is mass-listening to right now, so it is
fandom-dominated: measured live on 2026-09-20, 39 of the top 50 recordings
were one act, and 16 of the 50 were the *same recording* listed twice.
`get_sitewide_top_recordings` therefore fetches a pool ten times the
requested size and drops both duplicates and anything past two tracks per
artist (`_MAX_PER_ARTIST`). The listener's own history (`mytop`) is
deduplicated but not capped — if they really played one artist most, that
is the honest answer.

Both genre and artist go through LB Radio, which is public where the
documented `/1/explore/lb-radio` wrapper and the popularity endpoint are
now token-gated (401 without one, measured live 2026-09-20). Genre uses
`GET /1/lb-radio/tags` (`tag`, `mode`, `pop_begin`, `pop_end` and `count`
are all required) and returns tag-matched recording MBIDs; the tag is
lower-cased first, because LB Radio matches it literally and "Rock"
returned nothing where "rock" returned a full list. A 50-track "rock" list
had 49 distinct artists — far more diverse than the sitewide chart, which
is what makes it the useful source. Artist uses
`GET /1/lb-radio/artist/{mbid}` with `max_similar_artists=0` (the artist
itself, not a radio around them) and `max_recordings_per_artist=limit` (at
the default of 2, a 50-track request returned 2); its entries carry
`total_listen_count`, so sorting by that restores the "most listened"
ranking.

LB Radio generates its list on the fly (Troi) and is slow — measured at
10-30s — so both LB Radio calls get a longer timeout (`_RADIO_TIMEOUT`)
than the stats and metadata endpoints, which answer instantly.

**No token is needed for A.** The stats, LB Radio and metadata endpoints
are public (see "Verified" below); a username is enough, exactly like
Last.fm's `user.getTopTracks`. There is no application key; the
ListenBrainz name is entered in Settings and also prefills the builder
(see below).

## B. Personalized recommendations on Home

The endpoint is `GET /1/cf/recommendation/user/{user_name}/recording`,
ListenBrainz's collaborative filtering over the listener's own history —
including listens submitted from anywhere else, not just from Beacon. Beacon
does not have to scrobble anything for this to be personalized; the user
only has to use ListenBrainz somewhere.

It returns MBIDs and scores, nothing displayable:

```
payload.mbids: [{ recording_mbid, score, latest_listened_at }]
payload.total_mbid_count, model_id, model_url
```

A second call resolves those into something a shelf can render. Live-checked
against the public API:

```
POST /1/metadata/recording/   { recording_mbids: [...], inc: "artist release" }
→ recording.name, recording.length (ms)
  artist.name
  release.name, release.caa_id, release.caa_release_mbid
```

So a shelf is **two calls**: one CF, one batched metadata. Cover art is
derivable from the two CAA fields as
`https://coverartarchive.org/release/{caa_release_mbid}/{caa_id}-250.jpg`;
the backend returns that URL on a resolved track, but the artist shelf as
built shows Deezer artist photos instead, so nothing fetches it yet.

What the shelf *is* differs from the existing "Discover" shelf. Discover
(`core/recommendations.py`) is artist-based and community-derived through
ListenBrainz **Labs**, with no identity attached. This one is personal. As
built it is also artist-based: the recommended recordings are counted per
credited artist (`get_recommended_artists`), ranked by how many of the
recommendations each accounts for, and shown through the same
`SimilarArtistsShelf.vue` and Deezer/links enrichment as Discover, with the
artists the library already owns filtered out. It is a new shelf, not a
replacement.

The recording-level feed is still there (`get_recommendations`, exposed as
the builder's `recommended` source), so a track-based shelf remains
possible later without backend work — the open question below is why it
was not chosen.

Library matching stays name-based, for the same reason the playlist builder
is: Beacon's library tracks carry no MBIDs (`types/library.ts`). The matcher
can use the recording MBID only as a confirmation, never as identity — the
same rule `lastfmMatcher.ts` already documents for Last.fm's unreliable
ones. ListenBrainz's are real MusicBrainz IDs, so they are a better hint,
but the library side still has no MBID to meet them.

## The token question

The instinct "with an API key we get personalized recommendations" is
almost right but not quite, and the difference matters:

- **The CF endpoint is public.** Verified live without any `Authorization`
  header against a public profile: HTTP 200. A username is enough for a
  public ListenBrainz account. A token buys two things only: access to a
  **private** profile's data (unverified whether CF honours it), and higher
  rate limits.
- **A ListenBrainz user token is a write credential.** Unlike the Last.fm
  application key — which only reads public charts and cannot touch an
  account — this token can `POST /1/submit-listens`, delete listens, and
  change account settings. It must be treated as a secret, not as a
  convenience field.

That rules out the obvious storage. `account_settings.json` is returned to
every client by `GET /account-settings` (`services/connect/accountSettings.ts`
pulls it), so a token there would be handed back to each device and land in
localStorage. The Last.fm key deliberately is never sent back for exactly
this reason. If a token is ever supported it should follow that model: kept
server-side per account, mode `0600`, exposed only as
`configured: true/false`. That is new machinery (the Last.fm key is
installation-wide, this is per-account), which is why it belongs in a later
step, not the first.

**Recommendation: ship A and B username-only, token-free.** It covers
public profiles, needs no secret storage, and no new Settings surface. Add
the token only if a private-profile user actually asks.

## Privacy

This is a larger step than the existing Discover shelf. Discover sends
library *artist names* to MusicBrainz/ListenBrainz Labs and gets community
similarity back. The personalized shelf sends the listener's **identity**
(a username, or later a token) and gets back data derived from *their*
listening. That deserves the existing opt-out
(`stores/recommendations.ts`'s `recommendationsEnabled`, which today only
gates the Home shelves) and probably its own switch rather than riding
silently along with the community one. The FAQ's "what leaves the
deployment" section is the place that has to stay honest about it.

## Rate limits and caching

ListenBrainz asks for at most **1 request/second** and a real User-Agent
(`lyrics.shared.USER_AGENT` already exists). A shelf is two calls, so this
is easy, but the result should still be cached on disk with a TTL, the way
`core/recommendations.py` caches everything else — recommendations change
slowly, and Home reloads often. The CF payload carries a `last_updated`
timestamp to key a TTL on. The metadata POST is one batched call, so the
per-track cost is one, not N.

## Verified, and not

Verified live against `api.listenbrainz.org` while writing this:

- CF recommendations answer **without a token** for a public user (HTTP
  200, `payload.mbids` with scores).
- `/1/metadata/recording/` returns `recording.name`, `recording.length`,
  `artist.name`, `release.name`, `release.caa_id`,
  `release.caa_release_mbid` for a recording MBID.
- Stats endpoint shapes are as documented (recordings carry
  `track_name`/`artist_name`, plus `recording_mbid` when known).
- `GET /1/lb-radio/tags` and `GET /1/lb-radio/artist/{mbid}` answer
  **without a token**; their required params and response shapes are as
  used above. `GET /1/explore/lb-radio` and
  `GET /1/popularity/top-recordings-for-artist/{mbid}` both returned 401
  without one.
- A brand-new account's user stats return 204 (statistics not computed
  yet), which the module now reports as such rather than as empty.

Assumed, not yet confirmed:

- Whether a token actually unlocks CF for a **private** profile, or whether
  private data is simply unavailable via the API.
- The exact Cover Art Archive URL for `caa_id`/`caa_release_mbid`.
- That a real listener's CF feed is populated and useful; the endpoint can
  return 204 for a profile with too little history.

## Open questions

Settled: username-only, one `core/listenbrainz.py` module, no token and no
secret store; B as the artist shelf; and the ListenBrainz name entered in
Settings (under Library, beside the recommendations toggle), which also
prefills the playlist builder. What is still open:

- **B rides the existing recommendations toggle.** It sends the listener's
  *identity* (a public ListenBrainz name) where Discover only sends library
  artist names, but it is hidden by the same `recommendationsEnabled`
  switch rather than one of its own. That is a deliberate first cut — one
  switch is easier to explain than two — and worth revisiting if the
  identity/pseudonymity distinction turns out to matter to anyone.
- **The CF endpoint is experimental** (`model_id`/`model_url`, and the docs
  say it "probably will change"). The backend treats a 204 or an unexpected
  shape as "nothing to show" and the shelf stays hidden, so a change there
  should not break Home.
- **A track-based shelf remains possible** without backend work — the
  recording-level feed and its Cover Art Archive URLs are already there.

_Written 2026-09-20, before any of it was built; A and B were built the
same day. Change the code and this file goes stale; it is a plan, not a
contract._
