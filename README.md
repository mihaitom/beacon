# Beacon

> A self-hosted music client for Navidrome, Subsonic / OpenSubsonic, and (experimentally) Jellyfin — with built-in casting to Sonos, AirPlay, Chromecast, and DLNA/UPnP devices.

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

Beacon is a from-scratch Vue rebuild of [Feishin Connect](https://github.com/mihaitom/feishin-connect)'s desktop client — same Python casting backend (`connect/`), a leaner, more focused Vue 3 frontend built around Beacon's own feature set rather than upstream Feishin's. Nothing has an official release yet; see `CHANGELOG.md` for what's built so far.

> **Development note:** This project is developed with AI assistance. Please expect rough edges and report issues if you encounter them.

---

## Features

- **Sign in with Navidrome, Subsonic/OpenSubsonic, or (experimentally, see below) Jellyfin**, and stay signed in across restarts.
- **Browse your library** — Albums, Artists, Tracks, Genres, Playlists, Favorites, and search, all with local filtering across the whole library.
- **A proper Home** — quick access to what you've been listening to, most played tracks, recently added albums, and something new to try.
- **A Stats page** — library and listening totals, top tracks/artists/albums/genres, format and decade breakdowns.
- **Local playback** — queue, shuffle, repeat, seek, volume, multiselect (bulk queue/playlist actions), starring and rating tracks, synced/unsynced lyrics, and a fullscreen Now Playing view.
- **Casting to Sonos, AirPlay, Chromecast, and DLNA devices** — including casting to several at once, taking over a device someone else is using (with a confirmation prompt), and per-device volume control. AirPlay 2 pairing is handled for devices that require it (HomePods, Apple TVs).
- **Multi-user** — different logins on the same deployment each get independent playback to independent devices at the same time.
- **Internet radio stations** — add, play, and manage your own, with favicon lookup.
- **Trigger a Navidrome library rescan** from Settings, with a completion notice.
- **German and English UI**, detected automatically and switchable anytime in Settings.

Not yet built: ReplayGain (track/album gain) support, a mobile-friendly remote-control server, and Plex support — see `TODO.md`.

### Jellyfin support (experimental)

Jellyfin can be selected as a server type at login. Since Jellyfin has no Subsonic-compatible API of its own, the `connect` backend translates Subsonic-shaped requests into real Jellyfin API calls on the fly (see `connect/media/jellyfin_bridge.py`) — the frontend doesn't know the difference. Library browsing, favorites, and playlists work; internet radio stations work too (hosted by `connect` itself, since Jellyfin has no concept of them). Features Jellyfin has no equivalent for — personal 1–5 star ratings, library rescan, Track/Artist Radio, the Stats page — are hidden automatically rather than shown as dead-end controls. This path is newer and less exercised than the Navidrome/Subsonic one; expect rough edges.

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

**Mount a volume at `/data`** to keep AirPlay 2 pairings — and, for Jellyfin sessions, your internet radio stations — across container recreations/updates.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_PORT` | `9180` | Port nginx (the Beacon web UI) listens on. Change if `9180` is already taken on the host. |
| `PORT` | `9181` | Port the Connect API (Python backend) listens on. Change if `9181` is already in use — nginx still proxies `/api/` to whatever `PORT` is set to, no other change needed. |
| `CONNECT_TOKEN` | *(random per start)* | Secret token protecting the Connect API. If unset, a random one is generated each start — nginx adds it to every internal request automatically, so the browser never handles it directly. Only set this explicitly if something needs to call the API directly, bypassing nginx, with a token that survives restarts. |
| `CONNECT_DATA_DIR` | `/data` in Docker | Directory persistent backend files are stored in — AirPlay 2 pairing credentials, and (Jellyfin sessions only) internet radio stations. Docker already defaults this to `/data`; just mount a volume there. |
| `SERVER_INTERNAL_URL` | — | An alternate, more directly reachable address for Navidrome than whatever URL you log in with — only matters for **casting**: Sonos/Chromecast/AirPlay/DLNA devices fetch cover art and audio directly from Navidrome, not through Beacon. If you ever log in from a different network than your cast devices are on (e.g. a public URL from your phone while out, then casting to a speaker at home), this gives those devices a fixed, LAN-reachable address instead of round-tripping through the public URL. Not needed if you always log in from the same network your devices are on — see the note below. |
| `SERVER_URL` | — | The server's public-facing identity. Used only for the `SERVER_LOCK` allow-list and to prefill the login screen — never proxied. |
| `SERVER_LOCK` | `false` | When `true`, the login screen shows only username/password — server URL and type are fixed to `SERVER_URL` (or `SERVER_INTERNAL_URL` as a fallback) and `SERVER_TYPE`. |
| `SERVER_TYPE` | `subsonic` | What kind of server `SERVER_URL`/`SERVER_LOCK` point at — `subsonic` (covers Navidrome) or `jellyfin`. Only meaningful together with `SERVER_LOCK=true`. |
| `ALLOWED_ORIGINS` | — | Extra CORS origins for the Connect API, comma-separated. Not needed in standard Docker deployments — browser and API share the same domain via nginx, so requests are same-origin and CORS never applies. Only relevant if the backend is reached from a different origin than the page. |
| `TARGETS` | — | Pre-configure fixed cast devices without going through Beacon's UI, e.g. `sonos:Living Room,airplay:Kitchen`. |
| `DEBUG` | `false` | Verbose playback logs across all renderers (AirPlay via pyatv, Sonos via SoCo, the internal streamer), plus `httpx`/`uvicorn.access` and nginx access logs, and serves the Connect API's docs at `/api/docs`. Leave `false` for normal operation. |

> `SERVER_INTERNAL_URL` doesn't need a Docker Compose service name (e.g. `http://navidrome:4533`) — with `network_mode: host` there's no Docker bridge network for that to resolve on. If Navidrome runs on the same host, point this at its directly-reachable address instead, e.g. `http://localhost:4533`.

### Requirements

- Navidrome, a Subsonic/OpenSubsonic-compatible server, or Jellyfin (experimental — see above)
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

**Persistent backend data** (AirPlay 2 pairing credentials, Jellyfin internet radio stations) lives in Electron's standard per-user data directory, which survives app updates:

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

## Media server behind SSO (Authentik etc.)

If your media server (Navidrome, Subsonic, or Jellyfin) is protected by an SSO layer (e.g. Authentik forward auth via Traefik/nginx), the browser can't reach its API directly — every request gets intercepted and redirected to the SSO login page.

Beacon routes every media-server API call through the Connect backend, which reaches the server on the internal network, bypassing the SSO middleware entirely. Identity headers an SSO layer would normally inject (Authentik, Authelia, oauth2-proxy) are stripped before forwarding, so the media server always sees the actual Subsonic/Jellyfin credentials being sent — never the browsing user's SSO identity.

**Setup:**

1. Set `SERVER_INTERNAL_URL` to the address where the media server is reachable without SSO, e.g. `http://localhost:4533` if it's on the same host as Beacon (see the note under Environment variables above — Docker Compose service names don't resolve with `network_mode: host`).
2. Set `SERVER_URL` to Beacon's own public URL (not the media server's):
   ```yaml
   - SERVER_URL=https://beacon.example.com
   ```
