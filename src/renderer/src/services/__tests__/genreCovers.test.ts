import { describe, expect, it } from 'vitest'
import { coversByGenre } from '../genreCovers'
import type { Album } from '@/types/library'

function album(id: string, fields: Partial<Album> = {}): Album {
  return {
    id,
    name: id,
    artist: 'A',
    artistId: 'a',
    coverArtId: `cover-${id}`,
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

describe('coversByGenre', () => {
  it('files a cover under every genre its album has, in lower case', () => {
    const covers = coversByGenre([album('x', { genres: ['Pop', 'Dance'] })], 4)

    expect(covers.get('pop')).toEqual(['cover-x'])
    expect(covers.get('dance')).toEqual(['cover-x'])
  })

  it('falls back to the single genre where the server sends no list', () => {
    expect(coversByGenre([album('x', { genre: 'Rock' })], 4).get('rock')).toEqual(['cover-x'])
  })

  it('leaves out albums without a cover and counts a shared cover once', () => {
    const covers = coversByGenre(
      [
        album('a', { genre: 'Rock', coverArtId: null }),
        album('b', { genre: 'Rock', coverArtId: 'same' }),
        album('c', { genre: 'Rock', coverArtId: 'same' }),
      ],
      4,
    )

    expect(covers.get('rock')).toEqual(['same'])
  })

  it('caps the covers and picks the same ones every time', () => {
    const albums = Array.from({ length: 20 }, (_, i) => album(`al${i}`, { genre: 'Pop' }))

    const first = coversByGenre(albums, 4).get('pop')
    const again = coversByGenre([...albums].reverse(), 4).get('pop')

    expect(first).toHaveLength(4)
    // Not just the first albums of the alphabet, and not tied to the
    // order the library happens to be in.
    expect(again).toEqual(first)
  })
})
