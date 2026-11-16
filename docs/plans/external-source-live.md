# Plan: live audio from an external source

Not started. Follows [external-source.md](external-source.md), whose ground
rules hold here too: no service names, no example app for audio that may not
plainly be played.

## Why

A source app can have audio that never ends: a broadcast, a stream that is
running right now. Today the app can only refuse it, because everything Beacon
does with an item assumes a song:

- connect fetches the audio as often as it needs to: playback, every speaker,
  the waveform, beat analysis, a reload. With endless audio each of those is
  a connection of its own that never finishes, and the waveform and the beat
  analysis never come back.
- Seeking, `Range`, the duration, transitions and the 90-day item store all
  assume a file with an end.

Beacon already plays audio like this: radio stations. They are fetched once by
`core/radio_relay.py` and fanned out to every speaker, without a waveform,
seeking or transitions. Live audio from a source should take the same path
instead of a new one.

## Decisions

- **One flag per item**: `live: true` in `beacon.play`'s item. Not in `/v1`'s
  `capabilities`, since one app can offer both songs and live audio.
- **A live item plays alone and now.** `mode` has to be `now` and the message
  has to hold that one item; anything else is refused with `beacon.played`
  `ok: false`. Live audio never ends, so nothing queued after it would ever
  play, and nothing could be queued before it without cutting it off.
- **It plays as a station**, through `playRadioStation()`
  (`stores/playback/radio.ts`): title, artist as the station's subtitle, the
  cover as its picture. Casting goes through the relay, so the app is fetched
  once however many speakers play it.
- **Not a song.** A live item gets no `ext:` song, no place in the song
  history and no scrobble. It is kept the way a station played from Radio
  Browser is kept, so the radio history shows it.
- **The page learns whether Beacon can do it.** An older Beacon drops the
  unknown `live` field and plays the item as a song, the case this plan is
  about. So Beacon says so first: a `beacon.features` message after
  `beacon.ready`, `{features: ['live']}`, and a page offers live audio only
  once it has seen it. Later features use the same message.

## What the app has to deliver

Goes into `docs/help/reference/external-source-api.md` as its own section,
and into the AI instructions in Settings:

- An endless response: no `Content-Length`, no `Range`, no redirect.
- MP3, AAC (ADTS) or Ogg, which the relay takes as they are or re-encodes.
- At the pace it is played, roughly. The relay paces with `-readrate 1`, but
  an app that sends minutes at once only fills buffers.
- On the app's own address, like any `audioUrl`. Every new connection may
  start the stream afresh: Beacon makes one per listening session, plus one
  after a dropped connection.
- Optional: ICY metadata (`icy-metaint`) for a title that changes, which the
  relay already reads for stations.

## Where it touches Beacon

- `routes/external_source.py`: `ExternalItem` gets `live: bool = False`; a
  route that checks a live item's address against the source and returns
  what the renderer needs for a station, without registering a song.
- `core/radio_relay.py`: the address check from `external_source.py` (scheme,
  host and port of the source, no redirects) also for a relay that fetches a
  source's live address. Stations follow redirects today; a source must not.
- Renderer: the tab's message handler sends `beacon.features` and hands a live
  item to `playRadioStation()` instead of `register_items`.
- The example apps stay as they are. Neither has live audio, and the
  folder-source is no place to invent some.

## Still open

- **Local playback**: a station plays in the renderer from its own URL today.
  A source's address is often not reachable from the listener's device (the
  phone away from home), so it has to go through connect, as songs from a
  source already do.
- **Speakers and endless streams**:
  [endless-stream-on-speakers.md](../investigations/casting/endless-stream-on-speakers.md)
  has not measured most devices yet. Its results apply here unchanged.
- **A source removed while live audio plays**: should the relay stop, the way
  a removed source's songs answer 404?
- **Party mode**: whether guests may see live audio from a source at all;
  `routes/party.py` refuses `ext:` ids today.
