# The radio list gets the household banned (RESOLVED 2026-09-03)

The same reverse-proxy ban as
[the cover-art outage](mid-track-drop-reverse-proxy-403.md) — same proxy,
same IPS, same effect on anything playing at the time — reached a second
time by a different route. That entry is the mechanism; this one is the
second thing that walked into it, and why the first fix did not cover it.

**Symptom:** the household's own external IP gets banned by the reverse
proxy's CrowdSec, shortly after opening the radio view. Everything through
the proxy is denied for the duration, casting streams' own media fetches
included, so anything playing stops once its buffer runs out. It happened
once, was not understood, and happened again right after
`RADIO_FAVICON_CACHE_VERSION` was raised to 2 — which is what made the
cause findable.

## The mechanism

`/radio-favicon` answers one station at a time, and its URL carries that
station's homepage. A radio list therefore renders one request per station,
each to a *different, one-off* path, all within the second the view opens.
That alone is the shape a probe/crawl detector counts. Two things made it
reliably over the line rather than occasionally near it:

1. **Misses were not cacheable.** The route's 404 (and its 400) carried no
   `Cache-Control` at all — only the success path did. So every station
   whose icon could not be found was re-asked on *every render, every view,
   every reload, forever*: a permanent supply of 4xx from one IP.
   `crowdsecurity/http-probing` leaks a bucket of exactly those per source.
2. **The cache-version bump emptied the cache for everyone at once.**
   Raising `RADIO_FAVICON_CACHE_VERSION` is a deliberate, global,
   simultaneous cache miss — it exists to step around
   [poisoned entries](../../src/renderer/src/services/connect/radio.ts), and
   it worked. What it also did was turn every previously cached hit back
   into a request, in the same burst as the 404s that were never cached in
   the first place.

Four different `min_size` values (32 for the list row, 48 for the browse
dialog, 96 for the player bar, 512 for Now Playing) multiplied both: four
separate URLs, four separate cache keys and four separate lookups for one
station's logo.

## Why the cover-art fix did not already cover this

The 2026-08-23 outage was fixed by bounding and cancelling cover-art loads
and then collapsing them into `POST /cover-art/batch`. Station logos were
never part of that work, and the reasoning recorded at the time explicitly
set them aside: they were classed with the foreign-host images that "never
touch the proxy this is protecting, and appear a handful at a time rather
than by the screenful".

Both halves of that turned out to be wrong for logos specifically. They are
same-origin (that is the whole point — the proxy exists so a station never
sees the user's IP), so they *do* cross the proxy. And a radio list is
precisely a screenful of them.

## The fix

1. **Misses are cacheable** (`_NEGATIVE_CACHE_CONTROL`, six hours — shorter
   than a hit, because a station may put an icon up later and nothing on
   screen would show the answer as stale). This is the one that matters:
   it removes a permanent source of 4xx rather than shrinking a burst.
2. **`POST /radio-favicon/batch`**, modelled on `/cover-art/batch`: one
   request per screenful instead of one per station, whatever the list
   holds. Stations still being resolved come back as `pending` and are
   asked for again shortly, so one dead host cannot hold up the list.
3. **A shared server-side result cache**, so batching does not simply move
   the cost — a station's homepage is scraped once per week per size step,
   for every client, rather than once per client per view.
4. **Two size steps instead of four** (`faviconSizeStep`): 32/48 round up
   to 64, 96/512 share 512 — the player bar and Now Playing show the same
   station at the same moment, so sharing a key there saves a request.
5. **A backoff the whole app respects** (`pollGate.ts`). A bare 403 (no
   FastAPI `detail`, so not one of ours) or a 429 stands the background
   polling down for 30s and up, growing while the denials continue, reset
   by the first request that works. Polls also stop while the window is
   hidden. During the previous outage every one of those kept running for
   the whole ban, achieving nothing and keeping the bucket full.

## Why the test suite did not catch it

Same answer as the first time, and it is worth repeating because it will be
the answer next time too: nothing here is wrong in isolation. Every request
is correct, the response codes are right, and 404 is the honest answer for a
station with no icon. The defect is in the aggregate shape of correct
requests, which no unit test observes. What is now testable, and tested, is
each of the individual properties that shape is made of: that a miss is
cacheable, that a list produces one request, that a repeated station is
asked for once, and that being denied stops the polling.

## For next time

- **A cache-version bump is a load event, not just a correctness lever.**
  It empties every client's cache simultaneously. Before raising one, know
  what request burst that produces.
- **"It doesn't touch the proxy" is worth re-checking per endpoint, not per
  category.** The logo path was reasoned about as a foreign-host image and
  is nothing of the sort.
- **Check `Cache-Control` on the error paths, not just the success path.**
  A 404 nothing may cache is a request that repeats forever.
