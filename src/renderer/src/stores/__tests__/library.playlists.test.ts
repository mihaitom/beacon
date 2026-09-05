import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLibraryStore } from '../library'
import type { SubsonicClient } from '@/services/subsonic/client'
import type { Playlist } from '@/types/library'

// The cache lives in IndexedDB now (services/library/libraryCacheStore.ts),
// which jsdom has none of — stood in for by a plain map, same as
// library.cache.test.ts does. No account is logged in under test, so the
// record key is the bare field name.
const cache = vi.hoisted(() => new Map<string, { items: unknown[]; fetchedAt: number }>())

vi.mock('@/services/library/libraryCacheStore', () => ({
  LEGACY_CACHE_KEY: 'beacon.library-cache',
  readLibraryField: vi.fn(async (key: string) => cache.get(key) ?? null),
  writeLibraryField: vi.fn((key: string, items: unknown[], fetchedAt = Date.now()) => {
    cache.set(key, { items, fetchedAt })
  }),
  clearLibraryFields: vi.fn((keys: string[]) => {
    for (const key of keys) cache.delete(key)
  }),
}))

function makePlaylist(id: string, overrides: Partial<Playlist> = {}): Playlist {
  return {
    id,
    name: `List ${id}`,
    songCount: 3,
    duration: 600,
    public: false,
    coverArtId: null,
    owner: 'thomas',
    songs: [],
    ...overrides,
  }
}

function cachedPlaylists(): Playlist[] {
  return (cache.get('playlists')?.items ?? []) as Playlist[]
}

function stubClient(
  overrides: Record<string, unknown> = {},
): Record<string, ReturnType<typeof vi.fn>> {
  const client = {
    getPlaylists: vi.fn().mockResolvedValue([]),
    createPlaylist: vi.fn().mockResolvedValue(undefined),
    addToPlaylist: vi.fn().mockResolvedValue(undefined),
    setPlaylistSongs: vi.fn().mockResolvedValue(undefined),
    updatePlaylist: vi.fn().mockResolvedValue(undefined),
    deletePlaylist: vi.fn().mockResolvedValue(undefined),
    star: vi.fn().mockResolvedValue(undefined),
    unstar: vi.fn().mockResolvedValue(undefined),
    getStarred2: vi.fn().mockResolvedValue({ artists: [], albums: [], songs: [] }),
    search3: vi.fn().mockResolvedValue({ artists: [], albums: [], songs: [] }),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue(client as unknown as SubsonicClient)
  return client
}

describe('library mutations', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    cache.clear()
    vi.restoreAllMocks()
  })

  it('writes a deleted playlist out of the cache, not just out of memory', async () => {
    // Otherwise the next mount reads the cache-first path and, within the
    // hour-long TTL, serves the just-deleted playlist straight back.
    const library = useLibraryStore()
    stubClient()
    library.playlists = [makePlaylist('p1'), makePlaylist('p2')]

    await library.deletePlaylist('p1')

    expect(library.playlists.map((p) => p.id)).toEqual(['p2'])
    expect(cachedPlaylists().map((p) => p.id)).toEqual(['p2'])
  })

  it('writes a rename through to the cache for the same reason', async () => {
    const library = useLibraryStore()
    stubClient()
    library.playlists = [makePlaylist('p1', { name: 'Old' })]

    await library.updatePlaylist('p1', { name: 'New', public: true })

    expect(library.playlists[0]!.name).toBe('New')
    expect(library.playlists[0]!.public).toBe(true)
    expect(cachedPlaylists()[0]!.name).toBe('New')
  })

  it('refetches the list after adding songs, so the song count is not left stale', async () => {
    const library = useLibraryStore()
    const client = stubClient({
      getPlaylists: vi.fn().mockResolvedValue([makePlaylist('p1', { songCount: 5 })]),
    })
    library.playlists = [makePlaylist('p1', { songCount: 3 })]

    await library.addToPlaylist('p1', ['s1', 's2'])

    expect(client.addToPlaylist).toHaveBeenCalledWith('p1', ['s1', 's2'])
    expect(library.playlists[0]!.songCount).toBe(5)
  })

  it('reorders without touching the shared loading flag', async () => {
    // The view has already moved the row and reverts it itself on failure;
    // flashing a loader over a change that is already visible is wrong.
    const library = useLibraryStore()
    const client = stubClient()
    let loadingDuringCall = false
    client.setPlaylistSongs!.mockImplementation(() => {
      loadingDuringCall = library.loading
      return Promise.resolve()
    })

    await library.reorderPlaylist('p1', ['b', 'a'])

    expect(client.setPlaylistSongs).toHaveBeenCalledWith('p1', ['b', 'a'])
    expect(loadingDuringCall).toBe(false)
  })

  it('unstars something that is starred and stars something that is not', async () => {
    const library = useLibraryStore()
    const client = stubClient()

    await library.toggleStar({ id: 's1', starred: true })
    expect(client.unstar).toHaveBeenCalledWith({
      id: 's1',
      albumId: undefined,
      artistId: undefined,
    })
    expect(client.star).not.toHaveBeenCalled()

    await library.toggleStar({ albumId: 'al1', starred: false })
    expect(client.star).toHaveBeenCalledWith({ id: undefined, albumId: 'al1', artistId: undefined })
    // Re-read afterwards, so every view showing the starred lists agrees.
    expect(client.getStarred2).toHaveBeenCalledTimes(2)
  })

  it('clears the results for an empty search instead of querying for nothing', async () => {
    const library = useLibraryStore()
    const client = stubClient()
    library.searchResults = { artists: [], albums: [], songs: [] }

    await library.search('   ')

    expect(client.search3).not.toHaveBeenCalled()
  })

  /** The API's own default is 25 of each, which is a type-ahead dropdown's
   * worth: a common first name matches more than that in any real library,
   * and the results page gave no sign it had been cut short. Asserted here
   * rather than left to the client's defaults, because that is where it
   * silently was before. */
  it('asks for a page worth of results, not the API default of 25', async () => {
    const library = useLibraryStore()
    const client = stubClient()

    await library.search('michael')

    // `!` because the stub is a Record, so every lookup on it is optional.
    const [query, songCount, albumCount, artistCount] = client.search3!.mock.calls[0]!
    expect(query).toBe('michael')
    expect(songCount).toBeGreaterThanOrEqual(100)
    expect(albumCount).toBeGreaterThan(25)
    expect(artistCount).toBeGreaterThan(25)
  })
})
