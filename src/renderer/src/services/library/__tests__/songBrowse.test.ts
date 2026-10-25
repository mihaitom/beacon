import { describe, expect, it } from 'vitest'
import { makeSong } from '@/stores/__tests__/fixtures'
import {
  FILTER_FIELDS,
  filterOptions,
  filterSongs,
  sectionsFor,
  sortKeysFor,
  sortSongs,
} from '@/services/library/songBrowse'

const ids = (songs: { id: string }[]) => songs.map((song) => song.id)

describe('sortSongs', () => {
  it('puts a song the server has no date for last, whichever way round', () => {
    const songs = [
      makeSong('never', { lastPlayed: null }),
      makeSong('old', { lastPlayed: '2020-01-01T00:00:00Z' }),
      makeSong('new', { lastPlayed: '2026-01-01T00:00:00Z' }),
    ]

    expect(ids(sortSongs(songs, { key: 'lastPlayed', direction: 'desc' }))).toEqual([
      'new',
      'old',
      'never',
    ])
    expect(ids(sortSongs(songs, { key: 'lastPlayed', direction: 'asc' }))).toEqual([
      'old',
      'new',
      'never',
    ])
  })

  it("keeps an artist's songs together by album and track", () => {
    const songs = [
      makeSong('b2', { artist: 'A', album: 'B', trackNumber: 2 }),
      makeSong('z', { artist: 'Z', album: 'A' }),
      makeSong('a1', { artist: 'A', album: 'A', trackNumber: 1 }),
      makeSong('b1', { artist: 'A', album: 'B', trackNumber: 1 }),
    ]

    expect(ids(sortSongs(songs, { key: 'artist', direction: 'asc' }))).toEqual([
      'a1',
      'b1',
      'b2',
      'z',
    ])
  })

  it('turns only the picked order round, not what breaks its ties', () => {
    const songs = [
      makeSong('2020b', { year: 2020, artist: 'B' }),
      makeSong('2020a', { year: 2020, artist: 'A' }),
      makeSong('1990', { year: 1990 }),
    ]

    expect(ids(sortSongs(songs, { key: 'year', direction: 'desc' }))).toEqual([
      '2020a',
      '2020b',
      '1990',
    ])
  })
})

describe('sortKeysFor', () => {
  it('offers the artist and leaves out what the server does not send', () => {
    expect(sortKeysFor('subsonic')).toContain('artist')
    expect(sortKeysFor('subsonic')).toContain('bpm')
    expect(sortKeysFor('jellyfin')).not.toContain('bpm')
  })
})

describe('sectionsFor', () => {
  it('runs the bar the way the list runs', () => {
    const songs = [makeSong('a', { year: 1987 }), makeSong('b', { year: 2003 })]

    expect(sectionsFor(songs, { key: 'year', direction: 'desc' })).toEqual(['2000', '1980'])
    expect(sectionsFor(songs, { key: 'year', direction: 'asc' })).toEqual(['1980', '2000'])
    expect(sectionsFor(songs, { key: 'title', direction: 'desc' })[0]).not.toBe('#')
  })

  it('has none for an order nobody jumps through', () => {
    expect(sectionsFor([makeSong('a')], { key: 'size', direction: 'asc' })).toEqual([])
  })

  it("splits a range order into the filter menu's ranges, as the list meets them", () => {
    const sorted = [
      makeSong('a', { bpm: 128 }),
      makeSong('b', { bpm: 121 }),
      makeSong('c', { bpm: 95 }),
      makeSong('d', { bpm: null }),
    ]

    expect(sectionsFor(sorted, { key: 'bpm', direction: 'desc' })).toEqual([
      '120-129',
      '90-99',
      '?',
    ])
  })
})

describe('filterSongs', () => {
  it('lets a song through on any option of a field, but only on every field', () => {
    const songs = [
      makeSong('rock-5', { genre: 'Rock', rating: 5 }),
      makeSong('pop-4', { genre: 'Pop', rating: 4 }),
      makeSong('rock-2', { genre: 'Rock', rating: 2 }),
      makeSong('jazz-5', { genre: 'Jazz', rating: 5 }),
    ]

    const result = filterSongs(songs, { genre: ['Rock', 'Pop'], rating: ['5', '4'] })

    expect(ids(result)).toEqual(['rock-5', 'pop-4'])
  })

  it('treats a field with nothing picked as no filter', () => {
    const songs = [makeSong('a'), makeSong('b')]

    expect(filterSongs(songs, { genre: [] })).toBe(songs)
  })

  it('files a BPM on the edge of a range into the range it starts', () => {
    const songs = [
      makeSong('89', { bpm: 89 }),
      makeSong('90', { bpm: 90 }),
      makeSong('unmeasured', { bpm: 0 }),
    ]

    expect(ids(filterSongs(songs, { bpm: ['90-99'] }))).toEqual(['90'])
    expect(ids(filterSongs(songs, { bpm: ['?'] }))).toEqual(['unmeasured'])
  })

  it('dates by how long ago, against the time it is given', () => {
    const now = Date.parse('2026-10-25T12:00:00Z')
    const songs = [
      makeSong('yesterday', { added: '2026-10-24T12:00:00Z' }),
      makeSong('last-spring', { added: '2026-04-01T12:00:00Z' }),
    ]

    expect(ids(filterSongs(songs, { added: ['d7'] }, now))).toEqual(['yesterday'])
    expect(ids(filterSongs(songs, { added: ['m12'] }, now))).toEqual(['last-spring'])
  })
})

describe('filterOptions', () => {
  const field = (name: string) => FILTER_FIELDS.find((def) => def.field === name)!

  it('counts each option and lists the biggest genre first, the unknown last', () => {
    const songs = [
      makeSong('a', { genre: 'Pop' }),
      makeSong('b', { genre: 'Rock' }),
      makeSong('c', { genre: 'Rock' }),
      makeSong('d', { genre: null }),
    ]

    expect(filterOptions(songs, field('genre'))).toEqual([
      { option: 'Rock', count: 2 },
      { option: 'Pop', count: 1 },
      { option: '?', count: 1 },
    ])
  })

  it('keeps the whole star scale, even where no song has a rating', () => {
    const options = filterOptions([makeSong('a', { rating: 0 })], field('rating'))

    expect(options.map((entry) => entry.option)).toEqual(['5', '4', '3', '2', '1', '0'])
  })
})
