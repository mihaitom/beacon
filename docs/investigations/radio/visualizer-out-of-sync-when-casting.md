# OPEN: the radio visualizer never lined up with the cast audio

The fullscreen visualizer, while a _station_ is casting, is paced by the
device's own reported position (`core/radio_position.py` ->
`core/visualizer_feed.py`'s `_OffsetTrackerClock`). It has never been in
sync with what comes out of the speaker, and the feature has been behind
`RADIO_VISUALIZER_ENABLED` (`src/renderer/src/stores/connect.ts`) since
2026-09-04 for that reason. Flag back on 2026-09-07 for a fresh round of
measurements; this entry is what that round found.

**The one thing to read before touching this again:** every decision taken
between 2026-09-03 and 2026-09-05 was taken with a broken instrument. The
debug overlay re-based _both_ sides of its delta onto the first delivered
frame, so frame one read (0.00, 0.00) by construction and everything after
it was relative drift. A visualizer running the full device lead ahead of
the audio - the exact complaint the overlay was built for - still showed
Δ +0.00s. Fixed 2026-09-05 in `core/audio_analysis.py`, same commit as the
legend. Notes older than that date are not evidence.

## The mechanism that was wrong

`_OffsetTrackerClock` folded `RadioPositionTracker.buffer_lag()` into its
baseline from 2026-09-03, on this algebra: the baseline is the device's own
(already lagging) position taken once, so for a device playing at real-time
speed `elapsed_fn() - baseline` reduces to plain wall-clock time since the
baseline, and the device's delay cancels out of the subtraction instead of
surviving it. Therefore, it was reasoned, every frame comes out `lag`
seconds ahead of what the device is playing, and adding `lag` to the
baseline puts it back.

The algebra is right. The conclusion was not, and the fold never delivered
what it promised:

- **The analyzer reads the relay's live edge.** It subscribes lossy and
  without a burst (`core/radio_relay.py`'s `subscribe_audio()`, whose
  docstring says outright that an analyzer must never have one), so the
  oldest content it can possibly show is what its own decode buffer holds -
  `_MAX_LOOKAHEAD_SECONDS`, 3.0s. A hold of ten seconds cannot be served
  out of a three-second buffer; the surplus is dropped chunk by chunk by
  the lossy queue.
- **What was left of it evaporated in `elapsed()`.** While the folded
  baseline sat ahead of the device, `raw` clamped at 0 - and the
  extrapolation anchor seeded itself _from that clamped 0_ and then
  free-ran forward at real time. The hold lasted exactly one call. That is
  why the fold was invisible to the unit tests around it: they check the
  shape of the output (smoothed, monotonic, forward-only), which stayed
  perfect throughout.

## The measurement, 2026-09-07, Chromecast

With the fold logged (`[visualizer] tracker baseline += lag=...`) and the
overlay finally able to show an absolute delta:

| Reading                         | Run 1        | Run 2        |
| ------------------------------- | ------------ | ------------ |
| `buffer_lag()` folded in        | not logged   | 11.67s       |
| Δ right after the fold          | -            | ~-11s        |
| Δ once settled (within seconds) | -2.46s       | -2.19s       |
| Heard offset                    | "about that" | "about that" |

Δ is `content_position` of the released frame minus the session clock,
both re-based on first byte. Negative means the picture is behind the
sound. In both runs the listener heard the picture arrive late by roughly
the settled Δ - **the opposite of the complaint the fold was built for.**

The trajectory is the finding: a fold of 11.67s produced a steady state of
2.2s, so the pipeline is not passing the hold through. It saturates.

## What changed (2026-09-07)

- The fold is gone. `_apply_measured_lag()` is now
  `_apply_lead_correction()`: it still reads `buffer_lag()` once per
  baseline and logs it (the one number saying how long a device took to
  start after its own dispatch), and applies only
  `tracker_lead_correction()` - a calibration somebody measures, 0 by
  default.
- `elapsed()` no longer seeds its extrapolation anchor from a clamped
  zero. A baseline pushed ahead of the device now actually holds until the
  device passes it. Without this, any future correction would have
  evaporated the same way the fold did. Regression test:
  `test_a_correction_holds_the_clock_instead_of_evaporating`.

## Ruled out

