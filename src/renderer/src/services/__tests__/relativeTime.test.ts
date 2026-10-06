import { describe, expect, it } from 'vitest'
import { timeAgo } from '../relativeTime'

describe('timeAgo', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')

  it('says it in the largest whole unit', () => {
    expect(timeAgo(Date.parse('2026-10-03T11:00:00Z'), now, 'en')).toBe('3 days ago')
    expect(timeAgo(Date.parse('2026-10-06T09:00:00Z'), now, 'en')).toBe('3 hours ago')
    expect(timeAgo(Date.parse('2026-09-01T12:00:00Z'), now, 'en')).toBe('last month')
  })

  it('reads a moment ago, or a clock slightly ahead, as now', () => {
    expect(timeAgo(Date.parse('2026-10-06T11:59:40Z'), now, 'en')).toBe('this minute')
    expect(timeAgo(Date.parse('2026-10-06T12:05:00Z'), now, 'en')).toBe('this minute')
  })

  it('follows the language', () => {
    expect(timeAgo(Date.parse('2026-10-05T12:00:00Z'), now, 'de')).toBe('gestern')
  })

  it('is empty for a date it cannot read', () => {
    expect(timeAgo(NaN, now, 'en')).toBe('')
  })
})
