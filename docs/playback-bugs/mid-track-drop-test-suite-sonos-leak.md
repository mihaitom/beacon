# Cast device drops mid-track - test-suite Sonos-discovery leak (RESOLVED 2026-08-24, test-suite side)

See [the shared symptom/evidence file](mid-track-drop-symptom.md) for the
device-side signature, the full drops table, and the ruled-out list. This
file is the second, independent mechanism found for the identical symptom -
see also [the reverse-proxy 403 file](mid-track-drop-reverse-proxy-403.md),
the first one found, which this does **not** replace or override.

**What's resolved:** the test suite can no longer reach real Sonos hardware,
confirmed by a live A/B (below). **Assessment as of 2026-08-24 (the
listener's call): probably explains the whole mid-track-drop pattern in
[the symptom file](mid-track-drop-symptom.md)** - every recent drop lines up
with a `pytest` run, 5 for 5. Not independently confirmed on the wire - see
"What this does and does not explain" below for the gap and what would close
it.

## How it was found

2026-08-24, investigating that evening's cluster of drops, the listener
questioned the assumption that this was a recurrence of the old, external
mystery rather than something local going unnoticed - which prompted a fresh
look instead of re-filing it under the already-fixed 403 cause.

The listener then noticed the pattern directly: playback kept breaking
whenever the backend test suite was run. Confirmed with a deliberate,
controlled repro: fresh playback started, `pytest -q` run, playback stopped
immediately - twice, independently.

## The mechanism

`tests/test_playback.py`'s `/resume` regression test,
`test_resume_then_resync_does_not_corrupt_position_offset_after_deep_pause`,
used a *real production room's name* (rooms are anonymized to "room A"/"room
B" etc. throughout this log, same as elsewhere) for its `active_delivery`,
and only mocked `.play()`:

```python
default_session.state.active_delivery = SonosDelivery("room A")
...
with patch.object(SonosDelivery, "play", new=AsyncMock()):
    client.post("/resume")
```

`/resume`'s handler (`routes/playback.py`) schedules two background tasks
after that `.play()` call - `_apply_position_offset()` and
`_resync_position_periodically()` - which call the real, unmocked
`get_position()` for as long as the test process runs. Neither task is
awaited or cancelled by the test, and neither was covered by the `.play()`
mock. `get_position()` calls `SonosDelivery._get_device()`, which (absent a
cache hit) calls a real `soco.discover()` - a genuine network-wide SSDP
M-SEARCH - followed by a real `get_current_track_info()` SOAP call against
whatever answers to that room's real name.

The dev machine this runs on and the production Sonos speakers are on the
**same LAN** (confirmed via `ip route get`), so `soco.discover()`
finds the real device, not a fake one. `_apply_position_offset()` alone polls
`get_position()` every 0.5s for up to 10s; `_resync_position_periodically()`
then continues every `POSITION_RESYNC_INTERVAL` (8s) until the session's
`play_generation` changes - which, for this orphaned background task tied to
a test's now-discarded session object, never happens again, so it polls the
real device for as long as the pytest process itself stays alive (i.e. for
the rest of that test run).

## Confirmed reproducible

Cross-referencing every `pytest` invocation's timestamp that evening against
the drop log: four of the five mid-track drops that evening started 6-35s
after the start of a *full* `pytest -q` run (which takes ~35-45s), squarely
inside its execution window; the fifth lines up with the same test suite run
manually by the listener. See the table in
[the shared symptom file](mid-track-drop-symptom.md) (rows 12-14) for the
exact figures.

After the fix below was applied, the correlation was tested directly, twice:
fresh playback started, full `pytest -q` run (1228 passed, ~35s), playback
observed stable throughout both times.

## What this does and does not explain

**Does not explain:** the very first drop that evening, 20:31 ("Royal
Gigolos") - that one has its own confirmed, unrelated cause, an auto-advance
race - see
[Auto-advance onto a still-playing device drops the next track silently](auto-advance-still-playing-device.md).
The coincidence with a pytest run at the time was chance; that entry's own
log trace shows Beacon's own `device.stop()` call causing the stop, nothing
to do with test pollution.

**Does not yet explain the mechanism fully:** why a foreign, read-only SOAP
query from another host would make the device abandon its own
separately-held streaming connection to Beacon. The leading guess is that
Sonos's famously small concurrent-HTTP-connection budget gets exhausted by
the burst (SSDP + confirmation ping + repeated `get_current_track_info`, all
inside a few seconds, on top of the device's own in-flight audio fetch), but
that is inferred, not observed on the wire. Confirming it would need a packet
capture that also covers a second, non-production host's traffic to the
speaker during a reproduction.

**Casts doubt on the 2026-08-23 reverse-proxy 403 root cause too - not as
wrong, but as possibly not exhaustive.** `git blame` on the leaking test: the
real room name has been in the test suite since the very
first commit (`bad78f0`, 2026-08-12); the specific `/resume` test that leaks
the unmocked background tasks was added in `6265bf7` on 2026-08-20 - already
present throughout "A day of elimination" and "The controlled comparison"
(2026-08-22/23), which were also, ordinarily, worked on by running this same
test suite repeatedly against a live cast on the same LAN. See
[the reverse-proxy 403 file](mid-track-drop-reverse-proxy-403.md) for the full
caveat - that root cause is not in doubt, but it was never established as the
*only* thing dropping casts in that window.

**A related but distinct pre-existing note:** [the shared symptom file's
"Open lead - Beacon re-runs SSDP discovery every 8 seconds"](mid-track-drop-symptom.md)
documents the same `_get_device()`/`soco.discover()` mechanism causing load
during a *legitimate* cast session - a performance concern, not a leak, since
a real session is supposed to be able to reach its own device. This entry is
about *test* code reaching a real device it was never supposed to touch at
all - related root mechanism, different bug.

## The fix

`tests/conftest.py` gained an autouse fixture:

```python
@pytest.fixture(autouse=True)
def _block_real_sonos_discovery(monkeypatch):
    monkeypatch.setattr("soco.discover", lambda *args, **kwargs: None)
```

`SonosDelivery._get_device()` already handles `soco.discover()` returning
nothing cleanly (`list(soco.discover() or [])` → `RuntimeError("No Sonos
devices found.")`), and both leaking background tasks already swallow
exceptions from `get_position()` (`except Exception: continue`), so the net
effect is: any test that doesn't explicitly mock discovery itself now fails
closed (raises internally, caught, retried, eventually gives up) instead of
silently reaching real hardware. Every test that legitimately needs a device
already patches `soco.discover` or `SonosDelivery._get_device` itself, which
shadows this default for its own scope - full suite (1228 tests) still
passes unchanged.

**Why the test suite didn't catch itself:** there was no test *of the test
suite's* network isolation - nothing asserted that `soco.discover()` was
never reachable un-mocked. The specific leaking test was itself thoroughly
tested from the application's point of view (the `/resume` regression it
covers is real and correct); the gap was one level up; from the test
environment's own responsibility to never touch production systems.

## Next step

Whether the mid-track drops in
[the symptom file](mid-track-drop-symptom.md) stop entirely now that this
can't happen is the real test - open until a quiet multi-day stretch (with
the backend test suite still being run normally) confirms it, or a repro
attempt with test runs deliberately withheld does.
