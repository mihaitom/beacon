---
order: 4
---

# Home automation

Home Assistant or another automation tool can watch and control Beacon's
desktop app: see what is playing, pause and skip, pick the speakers, start
playlists and stations, and use all of that in automations. A ready-made
Home Assistant integration with a dashboard lives in
[home-assistant/](../../../home-assistant/); its README walks through
installing it. This page is the Beacon side of it.

## Setting it up

In the desktop app, **Settings > Advanced > Home automation**:

1. **Create key.** The key is shown once. It stays valid across restarts
   until it is revoked or replaced by a new one. It works whether or not the
   phone remote is switched on.
2. **Fixed port** (optional). Without one, the app picks a free port on
   every start. With one, it uses that port, unless something else holds it
   at start, in which case it falls back to a free port and shows a warning
   in the same place. While the fixed port is in use, the settings show the
   address and port to enter for a setup by hand. The environment variable
   `BEACON_PORT` sets it too and wins over the setting. The setting only
   exists in the installed app; run from source, `PORT` in `connect/.env`
   decides.

Only the desktop app offers this. The web/Docker build has no desktop
playback to control.

## Finding Beacon: mDNS

While a key exists, Beacon announces itself as `_beacon._tcp.local.`, named
"Beacon on _computer name_", with its current address and port. The
announcement is withdrawn when the key is revoked or the app quits, and
follows the machine to a new address within a minute.

Home Assistant picks that up by itself, and follows the app to a new port
or address. mDNS does not cross subnets or VLANs; for those setups, set a
fixed port and enter address and port by hand (see
[Networking](networking.md#speakers-in-another-subnet-or-vlan) for what else
crosses a VLAN and what doesn't).

## Building an integration of your own

The interface underneath - authentication, the state, the commands - is
described in [Home automation API](../reference/home-automation-api.md).
