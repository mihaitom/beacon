# Beacon for Home Assistant

A Home Assistant integration for the Beacon desktop app, and a dashboard
built on it. The interface underneath is described in
[docs/home-automation.md](../docs/home-automation.md).

## What you get

- **A media player**: what is playing, with cover, position and volume; play,
  pause, skip, seek, shuffle and repeat. It shows as unavailable while the
  app is closed.
- **Speakers**: the player's source, and a `Speaker` select, move playback to
  this computer or one speaker. A switch per speaker casts to several at
  once.
- **The library in the media browser**: queue, playlists, albums (by
  letter) and radio stations, plus a radio started from the current song. Songs can be played
  next or added to the queue.
- **Autoplay** as a switch, **Resume cast** as a button while a speaker has
  dropped out, **Scan for speakers**, the queue as a sensor, and a **Now
  playing** sensor whose history lists the songs themselves.
- **Discovery**: Home Assistant finds Beacon on the network and only asks
  for the key. When the app comes back on another port, the integration
  follows.

## Install

1. In Beacon: Settings > Advanced > Home automation > **Create key**.
2. Copy `custom_components/beacon` into your Home Assistant `config`
   folder, so it ends up as `config/custom_components/beacon`, and restart
   Home Assistant.
3. Settings > Devices & services: **Beacon** appears under Discovered. Add
   it and paste the key. If it does not appear (Home Assistant in another
   subnet or VLAN), add the Beacon integration by hand with the address and
   the fixed port from Beacon's settings.

## Dashboard

`dashboard.yaml` uses Home Assistant's own cards only. To use it, create a
new dashboard, open its raw configuration editor (⋮ > Edit dashboard > ⋮ >
Raw configuration editor) and paste the file in.

The entity ids in it are the ones a fresh install creates. If yours differ,
for instance because Home Assistant put the area in front, replace them:
Settings > Devices & services > Beacon lists them. Your speakers and
favourite playlists are left as commented examples; search the file for
`YOUR`.