3. The media server itself no longer needs to be reachable from the browser at all — Beacon is the only entry point to its API.

**Note:** This isn't needed if the media server is already reachable from wherever you log in (publicly reachable, or on the same network as the browser). In that case, leave `SERVER_INTERNAL_URL` unset — Beacon just uses whatever URL you log in with.

---

## FAQ

### ffmpeg required

Beacon uses **ffmpeg** to transcode the audio stream into a continuous MP3 stream for **Sonos, Chromecast, and DLNA**, which pull it over HTTP. (AirPlay doesn't use ffmpeg — the track is downloaded directly from the media server and streamed via pyatv.) It's already included in the Docker image; see Electron above for desktop installs. If ffmpeg is missing, the connect log prints a warning on startup, and casting to Sonos/Chromecast/DLNA fails.

### No devices found

Ensure the container is running with `network_mode: host`. Without host networking, mDNS/SSDP multicast packets can't reach the container and no devices will be discovered.

### My Sonos speaker doesn't appear under AirPlay

That's intentional. Sonos speakers advertise AirPlay 2 but require MFi hardware authentication that the AirPlay backend (pyatv) can't perform, so they're filtered out of the AirPlay list — use the dedicated **Sonos** output instead, where they appear with full volume and grouping support.

### AirPlay troubleshooting

Set `DEBUG=true` (see Environment variables above) to log the full AirPlay protocol negotiation, plus verbose Sonos and internal streamer logs.

---

## Development

Built with Vue 3 (Options API) + Vuetify + Pinia on the frontend, and Python/FastAPI (`connect/`) on the backend. Uses [electron-vite](https://github.com/alex8088/electron-vite) and pnpm.

- `pnpm run dev` — start frontend + backend for development
- `pnpm run type-check` — type-check the frontend
- `pnpm run lint` — lint the frontend
- `cd connect && uv run pytest` — run the backend test suite

## License

GPL-3.0, per `package.json`.
