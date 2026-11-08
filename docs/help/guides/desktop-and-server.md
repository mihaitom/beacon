---
order: 5
---

# Desktop app and Beacon server

The desktop app brings its own small Beacon backend, so on its own it only
knows what was played on that computer. Connected to a Beacon server of
yours, both show the same listening history on the Stats page and follow the
same settings.

Playing never waits for the server. What you hear while it is away is kept on
the computer and sent when it can be reached again.

## What is shared

- **Your listening history**, in both directions as far as the Stats page is
  concerned: the desktop app sends its plays and reads the server's.
- **Settings that belong to you:** language, equalizer presets and each
  speaker's equalizer, gapless and crossfade, table columns, lyrics providers,
  your Last.fm and ListenBrainz names and the like.

Things that belong to one computer or one installation stay there: audio
quality, this device's own equalizer, the API keys, Hue lights and casting
permissions. Your queue, favourites and playlists already live on your media
server.

## Connecting

1. Open Beacon on the server in a browser, signed in with your account, and
   go to Settings > Account > Desktop apps.
2. Give the key a name and create it. It is shown once.
3. In the desktop app, signed in with the same account, go to Settings >
   Account > Beacon server and enter the server's address and the key.

The first time, plays already on the computer are sent over, and the server's
settings replace the desktop app's wherever the server has one. A setting only
the desktop app has goes to the server.

A key belongs to exactly one account. Signed in with a different account, the
desktop app keeps that account's plays to itself and Settings says so. Each
device should get its own key, so one can be revoked without touching the
others.

## Behind a login

If Beacon sits behind Authentik, Authelia or another forward-auth,
`/device-link/` has to be let through without it, the same way as `/party/` in
[Party mode over the internet](party-over-the-internet.md#example-setups). The
desktop app says so when a login page answers instead of Beacon.

With Traefik:

```yaml
labels:
  - traefik.http.routers.beacon-device-link.rule=Host(`beacon.example.com`) && PathPrefix(`/device-link/`)
  - traefik.http.routers.beacon-device-link.priority=100
  - traefik.http.routers.beacon-device-link.service=beacon
```

Everything under that path needs a device key, and a key can only reach its
own account's history and settings. Failed attempts are rate limited by
address, which needs `TRUSTED_PROXIES` set as described under
[Client addresses](party-over-the-internet.md#client-addresses).

A server on the internet has to be reached over https. Plain http is only
accepted for addresses on your own network.

## Disconnecting

Disconnecting in the desktop app leaves everything on the computer as it is.
Settings the server had already replaced do not come back. Revoking the key on
the server stops the desktop app from sending, and it says so in Settings.

While connected, importing from Last.fm or ListenBrainz happens on the server,
since that is the history being shown.
