import { describe, expect, it } from 'vitest'
import { sortDetail, type BrowseContext, type DetailFormat } from '../libraryBrowse'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { ArtistStats } from '../artistStats'
import type { Album, Artist } from '@/types/library'

const format: DetailFormat = {
  t: (key) => `<${key}>`,
  plural: (key, count) => `<${key}:${count}>`,
  locale: 'en',
}

function context(stats: Partial<ArtistStats> | null = null): BrowseContext {
  return {
    serverType: 'subsonic',
    rated: true,
    favorites: true,
    statsOf: () =>
      stats ? ({ songCount: 0, duration: 0, playCount: 0, ...stats } as ArtistStats) : null,
  }
}

const album = (overrides: Partial<Album> = {}) =>
  ({
    id: 'al',
    name: 'Album',
    artist: 'Band',
    year: 1999,
    songCount: 9,
    duration: 2400,
    rating: 0,
    ...overrides,
  }) as Album

const artist = { id: 'ar', name: 'Band', albumCount: 3, rating: 0 } as Artist

describe('sortDetail', () => {
  it('says nothing for an order the row already shows', () => {
    const song = makeSong('s', { title: 'Song', artist: 'Band' })
    expect(sortDetail('songs', 'title', song, format, context())).toBeNull()
    expect(sortDetail('songs', 'artist', song, format, context())).toBeNull()
    expect(sortDetail('albums', 'name', album(), format, context())).toBeNull()
    expect(sortDetail('artists', 'albumCount', artist, format, context({}))).toBeNull()
  })

  it("names a song's value for the order, counted where it is a count", () => {
    const song = makeSong('s', { year: 1987, playCount: 4, bpm: 120, rating: 3 })
    expect(sortDetail('songs', 'year', song, format, context())).toBe('1987')
    expect(sortDetail('songs', 'playCount', song, format, context())).toBe('<home.playCount:4>')
    expect(sortDetail('songs', 'bpm', song, format, context())).toBe('120 BPM')
    expect(sortDetail('songs', 'rating', song, format, context())).toBe('★★★☆☆')
  })

  it('says nothing rather than a dash or "unrated" where there is no value', () => {
    const song = makeSong('s', { year: null, bpm: null, rating: 0 })
    expect(sortDetail('songs', 'year', song, format, context())).toBeNull()
    expect(sortDetail('songs', 'bpm', song, format, context())).toBeNull()
    expect(sortDetail('songs', 'rating', song, format, context())).toBeNull()
  })

  it("names an album's value for the order", () => {
    expect(sortDetail('albums', 'year', album(), format, context())).toBe('1999')
    expect(sortDetail('albums', 'songCount', album(), format, context())).toBe(
      '<favorites.countSongs:9>',
    )
    expect(sortDetail('albums', 'duration', album(), format, context())).toBe('40:00')
  })

  it("reads an artist's figures out of the song catalogue, once it is there", () => {
    expect(sortDetail('artists', 'years', artist, format, context())).toBeNull()
    const ctx = context({ firstYear: 1979, lastYear: 1994, duration: 5400, genre: 'Rock' })
    expect(sortDetail('artists', 'years', artist, format, ctx)).toBe('1979–1994')
    expect(sortDetail('artists', 'duration', artist, format, ctx)).toBe('1.5 h')
    expect(sortDetail('artists', 'genre', artist, format, ctx)).toBe('Rock')
  })
})
