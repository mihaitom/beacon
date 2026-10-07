# Idea: listening along from somewhere else

Status: idea, not planned. Nothing here is decided.

## What it would be

Party guests today see what plays and steer it with wishes and skip votes,
but the music itself only comes out of the host's speakers. Guests who are
not in the room - friends at home, colleagues in another office - would tap
"Listen along" on the party page and hear the same music in their own
browser, roughly in step with the host.

## Where the audio comes from

The guest page cannot simply hang on to what connect already streams:

- **While the host casts,** every speaker pulls its own ffmpeg run from
  `/stream/{session}`, tied to the device-facing logic in `routes/stream.py`
  (resume offset, stream generations, reconnects). A guest per connection
  there would be one transcode per guest and would drag the speaker logic
  into something it was not made for.
- **While the host plays locally,** connect produces no audio at all: the
  host's browser fetches the file through the proxy.

The clean shape is a virtual cast target, "Party stream", that the host
picks like a speaker (alone, or together with a real one). Most of it
exists:

- `stream_tracks` in `core/streamer.py` already chains the queue into one
  continuous stream for a device.
- `core/radio_relay.py` is the fan-out this needs: encode once, hand the
  bytes to any number of listeners, with the burst buffer and held
  connection that phones on mobile data depend on.

So this would be a new delivery target in `delivery/` plus a guest audio
endpoint, not a rework of party mode.

## Open questions

- **Sync between audio and page.** Each guest lags behind by their own
  buffer - a guess of 2 to 10 seconds through a CDN proxy and mobile data,
  not measured. Lyrics, the visualizer and the progress bar follow the
  host's clock today, so they would run ahead of what the guest hears. They
  would have to follow the guest's own audio position instead. Since connect
  produces the stream, it can carry position markers in band (the ICY muxer
  exists already) - easier than the radio visualizer case, where the lead
  could never be measured reliably and ended up a fixed constant. Still the
  part that needs the most testing on real devices.
- **Sync between guests.** Probably not needed: nobody hears anyone else.
  Only worth doing if it turns out to be missed.
- **iPhone.** An endless live stream behaves like internet radio and should
  play; the HLS workaround was for transcodes of known length
  (`docs/investigations/safari-transcode-jumps.md`). Needs checking on a
  device, including the lock screen.
- **Autoplay.** Browsers need a tap before sound, so "Listen along" is a
  button the guest presses - which also keeps the rule that nothing plays
  without someone asking.
- **CDN terms.** Proxying continuous audio through a free CDN plan (e.g.
  Cloudflare) may break its terms; not checked. Fallback: serve only the
  stream from a hostname that bypasses the CDN.
- **Rights.** Streaming a library over the internet to people outside the
  household is legally a different thing from a party in one room. A
  decision for whoever runs it, but worth stating in the docs if this ships.

## What would carry over unchanged

- **Security model.** The stream lives under `/party/`, bound to the guest
  cookie, one connection per guest, counted against the existing limits.
  Guests never see the media server's stream URL, because the relay sits in
  between.
- **Upload bandwidth** is modest: about 192 kbit/s per listener, around
  2 Mbit/s for ten.

## A first step, if it ever gets built

The virtual "Party stream" target with relay-style fan-out, and lyrics
following the guest's own position. Anything beyond that (sync between
guests, a choice of quality) only once the first version shows it is
missing.
