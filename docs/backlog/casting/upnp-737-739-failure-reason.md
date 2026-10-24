# UPnP 737/738/739 as a failure reason of their own

**Status:** open. Never seen; whether a Sonos sends these codes at all is
not established - so far only 701 and 800 have shown up.

SoCo's AVTransport error table (soco/services.py) knows 737 "No DNS Server",
738 "Bad Domain Name" and 739 "Server Error" - in effect: the speaker cannot
get at the URL it is meant to play. They are not in `_UPNP_REASONS`
(delivery/errors.py), so they arrive as `unknown` ("Playback on X failed")
with the raw text as detail. `unreachable` would be wrong: its text ("Is it
switched on and in the same network?") blames the speaker, which is
answering. Since 2026-09-13 DLNA faults go through the same table
(`_upnp_fault_code()`), so a renderer with the same codes benefits too.

## Where it can come from

The two cases do not share an explanation:

- **Beacon's own address is not reachable for the speaker.** Since
  2026-10-24 every speaker gets the address in its own network
  (`for_device()` in `core/local_address.py`, #56), which removes the most
  common case - a server in several networks. What is left is a Docker
  bridge network handing out the container's address, and a firewall between
  speaker and Beacon. The host is an IP there, so that would rather be 739
  than 737/738.
- **A station cast directly with a host name** (`PlayUrlRequest.cast_directly`)
  that the speaker cannot resolve - that would be 737/738, and "Beacon not
  reachable" is exactly wrong then.

## To do

Pick a reason that covers both cases honestly (something like "`{device}`
cannot reach the stream's address"), add it as a `REASON_*` in
`delivery/errors.py` and to `_UPNP_REASONS`, extend the union of
`DeliveryFailedError.reason` in `services/connect/types.ts`, and add
`connect.deliveryFailed.<key>` in all five locales. Open: whether the message
for Beacon's own stream should point at the network setup - that depends on
which Docker network modes Beacon supports; check
[the networking guide](../../help/guides/networking.md) first.
