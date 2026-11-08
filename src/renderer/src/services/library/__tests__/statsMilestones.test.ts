import { describe, expect, it } from 'vitest'
import {
  grooveAtRadius,
  grooveInfo,
  grooveRadius,
  milestoneRings,
  pressedRecords,
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
  const at = (records: number | undefined, plays = 3000) => ({
    plays,
    hours: 0,
    streak: 0,
    records,
  })

  it('is announced when another record is full', () => {
    expect(nextMoment(at(1), at(2))).toMatchObject({ kind: 'pressing', value: 2 })
  })

  it('is announced for the very first one', () => {
    expect(nextMoment(at(0), at(1))?.kind).toBe('pressing')
  })

  it('goes ahead of the round number it always falls on', () => {
    expect(nextMoment(at(2, 3000), at(3, 10000))?.kind).toBe('pressing')
  })

  it('is not announced again', () => {
    expect(nextMoment(at(2), at(2))).toBeNull()
  })

  it('needs something to compare against', () => {
    expect(nextMoment(at(undefined), at(2))).toBeNull()
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

  it.each([
    [1999, 50, 0],
    [2000, 100, 1],
    [3999, 100, 1],
    [4000, 250, 2],
    [10000, 500, 3],
    [20000, 1000, 4],
    [39999, 1000, 4],
  ])('at %i plays a groove is %i, with %i on the shelf', (plays, step, finished) => {
    expect(recordProgress(plays)).toMatchObject({ step, finished })
  })

  it('uses a record to the very last groove', () => {
    expect(recordProgress(1999).done).toBe(RECORD_GROOVES - 1)
  })

  it('carries on through the scale when the step changes', () => {
    // 2,000 plays at 100 a groove: half way in, not back at the start.
    expect(recordProgress(2000)).toMatchObject({ base: 0, done: 20 })
  })

  it('stays at a thousand a groove and starts empty records from there', () => {
    expect(recordProgress(40000)).toMatchObject({ step: 1000, base: 40000, done: 0, finished: 5 })
    expect(recordProgress(80000)).toMatchObject({ step: 1000, base: 80000, done: 0, finished: 6 })
    expect(recordProgress(41500)).toMatchObject({ done: 1, next: 42000, remaining: 500 })
  })

  it('never runs off the record, however much was played', () => {
    const huge = recordProgress(50_000_000)
    expect(huge.done).toBeLessThan(RECORD_GROOVES)
    expect(huge.remaining).toBeGreaterThan(0)
  })
})

describe('pressedRecords', () => {
  it('has one entry for each full record, at the plays it filled up', () => {
    expect(pressedRecords(13478, []).map((record) => record.plays)).toEqual([2000, 4000, 10000])
    expect(pressedRecords(1999, [])).toEqual([])
    expect(
      pressedRecords(85000, [])
        .map((record) => record.plays)
        .slice(-2),
    ).toEqual([40000, 80000])
  })

  it('dates a record by counting back through the log', () => {
    // Plays 11 to 14 are logged at 100, 200, 300 and 400; number 12 filled it.
    const records = pressedRecords(2002, [100, 200, 300, 400])
    expect(records[0]?.earnedAt).toBe(200)
  })

  it('has no date for what happened before the log begins', () => {
    expect(pressedRecords(2500, [100, 200])[0]?.earnedAt).toBeNull()
  })

  it('says how long a record took only when both ends are known', () => {
    const log = Array.from({ length: 3000 }, (_, index) => index)
    expect(pressedRecords(4500, log).map((record) => record.tookSeconds)).toEqual([null, 2000])
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
  const at500 = recordProgress(13000)

  it('puts a milestone on the groove it happened in', () => {
    // 1,000 plays at 500 a groove ends the second groove.
    expect(milestoneRings(1000, at500)).toEqual([{ groove: 2, value: 1000, size: 's' }])
  })

  it('shows only what has been celebrated', () => {
    expect(milestoneRings(999, at500)).toEqual([])
    expect(milestoneRings(2000, at500)).toHaveLength(2)
  })

  it('marks only the rounder ones once a groove holds a thousand', () => {
    const rings = milestoneRings(10000, recordProgress(30000))
    expect(rings.map((ring) => ring.value)).toEqual([5000, 10000])
  })

  it('counts from where a record starts', () => {
    const rings = milestoneRings(45000, recordProgress(46000))
    expect(rings).toEqual([{ groove: 5, value: 45000, size: 'm' }])
  })

  it('stops at the end of the record', () => {
    const rings = milestoneRings(100000, recordProgress(100))
    expect(Math.max(...rings.map((ring) => ring.groove))).toBeLessThanOrEqual(RECORD_GROOVES)
  })
})
