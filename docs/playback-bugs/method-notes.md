# Method notes

Things that repeatedly turned out to matter while chasing these:

- **Measure, do not infer.** Every real finding here came from a number, not
  from reading code. Two theories in one investigation looked compelling and
  were wrong; each was killed by a single measurement.
- **Beware n=1 correlation.** "The only track that dropped was also the only
  one with a big cover" was a real observation and a wrong conclusion. The
  next drop had a factor of 1.006.
- **A confident comment is not evidence.** Both the pacing bitrate and the
  waveform threading were wrong *and* documented as correct. Where a comment
  explains why something is safe, that is a place to check, not to trust.
- **100% coverage cannot catch a wrong meaning or a slow implementation.**
  Both major fixes here were bugs where the code did exactly what it said.
- **Silence is not success.** A monitor with a broken filter, or a lapsed UPnP
  subscription, looks exactly like "no problems occurred". Verify that
  instrumentation actually fires before trusting its quiet. This happened
  three times in one day: an invalid regex that would have died silently, a
  capture filtered to the wrong port, and a "clean" test window during which
  nothing was actually casting.
- **Check that the experiment is running before reading its result.** A
  scroll-load test was evaluated as passing before anyone noticed no cast was
  active at the time.
- **Do not build statistics on a handful of events.** Five occurrences with no
  measured denominator do not support a rate, and a rate is what a
  probability would need. "It used to happen in most listening sessions and
  has not since" is the honest form; anything with a percentage in it is not.
- **Prefer positive exclusions to absent signals.** "We saw no reboot" is
  weak; "the UPnP subscription kept the same SID across every renewal, which
  a reboot would have invalidated, and the event stream has no gap" is
  strong. Several theories were closed only because the instrumentation
  could show the thing was *still true*, not merely that nothing appeared.
- **Say when a hypothesis has become unfalsifiable, and then stop.** The
  firmware theory (see
  [the reverse-proxy 403 file](mid-track-drop-reverse-proxy-403.md)) fits
  every observation and cannot be tested, because dating the install needs a
  log that was switched off. That is not a lead in reserve; it is a place to
  stop spending time until a new source of evidence exists.
- **Absence is a weak result, so design for comparison instead.** Waiting for
  a rare, unreproducible bug to *not* happen can never be conclusive. Running
  the pre-fix build beside the current one, same room, same tooling, is worth
  more than any amount of quiet.
- **A test suite that reaches real infrastructure is itself a bug.** See the
  [test-suite Sonos-discovery leak](mid-track-drop-test-suite-sonos-leak.md):
  the same rigour applied to production code (measure, don't infer; check the
  correlation, don't assume it) is what actually found it - the fix wasn't
  found by reasoning about test isolation in the abstract, it was found by
  cross-referencing timestamps once the possibility was taken seriously.
