import { describe, expect, it } from 'vitest'
import { createPositionTracker } from '../positionTracker'

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
})
