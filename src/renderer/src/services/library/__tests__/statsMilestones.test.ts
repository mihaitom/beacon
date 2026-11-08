import { describe, expect, it } from 'vitest'
import {
  grooveAtRadius,
  grooveInfo,
  grooveRadius,
  milestoneRings,
  nextMoment,
  reachedMilestones,
  RECORD_GROOVES,
  recordProgress,
} from '../statsMilestones'

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

describe('a new pressing', () => {
  const at = (step: number | undefined) => ({ plays: 3000, hours: 0, streak: 0, step })

  it('is announced when a groove stands for more plays', () => {
    const moment = nextMoment(at(500), { ...at(1000), plays: 17000 })
    expect(moment).toMatchObject({ kind: 'pressing', value: 1000 })
  })

  it('goes ahead of the round number it always falls on', () => {
    expect(nextMoment(at(500), { plays: 20000, hours: 0, streak: 0, step: 1000 })?.kind).toBe(
      'pressing',
    )
  })

  it('is not announced again', () => {
    expect(nextMoment(at(1000), at(1000))).toBeNull()
  })

  it('needs something to compare against', () => {
    expect(nextMoment(at(undefined), at(1000))).toBeNull()
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
    expect(recordProgress(1699).step).toBe(50)
    expect(recordProgress(1700).step).toBe(100)
  })

  it('never runs off the record, however much was played', () => {
    const huge = recordProgress(50_000_000)
    expect(huge.done).toBeLessThan(RECORD_GROOVES)
    expect(huge.remaining).toBeGreaterThan(0)
  })
})

describe('grooveAtRadius', () => {
  it('finds each groove from its own radius', () => {
    for (const n of [1, 17, RECORD_GROOVES]) expect(grooveAtRadius(grooveRadius(n))).toBe(n)
  })

  it('takes the nearest when the pointer is between two', () => {
    expect(grooveAtRadius(grooveRadius(5) - 0.5)).toBe(5)
    expect(grooveAtRadius(grooveRadius(6) + 0.5)).toBe(6)
  })

  it('knows no groove on the label or off the record', () => {
    expect(grooveAtRadius(40)).toBeNull()
    expect(grooveAtRadius(300)).toBeNull()
  })
})

describe('grooveInfo', () => {
  // 13,459 plays: 26 grooves of 500 done, the 27th is the current one.
  const record = recordProgress(13459)

  it('gives a groove its range of plays', () => {
    expect(grooveInfo(record, 27)).toMatchObject({ from: 13000, to: 13500 })
    expect(grooveInfo(record, 1).from).toBe(0)
  })

  it('tells played, current and ahead apart', () => {
    expect(grooveInfo(record, 26).state).toBe('played')
    expect(grooveInfo(record, 27).state).toBe('current')
    expect(grooveInfo(record, 28).state).toBe('ahead')
  })

  it('says how far off a groove ahead is', () => {
    expect(grooveInfo(record, 30).left).toBe(14500 - 13459)
  })
})

describe('milestoneRings', () => {
  it('puts a milestone on the groove it happened in', () => {
    // 1,000 plays at 500 a groove ends the second groove.
    expect(milestoneRings(1000, 500)).toEqual([{ groove: 2, value: 1000, size: 's' }])
  })

  it('shows only what has been celebrated', () => {
    expect(milestoneRings(999, 500)).toEqual([])
    expect(milestoneRings(2000, 500)).toHaveLength(2)
  })

  it('keeps the biggest when several share a groove', () => {
    // 5,000 a groove: 1,000 to 5,000 all land on the first.
    expect(milestoneRings(5000, 5000)).toEqual([{ groove: 1, value: 5000, size: 'm' }])
  })

  it('stops at the end of the record', () => {
    const rings = milestoneRings(100000, 50)
    expect(Math.max(...rings.map((ring) => ring.groove))).toBeLessThanOrEqual(RECORD_GROOVES)
  })
})
