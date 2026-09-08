# Beacon - repository guide

A self-hosted music client: an Electron desktop app (and a Docker/web build
of the same frontend) for Navidrome/Subsonic, Jellyfin and Plex, with casting
to Sonos, AirPlay, Chromecast and DLNA. The user-facing description lives in
`README.md`; this file is the working context - how the pieces fit, what the
conventions are, and which mistakes have already been made once.

## The two halves

**`src/` - the frontend** (Vue 3 **Options API**, Vuetify 4, Pinia, TypeScript)

| Path                   | What it is                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`    | Electron main process (~450 lines): window, tray, media keys, auto-update, and spawning the bundled connect binary                                                                                                                                                                                               |
| `src/preload/index.ts` | The context bridge. Thin, and it has to stay that way                                                                                                                                                                                                                                                            |
| `src/renderer/src/`    | The whole app. `views/` (routed pages, `views/mobile/` for the phone shell), `components/`, `stores/` (Pinia), `services/` (everything that is not a component: `subsonic/` the API client, `connect/` the backend client, `playback/`, `lyrics/`, `library/`), `layouts/`, `i18n/locales/` (en, de, es, fr, it) |

**`connect/` - the backend** (Python 3.13, FastAPI, `uv`)

| Path                     | What it is                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect/main.py`        | App bootstrap. `load_dotenv()` runs _before_ the `core.*`/`routes.*` imports on purpose - several of them read their config at module import time                                                          |
| `connect/routes/`        | HTTP surface. `proxy.py` is the important one: `/rest/*` is a transparent passthrough to the media server, or to `media/jellyfin_bridge.py` / `media/plex_bridge.py`, which speak Subsonic on their behalf |
| `connect/core/`          | Sessions, auth, the playback clock, radio (relay, ICY metadata, history), waveform, recommendations                                                                                                        |
| `connect/delivery/`      | One module per cast target: `sonos.py`, `airplay.py`, `chromecast.py`, `dlna.py`, coordinated by `manager.py`                                                                                              |
| `connect/static/remote/` | The phone Remote Control UI - plain JS, no build step, served by connect itself                                                                                                                            |

The frontend never talks to the media server directly: every call goes
through connect's proxy, which is also what makes Jellyfin and Plex look like
Subsonic to everything above it. Casting is entirely connect's job - the
speaker fetches from connect, not from the app.

## Commands

```bash
pnpm dev                 # frontend + backend together (this is the one you want)
pnpm test:unit           # frontend unit suite (jsdom)
pnpm test:layout         # the *.browser.test.ts suite, real Chromium via Playwright
pnpm type-check          # vue-tsc
pnpm lint                # oxlint + eslint, both with --fix
pnpm format:check        # prettier

cd connect && uv run pytest                        # backend suite
cd connect && uv run --group dev ruff check .      # backend lint
cd connect && uv run --group dev ruff format .     # backend format (line length 100)
```

CI runs exactly these (`.github/workflows/test-frontend.yml`,
`test-python.yml`), so a green local run means a green CI run.

## Testing

Three layers, and which one a test belongs in is a real decision:

- **jsdom** (`**/__tests__/*.test.ts`) - the default. Logic, stores, services,
  component behaviour.
- **Real browser** (`**/__tests__/*.browser.test.ts`, `pnpm test:layout`) -
  only for what jsdom cannot answer: computed layout (container queries,
  `clamp()`, flex-wrap resolution, 3D transforms) and IndexedDB. jsdom would
  "pass" these against a fake layout without checking anything.
- **pytest** (`connect/tests/`) - the backend, including the Jellyfin/Plex
  bridges and every delivery target.

### How much to test where

The two halves are deliberately not held to the same standard.

**The backend gets thorough coverage.** A fault there surfaces as silence in
another room, across three device classes, often on hardware that isn't on
the development machine - the suite is the only place it can be caught early.

**The frontend is tested on function, not on appearance.** Its
backend-shaped half - `stores/`, `services/`, everything that computes,
reconciles or holds state - counts as logic and gets the same thorough
coverage as `connect/`; that is where the real bugs have been. Components are
tested for behaviour: a click does what it should, an empty result shows the
empty state, an error path is reachable. Layout is the exception, not the
routine - and only what jsdom genuinely cannot answer (see the browser layer
above).

**Don't pin down what is meant to change.** Counts of rendered elements,
their order, class names, copy, sizes - a test over those never finds a bug
and turns every deliberate design change red. Before writing one, ask what a
failure would mean: a real defect, or someone having redesigned something on
purpose? Only the first is worth a test. This is the question the mutation
check below does _not_ answer - a skeleton-loader count passes it happily and
is still worth nothing. When a test like that goes red on an intentional
change, delete it rather than adjusting its numbers.

Coverage is reported over _every_ renderer source file, not only the imported
ones - a number that rises as coverage gets narrower is worse than none. But
a renderer coverage percentage is not a goal in itself, and neither half's
number is the measure: **check a test by breaking the code it covers.** If
the suite stays green, the test does not test.

## Conventions

### Style and UI

`docs/styleguide.md` is the design system - **read it before building or
reshaping any UI**, and update it when a decision in it changes. Its
enforceable half lives as shared classes in
`src/renderer/src/assets/base.css` (`.beacon-panel`, `.panel-title`,
`.section-title`, `.eyebrow-label`, `.beacon-dialog`, `.mobile-row`);
`docs/styleguide.html` is
the same thing rendered, for looking at rather than reading.

