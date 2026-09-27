# Beacon for Home Assistant

Control the Beacon desktop app from Home Assistant: see what is playing,
pause and skip, pick the speakers, start playlists and radio stations, and
use all of it in automations. This folder holds a Home Assistant integration
and a ready-made dashboard for it.

Tested with Home Assistant 2026.9. The interface underneath is described in
[docs/home-automation.md](../docs/home-automation.md), for anyone who wants
to build something of their own.

- [What you get](#what-you-get)
- [Before you start](#before-you-start)
- [1. Create a key in Beacon](#1-create-a-key-in-beacon)
- [2. Install the integration](#2-install-the-integration)
- [3. Connect Home Assistant to Beacon](#3-connect-home-assistant-to-beacon)
- [4. Add the dashboard](#4-add-the-dashboard)
- [Using it in automations](#using-it-in-automations)
- [Troubleshooting](#troubleshooting)
- [Updating and removing](#updating-and-removing)

## What you get

One device, **Beacon**, with these entities. The ids are the ones a fresh
install creates; see [Entity ids](#entity-ids) if yours look different.

| Entity                            | What it does                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `media_player.beacon`             | What is playing, with cover, position and volume. Play, pause, skip, seek, shuffle, repeat, volume. The library in the media browser. |
| `select.beacon_speaker`           | Where Beacon plays: `This computer` or one speaker.                                                                                   |
| `switch.beacon_cast_<speaker>`    | One per speaker. Turning several on casts to all of them at once.                                                                     |
| `switch.beacon_autoplay`          | Autoplay: keeps playing similar songs when the queue runs out.                                                                        |
| `sensor.beacon_now_playing`       | "Artist – Title" as plain text, so the history and logbook list the songs.                                                            |
| `sensor.beacon_queue`             | How many songs are queued; the next ones are in its `up_next` attribute.                                                              |
| `button.beacon_resume_cast`       | Picks a cast back up after a speaker dropped out. Only available while that is the case.                                              |
| `button.beacon_scan_for_speakers` | Looks for speakers on the network again.                                                                                              |

In Home Assistant's **media browser** the player offers the queue, your
playlists, your albums (grouped by letter) and your radio stations, plus a
radio started from the current song. Songs can be played right away, played
next or added to the end of the queue.

While Beacon is closed, everything shows as unavailable, and comes back on
its own when the app runs again.

## Before you start

- **The Beacon desktop app**, on Windows, macOS or Linux. The Docker/web
  version does not offer this yet.
- **Home Assistant on the same network** as the computer running Beacon.
  Home Assistant finds Beacon on its own when both are in the same subnet;
  across subnets or VLANs it works too, with a fixed port (step 1).
- A way to copy files onto Home Assistant: the **Samba share**, **File
  editor**, **Studio Code Server** or **Terminal & SSH** add-on all work.

## 1. Create a key in Beacon

In Beacon, open **Settings > Advanced > Home automation**.

1. Click **Create key**. The key is shown **only this once**: copy it
   somewhere for step 3. If you lose it, create a new one; the old one
   stops working at that moment.
2. **Fixed port** (optional). Beacon normally picks a free port on every
   start, and Home Assistant follows it through the network announcement.
   Set a fixed port (for example `7071`) if Home Assistant is in another
   subnet or VLAN, or if you set the integration up by hand. It takes effect
   after restarting Beacon.

While a key exists, Beacon announces itself on the local network, which is
how Home Assistant finds it. Revoking the key ends the announcement and
locks Home Assistant out.

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
   appears as "Beacon on _your computer's name_".
2. Click **Add** and paste the key.

That is all. If Beacon does not show up under Discovered, add it by hand:
**Add integration** > **Beacon**, then enter the address and port and the
key. Beacon shows the address and port under its fixed port setting, once
one is set and in use.

## 4. Add the dashboard

`dashboard.yaml` is a complete dashboard built from Home Assistant's own
cards; nothing else needs installing. It has two pages: **Beacon** (now
playing, speakers, controls, library, up next, history) and
**Automations** (examples to copy).

1. **Settings > Dashboards > Add dashboard > New dashboard from scratch**.
   Name it "Beacon", pick an icon such as `mdi:music-circle`, and create it.
2. Open the new dashboard, click the **pencil** (top right), then **⋮ >
   Raw configuration editor**.
3. Replace everything in the editor with the contents of `dashboard.yaml`
   and **Save**.

### Entity ids

The dashboard uses the ids from the table above. Home Assistant can create
different ones, for instance with the area in front
(`switch.living_room_beacon_autoplay`) when the device was put into an area
while setting it up. Check under **Settings > Devices & services > Beacon >
1 device > Beacon**; if the ids differ, use search and replace in the raw
configuration editor.

### Your speakers and favourites

Two parts depend on your setup and are left as commented examples in the
file. Search for `YOUR`:

- **Speakers**: one tile per speaker switch, `switch.beacon_cast_<speaker>`.
  Home Assistant creates these as soon as Beacon has found your speakers.
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

**Beacon is not listed under Discovered.** Home Assistant and the computer
are probably in different subnets or VLANs, where the network announcement
does not reach. Add the integration by hand with a fixed port (steps 1 and
3). Also check that a key exists in Beacon: without one, Beacon does not
announce itself.

**"Beacon is not reachable" while setting up.** Beacon has to be running.
On Windows, the firewall has to let Beacon accept connections on private
networks; if Windows asked when Beacon first started and it was declined,
allow **connect-server** under Windows Security > Firewall > Allow an app.

**"The key was not accepted."** It was mistyped, or a newer key was created
since. Create a new one in Beacon and use that.

**Everything is unavailable.** The Beacon app is closed, or its key was
revoked or replaced. A replaced key needs setting up again: remove the
Beacon integration and add it with the new key.

**Albums or playlists say "Beacon is still loading this list".** Beacon
loads a large library from the music server the first time it is asked.
Open the folder again a moment later.

**The speaker list is empty or incomplete.** Press **Scan for speakers**.
A speaker that needs pairing (AirPlay) has to be paired in the Beacon app
first.

## Updating and removing

**Update:** copy the new `custom_components/beacon` over the old one and
restart Home Assistant. The setup and entities stay.

**Remove:** **Settings > Devices & services > Beacon > ⋮ > Delete**, then
delete `config/custom_components/beacon` and restart. In Beacon, revoke the
key so it stops announcing itself.
