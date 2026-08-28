<p align="center">
  <img src="src/renderer/public/favicon.ico" width="72" height="72" alt="Beacon icon: a lighthouse">
</p>

# Beacon

> A self-hosted music client for Navidrome, Subsonic / OpenSubsonic, Jellyfin and Plex - with built-in casting to Sonos, AirPlay, Chromecast, and DLNA/UPnP devices.

<p align="center"><sub>Yes, that's just <code>mdi-lighthouse-on</code> tinted amber. I write backend code for a living, not logos. This is as good as the branding gets.</sub></p>

<p align="center">
  <a href="https://github.com/mihaitom/beacon/actions/workflows/test-python.yml"><img src="https://img.shields.io/github/actions/workflow/status/mihaitom/beacon/test-python.yml?branch=main&style=flat-square&label=backend%20tests" alt="Backend tests"></a>
  <a href="https://codecov.io/gh/mihaitom/beacon"><img src="https://codecov.io/gh/mihaitom/beacon/branch/main/graph/badge.svg" alt="Backend coverage"></a>
  <a href="https://github.com/mihaitom/beacon/actions/workflows/test-frontend.yml"><img src="https://img.shields.io/github/actions/workflow/status/mihaitom/beacon/test-frontend.yml?branch=main&style=flat-square&label=frontend%20tests" alt="Frontend tests"></a>
  <a href="https://github.com/mihaitom/beacon/commits/main"><img src="https://img.shields.io/github/last-commit/mihaitom/beacon?style=flat-square&color=blue" alt="Last commit"></a>
  <a href="https://github.com/mihaitom/beacon/blob/main/LICENSE"><img src="https://img.shields.io/github/license/mihaitom/beacon?style=flat-square" alt="License"></a>
</p>

> **Development note:** This project is developed with AI assistance, and is covered by an extensive automated test suite. Issue reports are welcome.

---

## Screenshots

<p align="center">
  <img src="docs/screenshots/home.png" width="800" alt="Home view">
  <br><em>Home</em>
</p>
<p align="center">
  <img src="docs/screenshots/now-playing.png" width="800" alt="Fullscreen Now Playing view with lyrics and visualizer">
  <br><em>Now Playing</em>
</p>
<p align="center">
  <img src="docs/screenshots/library.png" width="800" alt="Library browsing view">
  <br><em>Library</em>
</p>
<p align="center">
  <img src="docs/screenshots/remote.png" width="260" alt="Remote Control: controlling Beacon's local playback from a phone">
  <img src="docs/screenshots/mobile-web.png" width="260" alt="The Docker/web build's responsive mobile UI, open directly on a phone's browser">
  <br><em>Remote Control (Electron) and the responsive mobile web UI (Docker/web)</em>
</p>

---

## Why Beacon?