Two rules that come up on every frontend change:

- **No Vuetify utility classes in templates.** No `d-flex`, `align-center`,
  `w-100`, `mb-4`. Layout goes in a scoped `<style>` block with named
  classes. Vuetify's _type_ classes (`text-body-small`,
  `text-medium-emphasis`) are fine - they are the app's type scale.
- **Options API, not Composition API.** The whole frontend is written this
  way; a `setup()` in the middle of it is the odd one out.

### Comments

Comment the _why_, and keep it short. A comment that has to get long is
usually a sign the code itself is unclear - clarify the code first (a named
helper, a named constant) and see what is left to say.

At length only for hard problems: browser and device quirks, measured
numbers, and places that look wrong but are deliberate. A number with no
explanation is still a number nobody dares change later. The story of an
investigation belongs in `docs/investigations/`, not in the code.

Existing comments are load-bearing - when you rewrite the code around one,
rewrite the comment too rather than leaving it describing what used to
happen.

### CHANGELOG.md

The changelog documents the gap between the **last release** and the next
one, not the development history in between:

- New work goes in an `[Unreleased]` section above the released ones. A
  section with a version number and a date is published and is not edited.
- A bug introduced _and_ fixed within the same unreleased cycle gets **no**
  "Fixed" entry - nobody outside ever saw it. Correct the existing
  Added/Changed entry instead so it describes the end state.
- Entries are non-technical: what a user can see, not which function changed.

### .github/workflows/

Four rules, all of them already visible in the existing files:

- A leading `_` means the workflow only ever runs as a `workflow_call`
  building block, never on its own. Its `name:` says `(internal) ...` too,
  so a run in the Actions list is recognisable as somebody else's job.
- Everything else is `<verb>-<subject>.yml`, and the `name:` reads the same
  way round: `Test ...`, `Publish ...`. The Actions sidebar sorts by name,
  so verb-first is what keeps the test workflows together and the publish
  ones together instead of interleaving them.
- `... (Manual)` in the name means dispatch-only. A workflow that also runs
  on push doesn't carry it.
- A workflow triggered by `push` always names its branches, or it runs on
  every Dependabot branch too - which for the packaging ones is four
  platform builds at a time. Which branches depends on what the workflow
  answers: the frontend and backend suites are development feedback and
  watch `[main, development]`, while `test-ffmpeg` and `test-package`
  answer a release question and watch `[main]` only, since the merge to
  main is when that question comes up. Both kinds keep
  `workflow_dispatch`, so either can be run earlier by hand.

### docs/investigations/

Every case that cost more than an afternoon leaves a file behind -
**including the theories that were ruled out**, which is the most valuable
part of an entry. Read `docs/investigations/README.md` before investigating
anything about streaming, casting or the playback clock; most of the folder
is playback, and it is where the dead ends are recorded.

It is not restricted to playback, or to bugs: a measurement series, an
approach that was tried and dropped, a decision nobody will reconstruct from
the diff belongs there too. A bug that was found on first look does not need
an entry. Keep those docs anonymous: no IPs, no real speaker or room names
("room A", "room B").

## Working agreements

- Work happens on the **`development`** branch and is merged to `main`. Check
  which branch you are on before making changes.
- **Commits, tagged releases, and Docker image builds/pushes are the
  maintainer's own step.** Staging changes, showing a diff and drafting a
  commit message is the useful part; running `git commit`, `build.sh` or
  `docker push` is not.
- A dev session may be running while you work. `pnpm build` writes to the
  same `out/` the running app uses, and connect holds port 9181 - don't
  build over a live session, and don't kill ports blindly.
- Other agents may be working in this repo at the same time. Uncommitted
  changes or failing tests that are not yours: report them, don't fix them.

## Things that have already bitten someone

- **Electron preload:** `window.api` is silently `undefined` unless the
  window is created with `sandbox: false` _and_ the preload is ESM. The
  symptom was a login that 404'd, nowhere near the actual cause.
- **Vuetify 4 ships its CSS in cascade layers.** An unlayered rule beats a
  layered one however specific the layered one is - `base.css` declares the
  layer order for exactly this reason, and only the reset lives in a layer.
- **Artwork caching has three layers already** (in-memory, IndexedDB, and
  connect's server cache). Do not add a fourth. Batching once quietly killed
  HTTP caching here.
- **Waveforms are deliberately never cached** - decoding takes under a
  second, and a cache would be a new thing that can go stale.
- **The bundled ffmpeg is built from a hand-written component list**, and
  `./configure` ignores a name it doesn't know as long as something else in
  the same comma list matched - so a forgotten format produces a build that
  succeeds and a track that won't play. Adding a format to the app means
  adding it to `build/ffmpeg/required-components` first; the backend suite
  and `scripts/verify-ffmpeg.sh` then fail until the recipe catches up. Read
  `build/ffmpeg/README.md` before touching anything in there.
- **Navidrome sends Subsonic clients a synthesised file path**
  (`Artist/Album/01-03 - Title.mp3`), not the real one, unless that player
  has "Report Real Path" enabled. Beacon shows what the server sent; that is
  not a bug in the path row.
