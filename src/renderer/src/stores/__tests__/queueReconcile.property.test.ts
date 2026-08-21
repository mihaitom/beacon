import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { diffCastQueue, idsEqual } from '../queueReconcile'

const idListArb = fc.array(fc.string({ minLength: 1, maxLength: 5 }), { maxLength: 8 })
const nonEmptyIdListArb = fc.array(fc.string({ minLength: 1, maxLength: 5 }), {
  minLength: 1,
  maxLength: 8,
})

describe('idsEqual (property-based)', () => {
  it('is reflexive', () => {
    fc.assert(
      fc.property(idListArb, (ids) => {
        expect(idsEqual(ids, [...ids])).toBe(true)
      }),
    )
  })

  it('is symmetric', () => {
    fc.assert(
      fc.property(idListArb, idListArb, (a, b) => {
        expect(idsEqual(a, b)).toBe(idsEqual(b, a))
      }),
    )
  })

  it('is false whenever the lengths differ', () => {
    fc.assert(
      fc.property(idListArb, fc.string({ minLength: 1 }), (a, extra) => {
        expect(idsEqual(a, [...a, extra])).toBe(false)
      }),
    )
  })
})

describe('diffCastQueue (property-based)', () => {
  it('queueMatches always agrees with idsEqual on the queue lists, independent of originalQueue', () => {
    fc.assert(
      fc.property(
        idListArb,
        idListArb,
        idListArb,
        idListArb,
        (localQueue, localOriginal, remoteQueue, remoteOriginal) => {
          const result = diffCastQueue(
            { queue: localQueue, originalQueue: localOriginal },
            { queue: remoteQueue, originalQueue: remoteOriginal },
          )
          expect(result.queueMatches).toBe(idsEqual(localQueue, remoteQueue))
        },
      ),
    )
  })

  it('an empty remote original_queue always reports originalMatches, regardless of the local one', () => {
    fc.assert(
      fc.property(idListArb, idListArb, (localQueue, localOriginal) => {
        const result = diffCastQueue(
          { queue: localQueue, originalQueue: localOriginal },
          { queue: localQueue, originalQueue: [] },
        )
        expect(result.originalMatches).toBe(true)
      }),
    )
  })

  it('a non-empty remote original_queue agrees with idsEqual', () => {
    fc.assert(
      fc.property(idListArb, nonEmptyIdListArb, (localOriginal, remoteOriginal) => {
        const result = diffCastQueue(
          { queue: [], originalQueue: localOriginal },
          { queue: [], originalQueue: remoteOriginal },
        )
        expect(result.originalMatches).toBe(idsEqual(localOriginal, remoteOriginal))
      }),
    )
  })
})