Beacon grew out of [Feishin Connect](https://github.com/mihaitom/feishin-connect), my own fork of [jeffvli/feishin](https://github.com/jeffvli/feishin) - a general-purpose Electron/React music player - that added a Python casting backend (`connect/`) as a feature bolted onto it (a button in the player bar). That backend, a real self-contained FastAPI service discovering cast devices, streaming to them, and tracking playback state on its own, turned out to be the part worth building on. But building on top of it meant building _around_ Feishin: every change had to fit inside an app and a codebase designed for a different purpose, and that got harder, not easier, the more `connect` grew into its own thing.

Beacon is `connect` as the actual foundation instead of an add-on - a frontend built specifically for it, not retrofitted onto one. Every playback action (local _and_ cast) goes through the same session, the same clock, the same auth token, instead of two loosely-connected halves of an app. The frontend is a from-scratch Vue 3 rebuild rather than carrying along Feishin's inherited React codebase and its full general-purpose feature surface. What that's bought so far: multi-user sessions where independent logins on the same deployment get independent playback to independent devices at the same time, a lyrics/visualizer sync calibrated against each cast device's own real position rather than a fixed guess, a login/session model that treats Jellyfin and Plex as first-class server types instead of an afterthought, and a phone that can either pair up as a dedicated remote for the desktop app or simply _be_ the player itself on the web build.

---

## Features

- **Sign in with Navidrome, Subsonic/OpenSubsonic, Jellyfin or Plex** (see below for what differs per server), and stay signed in across restarts. The server-URL field remembers previously used servers (deletable, one by one) so switching between them is one click.
- **Browse your library** - Albums, Artists, Tracks, Genres, Playlists, Favorites, and search, all with local filtering across the whole library.
- **A proper Home** - quick access to what you've been listening to, most played tracks, recently added albums, and real recommendations: a Discover shelf seeded from artists you actually play (via MusicBrainz + ListenBrainz), plus a "New to explore" shelf of similar artists not yet in your library, complete with photos and a link out. Toggleable in Settings.
- **A Stats page** - library and listening totals, top tracks/artists/albums/genres, format and decade breakdowns.
- **Local playback** - queue, shuffle, repeat, seek, volume, multiselect (bulk queue/playlist actions), starring and rating tracks, ReplayGain (track/album gain), synced/unsynced lyrics, a fullscreen Now Playing view, and a real-time frequency visualizer (local playback and casting alike). On phones and tablets, ReplayGain and the visualizer make way for playback that survives a screen lock - see the FAQ.
- **Casting to Sonos, AirPlay, Chromecast, and DLNA devices** - including casting to several at once, taking over a device someone else is using (with a confirmation prompt), and per-device volume control. AirPlay 2 pairing is handled for devices that require it (HomePods, Apple TVs). Casting auto-advances through the queue server-side, so it keeps going even if the controlling window is asleep or a phone's screen is locked.
- **Playlists** - create them (including straight from the current queue), rename, add and remove tracks, and drag tracks into a different order in your own playlists.
- **Multi-user** - different logins on the same deployment each get independent playback to independent devices at the same time.
- **Remote Control** - pair a phone to the desktop app over the LAN via QR code or PIN, no app install needed, and control local playback (Now Playing, Queue, Playlists, Tracks, Radio) from it. Electron only - see below.
- **A responsive mobile web UI** - open the Docker/web deployment directly on a phone's browser and it _is_ the player, no pairing needed.
- **Internet radio stations** - add, play, and manage your own, with favicon lookup.
- **Trigger a Navidrome library rescan** from Settings, with a completion notice.
- **Adjustable backend log level** (Trace/Debug/Info/Warning/Error) from Settings, in effect immediately, no restart needed - Debug covers Beacon's own code, Trace also turns on the third-party libraries underneath it (SoCo, pyatv, HTTP clients) for SOAP/HTTP-level detail. `LOG_LEVEL` is the env var fallback for a deployment that never comes up far enough to reach Settings.
- **Update notifications** - a dismissable/snoozable toast when a new release is out; auto-downloads in the background on Electron, links to the release on the web build.
- **German, English, Spanish, French, and Italian UI**, detected automatically and switchable anytime in Settings.

### Keyboard shortcuts

| Key                | Action                                 |
| ------------------ | -------------------------------------- |
| `Space` / `K`      | Play / pause                           |
| `←` / `→`          | Back / forward 5 seconds               |
| `Ctrl` + `←` / `→` | Previous / next track (`Cmd` on macOS) |
| `↑` / `↓`          | Volume up / down                       |
| `M`                | Mute                                   |
| `S`                | Toggle shuffle                         |
| `R`                | Cycle repeat mode                      |
| `F`                | Favorite the current track             |
| `Q`                | Show / hide the queue                  |
| `0` - `9`          | Jump to 0-90% of the track             |
| `?`                | Show this list in the app              |

They do nothing while you are typing in a field or a dialog is open, and leave a focused button or slider its own keys. The volume keys change the speaker's volume while casting to a single device, the same as the volume slider in the player bar does.

### Jellyfin and Plex support

Jellyfin and Plex can both be selected as a server type at login. Neither has a Subsonic-compatible API of its own, so the `connect` backend translates Subsonic-shaped requests into real Jellyfin/Plex API calls on the fly (see `connect/media/jellyfin_bridge.py` and `connect/media/plex_bridge.py`) - the frontend doesn't know the difference. Features a given backend has no equivalent for (or that just aren't bridged yet) are hidden automatically rather than shown as dead-end controls. Both paths are newer and less exercised than the Navidrome/Subsonic one, and a couple of things genuinely work differently there - the table below says which. Besides the usual unit tests, which can only check the bridges against Beacon's own understanding of the foreign API, there is a suite that runs them against real servers (`connect/tests/test_bridges_live.py`, excluded from the default test run): playlist creation, reordering, renaming and track add/remove, favorites, the browsing response shapes, library scans and lyrics - against Navidrome as well, since the assumptions Beacon makes about it are just as worth checking. It creates only throwaway playlists and deletes them again. What it does not cover yet is cover art and audio streaming, which take a different code path.

