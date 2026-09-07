# A slow media-server lookup froze streaming, and a transient one ended it (RESOLVED 2026-08-22)

**Symptom:** casting stopped dead mid-session. The log showed a 4.71s event
loop stall, `Auto-advance: track ... not found: [Errno -3] Try again`, and
`Track finished — marking stream complete` — with a full queue still waiting.

**Cause:** two of them at one call site. `_advance_or_end()` called
`session.media.get_track()` directly, and the media adapters are synchronous
HTTP clients, so the call ran **on the event loop**: for its whole duration
nothing else was serviced, every open `/stream` socket included. Usually
milliseconds and invisible. The sibling call `get_stream_url()` was already
wrapped in `asyncio.to_thread()` twice in the same file; this one was simply
missed. `routes/playback.py`'s `/play` handler had the identical omission.

Separately, a *transient* lookup failure was treated as "there is nothing
left to play" and ended the session outright.

**Trigger, reproduced:** scrolling ~15k tracks in the library view. Every
request re-resolves the media server's hostname (Python does not cache DNS),
which overran the host's systemd-resolved stub until it returned `EAI_AGAIN`.
One of those failures landed on an auto-advance.

**Fix:** both lookups moved onto a thread, and the auto-advance lookup now
retries a small, bounded number of times before concluding the queue is done
— bounded because it runs while holding `play_lock`.

**The burst itself had its own cause.** The media adapters called
`httpx.get()`/`httpx.post()`, the module-level convenience functions, which
build a client, resolve DNS, do a TLS handshake, make one request and discard
all of it. `routes/proxy.py` had already been migrated away from that exact
pattern; the adapters were missed. They now share one pooled `httpx.Client`
(`media/http_client.py`), so a burst reuses connections instead of
re-resolving per call. See
[Connection reuse was claimed but not achieved](fixed-connection-reuse-not-achieved.md)
for the full story of that fix, including the proxy's own half of it.

That fix is correct but probably was not what produced this particular
burst: cover art and library browsing go through the proxy, not the
adapters. The proxy pooled — with httpx's defaults, which cap keepalive at
20 of up to 100 connections and expire them after 5s. A library view
scrolling past hundreds of covers exceeds that immediately, so the surplus
closed after every request and was rebuilt, DNS lookup included, for the
next one. Its limits are now sized for that workload. Worth remembering
that "it uses a pooled client" and "it actually reuses connections" are not
the same claim.

Worth knowing alongside it: `SERVER_INTERNAL_URL` being unset routes every
library call out through the public hostname and a reverse proxy rather than
straight to the media server, which makes each of those calls more expensive
again. Setting it is complementary, not an alternative.

Caching DNS inside the app would have been the wrong layer — it leaves the
TCP and TLS setup per request, which costs more than the lookup. The
Electron-only app this backend grew out of never had the problem at all: its
renderer talked to the media server through Chromium, which pools connections
and caches DNS on its own.

**Why tests missed it:** an inline call and a threaded one behave identically
in a test suite — nothing else is competing for the loop. The bug only exists
under concurrency, and only shows up as *latency*, never as a wrong result.
Found by the event-loop stall detector, not by a test.
