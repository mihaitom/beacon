import { describe, expect, it } from 'vitest'
import { createEdgeDetector } from '../edgeDetector'

describe('edgeDetector', () => {
  it('reports no edge on the very first update() when it matches the (default false) initial value', () => {
    const detector = createEdgeDetector()
    expect(detector.update(false)).toBe(null)
  })

  it('a first update() that differs from the default initial value is a real rising edge', () => {
    // Matches lastEnded's original semantics: it started at `false`, so a
    // connect status already reporting `ended: true` on the very first
    // tick correctly fired advanceOnSongEnd() rather than being swallowed
    // as "no previous value to compare against".
    const detector = createEdgeDetector()
    expect(detector.update(true)).toBe('rising')
  })

  it('reports "rising" on a false→true transition', () => {
    const detector = createEdgeDetector()
    detector.update(false)
    expect(detector.update(true)).toBe('rising')
  })

  it('reports "falling" on a true→false transition', () => {
    const detector = createEdgeDetector(true)
    expect(detector.update(false)).toBe('falling')
  })

  it('reports null on repeated identical values — the "already-ended, still ended" case that must not re-trigger', () => {
    const detector = createEdgeDetector()
    detector.update(true)
    expect(detector.update(true)).toBe(null)
    expect(detector.update(true)).toBe(null)
  })

  it('only fires once per transition, not again until the value actually flips back', () => {
    const detector = createEdgeDetector()
    expect(detector.update(true)).toBe('rising')
    expect(detector.update(true)).toBe(null)
    expect(detector.update(false)).toBe('falling')
    expect(detector.update(true)).toBe('rising')
  })

  it('an explicit initial value of true means an immediate false is a real falling edge, not the first-call null', () => {
    const detector = createEdgeDetector(true)
    expect(detector.update(true)).toBe(null) // no change from the initial value
    expect(detector.update(false)).toBe('falling')
  })
})
