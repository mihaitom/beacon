---
order: 1
---

# Networking

Casting turns the usual direction around: Beacon does not send the music to a
speaker, the speaker comes and fetches it. Beacon tells a Sonos, a
Chromecast or a DLNA renderer an address, and the speaker opens a connection
back to it and keeps that connection open for the whole song. So the speaker
has to be able to reach Beacon, not just the other way round, and nothing
between the two may cut a connection that stays open for minutes.

Most casting problems that look like a broken speaker are one of those two
things. A song that breaks off or starts over after the same half a minute
every time is almost always the network.

## Who talks to whom

| What                                       | From → to                       | Port                                                                       |
| ------------------------------------------ | ------------------------------- | -------------------------------------------------------------------------- |
| Finding Sonos and DLNA speakers            | Beacon → the whole network      | UDP 1900 (SSDP multicast)                                                  |
| Finding AirPlay and Chromecast devices     | Beacon ↔ the whole network      | UDP 5353 (mDNS multicast)                                                  |
| Beacon announcing itself to Home Assistant | Beacon → the whole network      | UDP 5353 (mDNS multicast)                                                  |
| Controlling a Sonos                        | Beacon → speaker                | TCP 1400                                                                   |
| Controlling a Chromecast                   | Beacon → device                 | TCP 8009                                                                   |
| Controlling a DLNA renderer                | Beacon → renderer               | whatever port the renderer announces                                       |
| **The music** (Sonos, Chromecast, DLNA)    | **speaker → Beacon**            | **Beacon's port** (see below)                                              |
| **State and volume changes** (Sonos, DLNA) | **speaker → Beacon**            | **Beacon's port**                                                          |
| The music (AirPlay)                        | Beacon → speaker, and back      | the speaker's AirPlay port over TCP, plus UDP both ways for timing         |
| Cover art shown on the speaker or TV       | speaker → your media server     | your media server's port, at `NAVIDROME_INTERNAL_URL` or the login address |
| The app itself                             | browser or desktop app → Beacon | `WEB_PORT` (7070) in Docker                                                |

**Beacon's port** is `PORT`, 7071 by default, in Docker. The desktop app
picks a free port on every start, unless you set one under Settings →
Advanced → Home automation → Fixed port. A firewall rule for the desktop app
is best made for the program rather than for a port.

The two rows in bold are the ones that get forgotten: they are connections
the speaker opens towards Beacon, and a firewall that only lets Beacon's own
connections out blocks them.

## Docker: host networking

Run the container with `network_mode: host`. Discovery works by multicast,
and multicast does not get into a container behind Docker's bridge network.
Without it no speaker is found, and a speaker found by other means could
still not reach the container's internal address.

Host networking is Linux-only. On a Mac or Windows, use the desktop app
instead.

A `macvlan` network also works: the container gets an address of its own,
directly in the speakers' network, and nothing else. That is the setup to
pick if the host itself should not be in that network.

## A server in more than one network

A server with two network cards, a VPN or extra Docker networks has an
address in each network. Beacon hands every device the address in that
device's own network: the one the server's routing uses to reach the
device. That only works if the route leads there directly.

What goes wrong otherwise: the speaker reaches Beacon through a router,
while Beacon's replies leave directly through its own network card in the
speaker's network. The router in between sees only half of the connection,
never considers it established, and drops it when its timeout runs out. The
speaker then stops reading the stream 30-45 seconds in, plays what it has
buffered and starts the song over.

Worth checking:

- **Which interface leads to the speakers.** `ip route get <speaker address>`
  on the server should name the network card in the speakers' network and,
  as source, the server's address there.
- **A VPN that takes over local routes.** WireGuard, Tailscale or a company
  VPN can route the home network through the tunnel, and the speaker then
  gets the tunnel's address.
- **Two networks with the same purpose.** If the server and the media server
  sit in a fast storage network as well as the normal one, that is fine, as
  long as the speakers are reached through the normal one.

## Speakers in another subnet or VLAN

It works, but the network has to carry two things across that it normally
keeps to each side:

- **Discovery.** Multicast stays within its network. Between VLANs it needs
  an mDNS reflector (for AirPlay and Chromecast) and SSDP forwarding (for
  Sonos and DLNA). Many routers and access points call this "mDNS",
  "multicast DNS" or "IGMP proxy".
- **The connections both ways.** The firewall between the networks has to
  allow the speakers to open connections to Beacon's port, and Beacon to
  reach the speakers' control ports from the table above. A stateful
  firewall must not drop connections that stay quiet for a while: a speaker
  with a full buffer reads nothing for long stretches.

The Home Assistant integration has the same problem with mDNS; its guide
covers the fixed port for that in [Finding Beacon: mDNS](home-automation.md#finding-beacon-mdns).

## Wi-Fi

- **Client or AP isolation** (often on by default in a guest network) stops
  devices in the same Wi-Fi from talking to each other. Speakers and Beacon
  have to be able to.
- **IGMP snooping** that is switched on without an IGMP querier in the
  network lets multicast through for a few minutes and then stops it.
  Speakers that are found after a restart and then disappear point to this.
- **Mesh Wi-Fi, powerline adapters or a busy wireless link** can lose a
  connection that a short web request would never notice. A speaker on a
  cable for a test is the quickest way to rule this out.

## A media server behind a reverse proxy

If you log in to Navidrome or Jellyfin through a public address behind
Traefik, nginx, Cloudflare or an SSO layer, set `NAVIDROME_INTERNAL_URL` or
`JELLYFIN_INTERNAL_URL` to an address Beacon reaches it at directly, such as
`http://192.168.0.10:4533`. The audio then no longer takes the detour
through the proxy, whose timeouts, buffering or rate limits can interrupt a
song. Speakers also load cover art from that address, so it has to be
reachable from their network too. See the environment variables in the
README.

## When a speaker stops or starts over

1. **Set the log level to Debug** (Settings → Advanced). While casting, Now
   Playing then shows a small panel with what reaches the speaker.
2. **Compare the address the speaker was given with its own.** At Debug,
   the log names it for every song, as in
   `[Sonos:Room A] → play: http://192.168.1.5:7071/stream/...`. If the speaker
   is at `192.168.0.20`, it was handed an address in another network and
   reaches Beacon through a router. That is the case from
   [A server in more than one network](#a-server-in-more-than-one-network)
   above.
3. **`STALLED`** in the panel means the speaker stopped reading. With the
   connection still open on Beacon's side, something in between stopped
   carrying it.
4. **Check that Beacon is reachable from the speakers' network**, from a
   laptop or phone in that network:
   `curl -s -o /dev/null -w '%{http_code}\n' http://<beacon address>:7071/`.
   Any number, even 404, means the connection got through. A timeout means
   a firewall or a route is in the way.
5. **Try the speaker on a cable**, or a second speaker in the same place.

If none of that explains it, [Reporting a problem](../faq/reporting.md) says which log to turn on
and what to send along with a report.
