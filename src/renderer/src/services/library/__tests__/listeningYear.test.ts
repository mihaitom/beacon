import { describe, expect, it } from 'vitest'
import { buildYear, playsByHour, streaks } from '../listeningYear'

const at = (y: number, m: number, d: number, h = 12): number =>
  new Date(y, m - 1, d, h).getTime() / 1000

describe('streaks', () => {
  const today = new Date(2026, 10, 8, 15)

  it('counts consecutive days ending today', () => {
    const plays = [at(2026, 11, 6), at(2026, 11, 7), at(2026, 11, 8)]
    expect(streaks(plays, today).current).toBe(3)
  })

  it('keeps a streak alive before today has been played', () => {
    expect(streaks([at(2026, 11, 6), at(2026, 11, 7)], today).current).toBe(2)
  })

  it('ends a streak after a whole day without music', () => {
    expect(streaks([at(2026, 11, 5), at(2026, 11, 6)], today).current).toBe(0)
  })

  it('counts a day once however often it was played', () => {
    expect(streaks([at(2026, 11, 8, 9), at(2026, 11, 8, 10)], today).current).toBe(1)
  })

  it('finds the longest run anywhere in the log', () => {
    const plays = [at(2026, 3, 1), at(2026, 3, 2), at(2026, 3, 3), at(2026, 11, 8)]
    expect(streaks(plays, today)).toEqual({ current: 1, longest: 3 })
  })

  // Runs in whatever zone the suite does; in a DST zone this day has 23 hours,
  // which breaks anything counting in milliseconds.
  it('carries across a daylight saving change', () => {
    const plays = [at(2026, 3, 28), at(2026, 3, 29), at(2026, 3, 30)]
    expect(streaks(plays, new Date(2026, 2, 30, 15)).current).toBe(3)
  })

  it('files a play by the local day, not the UTC one', () => {
    const lateEvening = at(2026, 11, 7, 23)
    const earlyMorning = at(2026, 11, 8, 0)
    expect(streaks([lateEvening, earlyMorning], today).current).toBe(2)
  })
})

describe('buildYear', () => {
  // A Sunday, the end of a Monday-based week.
  const sunday = new Date(2026, 10, 8, 12)

  it('ends on the current week with Monday first', () => {
    const year = buildYear([], sunday, 2)
    expect(year).toHaveLength(2)
    expect(year[1]?.days[0]?.date.getDate()).toBe(2)
    expect(year[1]?.days[6]?.date.getDate()).toBe(8)
  })

  it('leaves the days that have not happened yet empty', () => {
    const wednesday = new Date(2026, 10, 4, 12)
    const [week] = buildYear([], wednesday, 1)
    expect(week?.days[2]).not.toBeNull()
    expect(week?.days[3]).toBeNull()
  })

  it('counts plays on their day', () => {
    const [week] = buildYear([at(2026, 11, 3, 8), at(2026, 11, 3, 20)], sunday, 1)
    expect(week?.days[1]?.count).toBe(2)
    expect(week?.days[0]?.level).toBe(0)
  })

  it('does not let one huge day flatten all the others', () => {
    const plays: number[] = []
    for (let day = 1; day <= 30; day++) plays.push(...Array(10).fill(at(2026, 10, day)))
    plays.push(...Array(500).fill(at(2026, 10, 31)))
    const days = buildYear(plays, sunday, 8).flatMap((week) => week.days)
    const ordinary = days.find((day) => day?.count === 10)
    expect(ordinary?.level).toBe(4)
  })

  it('never puts a played day on the empty level', () => {
    const plays = [at(2026, 11, 2)]
    for (let day = 1; day <= 30; day++) plays.push(...Array(100).fill(at(2026, 10, day)))
    const days = buildYear(plays, sunday, 8).flatMap((week) => week.days)
    expect(days.find((day) => day?.count === 1)?.level).toBe(1)
  })

  it('labels only the week a month opens', () => {
    const year = buildYear([], sunday, 9)
    const months = year.map((week) => week.month).filter((month) => month !== null)
    expect(new Set(months).size).toBe(months.length)
  })
})

describe('playsByHour', () => {
  it('uses the local hour', () => {
    const hours = playsByHour([at(2026, 11, 8, 7), at(2026, 11, 7, 7), at(2026, 11, 8, 23)])
    expect(hours[7]).toBe(2)
    expect(hours[23]).toBe(1)
    expect(hours).toHaveLength(24)
  })
})
