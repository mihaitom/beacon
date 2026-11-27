import { describe, expect, it } from 'vitest'
import { sectionedRows } from '../sectionedRows'

const first = (word: string) => word[0]!
const key = (word: string) => word

function shape(entries: ReturnType<typeof sectionedRows<string>>) {
  return entries.map((entry) =>
    entry.kind === 'section' ? `[${entry.section}]` : entry.items.map((c) => c.item).join(','),
  )
}

describe('sectionedRows', () => {
  it('puts a divider before each section and fills rows within it', () => {
    const entries = sectionedRows(['a1', 'a2', 'a3', 'b1'], first, 2, key)
    expect(shape(entries)).toEqual(['[a]', 'a1,a2', 'a3', '[b]', 'b1'])
  })

  it('is one item a row for a list', () => {
    expect(shape(sectionedRows(['a1', 'b1'], first, 1, key))).toEqual(['[a]', 'a1', '[b]', 'b1'])
  })

  it('has no dividers for an order without sections', () => {
    expect(shape(sectionedRows(['a1', 'a2', 'b1'], null, 2, key))).toEqual(['a1,a2', 'b1'])
  })

  it("keeps each item's place in the whole list", () => {
    const entries = sectionedRows(['a1', 'b1', 'b2'], first, 2, key)
    const indexes = entries.flatMap((entry) =>
      entry.kind === 'row' ? entry.items.map((c) => c.index) : [],
    )
    expect(indexes).toEqual([0, 1, 2])
  })

  it('gives every entry its own key', () => {
    const entries = sectionedRows(['a1', 'b1', 'a2'], first, 3, key)
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length)
  })
})
