import { describe, expect, it } from 'vitest'
import { ALPHABET_SECTIONS } from '../alphabetIndex'
import {
  UNKNOWN_YEAR_SECTION,
  defaultAlbumDirection,
  sectionFor,
  sectionsFor,
  sortAlbums,
  type AlbumSortKey,
} from '../albumSort'
import { RATING_SECTIONS, UNRATED_SECTION } from '../ratingSort'
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

/** An order the way picking it in the menu starts it. */
const by = (key: AlbumSortKey) => ({ key, direction: defaultAlbumDirection(key) })

describe('sortAlbums', () => {
  it("keeps the server's own alphabetical order for name", () => {
    // The server orders by sort name and knows where accents and numbers
    // go; re-sorting here could only disagree with it.
    const list = [album('b'), album('a'), album('c')]

    expect(sortAlbums(list, by('name'))).toBe(list)
  })

  it('puts the newest year first and albums without a year last', () => {
    const list = [
      album('old', { year: 1975 }),
      album('none'),
      album('new', { year: 2021 }),
      album('mid', { year: 1999 }),
    ]

    expect(ids(sortAlbums(list, by('year')))).toEqual(['new', 'mid', 'old', 'none'])
  })

  it('orders albums of the same year by name', () => {
    const list = [album('Zeta', { year: 2000 }), album('Alpha', { year: 2000 })]

    expect(ids(sortAlbums(list, by('year')))).toEqual(['Alpha', 'Zeta'])
  })

  it("lists an artist's albums in the order they came out", () => {
    const list = [
      album('later', { artist: 'Bowie', year: 1977 }),
      album('abba', { artist: 'ABBA', year: 1976 }),
      album('earlier', { artist: 'bowie', year: 1971 }),
    ]

    // Artist names compare without regard to case.
    expect(ids(sortAlbums(list, by('artist')))).toEqual(['abba', 'earlier', 'later'])
  })

  it('puts the latest addition first and undated albums last', () => {
    const list = [
      album('first', { created: '2024-01-01T00:00:00Z' }),
      album('undated'),
      album('latest', { created: '2026-10-01T12:00:00Z' }),
    ]

    expect(ids(sortAlbums(list, by('added')))).toEqual(['latest', 'first', 'undated'])
  })

  it('puts the most stars first, unrated last, and keeps the name order within a rating', () => {
    const list = [
      album('a-unrated'),
      album('b-three', { rating: 3 }),
      album('c-five', { rating: 5 }),
      album('d-three', { rating: 3 }),
    ]

    expect(ids(sortAlbums(list, by('rating')))).toEqual([
      'c-five',
      'b-three',
      'd-three',
      'a-unrated',
    ])
  })

  it('keeps albums without a year last when the order is turned round', () => {
    const list = [album('none'), album('new', { year: 2021 }), album('old', { year: 1975 })]

    expect(ids(sortAlbums(list, { key: 'year', direction: 'asc' }))).toEqual(['old', 'new', 'none'])
  })

  it('turns the artists round but keeps each discography in release order', () => {
    const list = [
      album('a-late', { artist: 'A', year: 2000 }),
      album('b', { artist: 'B', year: 1990 }),
      album('a-early', { artist: 'A', year: 1980 }),
    ]

    expect(ids(sortAlbums(list, { key: 'artist', direction: 'desc' }))).toEqual([
      'b',
      'a-early',
      'a-late',
    ])
  })

  it('leaves the list it was given untouched', () => {
    const list = [album('b', { year: 1 }), album('a', { year: 2 })]

    sortAlbums(list, by('year'))

    expect(ids(list)).toEqual(['b', 'a'])
  })
})

describe('sectionFor', () => {
  it('files a name under its sort name, an artist order under the artist', () => {
    const wall = album('w', { name: 'The Wall', sortName: 'Wall', artist: 'Pink Floyd' })

    expect(sectionFor(wall, by('name'))).toBe('W')
    expect(sectionFor(wall, by('artist'))).toBe('P')
  })

  it('files a year under its decade', () => {
    expect(sectionFor(album('a', { year: 1987 }), by('year'))).toBe('1980')
    expect(sectionFor(album('a', { year: 2020 }), by('year'))).toBe('2020')
    expect(sectionFor(album('a'), by('year'))).toBe(UNKNOWN_YEAR_SECTION)
  })

  it('files a rating under its star count, an unrated album last', () => {
    expect(sectionFor(album('a', { rating: 4 }), by('rating'))).toBe('4')
    expect(sectionFor(album('a'), by('rating'))).toBe(UNRATED_SECTION)
  })
})

describe('range sections', () => {
  it('files an album by its number of songs and lists the ranges as the list meets them', () => {
    const sorted = [album('long', { songCount: 22 }), album('lp', { songCount: 9 })]

    expect(sectionFor(sorted[0]!, by('songCount'))).toBe('21+')
    expect(sectionsFor(sorted, by('songCount'))).toEqual(['21+', '8-10'])
  })
})

describe('sectionsFor', () => {
  it('lists every decade between the newest and the oldest, newest first', () => {
    // 1990 has no albums but stays on the bar, greyed out by the caller,
    // so the decades keep their places.
    const list = [album('a', { year: 2003 }), album('b', { year: 1981 })]

    expect(sectionsFor(list, by('year'))).toEqual(['2000', '1990', '1980'])
  })

  it('ends with the no-year section only when some album has no year', () => {
    expect(sectionsFor([album('a', { year: 2003 }), album('b')], by('year'))).toEqual([
      '2000',
      UNKNOWN_YEAR_SECTION,
    ])
    expect(sectionsFor([album('b')], by('year'))).toEqual([UNKNOWN_YEAR_SECTION])
  })

  it('keeps the whole alphabet for the name orders', () => {
    expect(sectionsFor([album('a')], by('name'))).toEqual(ALPHABET_SECTIONS)
    expect(sectionsFor([album('a')], by('artist'))).toEqual(ALPHABET_SECTIONS)
    expect(sectionsFor([album('a')], by('rating'))).toEqual(RATING_SECTIONS)
  })
})
