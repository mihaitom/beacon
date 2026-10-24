---
order: 5
---

# When something does not turn up

## No devices found

Ensure the container is running with `network_mode: host`. Without host networking, mDNS/SSDP multicast packets can't reach the container and no devices will be discovered. Speakers in another subnet or VLAN need the network to carry discovery across, see [Networking](../networking.md#speakers-in-another-subnet-or-vlan).

## A speaker starts playing, then stops or starts over

Usually the network between the speaker and Beacon, not the speaker. A speaker does not get its music handed to it: it opens a connection back to Beacon (`PORT`, 7071 in Docker) and keeps it open for the whole song. Anything that interrupts a long-running connection shows up as a song that breaks off or starts over, often after the same half a minute or so every time.

Things worth checking:

- **Speaker and Beacon in different networks or VLANs.** The router or firewall in between has to allow the speaker to reach Beacon, and must not cut connections that stay open for minutes.
- **A server with more than one network connection** (two network cards, a VPN, Docker networks). Beacon gives each speaker the address the server's own routing uses towards it, so that route has to lead into the speaker's network directly. If replies take a different way than requests, a router in between sees only half the connection and drops it.
- **Mesh Wi-Fi, powerline adapters or a busy wireless link** can lose a connection that a short web request would never notice. A speaker on a cable is the quickest way to rule this out.

[Networking](../networking.md) goes through each of these, with the ports involved and a checklist.

**Seeing what happens:** with the log level at Debug (Settings → Advanced), Now Playing shows a small panel while casting: what was sent and how far into the song it reaches, whether the speaker is still reading (`STALLED` once it has stopped), how many seconds it has ahead, and what it asked for. The case that led to it is in [investigations/old-sonos-models-stop-reading-the-stream.md](../../investigations/old-sonos-models-stop-reading-the-stream.md).

## My Sonos speaker doesn't appear under AirPlay (or DLNA)

That's intentional. Sonos speakers advertise AirPlay 2 but require MFi hardware authentication that the AirPlay backend (pyatv) can't perform, so they're filtered out of the AirPlay list - use the dedicated **Sonos** output instead, where they appear with full volume and grouping support. Same idea for DLNA - Sonos also answers UPnP discovery there, and gets filtered for the same reason (the dedicated Sonos output already covers it properly). At log level Debug or louder, both filters are off, showing Sonos devices there too - useful for exercising the AirPlay/DLNA code paths themselves without owning that hardware, though actually streaming to Sonos-as-AirPlay still fails for the MFi reason above.

## Troubleshooting casting

Set the log level to Trace in Settings (or `LOG_LEVEL=trace`, see Environment variables above, if the app never comes up far enough to reach Settings) - Debug only covers Beacon's own code, Trace also turns on the SoCo/pyatv/HTTP libraries actually talking to the device, which is normally what you need for a casting issue. Expect a lot of output either way.
