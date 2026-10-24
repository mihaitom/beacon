---
order: 1
---

# Casting

## No devices found

Ensure the container is running with `network_mode: host`. Without host networking, mDNS/SSDP multicast packets can't reach the container and no devices will be discovered. Speakers in another subnet or VLAN need the network to carry discovery across, see [Networking](../guides/networking.md#speakers-in-another-subnet-or-vlan).

## A speaker starts playing, then stops or starts over

Usually the network between the speaker and Beacon, not the speaker. A speaker does not get its music handed to it: it opens a connection back to Beacon (`PORT`, 7071 in Docker) and keeps it open for the whole song. Anything that interrupts a long-running connection shows up as a song that breaks off or starts over, often after the same half a minute or so every time.

Things worth checking:

- **Speaker and Beacon in different networks or VLANs.** The router or firewall in between has to allow the speaker to reach Beacon, and must not cut connections that stay open for minutes.
- **A server with more than one network connection** (two network cards, a VPN, Docker networks). Beacon gives each speaker the address the server's own routing uses towards it, so that route has to lead into the speaker's network directly. If replies take a different way than requests, a router in between sees only half the connection and drops it.
- **Mesh Wi-Fi, powerline adapters or a busy wireless link** can lose a connection that a short web request would never notice. A speaker on a cable is the quickest way to rule this out.

[Networking](../guides/networking.md) goes through each of these, with the ports involved and a checklist. The case that led to it is in [investigations/old-sonos-models-stop-reading-the-stream.md](../../investigations/old-sonos-models-stop-reading-the-stream.md).

## My Sonos speaker doesn't appear under AirPlay (or DLNA)

That's intentional. Sonos speakers advertise AirPlay 2 but require MFi hardware authentication that the AirPlay backend (pyatv) can't perform, so they're filtered out of the AirPlay list - use the dedicated **Sonos** output instead, where they appear with full volume and grouping support. Same idea for DLNA - Sonos also answers UPnP discovery there, and gets filtered for the same reason (the dedicated Sonos output already covers it properly). At log level Debug or louder, both filters are off, showing Sonos devices there too - useful for exercising the AirPlay/DLNA code paths themselves without owning that hardware, though actually streaming to Sonos-as-AirPlay still fails for the MFi reason above.

## Why don't OS media keys / lock screen controls work while casting?

Media keys, the Windows/macOS lock screen controls, and the GNOME/KDE media widget on Linux are all driven by the browser's Media Session API, which only exposes a session to the OS while a real, audible `<audio>` element is actually playing in the tab. While casting, no audio plays locally at all - it goes straight to the Sonos/Chromecast/AirPlay/DLNA device - so there's nothing for the browser to report. Confirmed with local playback (works) vs. casting (doesn't) on both Chromium and Firefox/Gecko-based (e.g. Waterfox) browsers on Linux via `playerctl`. There's a known workaround (loop a silent `<audio>` element to keep a "real" session alive during casting) but it's fragile enough (autoplay policy quirks, volume-zero edge cases) that it's deliberately not implemented - the cast target's own controls (its companion app, physical buttons) already cover this case.

## Why is there no loading strip on the seek bar while casting?

Because nothing is loading here. During a cast the audio goes from the `connect` backend straight to the speaker, which fills its own buffer out of Beacon's reach, so there is no figure to draw: the strip is left out entirely rather than sitting there empty, which would read as "nothing has loaded yet". It is back the moment playback returns to this device. Radio never shows one either, since a live stream has no length to measure a buffer against - which is also why the seek bar is replaced by an elapsed-time readout there.

## Why doesn't the music carry on over my own speakers when I end a cast?

Because nothing here plays that was not asked for. Ending a cast leaves the track on the player bar, paused, at the point the speaker reached; pressing play carries it on this device. The same rule covers a speaker that stops on its own: Beacon cannot tell that apart from somebody pressing stop on the device itself, so it says so and offers to continue rather than deciding for you. The one time audio starts by itself is reloading the app while it was playing locally, which picks up where it left off.

## Why is there no visualizer while a station is casting?

It is switched off there on purpose, because it could not be made to line up. The analyzer is fed the live edge of the stream while the speaker plays roughly 13 seconds behind it, out of its own buffer, so the bars ran ahead of what the room heard. That gap is not a clock offset, so no correction constant closes it; feeding the analyzer delayed audio would, and that is a real piece of work nobody has taken on. A station playing on this device shows its visualizer as usual, and so does a cast library track, whose pacing Beacon controls itself. The measurements are in [investigations/radio-visualizer-cast-sync.md](../../investigations/radio-visualizer-cast-sync.md).
