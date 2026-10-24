# DLNA: a renderer that accepts the stream but never fetches it stays silent

**Status:** open, found 2026-09-13 while going through every cast target's
error handling. Never seen on a device; it follows from the code.

`delivery/dlna.py` subscribes only to `RenderingControl` (volume) for DLNA,
not to `AVTransport`. A renderer that accepts `SetAVTransportURI` and `Play`
without a fault but then never loads the stream (a format it cannot decode
after all, a URL it cannot reach) only reports that through its own
`TransportStatus` event - and nobody receives it. `/play` answers with
success, the app shows "playing", and because no GET `/stream` ever arrives,
`_mark_disconnected_if_not_reconnected()` (routes/stream.py) does not fire
either: it reacts to a connection that breaks off, not to one that never
comes.

Since the fix of the same day this is the only silent case left for DLNA: a
refused `Play` comes back as a UPnP fault, and play/pause/stop are no longer
skipped because of stale `CurrentTransportActions`.

## What a fix needs

- **Subscribe to AVTransport**, like `_subscribe_to_volume_events()` in
  `delivery/dlna.py`: the event URL is in the device description
  (`service.event_sub_url`), there is no fixed path as on Sonos. Careful when
  looking the service up: `profile_device.service(<type>)` is an exact key
  lookup and misses an `AVTransport:2`/`:3`;
  `profile_device.service_id("urn:upnp-org:serviceId:AVTransport")` finds it
  (as `_send_play()` does).
- **Open `routes/upnp.py` for DLNA.** `_handle_transport_problem()` looks the
  owner up only through `claims.owner_of("sonos", label)`. The callback path
  already carries the `device_type`; so far it is only used for
  RenderingControl.
- **Build a report for tracks.** A transport error only leads anywhere for
  radio today, on Sonos too (convert first, then `transport_error_response`);
  for a track from the queue there is no path. The pieces would be
  `mark_delivery_failed()` (core/session.py) and `transport_error_response()`
  (delivery/errors.py). `_TRANSPORT_STATUS_REASONS` knows the Sonos states;
  whether DLNA renderers send the same strings is open - the specification
  only knows `OK` and `ERROR_OCCURRED` plus vendor values.
- **Not every renderer accepts a subscription.** One that refuses keeps
  today's behaviour. A possible fallback: wait a while after dispatch for the
  first GET `/stream`. That would hit Sonos and Chromecast too and needs a
  limit that does not blame a slowly buffering device (a Chromecast takes
  about 10 s to its first sound on radio).

To reproduce: a format the renderer cannot decode but accepts anyway.
