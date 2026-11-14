# Beacon for Home Assistant

Control Beacon from Home Assistant: see what is playing, pause and skip,
pick the speakers, start playlists and radio stations, and use all of it in
automations. It works with the desktop app and with a Beacon server. This folder holds a Home Assistant integration
and a ready-made dashboard for it.

Tested with Home Assistant 2026.9. The interface underneath is Beacon's app
API, described in [docs/help/faq/apps-and-api.md](../docs/help/faq/apps-and-api.md),
for anyone who wants to build something of their own.

- [What you get](#what-you-get)
- [Before you start](#before-you-start)
- [1. Create a key in Beacon](#1-create-a-key-in-beacon)
- [2. Install the integration](#2-install-the-integration)
- [3. Connect Home Assistant to Beacon](#3-connect-home-assistant-to-beacon)
- [4. Add the dashboard](#4-add-the-dashboard)
- [More than one computer](#more-than-one-computer)
- [Using it in automations](#using-it-in-automations)
- [Troubleshooting](#troubleshooting)
- [Updating and removing](#updating-and-removing)

## What you get

A device called **Beacon** with these entities. They always have these ids,
whatever your computers are called, and follow the Beacon instance that is
in use (see [More than one computer](#more-than-one-computer)):

| Entity                            | What it does                                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media_player.beacon`             | What is playing, with cover, position and volume. Play, pause, skip, seek, shuffle, repeat, volume. The library in the media browser.                            |
| `select.beacon_speaker`           | Where Beacon plays: `This computer` or one speaker.                                                                                                              |
| `switch.beacon_autoplay`          | Autoplay: keeps playing similar songs when the queue runs out.                                                                                                   |
| `sensor.beacon_now_playing`       | "Artist – Title" as plain text, so the history and logbook list the songs.                                                                                       |
| `sensor.beacon_queue`             | How many songs are queued; the next ones are in its `up_next` attribute.                                                                                         |
| `sensor.beacon_party`             | Party mode: how many guests have joined as the state, with whether one is running, how many listen along online and the online bitrate as attributes. Read-only. |
| `button.beacon_resume_cast`       | Picks a cast back up after a speaker dropped out. Only available while that is the case.                                                                         |
| `button.beacon_scan_for_speakers` | Looks for speakers on the network again.                                                                                                                         |
| `select.beacon_instance`          | Which Beacon instance the above follow: `Automatic`, or one pinned.                                                                                              |

Each Beacon instance also gets a device of its own, named after the
computer ("Beacon on my-pc"), with the same entities for that instance
alone, plus a switch per speaker (`switch.beacon_on_my_pc_cast_<speaker>`):
turning several on casts to all of them at once.

Party mode is read-only here: a running party shows up on
`sensor.beacon_party` with its guests and online listeners, but it is
started and ended in the app itself.

In Home Assistant's **media browser** the player offers the queue, your
playlists, your albums (grouped by letter) and your radio stations, plus a
radio started from the current song. Songs can be played right away, played
next or added to the end of the queue.

While Beacon is closed, everything shows as unavailable, and comes back on
its own when the app runs again. The same while the desktop app is signed in
with another account than the key's.

### Desktop app or server

On the **desktop app**, Home Assistant steers the app itself, including
playing on the computer (`This computer`), and shows a running party.

On a **server**, it steers the account's music on speakers. Something played
in a browser tab is not steered from here. With nothing on a speaker yet,
pick one under `select.beacon_speaker` first, then start a playlist, album
or station: it begins there. A speaker somebody else is playing on stays
theirs. `This computer` stops the music on the speakers.

## Before you start

- **Beacon**: the desktop app on Windows, macOS or Linux, or a Beacon
  server (Docker).
- **Home Assistant on the same network** as Beacon. Home Assistant finds
  the desktop app and a server on its own when they are in the same subnet;
  across subnets or VLANs it works too, by entering the address (for the
  desktop app with a fixed port, step 1).
- A way to copy files onto Home Assistant: the **Samba share**, **File
  editor**, **Studio Code Server** or **Terminal & SSH** add-on all work.

## 1. Create a key in Beacon

In Beacon, open **Settings > Account > Apps and devices**, in the desktop
app or in a browser on the server, signed in with the account Home
Assistant should steer.

1. **New key**, **Own app**, a name such as "Home Assistant", and switch on
   **Steer playback** and **Browse the library and start music** (the
   media browser and starting playlists need that one). The key is shown
   **only this once**: copy it somewhere for step 3. If you lose it, make a
   new one and revoke the old one.
2. **Desktop app only: fixed port** (optional), on the same page. The app
   normally picks a free port on every start, and Home Assistant follows it
   through the network announcement. Set a fixed port (for example `7071`)
   if Home Assistant is in another subnet or VLAN, or if you set the
   integration up by hand. It takes effect after restarting Beacon.

While such a key exists, the desktop app announces itself on the local
network, which is how Home Assistant finds it. Revoking the key ends the
announcement and locks Home Assistant out.

## 2. Install the integration

Copy the folder `custom_components/beacon` from here into your Home
Assistant configuration folder, so that it ends up as:

```
config/
└── custom_components/
    └── beacon/
        ├── __init__.py
        ├── manifest.json
        └── ...
```

With **Terminal & SSH**, from a copy of this repository:

```sh
scp -r home-assistant/custom_components/beacon root@homeassistant.local:/config/custom_components/
```

Then restart Home Assistant: **Settings > System > ⋮ > Restart Home
Assistant**. A warning in the log that Beacon "has not been tested by Home
Assistant" is normal for every integration installed this way.

## 3. Connect Home Assistant to Beacon

With Beacon running and a key created:

1. Open **Settings > Devices & services**. Under **Discovered**, Beacon
   appears as "Beacon on _the computer's name_", the desktop app as well as
   a server.
2. Click **Add** and paste the key.

That is all. A server found this way is reached at its plain address in the
local network. To go through your reverse proxy instead, or if Beacon does
not show up under Discovered, add it by hand: **Add integration** > **Beacon**, then enter
Beacon's address and the key. For a server that is the address you open it
at, such as `https://beacon.example.com`; for the desktop app
`http://<computer>:<port>`, which the key dialog shows.

### Set up with the older key?

An entry set up with a key from **Settings > Advanced > Home automation**
keeps working, but Beacon is retiring that key. Home Assistant shows a
repair under **Settings > System > Repairs**: make a key as in step 1, open
the repair and paste it. The entities and their ids stay as they are.

## 4. The dashboard

The integration brings a ready-made dashboard along: after setting up, a
**Beacon** entry appears in the sidebar. It has two pages: **Beacon** (now
playing, speakers, controls, library, up next, history) and **Automations**
(examples to copy). It is built from Home Assistant's own cards only and
follows whichever Beacon instance is in use.

To hide it: **Settings > Devices & services > Beacon > Beacon (active) >
⚙ Configure** and switch off "Show the Beacon dashboard in the sidebar".

The dashboard in the sidebar cannot be edited. To make your own version of
it, for instance with your speakers and favourite playlists:

1. **Settings > Dashboards > Add dashboard > New dashboard from scratch**.
2. Open it, click the **pencil** (top right), then **⋮ > Raw configuration
   editor**.
3. Paste in the contents of `custom_components/beacon/dashboard.yaml` and
   **Save**. You can then hide the built-in one as described above.

### Your speakers and favourites

Two parts depend on your setup and are left as commented examples in the
file. Search for `YOUR`:

- **Speakers**: one tile per speaker switch of your instance,
  `switch.beacon_on_<computer>_cast_<speaker>`. Home Assistant creates these
  as soon as Beacon has found your speakers; they are listed on the
  instance's device page.
- **Favourites**: a button that starts a playlist or station by its name, as
  Beacon shows it:

  ```yaml
  - type: button
    name: Classic Rock
    icon: mdi:guitar-electric
    tap_action:
      action: perform-action
      perform_action: media_player.play_media
      target:
        entity_id: media_player.beacon
      data:
        media_content_id: playlist:Classic Rock
        media_content_type: playlist
  ```

  For a station, use `radio:<station name>` and `media_content_type:
channel`.

## More than one computer

Beacon on a desktop and a laptop, or a second copy on the same machine:
each shows up under Discovered and is added the same way, with its own key.

The **Beacon** device then follows whichever is in use: the one that is
playing, or else the one that is running. So the dashboard and your
automations keep working whichever computer you use. To tie them to one
instance instead, set `select.beacon_instance` to it; `Automatic` switches
back. For an automation about one computer in particular, use that
instance's own entities.

## Using it in automations

Everything works with Home Assistant's standard actions. A few that are
specific to Beacon:

```yaml
# Start a playlist or a station by name
- action: media_player.play_media
  target:
    entity_id: media_player.beacon
  data:
    media_content_id: radio:1LIVE
    media_content_type: channel

# Play on one speaker (or "This computer")
- action: select.select_option
  target:
    entity_id: select.beacon_speaker
  data:
    option: Living room

# Add a speaker to what is already playing
- action: switch.turn_on
  target:
    entity_id: switch.beacon_cast_kitchen
```

`play` and `pause` do exactly that: pausing something already paused does
nothing, so they are safe to fire from automations. The dashboard's
**Automations** page has complete examples.

## Troubleshooting

**Beacon is not listed under Discovered.** Only the desktop app announces
itself, so a server is always added by hand. Otherwise Home Assistant and
the computer are probably in different subnets or VLANs, where the network
announcement does not reach. Add the integration by hand with a fixed port
(steps 1 and 3). Also check that a key with **Steer playback** exists in
Beacon: without one, the app does not announce itself.

**"Beacon is not reachable" while setting up.** Beacon has to be running.
On Windows, the firewall has to let Beacon accept connections on private
networks; if Windows asked when Beacon first started and it was declined,
allow **connect-server** under Windows Security > Firewall > Allow an app.

**"The key was not accepted."** It was mistyped or revoked. Make a new one
in Beacon and use that.

**"This key may not control playback."** The key was made without **Steer
playback**. Make a new one with it.

**Everything is unavailable.** The Beacon app is closed or signed in with
another account, or its key was revoked. A revoked key needs setting up
again: remove the Beacon integration and add it with a new key.

**Playing from the media browser fails with `no_speaker`.** On a server,
nothing was playing on a speaker yet: pick one under `select.beacon_speaker`
first.

**The library fails with `media_login_rejected`.** The music server no
longer accepts the login the key was made with, for example after a
password change. Make a new key.

**Albums or playlists say "Beacon is still loading this list".** Only with
the older key: the desktop app loads a large library from the music server
the first time it is asked. Open the folder again a moment later.

**The speaker list is empty or incomplete.** Press **Scan for speakers**.
A speaker that needs pairing (AirPlay) has to be paired in the Beacon app
first.

## Updating and removing

**Update:** copy the new `custom_components/beacon` over the old one and
restart Home Assistant. The setup and entities stay.

**Remove:** **Settings > Devices & services > Beacon > ⋮ > Delete**, then
delete `config/custom_components/beacon` and restart. In Beacon, revoke the
key so it stops announcing itself.
