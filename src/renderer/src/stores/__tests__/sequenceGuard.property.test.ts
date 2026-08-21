import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createSequenceGuard } from '../sequenceGuard'

describe('sequenceGuard (property-based)', () => {
  it('of any run of begin() calls, only the token from the last one is current', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (count) => {
        const guard = createSequenceGuard()
        const tokens = Array.from({ length: count }, () => guard.begin())
        tokens.forEach((token, i) => {
          expect(guard.isCurrent(token)).toBe(i === tokens.length - 1)
        })
      }),
    )
  })

  it('a token, once superseded, never becomes current again — no matter how many more begin() calls follow', () => {
    // The exact shape of the race switchToIndexGuard/startCurrentGuard
    // exist for: a slow older call (e.g. the first of two rapid clicks)
    // resolving after a newer, faster one has already won must never read
    // as "still current".
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 50 }), (count) => {
        const guard = createSequenceGuard()
        const first = guard.begin()
        for (let i = 1; i < count; i++) guard.begin()
        expect(guard.isCurrent(first)).toBe(false)
      }),
    )
  })

  it('interleaving isCurrent() checks between begin() calls never reports more than one token current at a time', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 30 }), (count) => {
        const guard = createSequenceGuard()
        const tokens: number[] = []
        for (let i = 0; i < count; i++) {
          tokens.push(guard.begin())
          const currentCount = tokens.filter((t) => guard.isCurrent(t)).length
          expect(currentCount).toBe(1)
        }
      }),
    )
  })
})
