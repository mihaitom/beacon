# Plugin system - concept

Not built. This is the plan for one, written up so the decision behind the
ordering does not have to be re-derived later: **the ListenBrainz
recommendations get built into the core first, and the plugin system only
once a second external service (slskd, Lidarr) actually needs one.**

The reason is not effort. A plugin system is a public interface: from the
first third-party plugin onwards, every Beacon release either keeps it or
raises the API version and deliberately locks existing plugins out. A
contribution point designed for one consumer is wrong for the second one,
and by then it is already published.

**Runtime decided 2026-09-06: WebAssembly via Extism, plugins written in Go
and compiled with TinyGo** - the same shape Navidrome uses, for the reasons
under [Borrowed from Navidrome](#borrowed-from-navidrome). What that costs
and what it rules out is spelled out there and under
[Host services](#host-services).

Written 2026-09-06 against Beacon 1.1.0. Rough size of the whole thing:
12-15 focused days including tests, five locales and changelog.

## What constrains the design

The deciding constraint is packaging, not architecture.

- **Docker** runs connect from source in a real venv (`uv sync --locked`,
  see `Dockerfile`).
- **Desktop** ships the same code as a PyInstaller binary next to the app
  (`electron-builder.yml`, `extraResources: connect/dist/connect-server`),
  started by `src/main/index.ts`.

Nothing can be installed into a frozen binary, and no plugin may depend on
that difference: what works in one build has to work in the other. That
single requirement is what rules out plugins as Python packages - a plugin
needing so much as one library of its own would work under Docker and never
on the desktop - and what points at a self-contained artifact instead. Hence
WebAssembly.

The runtime is then Beacon's dependency rather than the plugin's, and it has
to survive both builds:

- **Wheels.** `extism-sys` has published a complete platform matrix
  (glibc, musl, macOS, Windows) up to 1.12.0, and an incomplete one since -
  1.13.0 shipped macOS arm64 alone, and 1.21.0 has no glibc-Linux wheel and
  no sdist. On Linux, pip therefore backtracks silently to 1.12.0. **Pin
  `extism-sys` explicitly** rather than letting a resolver decide which
  runtime version a build gets, and treat a matrix that stays incomplete as
  the trigger to reconsider (`wasmtime-py` covers every platform Beacon
  ships, at the price of writing the ABI by hand).
- **The Alpine image.** `Dockerfile` builds on
  `ghcr.io/astral-sh/uv:python3.14-alpine`, so the musl wheel is the one
  that matters there, not the glibc one.
- **PyInstaller.** The runtime ships a native library inside its wheel;
  `connect/packaging/connect-server.spec` has to collect it explicitly
  (`collect_dynamic_libs`), and a packaged build must actually be run to
  confirm it - the failure mode is an ImportError on a user's machine, not
  at build time.
- **Async.** Both candidate runtimes are synchronous. Every call into a
  plugin goes through `asyncio.to_thread`, for the same reason
  `routes/account_settings.py`'s handlers are sync `def`: blocking the event
  loop blocks every stream and every WebSocket in the process.

What already exists and is reusable:

- `core/account_settings.py` - settings that follow an account across
  devices. Exactly what plugin configuration needs.
- `routes/proxy.py` - the pattern for an authenticated passthrough with
  timeouts.
- `services/capabilities.ts` - the table the UI already consults to decide
  what to show.
- `AlbumShelf.vue` / `SimilarArtistsShelf.vue` - the render target for
  recommendations exists in full.
- The privacy dialog, which lists every outside service. Plugins have to
  appear there.

## What a plugin is

Two kinds, declared as `kind` in the manifest and sharing one catalog, one
config schema and the same contribution points:

- **`wasm`** - a `plugin.wasm` module plus its manifest, run through Extism.
  Written in Go and compiled with TinyGo (`tinygo build -o plugin.wasm
-target wasip1 -buildmode=c-shared`); Extism's PDKs also cover Rust and,
  experimentally, Python and TypeScript. This is the normal case.
- **`service`** - no code at all, just a manifest naming a base URL. Beacon
  calls it over HTTP. The escape hatch for something that is already a
  running service, the way Groove is today, or for work too heavy to want
  inside connect's process at all.

A plugin's own dependencies are compiled into the module, so they cannot
collide with connect's and cannot differ between the Docker and desktop
builds. That is the whole reason for the runtime.

What a plugin cannot do is reach anything on its own. It has no sockets, no
filesystem, no environment - everything it touches is a **host function**
Beacon exports into it, gated by a permission the manifest had to declare.
That is what makes the sandbox real rather than a warning in the UI, and
what makes the host function surface (see [Host services](#host-services))
the main design work of the whole project.

```go
// plugin.go - built with TinyGo, target wasip1
package main

import "github.com/extism/go-pdk"

//export nd_recommendations
func recommendations() int32 {
    // pdk.NewHTTPRequest only reaches hosts the manifest allowlisted;
    // config values come from the JSON Schema the manifest declares.
    user := pdk.GetConfig("username")
    req := pdk.NewHTTPRequest(pdk.MethodGet,
        "https://api.listenbrainz.org/1/cf/recommendation/user/"+user+"/recording")
    pdk.OutputJSON(parse(req.Send().Body()))
    return 0
}
```

A sketch, not a fixed API. The point is the size: a plugin is a couple of
dozen lines, not an application.

What a plugin does **not** deliver is presentation. It returns data and
declarations - a list of artists, a menu entry, a config field with a type
and a default. Beacon's own components render it, per `docs/styleguide.md`.
That costs expressiveness and keeps the UI consistent; as a side effect
plugins cannot make the app ugly.

## Borrowed from Jellyfin

Jellyfin does not take a GitHub repo URL, it takes a **manifest URL** - a
`manifest.json`, usually hosted on GitHub, acting as a catalog. A zip from a
release is installed, verified against a checksum, unpacked into a folder
per plugin and version. The management layer around that is proven and worth
copying; the runtime underneath it is .NET and does not transfer.

| Jellyfin                                                   | For Beacon       | Why                                                                                               |
| ---------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| Manifest URL as the source, `versions[]` per plugin        | take             | A catalog anyone can host on GitHub Pages or as a raw file, without Beacon having to know GitHub  |
| Zip from the release plus checksum                         | take             | But sha256 instead of MD5 - Jellyfin's MD5 is legacy                                              |
| Folder `{name}_{version}`, manifest on disk                | take             | Makes downgrades and keeping versions side by side trivial                                        |
| `targetAbi` as the compatibility gate                      | take             | As our own `apiVersion`, separate from Beacon's version number                                    |
| Status lifecycle, restart to activate                      | take             | Covers the cases one otherwise learns the hard way                                                |
| Only load DLLs present in the folder _and_ in the manifest | take             | Path traversal defense; here it means the manifest names the one `plugin.wasm` that may be loaded |
| `AssemblyLoadContext` per plugin                           | superseded       | The wasm sandbox isolates more thoroughly than a load context does                                |
| Config pages as shipped HTML                               | deliberately not | Third-party markup in the Electron renderer is a different category from a browser dashboard      |

Worth noting: even Jellyfin only runs third-party code in the backend.
`IHasWebPages` provides an admin dashboard page and nothing else; real user
facing pages need a third-party plugin that builds its way around that. The
client UI is officially not extensible there, and that is a decision rather
than a gap.

## Borrowed from Navidrome

Navidrome solved the same problem the other way round, and it is worth
reading before committing to anything here. A plugin there is an `.ndp`
file, a zip holding `manifest.json` and `plugin.wasm`, executed as
WebAssembly through Extism on the wazero runtime. Plugins are written in Go
(TinyGo), Rust, and experimentally Python or TypeScript, and compiled to
WASM.

That runtime choice buys two things this concept says are impossible in
Python: a **real sandbox** (no network listeners, no filesystem beyond
declared mounts, memory capped by the runtime) and **dependency isolation**
(a plugin's dependencies are compiled into the module and cannot collide
with the host's).

What it costs is the authoring bar. Writing a plugin means a compile
toolchain and a language nobody in a Vue/Python project necessarily has at
hand, and every host call crosses a serialization boundary. Everything that
crosses it is plain JSON: no live objects, no `session`, no client instance.
That is a constraint rather than a cost, and a healthy one - it is also what
would make a later move to a different runtime a change of transport rather
than a redesign.

**The verdict: take it.** Go with TinyGo is the primary target; Rust works
through the same PDK, and the experimental Python and TypeScript PDKs exist
for anyone who prefers them. The alternative that was weighed against it -
plugins as Python packages inside connect - trades a real sandbox and real
dependency isolation for a lower authoring bar, and both of those turn out
to be the things worth having when the plugins come from strangers on
GitHub. See [What constrains the design](#what-constrains-the-design) for
what hosting the runtime costs on Beacon's side.

What to take from their design beyond the runtime itself:

| Navidrome                                                                                                                          | For Beacon                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permissions declared in the manifest, each with a `reason` string and, for HTTP, a host allowlist                                  | Take, and enforce it: a wasm plugin has no sockets of its own, so the allowlist is a real gate rather than a promise. The `reason` string is what the settings UI and the privacy dialog show |
| Config as JSON Schema (draft-07) plus an optional UI schema                                                                        | Take instead of inventing a field-type list of our own                                                                                                                                        |
| Plugin id is the filename, not the manifest name - two copies with different configs are just two files                            | Take. Two Last.fm accounts, or a test alongside a live one, cost nothing                                                                                                                      |
| A `Matcher` host service: "ID > MBID > ISRC > fuzzy title", optionally scoped to a user so favorites and ratings influence ranking | Take as the ladder the `library` host function implements. This document reached the same conclusion independently; there it is already built once                                            |
| Hard limits: 10 MB per HTTP response, 10 s timeout, 5 redirects                                                                    | Take the numbers rather than inventing them                                                                                                                                                   |
| Capabilities auto-detected from exported function names                                                                            | Skip. Explicit `contributes` in the manifest is easier to filter a catalog on                                                                                                                 |
| No central registry at all - drop the file in a folder, run a rescan                                                               | Worth weighing against Jellyfin's catalog. See the open question on a default catalog                                                                                                         |

### The overlap worth noticing

Navidrome's own capability list is server-shaped: `MetadataAgent`,
`Scrobbler`, `Lyrics`, `SonicSimilarity`. Those feed Navidrome's provider
layer, which is what answers `getArtistInfo2`, `getSimilarSongs2` and
`getTopSongs` - endpoints Beacon already proxies and, in the case of
`getSimilarSongs2`, already consumes for Song Radio, Artist Radio and
autoplay.

So for a Navidrome user, a Last.fm or ListenBrainz recommendation source may
belong in a **Navidrome** plugin, not a Beacon one: written once, it reaches
Beacon through the proxy for free. Worth checking before building stage 0 -
consuming `getArtistInfo2` (biography, similar artists, images) may be
cheaper than the MusicBrainz path in `core/recommendations.py`.

It does not remove the need for Beacon's own path, though. Jellyfin and Plex
users get nothing from a Navidrome plugin, and that asymmetry is precisely
why `core/recommendations.py` exists in the first place.

## Host services

A plugin reaches the outside world only through functions Beacon exports
into it, each gated by a manifest permission. Designing that surface is the
main work of the project: it is the part that is public, versioned and
impossible to take back.

The temptation is to keep it small and let plugins carry their own
libraries. The concrete case argues the other way. Matching Last.fm
recommendations against Navidrome is what Groove does with `tunesynctool`,
which pulls in `click`, `musicbrainzngs`, `py-sonic`, `spotipy`,
`streamrip`, `thefuzz`, `tqdm` and `ytmusicapi` - 84 packages in its lock
file. A wasm plugin could compile a Go equivalent of all that into itself,
and it would still be wrong, because the heavy parts are Beacon's job:

- **Media server access.** `media/base.py` defines a `MediaClient` protocol
  that `SubsonicClient`, `JellyfinClient` and `PlexClient` implement, and
  every session holds one as `session.media`. A plugin talking to Navidrome
  itself would need credentials of its own and would simply not work for
  Jellyfin and Plex users. Groove needs `py-sonic` because it has no such
  abstraction; Beacon has one.
- **Matching names to library entries.** One implementation that behaves the
  same for every plugin beats one per plugin, and it is the part that needs
  a test suite.
- **MusicBrainz.** `core/recommendations.py` already resolves names to
  MBIDs, with the rate-limit etiquette and the disk cache.

So the host surface carries those as batteries, and a plugin stays a thin
adapter:

| Host function | Permission | What it does                                                                                                                |
| ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `http`        | `http`     | Outbound request, restricted to the hosts the manifest declared. 10 MB cap, 10 s timeout, 5 redirects - Navidrome's numbers |
| `library`     | `library`  | Search the session's media server, and match external songs: id, then MBID, then ISRC, then fuzzy title                     |
| `musicbrainz` | `http`     | Name to MBID, served from `core/recommendations.py`'s existing cache rather than each plugin re-resolving                   |
| `cache`       | none       | TTL storage scoped to the plugin                                                                                            |
| `log`         | none       | Writes under `connect.plugin.<id>`                                                                                          |

Config values are not a host function: Extism hands them in at
instantiation, from the JSON Schema the manifest declares.

A Last.fm plugin on top of this is exactly what the sketch above shows -
fetch, return names, let Beacon do the rest - and gets Jellyfin and Plex
support for free, which a plugin talking to Navidrome directly never would.

For the case that genuinely wants a large runtime of its own (audio analysis
and the like), the answer is a `service` plugin: the manifest declares a
base URL, the user runs the thing in their own container, and Beacon speaks
the same contribution points to it over HTTP.

## Catalog and manifest

A catalog URL is entered in the settings. Behind it sits a static JSON file,
not a service and nothing that has to run. Beacon reads it, filters on its
own `apiVersion` and shows what is installable.

```json
{
  "catalog": "1",
  "plugins": [
    {
      "id": "listenbrainz-recs",
      "kind": "wasm",
      "name": "ListenBrainz recommendations",
      "summary": "Personal suggestions on the home page",
      "author": "…",
      "homepage": "https://github.com/…",
      "contributes": ["recommendations.shelf"],
      "permissions": {
        "http": {
          "reason": "Fetches your recommendations from ListenBrainz",
          "hosts": ["api.listenbrainz.org"]
        },
        "library": { "reason": "Finds the suggested tracks in your library" }
      },
      "versions": [
        {
          "version": "1.2.0",
          "apiVersion": "1",
          "sourceUrl": "https://github.com/…/releases/download/v1.2.0/plugin.zip",
          "sha256": "9f2c…",
          "changelog": "Suggestions can now be limited to your own country",
          "released": "2026-09-01"
        }
      ]
    }
  ]
}
```

The zip carries `plugin.wasm` and the same description again as
`plugin.json`, plus the config schema (JSON Schema draft-07) Beacon builds
its settings form from. On a conflict the catalog wins for display fields
and the packaged manifest wins for `permissions` and the module name - those
are statements about the artifact and must not be widened from outside it.
A catalog asking for more than the package declares is a rejected install,
not a merge.

## Installing

1. **Read the catalog** and filter on our own `apiVersion`. What does not
   fit is never offered in the first place.
2. **Download the zip** from `sourceUrl`, with a size cap and a timeout.
3. **Verify sha256** against the catalog entry. A mismatch aborts; it is not
   a warning.
4. **Unpack** into `$CONNECT_DATA_DIR/plugins/{id}_{version}/`, checking
   archive paths against traversal.
5. **Write the manifest**: `plugin.json` from the package, enriched with
   origin, checksum and install time. Permissions come from the package, not
   from the catalog.
6. **Show what it may do** and let the user confirm: the declared
   permissions with their `reason` strings, and the hosts it will contact.
7. **Restart connect** to activate. Until then the state is `restart`, which
   lives in memory only and is never written to disk.
8. **Instantiate** the one `plugin.wasm` the manifest names, with only the
   host functions its permissions allow. Any failure marks the plugin
   instead of taking connect down with it.

Whether activation really needs a restart is worth revisiting once the
runtime is in: instantiating a wasm module has none of the problems
importing a Python package has, so hot-loading may turn out to be free.
Assume the restart until measured.

An update is the same sequence into a new folder; the old version stays
until the new one has started successfully. Uninstalling marks the folder
`deleted` and removes it on the next start - deleting a file that is
currently mapped is a bad idea on Windows anyway.

## States

Taken from Jellyfin because they cover the cases that actually occur. Each
one needs its own line in the settings UI; a plugin that silently does
nothing is the worst of them.

| State           | Meaning                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| `active`        | Loaded and running                                                                       |
| `disabled`      | Installed but switched off by the user. Never instantiated                               |
| `restart`       | Just installed or updated. In memory only, never persisted                               |
| `unsupported`   | The `apiVersion` does not match this Beacon version                                      |
| `malfunctioned` | Instantiation or a required export failed. With the error in the UI, not only in the log |
| `superseded`    | A newer version of the same id is installed                                              |

Two runtime rules that are not states but matter as much: every call into a
plugin has a timeout, and a plugin that repeatedly errors is stood down for
the session. A hanging plugin must not hold up the home page.

## Contribution points

Every contribution point is a frozen data shape. So: as few as possible, and
none of them before it has two consumers.

**`recommendations.shelf`** - the plugin returns a list of artist, album or
track names with an optional MBID. Beacon matches against the library and
renders a shelf on the home page, exactly like the existing discover
shelves. The expensive part is not the shelf but matching names against the
media server; Groove has a module with its own test suite for that, and it
did not come free. Navidrome's matcher settles the ladder to implement:
id, then MBID, then ISRC, then fuzzy title.

**`library.action`** - an entry in the context menu of an artist, album or
track ("Search in Lidarr", "Fetch via slskd"). The plugin receives the
object, returns a status message, Beacon shows a toast. No dialog, no page
of its own.

**Config** - not a point of its own but part of every plugin: a JSON Schema
(draft-07) in the manifest, borrowed from Navidrome rather than invented
here. Beacon builds the form from it and stores the values through
`core/account_settings.py`, so they follow the account; Extism hands them to
the plugin at instantiation. Secrets are never handed back out to the UI.

Deliberately left out: creating playlists is **not** a contribution point.
Groove writes into Navidrome directly today and should keep doing so; Beacon
only has to reload its playlists afterwards. Routing that through Beacon
would mean pulling the whole matching question into the core.

## API versioning

A plugin targets `apiVersion`, not Beacon's version number. It is a single
integer that only changes when a contribution point changes, not per
release. A plugin declaring `"apiVersion": "1"` runs on every Beacon version
that still serves 1.

Beacon may carry more than one. When 2 arrives, 1 stays served for at least
one minor version, and the UI tells the user which plugin needs an update.
New optional fields in a data shape do not raise the number; only removing
or repurposing does.

## Security

The runtime is what makes this section short. A wasm plugin has no sockets,
no filesystem, no environment and no way to reach connect's own objects - it
can call exactly the host functions Beacon exports, and each of those is
gated by a permission the manifest declared. Memory is capped by the runtime.
A plugin cannot open a listener, cannot read `delivery/credentials.py`, and
cannot talk to a host that is not on its own allowlist.

That turns the permission block from a promise into a gate, and it is what
the settings UI shows before an install: which permissions, and the `reason`
string for each. The privacy dialog lists every installed plugin with the
hosts it declared, the same way it lists Beacon's own outside services.

What the sandbox does **not** cover, and what must not be forgotten:

- **What Beacon hands over.** A `library` permission means the plugin sees
  library content. That is data leaving through a door Beacon opened, and no
  runtime prevents it - only the permission model does, which is why
  permissions are per plugin and shown before installing.
- **`service` plugins.** Those run wherever the user put them, outside all
  of this. They get the allowlist and the privacy entry, and nothing else.
- **The catalog itself.** Nothing above says the code does what it claims,
  only what it may touch. Jellyfin's answer is a curated repo plus a warning
  on foreign sources, and that stays the answer here: a default catalog the
  maintainer actually looks at, and a clear warning when someone adds
  another one.

## Stages

Estimates are focused work including tests, five locales and changelog.

| Stage            | Content                                                                                                                                                | Effort   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 0 - groundwork   | ListenBrainz recommendations built into `core/recommendations.py`, shelf on the home page. Becomes the first consumer later                            | 1-2 days |
| 1 - runtime      | Extism pinned and wired in, native library collected by PyInstaller, plugin calls off the event loop, and a packaged build on each platform proving it | 2 days   |
| 2 - catalog      | Read and filter the manifest, install, update, uninstall, checksum, version folders, states                                                            | 2-3 days |
| 3 - host surface | The host functions above, permission gating, the allowlist, per-call limits, stand-down after repeated failure                                         | 3 days   |
| 4 - points       | `recommendations.shelf` and the config schema, including library matching                                                                              | 2-3 days |
| 5 - surface      | Settings area: catalog, install, permissions shown before installing, states, configuration, i18n x5                                                   | 2 days   |
| 6 - docs         | Go template repo that builds a working plugin, API reference, versioning policy, privacy dialog entry                                                  | 2 days   |

Stage 7 would be `library.action` for slskd and Lidarr, one to two days once
everything above stands. That second case is the entire reason for having a
system at all, so it should not come last - design it alongside stage 4.

Stage 1 is the one to do first and to timebox. If collecting the native
library into the PyInstaller build turns into a fight on any platform, that
is the moment to reconsider the runtime, not after the host surface is
written on top of it.

## Non-goals

- **No third-party JavaScript in the renderer.** Plugins deliver data and
  declarations, never markup or frontend code.
- **No sandbox illusion.** Better no boundary and a clear warning than a
  boundary that is not one.
- **No host function without a permission.** Anything a plugin can reach is
  declared in its manifest and shown before installing. A convenience that
  bypasses that is not a convenience.
- **No second path for Docker.** What does not work in the desktop build
  works nowhere - that requirement is what chose the runtime in the first
  place.
- **No playlist creation by Beacon.** See above.
- **Nothing but plain data across the plugin boundary.** The runtime enforces
  it anyway; keeping it true in the API's shape is what would make a later
  change of runtime a change of transport rather than a redesign.
- **No plugin auto-update.** Third-party code that updates itself is exactly
  what one does not want. Beacon shows that a new version exists.

## Open questions

- **Is there a default catalog?** Without one the feature is empty for most
  users and every install starts with pasting a foreign URL. With one, the
  maintainer takes on a curation role indefinitely. Note that the two prior
  arts disagree: Jellyfin ships a catalog, Navidrome has no registry at all
  and expects the file to be dropped into a folder.
- **Per server or per account in the Docker build?** Plugins are installed
  server-side while settings follow the account. With several users on one
  server, "who may install" is a real question.
- **Who watches the runtime pin?** `extism-sys` is pinned deliberately (see
  [What constrains the design](#what-constrains-the-design)). Someone has to
  notice when its platform matrix is healthy again, or when it stops being
  maintained - that is a standing task, not a one-off decision.
- **Is the restart requirement acceptable?** It makes the loader
  substantially simpler and is one click in the desktop build. The
  alternative is loading and unloading modules at runtime, which is its own
  building site in Python.
- **How far does library matching have to go?** A shelf is fine with loose
  name matching. Anything that should later turn suggestions into a playlist
  needs the strict variant, which is a piece of work with its own test suite.

## Sources

- <https://jellyfin.org/docs/general/server/plugins/>
- <https://deepwiki.com/jellyfin/jellyfin/8-plugin-system>
- <https://github.com/danieladov/JellyfinPluginManifest/blob/master/manifest.json> (example manifest)
- <https://github.com/IAmParadox27/jellyfin-plugin-pages> (what user-facing plugin pages need there)
- <https://github.com/navidrome/navidrome/blob/master/plugins/README.md> (Navidrome's plugin system: manifest, permissions, host services)
- <https://github.com/navidrome/navidrome/pull/4833> (the PR that introduced it, with the multi-language PDK rationale)
