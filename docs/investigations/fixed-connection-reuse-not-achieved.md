# Connection reuse was claimed but not achieved (RESOLVED 2026-08-22)

**Symptom:** browsing a large library was slow, and a burst of requests could
overrun the host's DNS resolver hard enough to break playback (see
[A slow media-server lookup froze streaming, and a transient one ended it](fixed-slow-media-lookup-froze-streaming.md)).

**Cause:** two separate versions of the same mistake. The media adapters
called `httpx.get()`/`httpx.post()`, the module-level convenience functions,
which build a client, resolve DNS, do a TLS handshake, make one request and
discard all of it - 13 call sites. And `routes/proxy.py`, which *had* been
migrated to a shared client and carried a long comment explaining why,
constructed it with httpx's defaults: at most 20 of up to 100 connections kept
alive, expiring after 5s. A library view scrolling past hundreds of covers
exceeds that immediately, so the surplus closed after each request and was
rebuilt for the next.

**Fix:** a shared pooled client for the adapters (`media/http_client.py`) and
explicit limits on the proxy's client, sized for the workload it actually
sees.

**Lesson worth keeping:** "it uses a pooled client" and "it actually reuses
connections" are not the same claim. The proxy's comment described the first
and was believed to mean the second.
