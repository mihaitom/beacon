import { describe, expect, it } from 'vitest'
import { ALPHABET_SECTIONS } from '../alphabetIndex'
import {
  artistFilterFields,
  artistSectionFor,
  artistSectionsFor,
  defaultArtistDirection,
  sortArtists,
  type ArtistSortKey,
} from '../artistSort'
import { RATING_SECTIONS, UNRATED_SECTION, ratingSectionLabel } from '../ratingSort'
import type { Artist } from '@/types/library'
import type { ArtistStats } from '@/services/library/artistStats'
import { filterItems } from '@/services/library/libraryFilter'

function artist(id: string, fields: Partial<Artist> = {}): Artist {
  return {
    id,
    name: id,
    albumCount: 0,
    coverArtId: null,
    imageUrl: null,
    starred: false,
    rating: 0,
    albums: [],
    ...fields,
  }
}

const ids = (artists: Artist[]) => artists.map((a) => a.id)

const by = (key: ArtistSortKey) => ({ key, direction: defaultArtistDirection(key) })

describe('sortArtists', () => {
  it("keeps the server's own alphabetical order for name", () => {
    const list = [artist('b'), artist('a')]

    expect(sortArtists(list, by('name'))).toBe(list)
  })

  it('puts the most stars first, unrated last, and keeps the name order within a rating', () => {
    const list = [
      artist('a-unrated'),
      artist('b-two', { rating: 2 }),
      artist('c-five', { rating: 5 }),
      artist('d-two', { rating: 2 }),
    ]

    expect(ids(sortArtists(list, by('rating')))).toEqual(['c-five', 'b-two', 'd-two', 'a-unrated'])
    expect(ids(list)).toEqual(['a-unrated', 'b-two', 'c-five', 'd-two'])
  })
})

describe('artistSectionFor', () => {
  it('files a name under its sort name and a rating under its star count', () => {
    const beatles = artist('x', { name: 'The Beatles', sortName: 'Beatles', rating: 5 })

    expect(artistSectionFor(beatles, by('name'))).toBe('B')
    expect(artistSectionFor(beatles, by('rating'))).toBe('5')
    expect(artistSectionFor(artist('y'), by('rating'))).toBe(UNRATED_SECTION)
  })

  it('lists the alphabet for name and the star counts for rating', () => {
    expect(artistSectionsFor([], by('name'))).toEqual(ALPHABET_SECTIONS)
    expect(artistSectionsFor([], by('rating'))).toEqual(RATING_SECTIONS)
  })
})

describe('ratingSectionLabel', () => {
  it('draws a rating as stars and names the unrated section in words', () => {
    const t = (key: string) => `t:${key}`

    expect(ratingSectionLabel('3', t)).toBe('★★★☆☆')
    expect(ratingSectionLabel(UNRATED_SECTION, t)).toBe('t:library.unrated')
  })
})

function stats(fields: Partial<ArtistStats>): ArtistStats {
  return {
    songCount: 1,
    genre: null,
    firstYear: null,
    lastYear: null,
    duration: 0,
    playCount: 0,
    lastPlayed: null,
    added: null,
    ...fields,
  }
}

describe('the orders counted out of the catalogue', () => {
  const table: Record<string, ArtistStats> = {
    quiet: stats({ playCount: 2, firstYear: 1975, genre: 'Jazz', duration: 1800 }),
    loud: stats({ playCount: 640, firstYear: 2004, genre: 'Rock', duration: 40000 }),
    middle: stats({ playCount: 75, firstYear: 1991, genre: 'Ambient', duration: 9000 }),
  }
  const statsOf = (a: { name: string }) => table[a.name] ?? null
  const list = [artist('quiet'), artist('unknown'), artist('loud'), artist('middle')]

  it('puts the most played first and an artist with no songs last', () => {
    expect(ids(sortArtists(list, by('playCount'), statsOf))).toEqual([
      'loud',
      'middle',
      'quiet',
      'unknown',
    ])
  })

  it('keeps an artist with no songs last the other way round too', () => {
    const sort = { key: 'years' as const, direction: 'asc' as const }
    expect(ids(sortArtists(list, sort, statsOf))).toEqual(['quiet', 'middle', 'loud', 'unknown'])
  })

  it('sorts genres by name', () => {
    expect(ids(sortArtists(list, by('genre'), statsOf))).toEqual([
      'middle',
      'quiet',
      'loud',
      'unknown',
    ])
  })

  it('files them under the filter menu ranges, in the order the list runs', () => {
    const sorted = sortArtists(list, by('playCount'), statsOf)
    expect(artistSectionsFor(sorted, by('playCount'), statsOf)).toEqual([
      '500-999',
      '50-99',
      '1-9',
      '?',
    ])
    expect(artistSectionFor(artist('loud'), by('duration'), statsOf)).toBe('10-20')
    expect(artistSectionFor(artist('quiet'), by('years'), statsOf)).toBe('1970')
  })

  it('filters by them', () => {
    const fields = artistFilterFields(statsOf)
    expect(ids(filterItems(list, fields, { genre: ['Rock', 'Jazz'] }))).toEqual(['quiet', 'loud'])
    expect(ids(filterItems(list, fields, { year: ['1990'] }))).toEqual(['middle'])
  })

  it('tells a never-played artist from one with no songs', () => {
    const sort = by('lastPlayed')
    expect(artistSectionFor(artist('quiet'), sort, statsOf)).toBe('never')
    expect(artistSectionFor(artist('unknown'), sort, statsOf)).toBe('?')
  })
})
