import { describe, expect, it } from 'vitest'
import { nextMoment, reachedMilestones, recordProgress } from '../statsMilestones'

const zero = { plays: 0, hours: 0, streak: 0 }

describe('reachedMilestones', () => {
  it('rounds down to the last step of each kind', () => {
    expect(reachedMilestones({ plays: 2999, hours: 199, streak: 13 })).toEqual({
      plays: 2000,
      hours: 100,
      streak: 7,
    })
  })

  it('goes on in hundreds once a streak is past 100', () => {
    expect(reachedMilestones({ ...zero, streak: 257 }).streak).toBe(200)
  })

  it('has reached nothing below the first step', () => {
    expect(reachedMilestones({ plays: 999, hours: 99, streak: 6 })).toEqual(zero)
  })
})

describe('nextMoment', () => {
  it('stays silent on the first visit', () => {
    expect(nextMoment(null, { plays: 50000, hours: 900, streak: 100 })).toBeNull()
  })

  it('does not repeat what has been seen', () => {
    expect(nextMoment({ plays: 3000, hours: 0, streak: 0 }, { ...zero, plays: 3500 })).toBeNull()
  })

  it('fires exactly at the step', () => {
    expect(nextMoment(zero, { ...zero, plays: 1000 })?.value).toBe(1000)
    expect(nextMoment(zero, { ...zero, plays: 999 })).toBeNull()
  })

  it('makes one moment of several, the biggest', () => {
    const moment = nextMoment(zero, { plays: 10000, hours: 100, streak: 7 })
    expect(moment).toMatchObject({ kind: 'plays', value: 10000, size: 'l' })
  })

  it('prefers hours when two are the same size', () => {
    expect(nextMoment(zero, { plays: 1000, hours: 100, streak: 0 })?.kind).toBe('hours')
  })

  it('sizes by how round the number is', () => {
    const size = (plays: number): string | undefined => nextMoment(zero, { ...zero, plays })?.size
    expect(size(3000)).toBe('s')
    expect(size(5000)).toBe('m')
    expect(size(20000)).toBe('l')
  })

  it('sizes streaks by length', () => {
    const size = (streak: number): string | undefined => nextMoment(zero, { ...zero, streak })?.size
    expect(size(14)).toBe('s')
    expect(size(30)).toBe('m')
    expect(size(100)).toBe('l')
  })
})

describe('recordProgress', () => {
  it('starts a new listener on the smallest step', () => {
    expect(recordProgress(0)).toMatchObject({ step: 50, done: 0, progress: 0, next: 50 })
  })

  it('reports what is left to the next groove', () => {
    expect(recordProgress(120)).toMatchObject({ step: 50, done: 2, next: 150, remaining: 30 })
    expect(recordProgress(120).progress).toBeCloseTo(0.4)
  })

  it('moves to a bigger step before the grooves run out', () => {
    expect(recordProgress(2499).step).toBe(50)
    expect(recordProgress(2500).step).toBe(100)
  })

  it('never runs off the record, however much was played', () => {
    const huge = recordProgress(50_000_000)
    expect(huge.done).toBeLessThan(60)
    expect(huge.remaining).toBeGreaterThan(0)
  })
})
