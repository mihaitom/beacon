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

- **Beacon bundles no source app**, not as an example, not as an optional
  download, not in a sibling repo. The docs' example serves a local folder.
- **No service names** in the UI, the docs, the changelog or the code. The tab
  shows the name the admin gave the source.
- **No links** to third-party source apps from anything Beacon publishes.
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