- **"The device's startup buffer is the offset."** It is measurable
  (11.67s on Chromecast, consistent with the ~10.6-11.0s in
  `core/radio_position.py`'s docstring) and it is not what a listener sees.
  Applying it made things worse in the direction nobody predicted.
- **`tracker_lead_correction()` was the culprit.** It was 0 the whole time,
  as the log line shows. The 11.67s came from `buffer_lag()`.
- **The relay's burst buffer delays the analyzer.** It does not get one -
  `subscribe_audio(lossy=True)`, no `burst`. Devices do not get one either;
  only the local player does.

## After the removal, same evening

Chromecast, fresh station: `buffer_lag()` 12.22s measured and logged,
nothing applied. Δ settles at **+0.38s** - the picture now runs slightly
_ahead_ - and the listener puts what they hear at about half a second
early. The ~2.2s late is gone, and what is left is small and in the other
direction. The pipeline-depth theory is therefore out: a decoder pinned at
its lookahead cap would still be seconds behind, not ahead.

Read the delta only after this line, which arrives 15s or so in:

```
[position-resync] external position change detected — device=3.80s wall=16.01s, offset -2.19s -> -12.21s
```

That is the session clock - the delta's own right-hand side - being
recalibrated onto the device's reported position. Anything read before it
is a reading against a clock that is about to move 10s.

## Why the target is not Δ = 0

Δ compares the visualizer clock to the session clock, and the session clock
is calibrated to the device's _reported_ position. That report is where the
device's decoder is, not where the sound is: everything after it - the
Chromecast's own output stage, HDMI, whatever the speaker does - reports
nothing to any protocol Beacon speaks. Pinning Δ to 0 pins the picture to
the report, which is exactly the state measured above: Δ +0.38s, and still
audibly early.

So the last term is not measurable from inside the pipeline, by any
timestamp, and no amount of arithmetic finds it. Only eye and ear can, and
`BEACON_LEAD_CORRECTION_TRACKER` is where the answer goes. A correctly
calibrated install therefore reads Δ ≈ -(correction), not 0.

Two things to know while measuring it:

- **Not on 4/4 music.** At 120bpm a beat is 0.5s, and "the bars are down
  when the beat lands" fits ~0.25s early as well as ~0.75s late. Periodic
  material cannot tell an offset from an offset plus one beat - the same
  ambiguity that got the first correction measured this way (~1s,
  2026-09-05) retracted. Use `/debug/test-radio`, whose octave sequence is
  unambiguous.
- **The report is quantized.** A polled position steps in ~0.5s (DLNA:
  whole seconds), so the reference itself carries that much uncertainty
  before anything is calibrated against it.

## A separate failure, same evening: 48s of frozen bars

Not the sync question, and not caused by the removal - worth its own note
because it looks exactly like a broken visualizer and is not one.

After a pause/resume 3s into a station, a Chromecast reported nothing
usable for 48 seconds: `get_position()` returned None every poll
(`[position-resync] no usable position (raw=None)` repeatedly), so the
tracker never saw movement, the visualizer clock stood still, and the
buffering indicator stayed on - while the speaker played the whole time.

The proof that it was playing is in the same log:

```
18:47:13 real movement detected (0.08s -> 35.61s) — buffering done
18:47:13 tracker ready: device started 13.00s after its own dispatch
```

35.61s of audio at 48.6s after dispatch is a device that started 13s in and
has been playing ever since. It simply never said so. Everything that waits
on that reading - the bars and the buffering label both - waits blind.

`adjusted_current_time` only extrapolates while the pushed status says
PLAYING; anything else (BUFFERING, IDLE) reads as no position at all. And
the status is the last one the device _pushed_: a Chromecast object is
reused across dispatches (`_chromecast_cache`), so it can be the previous
session's.

Changed for the next occurrence: `ChromecastDelivery.get_position()` now
asks for a fresh status (`update_status()`, rate-limited to 1s) whenever the
cached one says nothing usable, and logs the `player_state` it saw. That
distinguishes the two candidates, which the old log could not:

- a stale cached status nothing ever updated - the ask fixes it;
- a device genuinely reporting BUFFERING for 48s - the ask changes nothing,
  and the fix has to be to stop trusting the device's own readiness. The
  relay knows whether that device is still pulling bytes, which is harder
  evidence of playback than anything the device says about itself.

## The reading that ended it: Δ +0.09s, seconds out of sync

Ten minutes into a station, after the screen had locked and the frontend
had been reloaded:

```
Visualizer: 172.55s
Cast: 172.46s
Δ: +0.09s
```

Two clocks agreeing to within a tenth of a second - and eye and ear several
seconds apart. **The delta cannot see this class of error at all**, and
that is not a bug in the overlay, it is what the delta is:

- A frontend reload starts a fresh analyzer (`Radio analysis started`),
  whose content position is 0 at its own first decoded byte - taken from
  the relay's **live edge**, since the analyzer subscribes lossy and
  without a burst.
- The cast clock's own baseline for the delta is taken at that same
  moment. Both sides then advance at real time, so the delta is ~0 by
  construction, whatever the device is playing.
- The device, meanwhile, is 13s behind live - its own log line says so on
  every dispatch of the evening: `device started 13.07s after its own
dispatch`, and the resync agrees: `device=843.14s wall=856.12s
delta=-12.99s`.

So the picture shows live audio, the speaker plays audio from 13s ago, and
the instrument reports agreement.

## Conclusion, 2026-09-07

The feature went back off the same evening it was opened. Not because of a
missing constant - because the gap is not a clock offset at all:

**The visualizer is fed the live edge; the device plays ~13s behind it.**
No arithmetic on a clock closes that, which is why the removed
`buffer_lag()` fold could not work: an analyzer can only be held back by
its own decode buffer (`_MAX_LOOKAHEAD_SECONDS`, 3s), and everything asked
of it beyond that is dropped by the lossy queue.

What would actually be needed is to feed the analyzer _delayed_ audio -
a per-device delay line of `buffer_lag()` seconds between the relay and
this analyzer's ffmpeg, sized from the same measurement that is already
logged - rather than to shift the clock that releases its frames. That is
a real piece of work, and it is the thing to build if anyone opens this
again. Two known costs up front: the delay is per device (a multi-target
cast has no single right value), and the delay line has to survive a
station change without stranding decoded frames in the future.

Also worth knowing, whoever picks it up: a small residual _is_ real on top
of the big one (Δ +0.38s on a clean start, heard as a hair early, and
`BEACON_LEAD_CORRECTION_TRACKER` is where it goes). It is the last 5% of
this problem, not the problem.

Tools that work: the debug overlay with its legend (log level Debug/Trace),
and the beep station at `/debug/test-radio`, whose octave sequence makes
"a second early" and "an interval minus a second late" distinguishable -
they were not, which is why the first correction measured this way
(~1s, 2026-09-05) was retracted rather than shipped as a default.
