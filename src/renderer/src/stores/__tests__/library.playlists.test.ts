import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLibraryStore } from '../library'
import { emitter } from '@/emitter'
import type Toast from '@/types/toast'
import type { SubsonicClient } from '@/services/subsonic/client'
import type { Playlist } from '@/types/library'

// The cache lives in IndexedDB now (services/library/libraryCacheStore.ts),
// which jsdom has none of — stood in for by a plain map, same as
// library.cache.test.ts does. No account is logged in under test, so the
// record key is the bare field name.
const cache = vi.hoisted(() => new Map<string, { items: unknown[]; fetchedAt: number }>())
// The real write goes to IndexedDB and takes a moment to land. Tests that
// care about that moment turn this up; everything else leaves it at zero.
const writeDelayMs = vi.hoisted(() => ({ value: 0 }))

vi.mock('@/services/library/libraryCacheStore', () => ({
  LEGACY_CACHE_KEY: 'beacon.library-cache',
  readLibraryField: vi.fn(async (key: string) => cache.get(key) ?? null),
  writeLibraryField: vi.fn(async (key: string, items: unknown[], fetchedAt = Date.now()) => {
    if (writeDelayMs.value) await new Promise((resolve) => setTimeout(resolve, writeDelayMs.value))
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
    removeFromPlaylist: vi.fn().mockResolvedValue(undefined),
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
  let toasts: Toast[]

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    cache.clear()
    writeDelayMs.value = 0
    toasts = []
    // The store emits on the real bus (see its announce()), not through a
    // component's this.$emitter.
    emitter.all.clear()
    emitter.on('toast', (toast) => {
      if (!Array.isArray(toast)) toasts.push(toast)
    })
    vi.restoreAllMocks()
  })

  afterEach(() => emitter.all.clear())

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

  it('does not let a deleted playlist come back when the page is reopened', async () => {
    // The cache write is asynchronous. If the delete returns before it has
    // landed, the next unforced read serves the old list straight back over
    // the in-memory one and the playlist reappears.
    const library = useLibraryStore()
    let listing = [makePlaylist('p1'), makePlaylist('p2')]
    stubClient({
      getPlaylists: vi.fn(async () => listing),
      deletePlaylist: vi.fn(async () => {
        listing = [makePlaylist('p2')]
      }),
    })
    await library.fetchPlaylists() // an earlier visit fills the cache

    writeDelayMs.value = 50
    await library.deletePlaylist('p1')
    await library.fetchPlaylists() // reopening the playlists page

    expect(library.playlists.map((p) => p.id)).toEqual(['p2'])
  })

  it('re-reads the playlist list long before the catalog cache would expire', async () => {
    // Playlists carry their own short TTL: the hour the catalog gets is
    // priced for re-reading 20k tracks, and a playlist list is one small
    // call that anything can change - another device, the server's own web
    // UI. Half a minute old is stale here and fresh for the catalog.
    const library = useLibraryStore()
    cache.set('playlists', {
      items: [makePlaylist('p1')],
      fetchedAt: Date.now() - 60_000,
    })
    const client = stubClient({
      getPlaylists: vi.fn(async () => [makePlaylist('p1'), makePlaylist('p2')]),
    })

    await library.fetchPlaylists()

    await vi.waitFor(() => expect(client.getPlaylists).toHaveBeenCalled())
    await vi.waitFor(() => expect(library.playlists.map((p) => p.id)).toEqual(['p1', 'p2']))
  })

  it('leaves a list it read seconds ago alone, so a context menu costs nothing', async () => {
    // The other half of that TTL: every track menu warms its playlist
    // picker with an unforced fetch, so this must not become a request per
    // right-click.
    const library = useLibraryStore()
    cache.set('playlists', { items: [makePlaylist('p1')], fetchedAt: Date.now() - 2_000 })
    const client = stubClient()

    await library.fetchPlaylists()

    expect(client.getPlaylists).not.toHaveBeenCalled()
    expect(library.playlists.map((p) => p.id)).toEqual(['p1'])
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

  it('keeps a newly created playlist visible once the page is reopened', async () => {
    // The bug this guards: creating a playlist re-reads the list and writes
    // it to the cache, but the write is asynchronous. A page that then asks
    // for the list unforced (PlaylistsView's created()) gets whatever the
    // cache holds, and cachedFetch() hands that back over the newer list in
    // memory — then treats its recent timestamp as reason not to re-read.
    // The playlist created from the queue drawer disappeared again for as
    // long as the TTL ran, on Jellyfin a whole day.
    const library = useLibraryStore()
    let listing = [makePlaylist('a')]
    stubClient({
      getPlaylists: vi.fn(async () => listing),
      createPlaylist: vi.fn(async () => {
        listing = [makePlaylist('a'), makePlaylist('new')]
      }),
    })

    await library.fetchPlaylists() // an earlier visit fills the cache
    writeDelayMs.value = 50 // from here the cache takes its time, as it does
    await library.createPlaylist('New one')
    expect(library.playlists.map((playlist) => playlist.id)).toEqual(['a', 'new'])

    await library.fetchPlaylists() // reopening the playlists page

    expect(library.playlists.map((playlist) => playlist.id)).toEqual(['a', 'new'])
  })

  it('says so when a playlist is created, for the pages that cannot show it', async () => {
    const library = useLibraryStore()
    stubClient()

    await library.createPlaylist('Road trip')

    expect(toasts.at(-1)?.level).toBe('success')
    expect(toasts.at(-1)?.message).toContain('Road trip')
  })

  it('names the playlist a song was added to', async () => {
    const library = useLibraryStore()
    stubClient({
      getPlaylists: vi.fn(async () => [makePlaylist('p1', { name: 'Road trip' })]),
    })

    await library.addToPlaylist('p1', ['s1'])
    expect(toasts.at(-1)?.message).toContain('Road trip')

    await library.addToPlaylist('p1', ['s1', 's2', 's3'])
    // The count matters as much as the name: "add to playlist" on a
    // multi-selection is one gesture and three tracks.
    expect(toasts.at(-1)?.message).toContain('3')
    expect(toasts.at(-1)?.message).toContain('Road trip')
  })

  it('refetches the list after removing songs, so the song count is not left stale', async () => {
    const library = useLibraryStore()
    const client = stubClient({
      getPlaylists: vi.fn().mockResolvedValue([makePlaylist('p1', { songCount: 1 })]),
    })
    library.playlists = [makePlaylist('p1', { songCount: 3 })]

    await library.removeFromPlaylist('p1', [2, 0])

    expect(client.removeFromPlaylist).toHaveBeenCalledWith('p1', [2, 0])
    expect(library.playlists[0]!.songCount).toBe(1)
  })

  it('removes without touching the shared loading flag', async () => {
    // Same reasoning as the reorder below: the row is already gone from
    // the view, so a loader over it would only flash.
    const library = useLibraryStore()
    const client = stubClient()
    let loadingDuringCall = false
    client.removeFromPlaylist!.mockImplementation(() => {
      loadingDuringCall = library.loading
      return Promise.resolve()
    })

    await library.removeFromPlaylist('p1', [0])

    expect(loadingDuringCall).toBe(false)
  })

  it('restores a playlist by sending the complete list back, and refreshes the count', async () => {
    const library = useLibraryStore()
    const client = stubClient({
      getPlaylists: vi.fn().mockResolvedValue([makePlaylist('p1', { songCount: 3 })]),
    })
    library.playlists = [makePlaylist('p1', { songCount: 2 })]

    await library.restorePlaylistSongs('p1', ['a', 'b', 'c'])

    expect(client.setPlaylistSongs).toHaveBeenCalledWith('p1', ['a', 'b', 'c'])
    expect(library.playlists[0]!.songCount).toBe(3)
  })

  it('still counts as done when only the list refresh fails', async () => {
    // The entry really is gone by then. Passing the refresh's failure on
    // would report a removal that worked as one that didn't, and offer to
    // undo it.
    const library = useLibraryStore()
    const client = stubClient({
      getPlaylists: vi.fn().mockRejectedValue(new Error('offline')),
    })

    await expect(library.removeFromPlaylist('p1', [0])).resolves.toBeUndefined()
    await expect(library.restorePlaylistSongs('p1', ['a'])).resolves.toBeUndefined()

    expect(client.removeFromPlaylist).toHaveBeenCalledWith('p1', [0])
    expect(client.setPlaylistSongs).toHaveBeenCalledWith('p1', ['a'])
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
