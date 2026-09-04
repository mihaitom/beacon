import { describe, expect, it } from 'vitest'
import { createPositionTracker } from '../positionTracker'

// Mirrors MAX_SMOOTHED_REWIND_SECONDS in positionTracker.ts, which stays
// private to record() — this is the largest backwards step the tests below
// expect to be smoothed rather than followed.
const MAX_SMOOTHED_REWIND = 1.5

describe('positionTracker', () => {
  it('has no anchor before the first record()', () => {
    const tracker = createPositionTracker()
    expect(tracker.hasAnchor()).toBe(false)
  })

  it('has an anchor once recorded', () => {
    const tracker = createPositionTracker()
    tracker.record(10, 1000)
    expect(tracker.hasAnchor()).toBe(true)
  })

  it('extrapolates forward from the recorded anchor by elapsed wall-clock time', () => {
    const tracker = createPositionTracker()
    tracker.record(10, 1000)
    expect(tracker.extrapolate(1500, 0)).toBeCloseTo(10.5) // +500ms
  })

  it('returns exactly the anchor at the moment it was recorded', () => {
    const tracker = createPositionTracker()
    tracker.record(42, 1000)
    expect(tracker.extrapolate(1000, 0)).toBe(42)
  })

  it('clamps the extrapolated value to duration', () => {
    const tracker = createPositionTracker()
    tracker.record(179, 1000)
    expect(tracker.extrapolate(5000, 180)).toBe(180) // would overshoot without clamping
  })

  it('does not clamp when duration is 0 (not yet known)', () => {
    const tracker = createPositionTracker()
    tracker.record(179, 1000)
    expect(tracker.extrapolate(5000, 0)).toBeGreaterThan(180)
  })

  it('re-anchors on a fresh record(), discarding extrapolation built on the old anchor', () => {
    const tracker = createPositionTracker()
    tracker.record(10, 1000)
    tracker.record(50, 2000) // a real correction, e.g. the next SSE tick
    expect(tracker.extrapolate(2000, 0)).toBe(50)
  })

  it('drops the anchor on reset(), so hasAnchor() is false again', () => {
    const tracker = createPositionTracker()
    tracker.record(10, 1000)
    tracker.reset()
    expect(tracker.hasAnchor()).toBe(false)
  })

  it('extrapolate() reports 0 once reset — nothing to anchor from', () => {
    const tracker = createPositionTracker()
    tracker.record(10, 1000)
    tracker.reset()
    expect(tracker.extrapolate(2000, 0)).toBe(0)
  })

  describe('a small backwards correction', () => {
    it('holds the displayed position at the moment it lands', () => {
      const tracker = createPositionTracker()
      tracker.record(10, 1000)
      tracker.record(10.5, 2000) // 11s on screen by now — a 0.5s rewind
      expect(tracker.extrapolate(2000, 0)).toBeCloseTo(11)
    })

    it('is given back over the catch-up window rather than held forever', () => {
      const tracker = createPositionTracker()
      tracker.record(10, 1000)
      tracker.record(10.5, 2000) // held 0.5s ahead of the backend

      // Halfway through the 2s window: half the lead handed back, so the
      // display has advanced 0.75s over the last second instead of 1s.
      expect(tracker.extrapolate(3000, 0)).toBeCloseTo(11.75)
      // Window over — exactly what the backend would say by now (10.5 + 2s),
      // no lead left.
      expect(tracker.extrapolate(4000, 0)).toBeCloseTo(12.5)
      expect(tracker.extrapolate(5000, 0)).toBeCloseTo(13.5)
    })

    it('never stalls or reverses while giving it back', () => {
      const tracker = createPositionTracker()
      tracker.record(10, 1000)
      tracker.record(10 - MAX_SMOOTHED_REWIND, 1000) // the largest lead still smoothed

      let previous = tracker.extrapolate(1000, 0)
      for (let now = 1050; now <= 4000; now += 50) {
        const value = tracker.extrapolate(now, 0)
        expect(value).toBeGreaterThan(previous)
        previous = value
      }
    })

    it('does not accumulate into a lead that eventually snaps back', () => {
      // The bug this all exists for: every ~2s status tick reading a little
      // below the extrapolated position used to push the display further
      // ahead of the backend for good, until the gap crossed the smoothing
      // window and one tick was taken at face value — the seek bar jumping
      // backwards, and the lyrics highlight with it.
      const tracker = createPositionTracker()
      let now = 1000
      let elapsed = 10
      tracker.record(elapsed, now)

      for (let tick = 0; tick < 40; tick++) {
        now += 2000
        elapsed += 1.8 // the backend consistently a little behind wall clock
        const before = tracker.extrapolate(now, 0)
        tracker.record(elapsed, now)
        // Never a backwards step at a tick boundary...
        expect(tracker.extrapolate(now, 0)).toBeGreaterThanOrEqual(before)
      }

      // ...and never more than one catch-up window's worth ahead of what the
      // backend last reported, however many corrections have gone by.
      expect(tracker.extrapolate(now, 0) - elapsed).toBeLessThanOrEqual(MAX_SMOOTHED_REWIND)
    })
  })
})