| Feature                                     | Navidrome / Subsonic |  Jellyfin   |              Plex              |
| ------------------------------------------- | :------------------: | :---------: | :----------------------------: |
| Library browsing, playlists, casting        |          ✅          |     ✅      |               ✅               |
| Internet radio stations                     |          ✅          |     ✅      |               ✅               |
| Play history / Stats page                   |          ✅          |     ✅      |               ✅               |
| Favorites (heart icon)                      |          ✅          |     ✅      |               ❌               |
| Personal 1-5 star rating                    |          ✅          |     ❌      |               ✅               |
| Song/Artist Radio and Autoplay              |          ✅          |     ✅      | ✅ (needs an active Plex Pass) |
| Create playlists, add/remove/reorder tracks |          ✅          |     ✅      |               ✅               |
| Lyrics stored with the file (tags or .lrc)  |          ✅          |     ✅      |         ✅ (.lrc only)         |
| Trigger a library rescan from Settings      |     ✅ (admins)      | ✅ (admins) |           ✅ (owner)           |

Lyrics are a two-step lookup everywhere: whatever is stored with the audio file itself comes first (it belongs to that exact recording), and only if there is none does Beacon search its own third-party providers - so lyrics work on all three, this row is only about the first step. Jellyfin serves the file's own lyrics to any signed-in user, from the tags or from an .lrc next to the track. Plex only reads the .lrc: a `USLT` tag that Navidrome and Jellyfin both pick up produces no lyrics there at all, verified against a live server. Where Plex finds nothing, the third-party lookup takes over exactly as it would for an untagged track.

