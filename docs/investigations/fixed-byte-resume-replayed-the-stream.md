# fixed - A dropped stream resumed from the wrong place, and play could not restart it

**Fixed 2026-10-14.** Reported as "four drops over a working day, a reload
fixes it, pressing play does not", from the desktop web app on a work
network that reaches Beacon through a cloud security proxy.

## What the access log showed

connect's own log was gone (the container had been recreated), so this was
read off the reverse proxy's JSON access log, which records every request
with its start, duration and byte count. All four drops looked the same:

1. The mix's audio connection stopped reaching the browser while connect
   kept writing to it - the proxy's log shows that response running on
   until after the reload. The proxy in between had cut the client side.
   It rotates its egress address within a session, and it occasionally
   redirects requests through its own re-authentication.
2. Moments later the **same URL** (`.../audio?epoch=...&from=0.000`) was
   requested again from a different egress address. The app's own
   reconnect never builds that URL - it asks from the position heard - so
   this was the browser.
3. Where the app's reconnect then did run (`from=<seconds>`), the same thing
   happened to its URL a minute later, and playback stopped for good.
4. Play only resumed the element and the mix: `resume` requests with no
   audio request after them, then a reload (a new player id).

## The measurement

A small server shaped like connect's audio route (200, chunked, endless
FLAC, no length) cut its first response after 12s, with Chromium 151
playing it:

- The element's opening request carries `Range: bytes=0-`.
- After the cut, Chromium reopens the same URL by itself with
  `Range: bytes=<bytes received>-`.
- Answered with a fresh 200, it plays on from that body - which for connect
  is the stream from `from` again, so a mix's opening URL replays the run
  from its first song.
- Answered with **416**, it plays out what it has buffered and fires
  `ended`. No `error`.

## The fix

- Both stream-time routes (`/stream/local/mix/.../audio` and
  `/stream/local/{id}?start=`) answer a `Range` that starts past byte 0 with
  416 (`refuse_byte_resume()` in `connect/routes/local_stream.py`). The
  `ended` that follows is already treated as an early end by AudioEngine,
  which reconnects from the position heard - after the browser's buffer has
  played out, so a cut costs at most the reconnect itself.
- AudioEngine reports `failed` once a source is lost for good, and play
  restarts the source from where it was heard instead of resuming the dead
  element.

## Why the suites did not catch it

Neither side modelled the browser re-requesting a URL on its own. The
backend test that covered `start` together with a `Range` header even
asserted the replay (`test_start_wins_over_a_range_header`), on the
assumption that only a confused caller would send both.
