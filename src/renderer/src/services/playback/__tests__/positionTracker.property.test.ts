import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createPositionTracker } from '../positionTracker'

// Domain: elapsed/duration in seconds (a song is never literally 0s long in
// practice, but 0 duration is also the sentinel for "not yet known" — see
// positionTracker.ts — so it's covered separately in the "unclamped" tests
// below rather than mixed into durationArb). Time deltas in ms, matching
// performance.now()'s unit.
const elapsedArb = fc.double({ min: 0, max: 10_000, noNaN: true })
const durationArb = fc.double({ min: 1, max: 10_000, noNaN: true })
const dtMsArb = fc.integer({ min: 0, max: 600_000 })
const nowArb = fc.integer({ min: 0, max: 10 ** 9 })

describe('positionTracker (property-based)', () => {
  it('extrapolate() never exceeds duration, however much time has passed', () => {
    fc.assert(
      fc.property(elapsedArb, durationArb, nowArb, dtMsArb, (elapsed, duration, base, dt) => {
        const tracker = createPositionTracker()
        tracker.record(Math.min(elapsed, duration), base)
        expect(tracker.extrapolate(base + dt, duration)).toBeLessThanOrEqual(duration)
      }),
    )
  })

  it('extrapolate() never goes backward between two reads with no record()/reset() in between', () => {
    fc.assert(
      fc.property(elapsedArb, nowArb, dtMsArb, dtMsArb, (elapsed, base, dt1, dt2) => {
        const tracker = createPositionTracker()
        tracker.record(elapsed, base)
        const first = tracker.extrapolate(base + dt1, 0)
        const second = tracker.extrapolate(base + dt1 + dt2, 0)
        expect(second).toBeGreaterThanOrEqual(first)
      }),
    )
  })

  it('extrapolate() reads back exactly the recorded value at the moment of record()', () => {
    fc.assert(
      fc.property(elapsedArb, nowArb, (elapsed, now) => {
        const tracker = createPositionTracker()
        tracker.record(elapsed, now)
        expect(tracker.extrapolate(now, 0)).toBe(elapsed)
      }),
    )
  })

  it('reset() always makes extrapolate() report 0, regardless of any prior anchor', () => {
    fc.assert(
      fc.property(elapsedArb, nowArb, dtMsArb, durationArb, (elapsed, now, dt, duration) => {
        const tracker = createPositionTracker()
        tracker.record(elapsed, now)
        tracker.reset()
        expect(tracker.hasAnchor()).toBe(false)
        expect(tracker.extrapolate(now + dt, duration)).toBe(0)
      }),
    )
  })

  it('a fresh record() re-anchors outright whenever it is not a small backwards correction', () => {
    // This is the exact shape of the "0:00 stuck" / "stale position"
    // changelog bugs: a correction (record()) landing mid-flight must win
    // outright, never get blended with or overridden by extrapolation from
    // the anchor it's replacing.
    //
    // The one exception is a *small* backwards step, which is held instead
    // — see MAX_SMOOTHED_REWIND_SECONDS in positionTracker.ts. Excluded
    // here rather than weakening the assertion, so this keeps saying
    // exactly what it always did about every other case.
    fc.assert(
      fc.property(
        elapsedArb,
        elapsedArb,
        nowArb,
        dtMsArb,
        (firstElapsed, secondElapsed, base, dt) => {
          const tracker = createPositionTracker()
          tracker.record(firstElapsed, base)
          const correctionAt = base + dt
          const onScreen = firstElapsed + dt / 1000
          const rewind = onScreen - secondElapsed
          fc.pre(rewind <= 0 || rewind > 1.5)
          tracker.record(secondElapsed, correctionAt)
          expect(tracker.extrapolate(correctionAt, 0)).toBe(secondElapsed)
        },
      ),
    )
  })

  it('a small backwards correction holds the displayed position instead of rewinding it', () => {
    // The seek bar's time counter visibly ticking backwards, reported live.
    // The backend slews a recalibrated position_offset in over two seconds
    // (connect/core/playback_clock.py), so a status tick landing mid-slew
    // legitimately reads a little below the previous one — that must not
    // reach the display.
    fc.assert(
      fc.property(
        elapsedArb,
        fc.double({ min: 0.01, max: 1.5, noNaN: true }),
        nowArb,
        dtMsArb,
        (elapsed, rewind, base, dt) => {
          const tracker = createPositionTracker()
          tracker.record(elapsed, base)
          const correctionAt = base + dt
          const onScreen = tracker.extrapolate(correctionAt, 0)
          tracker.record(onScreen - rewind, correctionAt)
          expect(tracker.extrapolate(correctionAt, 0)).toBeCloseTo(onScreen, 6)
        },
      ),
    )
  })

  it('the displayed position never goes backward across an arbitrary run of small corrections', () => {
    // The invariant that actually matters to a listener, stated directly:
    // whatever sequence of ticks the backend sends, as long as each one is
    // within the smoothing window, what is on screen only ever advances.
    fc.assert(
      fc.property(
        elapsedArb,
        nowArb,
        fc.array(
          fc.record({
            dt: fc.integer({ min: 1, max: 4000 }),
            drift: fc.double({ min: -1.5, max: 1.5, noNaN: true }),
          }),
          { maxLength: 40 },
        ),
        (elapsed, base, ticks) => {
          const tracker = createPositionTracker()
          tracker.record(elapsed, base)
          let now = base
          let previous = tracker.extrapolate(now, 0)
          for (const { dt, drift } of ticks) {
            now += dt
            const seen = tracker.extrapolate(now, 0)
            tracker.record(seen + drift, now)
            const after = tracker.extrapolate(now, 0)
            expect(after).toBeGreaterThanOrEqual(previous - 1e-9)
            previous = after
          }
        },
      ),
    )
  })

  // Broader sweep: replay a random sequence of record()/reset()/extrapolate()
  // calls, with time only ever moving forward (like real performance.now()),
  // and check the invariants above hold at every step — not just in the
  // isolated two/three-step scenarios above. This is what actually catches
  // an interleaving nobody thought to hand-write, the same shape of bug
  // behind the tail-end/0:00/drift casting bugs in the changelog. Duration
  // is fixed at 0 (unclamped) here so the monotonicity check below isn't
  // muddied by a different clamp on every step — clamping itself is already
  // covered above.
  it('holds its invariants across arbitrary sequences of record()/reset()/extrapolate() calls', () => {
    const action = fc.oneof(
      fc.record({ type: fc.constant('record' as const), elapsed: elapsedArb }),
      fc.record({ type: fc.constant('reset' as const) }),
      fc.record({ type: fc.constant('check' as const) }),
    )

    fc.assert(
      fc.property(fc.array(fc.tuple(action, dtMsArb), { minLength: 1, maxLength: 40 }), (steps) => {
        const tracker = createPositionTracker()
        let now = 0
        let lastRecordedElapsed: number | null = null
        let lastExtrapolated: number | null = null

        for (const [step, dt] of steps) {
          now += dt
          if (step.type === 'record') {
            tracker.record(step.elapsed, now)
            lastRecordedElapsed = step.elapsed
            lastExtrapolated = null // a fresh anchor resets what "last read" means
          } else if (step.type === 'reset') {
            tracker.reset()
            lastRecordedElapsed = null
            lastExtrapolated = null
            expect(tracker.hasAnchor()).toBe(false)
          } else {
            expect(tracker.hasAnchor()).toBe(lastRecordedElapsed !== null)
            if (!tracker.hasAnchor()) {
              expect(tracker.extrapolate(now, 0)).toBe(0)
              continue
            }
            const value = tracker.extrapolate(now, 0)
            expect(value).toBeGreaterThanOrEqual(lastRecordedElapsed!)
            if (lastExtrapolated !== null) expect(value).toBeGreaterThanOrEqual(lastExtrapolated)
            lastExtrapolated = value
          }
        }
      }),
    )
  })
})
