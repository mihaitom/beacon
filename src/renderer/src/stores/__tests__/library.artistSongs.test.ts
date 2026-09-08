import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLibraryStore } from '../library'
import type { SubsonicClient } from '@/services/subsonic/client'
import type { Album, Artist } from '@/types/library'
import { makeSong } from './fixtures'

/**
 * An artist's songs are not the same set as the songs on their albums, and
 * treating them as one left a whole kind of artist with a blank page: a
 * performer on a compilation owns no album (it belongs to "Various
 * Artists"), so there was nothing to walk and nothing to show.
 */
function artist(overrides: Partial<Artist> = {}): Artist {
  return {
    id: 'yyy',
    name: 'Yeah Yeah Yeahs',
    albumCount: 0,
    coverArtId: null,
    imageUrl: null,
    starred: false,
    rating: 0,
    albums: [],
    ...overrides,
  }
}

function album(id: string): Album {
  return {
    id,
    name: `Album ${id}`,
    artist: 'Yeah Yeah Yeahs',
    artistId: 'yyy',
    coverArtId: null,
    songCount: 1,
    duration: 180,
    year: 2024,
    genre: null,
    starred: false,
    rating: 0,
    songs: [],
  }
}

/** The catalogue the app loads on startup - what an artist's guest
 * appearances are actually found in, no request involved. */
function seedCatalogue(songs: ReturnType<typeof makeSong>[]) {
  const store = useLibraryStore()
  store.allSongs = songs
  store.allSongsLoaded = true
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.restoreAllMocks()
})

describe('fetchAllSongsForArtist', () => {
  it('finds the songs of an artist who owns no album at all', async () => {
    const store = seedCatalogue([
      makeSong('compilation-track', {
        title: 'Heads Will Roll (A-Trak remix)',
        artist: 'Yeah Yeah Yeahs',
        artistId: 'yyy',
        album: 'Project X',
      }),
    ])

    const songs = await store.fetchAllSongsForArtist(artist())

    expect(songs.map((s) => s.id)).toEqual(['compilation-track'])
  })

  it('drops what the search turned up that is not theirs', async () => {
    // A search for a name matches titles and albums too - showing those
    // would put a stranger's song on the page.
    const store = seedCatalogue([
      makeSong('theirs', { artist: 'Yeah Yeah Yeahs', artistId: 'yyy' }),
      makeSong('not-theirs', { artist: 'Bruce Springsteen', artistId: 'boss' }),
    ])

    const songs = await store.fetchAllSongsForArtist(artist())

    expect(songs.map((s) => s.id)).toEqual(['theirs'])
  })

  it('adds guest appearances to the songs on their own albums, once each', async () => {
    const own = makeSong('own', { artist: 'Yeah Yeah Yeahs', artistId: 'yyy' })
    const store = seedCatalogue([
      own,
      makeSong('guest', { artist: 'Someone & Yeah Yeah Yeahs', artistId: 'x' }),
    ])
    vi.spyOn(store, 'fetchAlbum').mockResolvedValue({ ...album('a1'), songs: [own] })

    const songs = await store.fetchAllSongsForArtist(artist({ albums: [album('a1')] }))

    expect(songs.map((s) => s.id).sort()).toEqual(['guest', 'own'])
  })

  it('asks the server for nothing beyond the albums themselves', async () => {
    // The guest appearances come out of the catalogue this client already
    // holds. A search per artist page would have cost seconds on Jellyfin,
    // whose bridge measures ~9ms per item returned.
    const store = seedCatalogue([makeSong('guest', { artist: 'Someone & Yeah Yeah Yeahs' })])
    const client = { search3: vi.fn() }
    vi.spyOn(store, 'client').mockReturnValue(client as unknown as SubsonicClient)

    const songs = await store.fetchAllSongsForArtist(artist())

    expect(songs.map((s) => s.id)).toEqual(['guest'])
    expect(client.search3).not.toHaveBeenCalled()
  })
})
