---
order: 4
---

# Room lights

## Why can I pick only one Hue area, not several at once?

A Hue bridge plays along with music in one entertainment area at a time - that is the bridge's limit, not Beacon's. The same is why the lights stop following Beacon while the Hue Sync app or a TV box is using that area.

To light several rooms together, make one entertainment area in the Hue app that holds the lights of all of them, and pick that one in Beacon. The Hue app tells you how many lights an area can take, and lights far from the bridge and from each other can follow fast changes less evenly.

## Why does one of my lights not play along?

Only lights that can show colours can join an entertainment area - that is Hue's rule, and it also leaves out White ambiance lights, which change only between warmer and cooler white. Beacon plays on the lights in the area, so the others are not part of the show: they stay as they are while the rest play along, even in the same room. A colour light that is missing may just not be in the area yet: add it in the Hue app, and Beacon takes it along the next time the lights start.

## Why do the lights not play along when I listen on my phone?

The lights follow what Beacon casts to a speaker, started from any device, and what a computer or a tablet plays itself - in the desktop app or in a browser. Music playing on a phone itself is left out on purpose: a phone may be listening on the way to work, and that should not set the lights at home flashing. To light the room from your phone, cast to a speaker in that room.

A tablet's browser may stop telling Beacon where the song is once the screen is locked or another app is in front; the lights then stop a few seconds later. The desktop app and a browser on a computer keep going in the background.

When more than one thing plays at once, a cast comes first, since it plays in a room; among several casts, the one started last.

## Why not with the radio?

Beacon analyses a whole song once when it starts, so it knows where every beat falls before it is heard - that is what lets a light change in time to land on the beat. A radio station is a live stream with nothing to look ahead into, so the lights leave it alone.

## The lights flash a little before or after the beat

Light takes a moment to get from Beacon to the lamps, and how long depends on the bridge and the network. Under Advanced, Lead sets how much earlier the lights are sent their colour: raise it if they flash after the beat, lower it if before.

## Why do the lights not flash at the start of a song, or not at all in some songs?

For the first second or two of a song, while Beacon works out its beats, the lights stay on steadily. After that they flash only where a beat is actually heard: through a breakdown without drums they stop flashing and breathe gently with what still plays, and a song without a steady beat, such as a ballad without drums or spoken word, gets no flashes at all - the brightness then only follows how loud the song is. The Calm style never flashes.

## Beacon does not find my Hue bridge

The search listens for the bridge on the local network (mDNS), the same way Beacon finds AirPlay and Chromecast devices, so it needs the same setup: in Docker, `network_mode: host`, and the bridge in the same network as Beacon, since mDNS does not cross subnets or VLANs. Where the search finds nothing, enter the bridge's address by hand; the Hue app shows it in the bridge's settings. Once paired, Beacon talks to the bridge directly - which ports, see [Networking](../guides/networking.md#who-talks-to-whom).
