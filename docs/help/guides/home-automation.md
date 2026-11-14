---
group: connecting
order: 3
---

# Home automation

Home Assistant or another automation tool can watch and control Beacon:
see what is playing, pause and skip, pick the speakers, start playlists and
stations, and use all of that in automations. On the desktop app that is its
own playback; on a server, the account's music on speakers. A ready-made
Home Assistant integration with a dashboard lives in
[home-assistant/](../../../home-assistant/); its README walks through
installing it. This page is the Beacon side of it.

## Setting it up

In Beacon, **Settings > Account > Apps and devices**, on the desktop app or
in a browser on the server:

1. **New key**, **Own app**, with **Steer playback** switched on, and
   **Browse the library and start music** for picking playlists, albums and stations. The
   key is shown once and belongs to the account it was made in.
2. **On the desktop app: a fixed port** (optional), in the same place.
   Without one, the app picks a free port on every start. With one, it uses
   that port, unless something else holds it at start, in which case it
   falls back to a free port and shows a warning there. The environment
   variable `BEACON_PORT` sets it too and wins over the setting. The setting
   only exists in the installed app; run from source, `PORT` in
   `connect/.env` decides.

The desktop app is steered while its window is open and signed in with the
key's account. A server steers what the account casts to speakers, never a
browser tab, and can start something new on a speaker named in the command.

## Finding Beacon: mDNS

While a key with the right to control playback exists, Beacon announces
itself as `_beacon._tcp.local.`, named "Beacon on _computer name_", with its
current address and port. The announcement is withdrawn when the last such
key is revoked or Beacon quits, and follows the machine to a new address
within a minute. A server announces itself the same way, while any account
has such a key, with the port its web page answers on (7070 unless
`WEB_PORT` says otherwise). That is the plain address in the local network;
to go through a reverse proxy instead, enter its address by hand.

Home Assistant picks that up by itself, and follows the app to a new port
or address. mDNS does not cross subnets or VLANs; for those setups, set a
fixed port and enter the address by hand (see
[Networking](networking.md#speakers-in-another-subnet-or-vlan) for what else
crosses a VLAN and what doesn't).

## The older Home automation key

Settings > Advanced > Home automation still makes the key Home Assistant
used before, and an integration set up with it keeps working. It is being
retired and will be removed in a later release; the Home Assistant
integration offers a repair that switches it to a new key in one step.

## Building an integration of your own

The interface underneath is the app API, described in
[Your own apps](../faq/apps-and-api.md#how-do-i-control-playback).
