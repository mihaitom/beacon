import { describe, expect, it } from 'vitest'
import { dropHalf, reorderTarget } from '../rowReorder'

// A move by (from, to) as the stores do it: take the row out, put it back
// in at `to`.
function moved(list: string[], from: number, to: number): string[] {
  const next = [...list]
  const [row] = next.splice(from, 1)
  next.splice(to, 0, row!)
  return next
}

const list = ['a', 'b', 'c', 'd', 'e']

describe('dropHalf', () => {
  const rect = { top: 100, height: 40 }

  it('drops in front of a row from its upper half', () => {
    expect(dropHalf(110, rect)).toBe('before')
  })

  it('drops behind a row from its lower half', () => {
    expect(dropHalf(130, rect)).toBe('after')
  })
})

describe('reorderTarget', () => {
  it('moves a row down to just behind the row it was dropped on', () => {
    // 'b' onto the lower half of 'd'.
    expect(moved(list, 1, reorderTarget(1, 3, 'after'))).toEqual(['a', 'c', 'd', 'b', 'e'])
  })

  it('swaps a row with the very next one', () => {
    expect(moved(list, 1, reorderTarget(1, 2, 'after'))).toEqual(['a', 'c', 'b', 'd', 'e'])
  })

  it('moves a row up to just in front of the row it was dropped on', () => {
    // 'd' onto the upper half of 'b'.
    expect(moved(list, 3, reorderTarget(3, 1, 'before'))).toEqual(['a', 'd', 'b', 'c', 'e'])
  })

  it('moves a row to the end', () => {
    expect(moved(list, 0, reorderTarget(0, 4, 'after'))).toEqual(['b', 'c', 'd', 'e', 'a'])
  })

  it('leaves a row dropped next to itself where it is', () => {
    expect(reorderTarget(2, 2, 'before')).toBe(2)
    expect(reorderTarget(2, 2, 'after')).toBe(2)
    expect(reorderTarget(2, 3, 'before')).toBe(2)
    expect(reorderTarget(2, 1, 'after')).toBe(2)
  })
})
