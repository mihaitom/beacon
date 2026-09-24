import { describe, expect, it } from 'vitest'
import { formatTotalDuration } from '../totalDuration'

const t = (key: string, values: Record<string, number>) =>
  key.endsWith('Hours') ? `${values.hours}h ${values.minutes}m` : `${values.minutes}m`

describe('formatTotalDuration', () => {
  it('reads minutes under an hour', () => {
    expect(formatTotalDuration(56 * 60 + 10, t)).toBe('56m')
  })

  it('splits into hours past an hour', () => {
    expect(formatTotalDuration(86 * 60, t)).toBe('1h 26m')
  })

  it('rounds up to the hour rather than reading "60 minutes"', () => {
    expect(formatTotalDuration(59 * 60 + 40, t)).toBe('1h 0m')
  })

  it('is empty with nothing to add up', () => {
    expect(formatTotalDuration(0, t)).toBe('')
  })
})
