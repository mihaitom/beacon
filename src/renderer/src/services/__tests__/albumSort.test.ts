import { describe, expect, it } from 'vitest'
import { ALPHABET_SECTIONS } from '../alphabetIndex'
import { UNKNOWN_YEAR_SECTION, sectionFor, sectionsFor, sortAlbums } from '../albumSort'
import type { Album } from '@/types/library'

function album(id: string, fields: Partial<Album> = {}): Album {
  return {
    id,
    name: id,
    artist: 'Artist',
    artistId: 'ar',
    coverArtId: null,
    songCount: 1,
    duration: 1,
    year: null,
    genre: null,
    starred: false,
    rating: 0,
    songs: [],
    ...fields,
  }
}

const ids = (albums: Album[]) => albums.map((a) => a.id)

describe('sortAlbums', () => {
  it("keeps the server's own alphabetical order for name", () => {
    // The server orders by sort name and knows where accents and numbers
    // go; re-sorting here could only disagree with it.
    const list = [album('b'), album('a'), album('c')]

    expect(sortAlbums(list, 'name')).toBe(list)
  })

  it('puts the newest year first and albums without a year last', () => {
    const list = [
      album('old', { year: 1975 }),
      album('none'),
      album('new', { year: 2021 }),
      album('mid', { year: 1999 }),
    ]

    expect(ids(sortAlbums(list, 'year'))).toEqual(['new', 'mid', 'old', 'none'])
  })

  it('orders albums of the same year by name', () => {
    const list = [album('Zeta', { year: 2000 }), album('Alpha', { year: 2000 })]

    expect(ids(sortAlbums(list, 'year'))).toEqual(['Alpha', 'Zeta'])
  })

  it("lists an artist's albums in the order they came out", () => {
    const list = [
      album('later', { artist: 'Bowie', year: 1977 }),
      album('abba', { artist: 'ABBA', year: 1976 }),
      album('earlier', { artist: 'bowie', year: 1971 }),
    ]

    // Artist names compare without regard to case.
    expect(ids(sortAlbums(list, 'artist'))).toEqual(['abba', 'earlier', 'later'])
  })

  it('puts the latest addition first and undated albums last', () => {
    const list = [
      album('first', { created: '2024-01-01T00:00:00Z' }),
      album('undated'),
      album('latest', { created: '2026-10-01T12:00:00Z' }),
    ]

    expect(ids(sortAlbums(list, 'added'))).toEqual(['latest', 'first', 'undated'])
  })

  it('leaves the list it was given untouched', () => {
    const list = [album('b', { year: 1 }), album('a', { year: 2 })]

    sortAlbums(list, 'year')

    expect(ids(list)).toEqual(['b', 'a'])
  })
})

describe('sectionFor', () => {
  it('files a name under its sort name, an artist order under the artist', () => {
    const wall = album('w', { name: 'The Wall', sortName: 'Wall', artist: 'Pink Floyd' })

    expect(sectionFor(wall, 'name')).toBe('W')
    expect(sectionFor(wall, 'artist')).toBe('P')
  })

  it('files a year under its decade', () => {
    expect(sectionFor(album('a', { year: 1987 }), 'year')).toBe('1980')
    expect(sectionFor(album('a', { year: 2020 }), 'year')).toBe('2020')
    expect(sectionFor(album('a'), 'year')).toBe(UNKNOWN_YEAR_SECTION)
  })

  it('has no sections for recently added', () => {
    expect(sectionFor(album('a', { created: '2026-01-01' }), 'added')).toBe('')
  })
})

describe('sectionsFor', () => {
  it('lists every decade between the newest and the oldest, newest first', () => {
    // 1990 has no albums but stays on the bar, greyed out by the caller,
    // so the decades keep their places.
    const list = [album('a', { year: 2003 }), album('b', { year: 1981 })]

    expect(sectionsFor(list, 'year')).toEqual(['2000', '1990', '1980'])
  })

  it('ends with the no-year section only when some album has no year', () => {
    expect(sectionsFor([album('a', { year: 2003 }), album('b')], 'year')).toEqual([
      '2000',
      UNKNOWN_YEAR_SECTION,
    ])
    expect(sectionsFor([album('b')], 'year')).toEqual([UNKNOWN_YEAR_SECTION])
  })

  it('keeps the whole alphabet for the name orders and nothing for recently added', () => {
    expect(sectionsFor([album('a')], 'name')).toEqual(ALPHABET_SECTIONS)
    expect(sectionsFor([album('a')], 'artist')).toEqual(ALPHABET_SECTIONS)
    expect(sectionsFor([album('a')], 'added')).toEqual([])
  })
})
