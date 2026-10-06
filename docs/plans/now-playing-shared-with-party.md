# Plan: one Now Playing for the app and the party guests

Status: planned, not started. Branch `partymode` (party mode itself is done
and uncommitted at the time of writing; see `docs/party-mode.md`).

## Why

The party guest page (`src/renderer/src/party/`) has its own Now Playing,
`party/components/GuestNowPlaying.vue`, rebuilt from the app's pieces. Every
round of testing found another place where the copy had drifted from the
app: lyrics that did not scroll, colours that stayed amber, no flip on a
narrow window, a different corner card. A copy keeps drifting.

The goal is that guests see the app's own Now Playing:

- `GuestNowPlaying` (desktop) is `NowPlayingView` plus a skip-vote button.
- On a phone it is the same view in its compact form (`NowPlayingStageMobile`),
  as `MobileNowPlayingView` uses it.
- The only other difference: the guest's lyrics have no editing tools
  (calibrate, sync offset, pick another match, click a line to seek).

## Why it was not done that way to begin with

The Now Playing components read the host's stores directly instead of taking
their data from outside, and some of what they do is reserved for the host.
Measured on 2026-10-06 (`grep use*Store`):

| Component                                | Lines | Reads                                                                                                                                   |
| ---------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `views/NowPlayingView.vue`               | 1017  | playback, connect, drawers, fanart, library, lyrics, radioMetadata; audioEngine; fanart/visualizer/logLevel services with the app token |
| `now-playing/NowPlayingStageDesktop.vue` | 473   | playback, drawers, radioMetadata                                                                                                        |
| `now-playing/NowPlayingStageMobile.vue`  | 316   | playback, drawers, radioMetadata                                                                                                        |
| `now-playing/NowPlayingToolbar.vue`      | 276   | auth, autoplay, drawers, playback                                                                                                       |
| `now-playing/NowPlayingTrackPanels.vue`  | 530   | none directly, but renders `CoverArt` and `router-link`s to artist/album pages                                                          |
| `now-playing/NowPlayingArtwork.vue`      | 115   | none directly, but `CoverArt`                                                                                                           |
| `now-playing/NowPlayingBackdrop.vue`     | 109   | nothing (already reusable)                                                                                                              |
| `now-playing/NowPlayingVisualizer.vue`   | 131   | nothing, but wraps `AudioVisualizer` (playback, auth, audio engine)                                                                     |
| `lyrics/LyricsPanel.vue`                 | 493   | lyrics, playback; seek, calibrate, offset, candidate picker                                                                             |
| `library/CoverArt.vue`                   | 799   | library (URL built with the app token, batched through connect)                                                                         |
| `radio/RadioTitleLog.vue`                | 1059  | library (radio is out of scope for guests, see below)                                                                                   |

Mounted in the guest page as they are, these would have no data, and the
host's whole playback store would be bundled with the guest page. Pieces
that are already store-free and shared today: `NowPlayingBackdrop`,
`lyrics/LyricsLines.vue` (split out of `LyricsPanel`),
`player/VisualizerBars.vue` (split out of `AudioVisualizer`),
`services/visualizerBands.ts`, `plugins/theme.ts`.

## The approach: separate where the data comes from from how it is shown

### 1. A Now Playing source

`components/now-playing/source.ts`: the interface the presentation reads,
handed down with `provide`/`inject` (key `nowPlayingSource`), so nothing in
the presentation imports a store.

What it carries (reactive):

- `song`: title, artist, album, artistId/albumId (for links), the cover as
  a ready URL, and who wished for it (party only)
- `radio`: name, favicon, ICY tag, title log (null for guests)
- `playing`, `position` (seconds, kept current), `duration`
- `next`: the upcoming song, for the corner's "next up" panels
- `lyrics`: lines, synced, offset, songKey, loading/error/status, source
  attribution
- `backdrop`: the artist background URL, the list to step through, the
  current index
- `visualizer`: available or not, and a `sample(): number[] | null`
- `capabilities`: `seek`, `calibrateLyrics`, `pickLyricsMatch`,
  `autoplay`, `fullscreen`, `artistLinks`, `titleLog`, `debug`
- actions: `seek(t)`, `nextBackground()`, `setLyricsOffset(o)`,
  `loadLyricsCandidates()`, `toggleAutoplay()`, ... (no-ops or absent where
  the capability is off)

View state that is a preference and not data (lyrics open, visualizer on,
artwork hidden) stays with the view. The host keeps it where it is today
(`drawers.lyricsPanelOpen`, account-scoped localStorage); the guest page in
its own localStorage key. Pass it through the source as well (`ui`), so
the stages do not need to know which.

### 2. The host source