A library rescan is administrator-only on every server Beacon speaks to - Navidrome marks `startScan` as such in its own route table, Jellyfin's API requires elevation, and Plex's section refresh is owner-only. Beacon asks the server which kind of account is signed in (Subsonic's `getUser.view`, which the two bridges answer by translating it into Jellyfin's user policy and Plex's owner-only settings endpoint) and only offers the button to an administrator; a server that doesn't answer at all leaves it visible rather than hiding something that might have worked. What the button then reports differs: Navidrome counts the tracks it has processed, while Jellyfin and Plex only know a percentage, so that is what gets shown for them.

Song/Artist Radio and Autoplay on Plex are bridged onto Plex's own Sonic Analysis feature (`/library/metadata/{id}/nearest`, the same thing "Play Similar Tracks" uses in every official Plex client) - but Sonic Analysis itself is a Plex Pass-gated feature server-side, confirmed against Plex's own support docs. Without an active Plex Pass, the buttons and the Autoplay toggle are still there, they just quietly return nothing instead of a real mix. Favorites is the one genuine dead end: Plex's core Media Server API has no separate boolean favorite at all - the heart-shaped "Love" seen in Plexamp/mobile is backed by a different, Plex Pass cloud sync API this bridge doesn't talk to, and personal ratings already cover the "mark this" use case for Plex instead.

### Remote Control (Electron) and the mobile web UI

Two different answers to "control Beacon from my phone", depending on how you run it:

- **Electron (desktop app):** Settings → Remote Control pairs a phone to _that specific, already-running_ desktop window over the LAN - scan a QR code or type in a short PIN, no app install on the phone. It relays commands to the same local playback the desktop window already has open (Now Playing, Queue, Playlists, Tracks, Radio), not to casting sessions, which already have their own independent per-device control. The pairing credential is a long random token separate from `CONNECT_TOKEN`, regenerated every time the feature is (re-)enabled, and the feature auto-disables if the desktop app goes away.
- **Docker/web:** there's no separate desktop window to pair against - the browser tab already is the player. Opening the deployment directly on a phone's browser switches to a responsive mobile layout automatically; nothing to enable.

---

## Docker (recommended)

> **`network_mode: host` is required.** The Connect backend discovers Sonos, AirPlay, Chromecast, and DLNA devices via mDNS/SSDP multicast, which only works when the container shares the host's network stack. Without it, no devices will be found. Host networking is Linux-only - on Mac or Windows, run the backend natively instead.

> [!CAUTION]
> **Not designed to be exposed to the open internet on its own.** This deployment expects an authentication layer in front of it (e.g. Authentik, Authelia, or a reverse proxy with basic auth) if it's reachable from outside your local network. Your media server's own login is not a substitute for that.

```yaml
services:
  beacon:
    container_name: beacon
    image: ghcr.io/mihaitom/beacon:latest
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./data:/data
```

That's it - Beacon asks for your server URL, username, and password on first launch; nothing needs to be pre-configured. See the environment variables below for optional locking, LAN optimization, and SSO scenarios.

**Mount a volume at `/data`** to keep AirPlay 2 pairings, your log-level setting, the recommendations cache, and (for Jellyfin/Plex sessions) your internet radio stations across container recreations/updates.

### Environment variables

| Variable                 | Default              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WEB_PORT`               | `7070`               | Port nginx (the Beacon web UI) listens on. Change if `7070` is already taken on the host.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PORT`                   | `7071`               | Port the Connect API (Python backend) listens on. Change if `7071` is already in use - nginx still proxies `/api/` to whatever `PORT` is set to, no other change needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CONNECT_TOKEN`          | _(random per start)_ | Secret token protecting the Connect API. If unset, a random one is generated each start - nginx adds it to every internal request automatically, so the browser never handles it directly. Only set this explicitly if something needs to call the API directly, bypassing nginx, with a token that survives restarts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CONNECT_DATA_DIR`       | `/data` in Docker    | Directory persistent backend files are stored in - AirPlay 2 pairing credentials, the log-level setting, the recommendations cache, and (Jellyfin/Plex sessions only) internet radio stations. Docker already defaults this to `/data`; just mount a volume there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `NAVIDROME_INTERNAL_URL` | -                    | An alternate, more directly reachable address for Navidrome than whatever URL you log in with. **Navidrome/Subsonic only** - see `JELLYFIN_INTERNAL_URL` below for the Jellyfin equivalent; Plex has none (its server address comes from Plex's own account-based discovery, not a URL you type in). Only matters for **casting**: audio always streams through Beacon's own `/stream` endpoint regardless of server type, but cast devices (Sonos/Chromecast/AirPlay/DLNA) fetch _cover art_ directly from the media server, not through Beacon. If you ever log in from a different network than your cast devices are on (e.g. a public URL from your phone while out, then casting to a speaker at home), this gives those devices a fixed, LAN-reachable address for that cover art instead of round-tripping through the public URL. Not needed if you always log in from the same network your devices are on - see the note below. |
| `JELLYFIN_INTERNAL_URL`  | -                    | Same idea as `NAVIDROME_INTERNAL_URL` above, for Jellyfin sessions. A separate variable rather than reusing `NAVIDROME_INTERNAL_URL` for both - a Jellyfin session checked against a Navidrome-shaped internal address always failed (Navidrome has no `/Users/Me` endpoint for Jellyfin's own login check to hit).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SERVER_URL`             | -                    | The server's public-facing identity. Used only for the `SERVER_LOCK` allow-list and to prefill the login screen - never proxied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SERVER_LOCK`            | `false`              | When `true`, the login screen shows only username/password - server URL and type are fixed to `SERVER_URL` (or `NAVIDROME_INTERNAL_URL` as a fallback) and `SERVER_TYPE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SERVER_TYPE`            | `subsonic`           | What kind of server `SERVER_URL`/`SERVER_LOCK` point at - `subsonic` (covers Navidrome), `jellyfin`, or `plex`. Only meaningful together with `SERVER_LOCK=true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ALLOWED_ORIGINS`        | -                    | Extra CORS origins for the Connect API, comma-separated. Not needed in standard Docker deployments - browser and API share the same domain via nginx, so requests are same-origin and CORS never applies. Only relevant if the backend is reached from a different origin than the page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LOG_LEVEL`              | -                    | Startup log verbosity - `trace`, `debug`, `info`, `warning`, or `error` (case-insensitive). Prefer the log-level dropdown in Settings instead (same five levels, persisted, in effect immediately, no restart needed) - this is only the fallback for a deployment that never comes up far enough to reach it. `debug` covers Beacon's own code only; `trace` also turns on the third-party libraries underneath it (SoCo, pyatv, `httpx`/`httpcore`, `uvicorn.access`) for SOAP/HTTP-level detail - a lot of output, so reach for it only when actually troubleshooting one of those.                                                                                                                                                                                                                                                                                                                                                     |

> `NAVIDROME_INTERNAL_URL` doesn't need a Docker Compose service name (e.g. `http://navidrome:4533`) - with `network_mode: host` there's no Docker bridge network for that to resolve on. If Navidrome runs on the same host, point this at its directly-reachable address instead, e.g. `http://localhost:4533`.

### Requirements

- Navidrome, a Subsonic/OpenSubsonic-compatible server, or Jellyfin/Plex (see above for what differs)
- Sonos, AirPlay, Chromecast, and/or DLNA/UPnP devices on the same network as the Docker host, if you want to cast
- Docker host on Linux (host networking is Linux-only)

---

## Electron (desktop app)

The Connect backend starts and stops automatically alongside the Electron app - no separate Python installation needed in the packaged build. Its port is selected dynamically at startup (from 7071), so it never conflicts with anything else already using that port.

**Development** (Node with pnpm, and Python with [uv](https://docs.astral.sh/uv/) for the backend):

```bash
pnpm install
pnpm run dev   # starts both the Connect backend (uv run python main.py) and Electron
```

**Packaging** (builds the Connect backend into a standalone binary via PyInstaller first, then the Electron app):

```bash
pnpm run package        # current platform
pnpm run package:linux  # or publish:linux / publish:mac / publish:win, etc. - see package.json
```

Users need **ffmpeg** installed on their system (`apt install ffmpeg` / `brew install ffmpeg` / download from [ffmpeg.org](https://ffmpeg.org/download.html) on Windows) - it is not bundled.

**Persistent backend data** (AirPlay 2 pairing credentials, log-level setting, recommendations cache, Jellyfin/Plex internet radio stations) lives in Electron's standard per-user data directory, which survives app updates:

| Platform | Path                                   |
| -------- | -------------------------------------- |
| Windows  | `%APPDATA%\Beacon`                     |
| macOS    | `~/Library/Application Support/Beacon` |
| Linux    | `~/.config/Beacon`                     |

### Web build (no Electron)

```bash
pnpm run build:web   # or vite's own dev server for local development
```

The bare web build talks to a separately-running Connect backend (`cd connect && uv run python main.py`) - see `docker-compose.yaml`'s comments and `connect/.env.example` for the environment variables it reads.

---

## Navidrome/Jellyfin behind SSO (Authentik etc.)

**Not Plex.** Plex doesn't use a URL you type in at all - the server address comes from Plex's own account-based discovery (`list_resources()`), which already prefers a local, LAN-reachable connection over a remote one when it finds one. An SSO-style internal-URL override wouldn't have anything to plug into there.

The browser itself is never the problem: it always talks to Beacon's own Connect backend (`services/subsonic/client.ts` proxies every request), never to the media server directly, regardless of SSO. The actual issue is the _Connect backend's own_ outbound requests - if your Navidrome or Jellyfin is protected by an SSO layer (e.g. Authentik forward auth via Traefik/nginx), Connect's requests get intercepted and redirected to the SSO login page too, same as a browser's would be, since Connect only authenticates with your real Navidrome/Jellyfin credentials, not the SSO layer. `NAVIDROME_INTERNAL_URL`/`JELLYFIN_INTERNAL_URL` gives Connect (and, for Navidrome, cast devices fetching cover art directly too - see that row) a second, SSO-free address to reach the media server on, separate from the public URL used for login/identity.

**Setup:**

1. Set `NAVIDROME_INTERNAL_URL` (or `JELLYFIN_INTERNAL_URL`) to the address where the media server is reachable without SSO, e.g. `http://localhost:4533` if it's on the same host as Beacon (see the note under Environment variables above - Docker Compose service names don't resolve with `network_mode: host`).
2. Set `SERVER_URL` to Beacon's own public URL (not the media server's):
   ```yaml
   - SERVER_URL=https://beacon.example.com
   ```
3. The media server itself no longer needs to be reachable from the browser at all - Beacon is the only entry point.

**Note:** This isn't needed if the media server is already reachable from wherever you log in (publicly reachable, or on the same network as the browser). In that case, leave the internal-URL variable unset - Beacon just uses whatever URL you log in with.

---

## FAQ

### ffmpeg required

Beacon uses **ffmpeg** to prepare the audio stream for **Sonos, Chromecast, and DLNA**, which pull it over HTTP. Whenever the source is already in a format these devices support directly (FLAC, MP3, AAC, or Ogg Vorbis), ffmpeg just stream-copies it - no re-encoding, no quality loss. Other lossless sources (ALAC, WAV/AIFF, APE) get losslessly re-encoded to FLAC instead; anything else (Opus, WMA, ...) falls back to a 192kbps MP3 re-encode. (AirPlay takes the same ffmpeg-prepared stream but is pushed to rather than pulling it, via pyatv - only a live radio URL is handed to the device untouched.) It's already included in the Docker image; see Electron above for desktop installs. If ffmpeg is missing, the connect log prints a warning on startup, and casting to Sonos/Chromecast/DLNA fails.

Settings -> Playback can cap that choice, and can also apply it to Beacon's own player. Both settings are upper limits rather than replacements: a source that already fits under one is sent untouched, so setting "MP3 320" does not re-encode a 128kbps file into a larger one. For casting, each device's own format limits still win on top. For this device's own playback the limit is also what makes ALAC, APE and other formats no browser decodes playable at all - they are always above it, so they always get converted. MP3 is the only conversion offered locally because it is the only one whose output size is predictable enough to seek in reliably; ffmpeg's AAC and Opus encoders don't hold the bitrate they're given, which would put every scrub in the wrong place. Both settings are stored per device, so a phone and a desktop can be set differently.

### Why can Beacon feel slower with Jellyfin?

Navidrome/Subsonic is the primary, most-exercised backend. Jellyfin has no Subsonic-compatible API of its own, so `connect` translates every request on the fly into real Jellyfin API calls (see `connect/media/jellyfin_bridge.py`) - and Jellyfin's own API just isn't as optimized for this access pattern as Navidrome's. That combination means library loads and scans can take noticeably longer, especially on a large library (a full track-catalog fetch can take minutes rather than seconds). This is inherent to Jellyfin/the bridge, not something Beacon's UI does differently per backend - see "Jellyfin and Plex support" above.

### No devices found

Ensure the container is running with `network_mode: host`. Without host networking, mDNS/SSDP multicast packets can't reach the container and no devices will be discovered.

### My Sonos speaker doesn't appear under AirPlay (or DLNA)

That's intentional. Sonos speakers advertise AirPlay 2 but require MFi hardware authentication that the AirPlay backend (pyatv) can't perform, so they're filtered out of the AirPlay list - use the dedicated **Sonos** output instead, where they appear with full volume and grouping support. Same idea for DLNA - Sonos also answers UPnP discovery there, and gets filtered for the same reason (the dedicated Sonos output already covers it properly). At log level Debug or louder, both filters are off, showing Sonos devices there too - useful for exercising the AirPlay/DLNA code paths themselves without owning that hardware, though actually streaming to Sonos-as-AirPlay still fails for the MFi reason above.

### Troubleshooting casting

Set the log level to Trace in Settings (or `LOG_LEVEL=trace`, see Environment variables above, if the app never comes up far enough to reach Settings) - Debug only covers Beacon's own code, Trace also turns on the SoCo/pyatv/HTTP libraries actually talking to the device, which is normally what you need for a casting issue. Expect a lot of output either way.

### Why is there no visualizer, ReplayGain or volume slider in the mobile web player?

So that the music keeps playing when the screen locks. Both features need the audio routed through the browser's Web Audio graph, and on iOS that same routing is what makes Safari treat the playback as Web Audio, which it suspends the moment the screen locks or the tab goes to the background. A plain audio element is allowed to carry on, lock screen controls included. Phones and tablets therefore play without that graph, which leaves both features out there. The volume slider goes with them: a phone browser makes an audio element's volume read-only, so that slider never did anything there in the first place - the device's own volume buttons are what changes the level. Nothing changes in the desktop app, in a desktop browser, or while casting - the visualizer's data comes from the `connect` backend during a cast, not from the phone, so it works there either way.

**Casting is unaffected by any of this** - Sonos/Chromecast/AirPlay/DLNA playback is driven entirely by the `connect` backend, independent of whether a browser tab or phone screen is even open, so locking the screen (or closing the tab) doesn't interrupt a cast already in progress.

### Why don't OS media keys / lock screen controls work while casting?

Media keys, the Windows/macOS lock screen controls, and the GNOME/KDE media widget on Linux are all driven by the browser's Media Session API, which only exposes a session to the OS while a real, audible `<audio>` element is actually playing in the tab. While casting, no audio plays locally at all - it goes straight to the Sonos/Chromecast/AirPlay/DLNA device - so there's nothing for the browser to report. Confirmed with local playback (works) vs. casting (doesn't) on both Chromium and Firefox/Gecko-based (e.g. Waterfox) browsers on Linux via `playerctl`. There's a known workaround (loop a silent `<audio>` element to keep a "real" session alive during casting) but it's fragile enough (autoplay policy quirks, volume-zero edge cases) that it's deliberately not implemented - the cast target's own controls (its companion app, physical buttons) already cover this case.

### What does the recommendations feature send where?

The Discover/"New to explore" shelves on Home resolve a handful of artist names already in your library against MusicBrainz (to get an artist ID) and ListenBrainz (to get similar artists back) - both free, no-account, no-API-key services from the MetaBrainz project. "New to explore" additionally looks up a photo and a link for artists not in your library via Deezer's public search API (also no API key) - the same source Navidrome itself defaults to for artist images. No listening history, usernames, or anything else leaves the deployment - just a short list of artist names. Turn it off entirely in Settings if you'd rather not.

---

## Development

Built with Vue 3 (Options API) + Vuetify + Pinia on the frontend, and Python/FastAPI (`connect/`) on the backend. Uses [electron-vite](https://github.com/alex8088/electron-vite) and pnpm.

- `pnpm run dev` - start frontend + backend for development
- `pnpm run type-check` - type-check the frontend
- `pnpm run lint` - lint the frontend
- `pnpm test:unit` - run the frontend unit test suite (jsdom); `pnpm test:layout` runs the real-browser layout suite alongside it
- `cd connect && uv run pytest` - run the backend test suite

## License

GPL-3.0, per `package.json`.
