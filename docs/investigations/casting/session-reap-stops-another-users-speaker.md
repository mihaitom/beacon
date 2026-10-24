# A session being reaped stopped a speaker somebody else was using (RESOLVED 2026-08-22)

Not a drop, but it produces one: the same "cast device dropped its connection"
error, with no cause visible in the affected instance at all. Worth reading
before chasing a drop that happened while more than one Beacon instance was
running.

**What happened:** at 22:01:30 a session in one instance was reaped after
`SESSION_IDLE_TIMEOUT`, and `reap_once()` called `stop()` on the delivery it
still held from a cast that had ended over an hour earlier. That speaker
belonged to a *different* Beacon instance by then, which was mid-track on it.
The victim instance saw its stream cancelled with nothing to explain it - no
request, no error - and reported a drop 10s later. The only trace was a single
`[Sonos:room A] stopped` line in the *other* container's log.

Cross-instance claims cannot catch this: `core/claims.py` is per process, and
two instances share nothing but the speakers themselves. Session ids don't
even differ between them - they are derived from the media-server login, so
the same user gets the same id everywhere.

**Fix:** `reap_once()` now stops a device only when the session still believes
it is streaming *and* the device still reports our own stream URL (our port,
our session id) as what it is playing - `BaseDelivery.current_uri()`, with
Sonos/Chromecast/DLNA implementations and `None` ("can't say", stop as before)
for AirPlay.

**Why the tests didn't catch it:** the existing reap test asserted that the
delivery gets stopped, which was the whole of the intended behaviour as
written. Nothing described *whose* device it was, because until a second
instance existed on the same network the question could not come up.
