import { describe, expect, it } from 'vitest'
import { makeSong } from '@/stores/__tests__/fixtures'
import { lineOfTheDay, statsLines, type StatsLine } from '../statsLines'

const TODAY = new Date(2026, 10, 8, 12)
const seconds = (date: Date): number => Math.floor(date.getTime() / 1000)
const daysAgo = (days: number, hour = 12): number => seconds(new Date(2026, 10, 8 - days, hour))

function lines(
  songs: ReturnType<typeof makeSong>[],
  timestamps: number[] = [],
): Map<string, StatsLine['params']> {
  const built = statsLines({ songs, timestamps, today: TODAY, locale: 'en-US' })
  return new Map(built.map((line) => [line.key, line.params]))
}

const repeated = (count: number, stamp: number): number[] => Array(count).fill(stamp)

describe('what the library can say', () => {
  it('names the artist played most across their songs', () => {
    const said = lines([
      makeSong('1', { artist: 'A', playCount: 8 }),
      makeSong('2', { artist: 'A', playCount: 8 }),
      makeSong('3', { artist: 'B', playCount: 12 }),
    ])
    expect(said.get('topArtist')).toEqual({ artist: 'A', n: '16' })
  })

  it('puts a share of the plays as one in so many', () => {
    const said = lines([
      makeSong('1', { artist: 'A', playCount: 75 }),
      makeSong('2', { artist: 'B', playCount: 75 }),
      makeSong('3', { artist: 'C', playCount: 150 }),
    ])
    expect(said.get('artistShare')).toEqual({ artist: 'C', n: '2' })
  })

  it('counts what has not been played yet', () => {
    const said = lines([
      makeSong('1', { playCount: 0, albumId: 'x' }),
      makeSong('2', { playCount: 0, albumId: 'y' }),
      makeSong('3', { playCount: 0, albumId: 'y' }),
      makeSong('4', { playCount: 1, albumId: 'z' }),
    ])
    expect(said.get('unplayed')).toEqual({ n: '3' })
    expect(said.get('unplayedAlbums')).toEqual({ n: '2' })
  })

  it('measures a genre by time, not by plays', () => {
    const said = lines([
      makeSong('1', { genre: 'Long', playCount: 1, duration: 3000 }),
      makeSong('2', { genre: 'Short', playCount: 10, duration: 100 }),
    ])
    expect(said.get('topGenre')).toEqual({ genre: 'Long', n: '75' })
  })

  it('ignores a year nobody recorded in', () => {
    const said = lines([
      makeSong('1', { year: 1885, playCount: 1 }),
      makeSong('2', { year: 1972, playCount: 1 }),
    ])
    expect(said.get('oldest')).toEqual({ year: '1972' })
  })

  it('leaves out what is too small to mention', () => {
    const said = lines([makeSong('1', { artist: 'A', playCount: 2, duration: 100 })])
    expect(said.has('topArtist')).toBe(false)
    expect(said.has('topSong')).toBe(false)
    expect(said.has('longestSong')).toBe(false)
  })
})

describe('what the log can say', () => {
  it('counts today and the last seven days apart', () => {
    const said = lines(
      [],
      [...repeated(4, daysAgo(10)), ...repeated(6, daysAgo(3)), ...repeated(5, daysAgo(0))],
    )
    expect(said.get('today')).toEqual({ n: '5' })
    expect(said.get('lastWeek')).toEqual({ n: '11' })
  })

  it('finds the biggest day', () => {
    const said = lines([], [...repeated(12, daysAgo(40)), ...repeated(11, daysAgo(2))])
    expect(said.get('bestDay')).toEqual({ n: '12', date: 'September 29' })
  })

  it('finds the favourite weekday', () => {
    // 8 November 2026 is a Sunday.
    const said = lines([], [...repeated(40, daysAgo(0)), ...repeated(20, daysAgo(1))])
    expect(said.get('weekday')).toEqual({ weekday: 'Sunday' })
  })

  it('tells late from early', () => {
    const said = lines([], [...repeated(30, daysAgo(1, 23)), ...repeated(70, daysAgo(1, 14))])
    expect(said.get('late')).toEqual({ n: '30' })
    expect(said.has('early')).toBe(false)
  })

  it('reports growth but keeps quiet about a decline', () => {
    const grown = lines([], [...repeated(30, daysAgo(40)), ...repeated(45, daysAgo(5))])
    expect(grown.get('trend')).toEqual({ n: '50' })
    const fallen = lines([], [...repeated(45, daysAgo(40)), ...repeated(30, daysAgo(5))])
    expect(fallen.has('trend')).toBe(false)
  })

  it('counts the longest silence between days with music', () => {
    const log = [daysAgo(80), daysAgo(70), daysAgo(66), daysAgo(65)]
    expect(lines([], log).get('longestGap')).toEqual({ n: '9' })
  })

  it('does not boast about a long silence', () => {
    const log = [daysAgo(80), daysAgo(20)]
    expect(lines([], log).has('longestGap')).toBe(false)
  })

  it('says nothing without a log', () => {
    expect(lines([]).size).toBe(0)
  })
})

describe('lineOfTheDay', () => {
  const all = ['a', 'b', 'c'].map((key) => ({ key, params: {} }))

  it('stays the same all day', () => {
    const morning = lineOfTheDay(all, new Date(2026, 10, 8, 1))
    const night = lineOfTheDay(all, new Date(2026, 10, 8, 23))
    expect(morning).toBe(night)
  })

  it('goes through every line before one comes back', () => {
    const shown = [8, 9, 10].map((day) => lineOfTheDay(all, new Date(2026, 10, day))?.key)
    expect(new Set(shown).size).toBe(3)
  })

  it('is nothing when there is nothing to say', () => {
    expect(lineOfTheDay([], TODAY)).toBeNull()
  })
})
