# External sources

Built on `feature/external-source`, not released yet, from discussion #88: a
song the library does not have, played on the speakers at home without leaving
Beacon. The user runs small apps of their own, each bringing its own page and
handing Beacon audio URLs; whatever that app does to produce the audio is its own
business. The contract is `docs/help/reference/external-source-api.md`, the
user-facing side `docs/help/faq/external-sources.md`.

## Ground rules

These are what keep this a neutral feature, and they hold for every later
change too:

- **Example apps only for audio that may plainly be played.** The repo carries
  two, separate from the app and never part of a build or an image: a local
  folder (the listener's own files) and the Live Music Archive at archive.org
  (recordings its bands allow to be shared, over the archive's public API),
  the second to show that an online source works too. Nothing for a service
  whose terms forbid fetching its audio, streaming services and video
  platforms above all, not even "to demonstrate". They live in `docs/examples/<name>/`,
  each a project of its own with its own tests (`test-examples.yml`).
- **No service names** in Beacon's own UI, docs, changelog or code. The tab
  shows the name the admin gave the source. Only an example app and its own
  README name what it plays from, and an entry in the list of apps by others
  (below) is its author's text, not Beacon's.
- **Apps by others are listed, not provided.** `community/external-sources.json`
  holds apps their authors wrote and publish themselves, added by pull
  request (`community/README.md`), and Beacon shows it under **Find apps**.
  Beacon ships none of them, builds none, runs none and checks none; the
  dialog says so above the list, every time, and that whoever adds one
  decides whether they may play what it plays. An entry may name the
  service it plays from - the rule above still holds for everything else
  Beacon publishes. This replaced "no links to third-party source apps": the
  maintainer does not answer for what someone else's app does, and a list
  is what lets people find each other's apps at all. An entry can be taken
  out again (a repository gone, an app that no longer works, its author's
  wish).
- **No plugin system.** Beacon runs no foreign code in its own context; the
  source's page is sandboxed and talks to Beacon only through messages.

## Shape

```
renderer  <-- postMessage -->  sandboxed iframe  <-- /external-ui/<secret>/<id>/ --> connect --> app /ui/
   |
   | POST /external-source/<id>/items {audioUrl, metadata}  ->  Subsonic song with an ext: id
   v
playback store, as for any song  ->  /rest/stream?id=ext:...  ->  connect --GET (Range)--> app
```

- **Audio is pulled, not pushed.** connect fetches the URL itself as often as it
  needs to: a speaker reconnecting, a seek, the waveform, beat analysis, a queue
  restored after a reload. A stream pushed once could serve none of these.
- **`ext:` ids through the media clients.** `media/base.py`'s `routes_external`
  decorates `get_track`, `get_stream_url` and `get_cover_art_url` on all three
  clients, so the ~20 call sites (casting, transitions, waveform, visualizer,
  lights, party host) need no change. A wrapper around `session.media` was
  rejected: it would break 14 `isinstance` checks.
- **`/rest/*` rules** in `media/external_bridge.py`, ahead of the
  Jellyfin/Plex/Subsonic dispatch: getSong/stream/getCoverArt from the stored
  item, scrobble swallowed, star/unstar/setRating refused, lyrics and similar
  songs empty, `ext:` ids taken out of createPlaylist/updatePlaylist/
  savePlayQueue. In the proxy, so the remote control and the app API get the
  same rules as the renderer.
- **Several sources**, up to twelve, each `{id, name, icon, base_url, token}`
  in `external_sources.json`; the single `external_source.json` of the first
  build is moved into it on first read. The icon is any `mdi-` name to connect,
  one of `EXTERNAL_SOURCE_ICONS` in the dialog.
- **The id** is `ext:` plus a hash of the audio URL, so playing a song twice
  keeps one history entry. It needs no source in it: the URL is absolute and
  carries the source's address, and audio is fetched without the source's
  token.
- **The renderer** hides what cannot work (`isExternalSourceSong`,
  `currentSongInLibrary`): favourites, rating, playlists, Song Radio, file info.

## Security

- **Only the app's own address.** `audioUrl` and `coverUrl` are resolved against
  `<base>/ui/` and refused unless scheme, host and port match the base URL.
  connect's own fetches of them follow no redirects.
- **The page is sandboxed twice**: `Content-Security-Policy: sandbox ...`
  without `allow-same-origin`/`allow-top-navigation` on every `/external-ui/`
  response, and the same `sandbox` attribute on the iframe. Its requests carry
  no cookie and no connect token; set-cookie and the app's own CSP/CORS headers
  are dropped.
- **A removed source is no longer fetched from**: its songs stay in the
  history, but stream and cover answer 404 once no source has their address.
- **The page's address is the credential** (`/external-ui/<secret>/<id>/`, new on
  every connect start), because a sandboxed page cannot send a token. nginx
  gives the prefix its own location without the injected token, like `/party/`.
- **Who may set it up**: an admin on Docker (`BEACON_HOSTED`), anyone signed in
  on the desktop. The token for the app is stored 0600 and never sent back.
- **The media server's credentials never go to the app**: the cover batch
  route skips `auth_headers()` for `ext:` ids.
- **Party guests** cannot name an `ext:` id (`routes/party.py`'s `_check_id`).

## Changed from the first plan

- `POST /external/play` became `POST /external-source/items`, which only
  registers the song. The renderer queues it with the existing playback
  actions, so local playback and casting need nothing new.
- Items are pruned after 90 days unused, not by checking queues and history.
- Mobile has no tab of its own (the bar is full): a button in the Radio view's
  header, a menu of them with more than one source.
- One source became several, set up in a dialog each, with an icon for the
  tab.

## Apps by others

- **One file on main**, `community/external-sources.json`: `{"apps": [{name,
description, repository, author, icon?}]}`. main, not development, so an
  entry is live as soon as its pull request is merged, for every installed
  version (DIRECTORY_BRANCH is development only until the list is on main;
  the publish workflows refuse to build while it is). `author` is a GitHub
  login, credited with avatar and profile link the way the release notes
  credit people. An entry may point into Beacon's own repository
  (folder-source).
- **Read in the renderer** (`services/externalSourceDirectory.ts`), from
  raw.githubusercontent.com like the changelog, each time the dialog opens:
  it is small, and a cached copy would hide a new entry. Nothing is fetched
  until someone opens it.
- **Nothing in it is trusted.** `parseDirectory()` drops an entry with a
  missing or overlong field, an address that is not plain `https://`, or an
  icon Beacon does not offer, keeps one entry per repository and caps the
  list; one broken entry never hides the rest. The repository link is an
  ordinary link, sent to the browser by main/index.ts.
- **No install button.** Each card leads to its repository, nothing more:
  an app is run as its README says and then added like any other source.
  A button that added it straight away read as a one-click install, which
  it never was.
- **GitHub, Codeberg and GitLab only** (`REPOSITORY_HOSTS`), for the
  repository and so for its picture. Opening the list makes Beacon load
  every picture in it; on someone's own server that would tell its owner
  the address of everyone who looked. Those three see no more than GitHub
  already does from the release notes' avatars.
- **A picture only from the app's own repository.** `icon` is a Beacon icon
  name or an `https://` `.webp` on the hosts REPOSITORY_HOSTS gives the
  repository's host (raw.githubusercontent.com too for GitHub) under the
  same owner/name; a GitHub `blob` page address is
  turned into the file. Nothing in the list makes Beacon load from
  anywhere else, and the icon stands in when the picture does not load.
- **The pull request checks itself:** a frontend test reads the file through
  the same `parseDirectory()` and fails on any entry it would drop, and
  test-frontend.yml runs on changes under `community/`.
- **Gone repositories are found:** `scripts/check-community-apps.mjs`
  (check-community-apps.yml, on pull requests and every Monday) asks every
  repository and picture. 404 or 410 fails, so the scheduled run is the
  notice to take an entry out; a timeout or rate limit only warns. Not in
  the unit tests, which must not depend on the network.

## Not built yet

- `resolve` (the app answering "do you have artist X, title Y"), and with it
  playing missing songs from album pages and the playlist builder's Deezer
  charts.
- An app-API command to queue an `audioUrl` from outside the tab.

## Open questions

- **Behind a forward auth** the page's subrequests come from an opaque origin
  and carry no login cookie. The FAQ says to let `/external-ui/` past the
  login; not yet tried behind the real proxy.
- **Duration** is whatever the page sends. Without one, connect could probe it
  from the audio; not done yet.
- **ffmpeg follows redirects** when it reads the audio for casting; the check
  on the address covers only the first hop.
- **Expired URLs**: a queue restored days later may hold audio the app no
  longer serves. Skipped like a deleted library song for now, without a word
  about why.
- **Offline desktop app**: its bundled connect has no sources unless they are
  configured there too.
