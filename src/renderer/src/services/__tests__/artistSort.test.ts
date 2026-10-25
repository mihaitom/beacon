import { describe, expect, it } from 'vitest'
import { ALPHABET_SECTIONS } from '../alphabetIndex'
import {
  artistSectionFor,
  artistSectionsFor,
  defaultArtistDirection,
  sortArtists,
  type ArtistSortKey,
} from '../artistSort'
import { RATING_SECTIONS, UNRATED_SECTION, ratingSectionLabel } from '../ratingSort'
import type { Artist } from '@/types/library'

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
