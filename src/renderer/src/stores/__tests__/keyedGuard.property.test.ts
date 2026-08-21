import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createKeyedGuard } from '../keyedGuard'

const keyArb = fc.string({ minLength: 1, maxLength: 4 })

describe('keyedGuard (property-based)', () => {
  it('after a run of begin() calls, only the last key is current', () => {
    fc.assert(
      fc.property(fc.array(keyArb, { minLength: 1, maxLength: 30 }), (keys) => {
        const guard = createKeyedGuard<string>()
        for (const key of keys) guard.begin(key)
        const last = keys[keys.length - 1]!
        expect(guard.isCurrent(last)).toBe(true)
        // Every earlier key is only "current" if it happens to equal the
        // last one (the same key begun again) — otherwise it must read as
        // superseded.
        for (const key of keys) {
          expect(guard.isCurrent(key)).toBe(key === last)
        }
      }),
    )
  })

  it("end() on a stale key never clears a newer key's in-flight state", () => {
    fc.assert(
      fc.property(keyArb, keyArb, (older, newer) => {
        fc.pre(older !== newer)
        const guard = createKeyedGuard<string>()
        guard.begin(older)
        guard.begin(newer)
        guard.end(older) // the older call's own (now-stale) cleanup
        expect(guard.isCurrent(newer)).toBe(true)
        expect(guard.hasAny()).toBe(true)
      }),
    )
  })

  it('end() on the current key always clears hasAny(), regardless of how it got there', () => {
    fc.assert(
      fc.property(fc.array(keyArb, { minLength: 1, maxLength: 20 }), (keys) => {
        const guard = createKeyedGuard<string>()
        for (const key of keys) guard.begin(key)
        guard.end(keys[keys.length - 1]!)
        expect(guard.hasAny()).toBe(false)
      }),
    )
  })
})