`components/now-playing/hostSource.ts` (or a composable/Options mixin, to
match the codebase's Options API): builds the source from the stores and
services `NowPlayingView` uses today. This is where everything with the app
token lives: `CoverArt`'s URLs, `getArtistArt`/`fanartImageUrl`, the
`VisualizerEventSource`, the audio-engine analyser, `getLogLevel`.

`NowPlayingView` keeps its logic (backdrop crossfade and preloading, colour
extraction, `applyPrimary`, the flip slide in `onStageResized`, fullscreen,
the next-up panels) but reads its inputs from the source instead of the
stores. Where it is a fair split, move the host-only logic (preloading the
next artist, the fanart lookup) into the host source, and keep only
presentation in the view.

### 3. The presentation stops importing stores

- Stages, toolbar, track panels, artwork: replace store reads with
  `inject('nowPlayingSource')`. Router links only when
  `capabilities.artistLinks` (the mobile stage already renders plain text
  instead of links - reuse that branch).
- `CoverArt`: a `src` prop for a URL that is used as is (no batching, no
  app token). `imageUrl` exists but goes through connect's batch with the
  token, so it is not that.
- `LyricsPanel`: reads lyrics and position from the source; its toolbar
  shows calibrate/offset/picker only with the matching capability, line
  clicks seek only with `seek`. `LyricsCandidateList` stays host-only
  (only mounted when `pickLyricsMatch`).
- `NowPlayingVisualizer` / `AudioVisualizer`: draw from `source.visualizer`.
  `AudioVisualizer`'s local/cast data sources move into the host source;
  what is left is `VisualizerBars`.
- `NowPlayingToolbar`: a slot (or `extraActions`) for the guest's skip
  button; autoplay/fullscreen/debug/title-log behind capabilities.

Rule to check at the end: `grep -l "use[A-Z][a-zA-Z]*Store" components/now-playing components/lyrics/LyricsPanel.vue`
returns nothing, and the party bundle contains none of the host's stores
(after `pnpm build:party`, `grep -c getSimilarSongs2 connect/static/party/assets/*.js` is 0).

### 4. The guest source

`party/guestSource.ts`: builds the same interface from the party store
(`party/store.ts`): the snapshot, the extrapolated position, the host's
lyrics, `/party/api/backdrop?index=`, `/party/api/cover`, and the
`/party/api/visualizer` SSE fed into `sample()`. Capabilities all off
except `fullscreen` (harmless, and useful on a TV), no radio title log.

The guest page then renders `NowPlayingView` with `compact` on a phone
(`$vuetify.display.smAndDown`, the app's 960px) and passes the skip button
into the toolbar slot. `GuestNowPlaying.vue`, its layout test and its
copies of the corner/flip CSS are deleted; the guest-specific bits that
remain are the skip button and the source.

### Out of scope

- Radio for guests: the guest snapshot only carries the station name. Keep
  showing that; the title log stays host-only (`capabilities.titleLog`).
- The host's queue drawer, transport controls, `MobileTransportControls`:
  guests have their own queue and wish tabs.

## Order of work

Each step leaves the app working and the suites green, so it can stop
anywhere.

1. `source.ts` interface and the host source, with `NowPlayingView`
   providing it. No component reads it yet.
2. Move one component at a time to the source, leaf first: `NowPlayingArtwork`
   (+ `CoverArt` `src`), `NowPlayingTrackPanels`, `NowPlayingToolbar`,
   `LyricsPanel`, `NowPlayingVisualizer`/`AudioVisualizer`, the two stages,
   then `NowPlayingView` itself. Run the suites after each.
3. The guest source, and the guest page on `NowPlayingView`. Delete
   `GuestNowPlaying.vue`.
4. Browser check against the e2e setup below, then on real hardware.

## Safety net

These must stay green without being edited (if one needs changing, that is
a behaviour change to look at, not to wave through):

- `views/__tests__/NowPlayingView.test.ts`
- `views/__tests__/NowPlayingView.layout.browser.test.ts`
- `views/__tests__/NowPlayingView.compact.layout.browser.test.ts`
- `components/lyrics/__tests__/LyricsPanel.*.test.ts` (autoscroll, states,
  picker, layout)
- `components/player/__tests__/VisualizerBars.layout.browser.test.ts`

Tests that mount these components with Pinia set up will need the source
provided. Give them a test helper that builds the host source, so they keep
testing through the stores as today.

New tests:

- guest source (jsdom): snapshot to source mapping, capabilities off,
  position extrapolation, backdrop index
- the guest page renders `NowPlayingView` with the skip button and without
  lyrics editing tools (jsdom, behaviour only)
- move the guest lyrics scroll test into the shared view's tests, if it is
  not already covered there

Check each new test by breaking the code it covers (see CLAUDE.md).

## E2E setup used during party mode

A connect on a spare port with a fake renderer, no Electron needed:

- `PORT=9190 CONNECT_TOKEN=e2etoken CONNECT_DATA_DIR=<scratch>/data uv run python main.py`
  in `connect/`
- `POST /party-host/enable` with the token, then a small script that holds
  `/remote/agent-events` open, answers `songs-request`/`albums-request`/
  `album-request`/`party-wish`/`next`, pushes `/remote/state` snapshots
  (with `position`, `party_lyrics_key`, `party_backdrop(s)`) and
  `/party-host/lyrics`
- Fanart test images: `core.fanart.store_image(url, png_bytes)` with the
  same `CONNECT_DATA_DIR`, then pass those URLs as `party_backdrop(s)`
- Playwright (already a dev dependency) for screenshots at 1440x900 and
  390x780

Do not run it on 7071/9181 or while a dev session is running.
