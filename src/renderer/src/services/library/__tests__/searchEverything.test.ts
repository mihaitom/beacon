import { describe, expect, it } from 'vitest'
import { searchEverything, type SearchSources } from '../searchEverything'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Album, Artist, Playlist, RadioStation } from '@/types/library'

const LIMITS = { artists: 2, albums: 2, songs: 2, playlists: 2, stations: 2 }

function sources(overrides: Partial<SearchSources> = {}): SearchSources {
  return { artists: [], albums: [], songs: [], playlists: [], stations: [], ...overrides }
}

const artist = (name: string) => ({ id: name, name, albumCount: 1 }) as Artist
const album = (name: string, artistName = 'Someone') =>
  ({ id: name, name, artist: artistName }) as Album
const playlist = (name: string) => ({ id: name, name }) as Playlist
const station = (name: string) => ({ id: name, name, streamUrl: 'http://x' }) as RadioStation

describe('searchEverything', () => {
  it('finds nothing for an empty term', () => {
    expect(searchEverything('  ', sources({ artists: [artist('Blue')] }), LIMITS)).toEqual([])
  })

  it('leaves out the kinds with no match', () => {
    const sections = searchEverything(
      'blue',
      sources({ artists: [artist('Red')], playlists: [playlist('Blue Hour')] }),
      LIMITS,
    )
    expect(sections.map((section) => section.kind)).toEqual(['playlists'])
  })

  it('puts the artist first when the term is an artist', () => {
    const sections = searchEverything(
      'metallica',
      sources({
        artists: [artist('Metallica')],
        songs: [makeSong('a', { title: 'One', artist: 'Metallica' })],
      }),
      LIMITS,
    )
    expect(sections.map((section) => section.kind)).toEqual(['artists', 'songs'])
  })

  it('puts the songs first when the term is a song title', () => {
    const sections = searchEverything(
      'enter sandman',
      sources({
        albums: [album('Metallica', 'Enter Sandman Tribute Band')],
        songs: [makeSong('a', { title: 'Enter Sandman', artist: 'Metallica' })],
      }),
      LIMITS,
    )
    expect(sections[0]?.kind).toBe('songs')
  })

  it('cuts each kind to its limit but counts every match', () => {
    const sections = searchEverything(
      'blue',
      sources({ stations: [station('Blue 1'), station('Blue 2'), station('Blue 3')] }),
      LIMITS,
    )
    expect(sections[0]!.items).toHaveLength(2)
    expect(sections[0]!.total).toBe(3)
  })

  it('ranks the best match first within a kind', () => {
    const sections = searchEverything(
      'blue',
      sources({
        songs: [makeSong('a', { title: 'Red', artist: 'Blue' }), makeSong('b', { title: 'Blue' })],
      }),
      LIMITS,
    )
    expect(sections[0]!.items.map((song) => song.id)).toEqual(['b', 'a'])
  })
})
