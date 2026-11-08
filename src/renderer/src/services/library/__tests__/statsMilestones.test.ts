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

  it('climbs a ladder that spreads out', () => {
    expect(reachedMilestones({ ...zero, hours: 1234 }).hours).toBe(1000)
    expect(reachedMilestones({ ...zero, streak: 257 }).streak).toBe(200)
    expect(reachedMilestones({ ...zero, streak: 400 }).streak).toBe(365)
  })

  it('goes on evenly past the last rung', () => {
    expect(reachedMilestones({ ...zero, hours: 17000 }).hours).toBe(15000)
    expect(reachedMilestones({ ...zero, streak: 1700 }).streak).toBe(1500)
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

  it('awards streaks a metal by length', () => {
    const tier = (streak: number): string | undefined => nextMoment(zero, { ...zero, streak })?.tier
    expect([7, 30, 100, 300, 500].map(tier)).toEqual([
      'bronze',
      'silver',
      'gold',
      'platinum',
      'diamond',
    ])
  })

  it('awards hours a metal by amount', () => {
    const tier = (hours: number): string | undefined => nextMoment(zero, { ...zero, hours })?.tier
    expect([100, 500, 1000, 2500, 10000].map(tier)).toEqual([
      'bronze',
      'silver',
      'gold',
      'platinum',
      'diamond',
    ])
  })

  it('stays quiet between rungs after a seen figure from the old steps', () => {
    const seen = { ...zero, hours: 1200 }
    expect(nextMoment(seen, { ...zero, hours: 1400 })).toBeNull()
    expect(nextMoment(seen, { ...zero, hours: 1500 })?.value).toBe(1500)
  })

  it('lets a gold streak win over bronze hours', () => {
    expect(nextMoment(zero, { plays: 0, hours: 100, streak: 100 })?.kind).toBe('streak')
  })

  it('lets the bigger metal win over a round number of plays', () => {
    expect(nextMoment(zero, { plays: 5000, hours: 2500, streak: 0 })?.kind).toBe('hours')
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
    expect(nextMoment(at(1), at(2))).toMatchObject({
      kind: 'pressing',
      value: 2,
      tier: 'bronze',
    })
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
    expect(recordProgress(0)).toMatchObject({ step: 10, done: 0, progress: 0, next: 10 })
  })

  it('reports what is left to the next groove', () => {
    expect(recordProgress(124)).toMatchObject({ step: 10, done: 12, next: 130, remaining: 6 })
    expect(recordProgress(124).progress).toBeCloseTo(0.4)
  })

  it.each([
    [499, 10, 0],
    [500, 10, 1],
    [1999, 10, 3],
    [2000, 20, 4],
    [4999, 20, 6],
    [5000, 50, 7],
    [9999, 50, 8],
    [10000, 100, 9],
    [24999, 100, 11],
    [25000, 500, 12],
    [49999, 500, 12],
    [50000, 500, 13],
    [75000, 500, 14],
  ])('at %i plays a groove is %i, with %i on the shelf', (plays, step, finished) => {
    expect(recordProgress(plays)).toMatchObject({ step, finished })
  })

  it('uses a record to the very last groove', () => {
    expect(recordProgress(499).done).toBe(RECORD_GROOVES - 1)
  })

  it('starts every new record at the first groove', () => {
    expect(recordProgress(500)).toMatchObject({ base: 500, done: 0, next: 510 })
    expect(recordProgress(2000)).toMatchObject({ base: 2000, done: 0, next: 2020 })
  })

  it('keeps the diamond step from the first diamond on', () => {
    expect(recordProgress(50000)).toMatchObject({ step: 500, base: 50000, finished: 13 })
    expect(recordProgress(75000)).toMatchObject({ step: 500, base: 75000, finished: 14 })
    expect(recordProgress(50750)).toMatchObject({ done: 1, next: 51000, remaining: 250 })
  })

  it('knows what each record holds on its own', () => {
    const holds = pressedRecords(50000, []).map((record) => record.holds)
    expect(holds.slice(0, 4)).toEqual([500, 500, 500, 500])
    expect(holds.at(-1)).toBe(25000)
  })

  it('never runs off the record, however much was played', () => {
    const huge = recordProgress(50_000_000)
    expect(huge.done).toBeLessThan(RECORD_GROOVES)
    expect(huge.remaining).toBeGreaterThan(0)
  })
})

describe('pressedRecords', () => {
  const totals = (plays: number): number[] =>
    pressedRecords(plays, []).map((record) => record.plays)

  it('has one entry for each full record, at a round total', () => {
    const upTo10k = [500, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000]
    expect(totals(499)).toEqual([])
    expect(totals(13459)).toEqual(upTo10k)
    expect(totals(100000)).toEqual([...upTo10k, 15000, 20000, 25000, 50000, 75000, 100000])
    expect(totals(150000).slice(-2)).toEqual([125000, 150000])
  })

  it('climbs the tiers as the industry does', () => {
    const tiers = pressedRecords(50000, []).map((record) => record.tier)
    expect(tiers).toEqual([
      ...Array(4).fill('bronze'),
      ...Array(3).fill('silver'),
      ...Array(2).fill('gold'),
      ...Array(3).fill('platinum'),
      'diamond',
    ])
  })

  it('dates a record by counting back through the log', () => {
    // The last four plays are logged; the 500th is the second of them.
    const records = pressedRecords(502, [100, 200, 300, 400])
    expect(records[0]?.earnedAt).toBe(200)
  })

  it('has no date for what happened before the log begins', () => {
    expect(pressedRecords(600, [100, 200])[0]?.earnedAt).toBeNull()
  })

  it('says how long a record took only when both ends are known', () => {
    const log = Array.from({ length: 1200 }, (_, index) => index)
    expect(pressedRecords(1600, log).map((record) => record.tookSeconds)).toEqual([null, 500, 500])
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
  // 13,459 plays: on the first platinum, from 10,000 at 100 a groove, in the 35th.
  const record = recordProgress(13459)

  it('gives a groove its range of plays', () => {
    expect(grooveInfo(record, 35)).toMatchObject({ from: 13400, to: 13500 })
    expect(grooveInfo(record, 1).from).toBe(10000)
  })

  it('tells played, current and ahead apart', () => {
    expect(grooveInfo(record, 34).state).toBe('played')
    expect(grooveInfo(record, 35).state).toBe('current')
    expect(grooveInfo(record, 36).state).toBe('ahead')
  })

  it('says how far off a groove ahead is', () => {
    expect(grooveInfo(record, 38).left).toBe(13700 - 13459)
  })
})

describe('milestoneRings', () => {
  // The first platinum: from 10,000 at 100 a groove.
  const platinum = recordProgress(12000)

  it('puts a milestone on the groove it happened in', () => {
    expect(milestoneRings(11000, platinum)).toEqual([{ groove: 10, value: 11000, size: 's' }])
  })

  it('finds the round thousands of a record that does not start on one', () => {
    expect(milestoneRings(1000, recordProgress(600))).toEqual([
      { groove: 50, value: 1000, size: 's' },
    ])
  })

  it('shows only what has been celebrated', () => {
    expect(milestoneRings(10999, platinum)).toEqual([])
    expect(milestoneRings(12000, platinum)).toHaveLength(2)
  })

  it('counts from where a record starts', () => {
    expect(milestoneRings(51000, recordProgress(60000))).toEqual([
      { groove: 2, value: 51000, size: 's' },
    ])
  })

  it('stops at the end of the record', () => {
    const rings = milestoneRings(100000, platinum)
    expect(rings.at(-1)).toMatchObject({ groove: RECORD_GROOVES, value: 15000 })
  })
})
