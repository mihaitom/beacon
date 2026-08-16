# Beacon

> A self-hosted music client for Navidrome, Subsonic / OpenSubsonic, and (experimentally) Jellyfin and Plex — with built-in casting to Sonos, AirPlay, Chromecast, and DLNA/UPnP devices.

<p align="center">
  <a href="https://github.com/mihaitom/beacon/actions/workflows/test-python.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/mihaitom/beacon/test-python.yml?branch=development&style=flat-square&label=backend%20tests" alt="Backend tests">
  </a>
  <a href="https://github.com/mihaitom/beacon/actions/workflows/test-frontend.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/mihaitom/beacon/test-frontend.yml?branch=development&style=flat-square&label=frontend%20tests" alt="Frontend tests">
  </a>
  <a href="https://github.com/mihaitom/beacon/commits/development">
    <img src="https://img.shields.io/github/last-commit/mihaitom/beacon?style=flat-square&color=blue" alt="Last commit">
  </a>
</p>

> **Development note:** This project is developed with AI assistance. Please expect rough edges and report issues if you encounter them.

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

*(Drop PNGs into `docs/screenshots/` under these filenames and they'll show up here.)*

---

## Why Beacon?

Beacon grew out of [Feishin Connect](https://github.com/mihaitom/feishin-connect), my own fork of [jeffvli/feishin](https://github.com/jeffvli/feishin) — a general-purpose Electron/React music player — that added a Python casting backend (`connect/`) as a feature bolted onto it (a button in the player bar). That backend, a real self-contained FastAPI service discovering cast devices, streaming to them, and tracking playback state on its own, turned out to be the part worth building on. But building on top of it meant building *around* Feishin: every change had to fit inside an app and a codebase designed for a different purpose, and that got harder, not easier, the more `connect` grew into its own thing.

Beacon is `connect` as the actual foundation instead of an add-on — a frontend built spec
ifically for it, not retrofitted onto one. Every playback action (local *and* cast) goes
through the same session, the same clock, the same auth token, instead of two loosely-con
nected halves of an app. The frontend is a from-scratch Vue 3 rebuild rather than carryin
g along Feishin's inherited React codebase and its full general-purpose feature surface.
What that's bought so far: multi-user sessions where independent logins on the same deplo
yment get independent playback to independent devices at the same time, a lyrics/visualiz
er sync calibrated against each cast device's own real position rather than a fixed guess
, and a login/session model that treats Jellyfin and Plex as first-class server types ins
tead of an afterthought.

---

## Features

- **Sign in with Navidrome, Subsonic/OpenSubsonic, or (experimentally, see below) Jellyfin or Plex**, and stay signed in across restarts.
- **Browse your library** — Albums, Artists, Tracks, Genres, Playlists, Favorites, and search, all with local filtering across the whole library.
- **A proper Home** — quick access to what you've been listening to, most played tracks, recently added albums, and something new to try.
- **A Stats page** — library and listening totals, top tracks/artists/albums/genres, format and decade breakdowns.
- **Local playback** — queue, shuffle, repeat, seek, volume, multiselect (bulk queue/playlist actions), starring and rating tracks, ReplayGain (track/album gain), synced/unsynced lyrics, a fullscreen Now Playing view, and a real-time frequency visualizer (local playback and casting alike).
- **Casting to Sonos, AirPlay, Chromecast, and DLNA devices** — including casting to several at once, taking over a device someone else is using (with a confirmation prompt), and per-device volume control. AirPlay 2 pairing is handled for devices that require it (HomePods, Apple TVs).
- **Multi-user** — different logins on the same deployment each get independent playback to independent devices at the same time.
- **Internet radio stations** — add, play, and manage your own, with favicon lookup.
- **Trigger a Navidrome library rescan** from Settings, with a completion notice.
- **German and English UI**, detected automatically and switchable anytime in Settings.

Not yet built: a mobile-friendly remote-control server — see `TODO.md`.

### Jellyfin and Plex support (experimental)

Jellyfin and Plex can both be selected as a server type at login. Neither has a Subsonic-compatible API of its own, so the `connect` backend translates Subsonic-shaped requests into real Jellyfin/Plex API calls on the fly (see `connect/media/jellyfin_bridge.py` and `connect/media/plex_bridge.py`) — the frontend doesn't know the difference. Library browsing and playlists work on both; Jellyfin also has favorites, Plex also has personal 1–5 star ratings — each backend gets whichever of the two it actually supports, rather than faking the other. Internet radio stations work on both too (hosted by `connect` itself, since neither Jellyfin nor Plex has a concept of them). Features a given backend has no equivalent for are hidden automatically rather than shown as dead-end controls. Both paths are newer and less exercised than the Navidrome/Subsonic one; expect rough edges — see `PLEX_PLAN.md` for Plex's own rollout status.

---

## Docker (recommended)

> **`network_mode: host` is required.** The Connect backend discovers Sonos, AirPlay, Chromecast, and DLNA devices via mDNS/SSDP multicast, which only works when the container shares the host's network stack. Without it, no devices will be found. Host networking is Linux-only — on Mac or Windows, run the backend natively instead.

> [!CAUTION]
> **Not designed to be exposed to the open internet on its own.** This deployment expects an authentication layer in front of it (e.g. Authentik, Authelia, or a reverse proxy with basic auth) if it's reachable from outside your local network. Your media server's own login is not a substitute for that.

```yaml
services:
    beacon:
        container_name: beacon
        image: ghcr.io/mihaitom/beacon:latest # or `build: .` from a local checkout
        restart: unless-stopped
        network_mode: host
        volumes:
            - ./data:/data
```

That's it — Beacon asks for your server URL, username, and password on first launch; nothing needs to be pre-configured. See the environment variables below for optional locking, LAN optimization, and SSO scenarios.

**Mount a volume at `/data`** to keep AirPlay 2 pairings — and, for Jellyfin/Plex sessions, your internet radio stations — across container recreations/updates.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_PORT` | `9180` | Port nginx (the Beacon web UI) listens on. Change if `9180` is already taken on the host. |
| `PORT` | `9181` | Port the Connect API (Python backend) listens on. Change if `9181` is already in use — nginx still proxies `/api/` to whatever `PORT` is set to, no other change needed. |
| `CONNECT_TOKEN` | *(random per start)* | Secret token protecting the Connect API. If unset, a random one is generated each start — nginx adds it to every internal request automatically, so the browser never handles it directly. Only set this explicitly if something needs to call the API directly, bypassing nginx, with a token that survives restarts. |
| `CONNECT_DATA_DIR` | `/data` in Docker | Directory persistent backend files are stored in — AirPlay 2 pairing credentials, and (Jellyfin/Plex sessions only) internet radio stations. Docker already defaults this to `/data`; just mount a volume there. |
| `NAVIDROME_INTERNAL_URL` | — | An alternate, more directly reachable address for Navidrome than whatever URL you log in with. **Navidrome/Subsonic only** — see `JELLYFIN_INTERNAL_URL` below for the Jellyfin equivalent; Plex has none (its server address comes from Plex's own account-based discovery, not a URL you type in). Only matters for **casting**: audio always streams through Beacon's own `/stream` endpoint regardless of server type, but cast devices (Sonos/Chromecast/AirPlay/DLNA) fetch *cover art* directly from the media server, not through Beacon. If you ever log in from a different network than your cast devices are on (e.g. a public URL from your phone while out, then casting to a speaker at home), this gives those devices a fixed, LAN-reachable address for that cover art instead of round-tripping through the public URL. Not needed if you always log in from the same network your devices are on — see the note below. |
| `JELLYFIN_INTERNAL_URL` | — | Same idea as `NAVIDROME_INTERNAL_URL` above, for Jellyfin sessions. A separate variable rather than reusing `NAVIDROME_INTERNAL_URL` for both — a Jellyfin session checked against a Navidrome-shaped internal address always failed (Navidrome has no `/Users/Me` endpoint for Jellyfin's own login check to hit). |
| `SERVER_URL` | — | The server's public-facing identity. Used only for the `SERVER_LOCK` allow-list and to prefill the login screen — never proxied. |
| `SERVER_LOCK` | `false` | When `true`, the login screen shows only username/password — server URL and type are fixed to `SERVER_URL` (or `NAVIDROME_INTERNAL_URL` as a fallback) and `SERVER_TYPE`. |
| `SERVER_TYPE` | `subsonic` | What kind of server `SERVER_URL`/`SERVER_LOCK` point at — `subsonic` (covers Navidrome), `jellyfin`, or `plex`. Only meaningful together with `SERVER_LOCK=true`. |
| `ALLOWED_ORIGINS` | — | Extra CORS origins for the Connect API, comma-separated. Not needed in standard Docker deployments — browser and API share the same domain via nginx, so requests are same-origin and CORS never applies. Only relevant if the backend is reached from a different origin than the page. |
| `DEBUG` | `false` | Logs everything — AirPlay, Sonos, the internal streamer, `httpx`/`uvicorn.access`, nginx access logs — plus serves the Connect API's docs at `/api/docs`. A lot of output; leave `false` for normal operation. |

> `NAVIDROME_INTERNAL_URL` doesn't need a Docker Compose service name (e.g. `http://navidrome:4533`) — with `network_mode: host` there's no Docker bridge network for that to resolve on. If Navidrome runs on the same host, point this at its directly-reachable address instead, e.g. `http://localhost:4533`.

### Requirements

- Navidrome, a Subsonic/OpenSubsonic-compatible server, or Jellyfin/Plex (experimental — see above)
- Sonos, AirPlay, Chromecast, and/or DLNA/UPnP devices on the same network as the Docker host, if you want to cast
- Docker host on Linux (host networking is Linux-only)

---

## Electron (desktop app)

The Connect backend starts and stops automatically alongside the Electron app — no separate Python installation needed in the packaged build. Its port is selected dynamically at startup (from 9181), so it never conflicts with anything else already using that port.

**Development** (Node with pnpm, and Python with [uv](https://docs.astral.sh/uv/) for the backend):

```bash
pnpm install
pnpm run dev   # starts both the Connect backend (uv run python main.py) and Electron
```

**Packaging** (builds the Connect backend into a standalone binary via PyInstaller first, then the Electron app):

```bash
pnpm run package        # current platform
pnpm run package:linux  # or publish:linux / publish:mac / publish:win, etc. — see package.json
```

Users need **ffmpeg** installed on their system (`apt install ffmpeg` / `brew install ffmpeg` / download from [ffmpeg.org](https://ffmpeg.org/download.html) on Windows) — it is not bundled.

**Persistent backend data** (AirPlay 2 pairing credentials, Jellyfin/Plex internet radio stations) lives in Electron's standard per-user data directory, which survives app updates:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\Beacon` |
| macOS | `~/Library/Application Support/Beacon` |
| Linux | `~/.config/Beacon` |

### Web build (no Electron)

```bash
pnpm run build:web   # or vite's own dev server for local development
```

The bare web build talks to a separately-running Connect backend (`cd connect && uv run python main.py`) — see `docker-compose.yaml`'s comments and `connect/.env.example` for the environment variables it reads.

---

## Navidrome/Jellyfin behind SSO (Authentik etc.)

**Not Plex.** Plex doesn't use a URL you type in at all — the server address comes from Plex's own account-based discovery (`list_resources()`), which already prefers a local, LAN-reachable connection over a remote one when it finds one. An SSO-style internal-URL override wouldn't have anything to plug into there.

The browser itself is never the problem: it always talks to Beacon's own Connect backend (`services/subsonic/client.ts` proxies every request), never to the media server directly, regardless of SSO. The actual issue is the *Connect backend's own* outbound requests — if your Navidrome or Jellyfin is protected by an SSO layer (e.g. Authentik forward auth via Traefik/nginx), Connect's requests get intercepted and redirected to the SSO login page too, same as a browser's would be, since Connect only authenticates with your real Navidrome/Jellyfin credentials, not the SSO layer. `NAVIDROME_INTERNAL_URL`/`JELLYFIN_INTERNAL_URL` gives Connect (and, for Navidrome, cast devices fetching cover art directly too — see that row) a second, SSO-free address to reach the media server on, separate from the public URL used for login/identity.

**Setup:**

1. Set `NAVIDROME_INTERNAL_URL` (or `JELLYFIN_INTERNAL_URL`) to the address where the media server is reachable without SSO, e.g. `http://localhost:4533` if it's on the same host as Beacon (see the note under Environment variables above — Docker Compose service names don't resolve with `network_mode: host`).
2. Set `SERVER_URL` to Beacon's own public URL (not the media server's):
   ```yaml
   - SERVER_URL=https://beacon.example.com
   ```
3. The media server itself no longer needs to be reachable from the browser at all — Beacon is the only entry point.

**Note:** This isn't needed if the media server is already reachable from wherever you log in (publicly reachable, or on the same network as the browser). In that case, leave the internal-URL variable unset — Beacon just uses whatever URL you log in with.

---

## FAQ

### ffmpeg required

Beacon uses **ffmpeg** to transcode the audio stream into a continuous MP3 stream for **Sonos, Chromecast, and DLNA**, which pull it over HTTP. (AirPlay doesn't use ffmpeg — the track is downloaded directly from the media server and streamed via pyatv.) It's already included in the Docker image; see Electron above for desktop installs. If ffmpeg is missing, the connect log prints a warning on startup, and casting to Sonos/Chromecast/DLNA fails.

### No devices found

Ensure the container is running with `network_mode: host`. Without host networking, mDNS/SSDP multicast packets can't reach the container and no devices will be discovered.

### My Sonos speaker doesn't appear under AirPlay

That's intentional. Sonos speakers advertise AirPlay 2 but require MFi hardware authentication that the AirPlay backend (pyatv) can't perform, so they're filtered out of the AirPlay list — use the dedicated **Sonos** output instead, where they appear with full volume and grouping support.

### Troubleshooting casting

Set `DEBUG=true` (see Environment variables above) — it logs everything, so expect a lot of output.

---

## Development

Built with Vue 3 (Options API) + Vuetify + Pinia on the frontend, and Python/FastAPI (`connect/`) on the backend. Uses [electron-vite](https://github.com/alex8088/electron-vite) and pnpm.

- `pnpm run dev` — start frontend + backend for development
- `pnpm run type-check` — type-check the frontend
- `pnpm run lint` — lint the frontend
- `cd connect && uv run pytest` — run the backend test suite

## License

GPL-3.0, per `package.json`.
