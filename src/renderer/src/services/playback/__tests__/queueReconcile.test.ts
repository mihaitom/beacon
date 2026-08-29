import { describe, expect, it } from 'vitest'
import { diffCastQueue, idsEqual } from '../queueReconcile'

describe('idsEqual', () => {
  it('is true for same ids in the same order', () => {
    expect(idsEqual(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true)
  })

  it('is false when the order differs', () => {
    expect(idsEqual(['a', 'b'], ['b', 'a'])).toBe(false)
  })

  it('is false when the lengths differ, even if one is a prefix of the other', () => {
    expect(idsEqual(['a', 'b'], ['a', 'b', 'c'])).toBe(false)
  })

  it('is true for two empty lists', () => {
    expect(idsEqual([], [])).toBe(true)
  })
})

describe('diffCastQueue', () => {
  it('matches both when local and remote are identical', () => {
    const result = diffCastQueue(
      { queue: ['a', 'b'], originalQueue: ['a', 'b'] },
      { queue: ['a', 'b'], originalQueue: ['a', 'b'] },
    )
    expect(result).toEqual({ queueMatches: true, originalMatches: true })
  })

  it('flags the queue as not matching when the remote list differs', () => {
    const result = diffCastQueue(
      { queue: ['a', 'b'], originalQueue: ['a', 'b'] },
      { queue: ['a', 'b', 'c'], originalQueue: ['a', 'b'] },
    )
    expect(result.queueMatches).toBe(false)
  })

  it('treats an empty remote original_queue as a match, not something to adopt', () => {
    const result = diffCastQueue(
      { queue: ['a'], originalQueue: ['a', 'b', 'c'] },
      { queue: ['a'], originalQueue: [] },
    )
    // A payload that never meaningfully set original_queue shouldn't wipe
    // out the local one.
    expect(result.originalMatches).toBe(true)
  })

  it('flags originalMatches false when a non-empty remote original_queue genuinely differs', () => {
    const result = diffCastQueue(
      { queue: ['a'], originalQueue: ['a', 'b'] },
      { queue: ['a'], originalQueue: ['b', 'a'] },
    )
    expect(result.originalMatches).toBe(false)
  })
})
