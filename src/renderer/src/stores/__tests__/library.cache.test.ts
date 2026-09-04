import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useLibraryStore } from '../library'
import { useAuthStore } from '../auth'
import type { SubsonicClient } from '@/services/subsonic/client'
import type { Album, Artist } from '@/types/library'
import { makeSong } from './fixtures'

const CACHE_KEY = 'beacon.library-cache'
const HOUR = 60 * 60 * 1000

// The cache lives in IndexedDB now (services/library/libraryCacheStore.ts),
// which jsdom has none of — stood in for here by a plain map, so these
// tests stay about *when* the store keeps and refreshes things. The store
// itself is exercised against a real IndexedDB in
// services/library/__tests__/libraryCacheStore.browser.test.ts.
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

function makeArtist(id: string): Artist {
  return {
    id,
    name: `Artist ${id}`,
    albumCount: 1,
    coverArtId: null,
    imageUrl: null,
    starred: false,
    rating: 0,
    albums: [],
  }
}

function makeAlbum(id: string): Album {
  return {
    id,
    name: `Album ${id}`,
    artist: 'Test Artist',
    artistId: 'artist-1',
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

/** Writes a cache entry as if it had been fetched `ageMs` ago — the TTL is
 * an hour on a Subsonic server, so this is how a test picks the stale or
 * the fresh branch. No account is logged in under test, so the record key
 * is the bare field name (see fieldKey()). */
function seedCache(field: string, value: unknown[], ageMs: number): void {
  cache.set(field, { items: value, fetchedAt: Date.now() - ageMs })
}

/** The pre-IndexedDB cache, as an upgrading install still has it. */
function seedLegacyBlob(field: string, value: unknown[], ageMs: number): void {
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ [field]: value, fetchedAt: { [field]: Date.now() - ageMs } }),
  )
}

function stubClient(
  overrides: Record<string, unknown> = {},
): Record<string, ReturnType<typeof vi.fn>> {
  const client = {
    getArtists: vi.fn().mockResolvedValue([]),
    getAlbumList2: vi.fn().mockResolvedValue([]),
    search3: vi
      .fn()
      .mockResolvedValue({ artists: [], albums: [], songs: [], totalRecordCount: null }),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue(client as unknown as SubsonicClient)
  return client
}

describe('library caching', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    cache.clear()
    vi.restoreAllMocks()
  })

  it('serves a still-fresh cache without asking the server at all', async () => {
    // What the TTL is for: on a large Jellyfin library a full refetch is a
    // multi-minute scan, and re-running it on every app start is the cost
    // this avoids.
    const library = useLibraryStore()
    seedCache('artists', [makeArtist('cached')], 5 * 60 * 1000)
    const client = stubClient()

    await library.fetchArtists()

    expect(library.artists.map((a) => a.id)).toEqual(['cached'])
    expect(client.getArtists).not.toHaveBeenCalled()
  })

  it('refreshes a cache that has gone stale', async () => {
    const library = useLibraryStore()
    seedCache('artists', [makeArtist('cached')], 2 * HOUR)
    stubClient({ getArtists: vi.fn().mockResolvedValue([makeArtist('fresh')]) })

    await library.fetchArtists()
    await flushPromises()

    expect(library.artists.map((a) => a.id)).toEqual(['fresh'])
  })

  it('keeps showing the cached library when the refresh behind it fails', async () => {
    const library = useLibraryStore()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    seedCache('artists', [makeArtist('cached')], 2 * HOUR)
    stubClient({ getArtists: vi.fn().mockRejectedValue(new Error('offline')) })

    await library.fetchArtists()
    await flushPromises()

    expect(library.artists.map((a) => a.id)).toEqual(['cached'])
    expect(library.error).toBeNull() // a background refresh is not the user's problem
  })

  it('retries a refresh that failed on the first attempt', async () => {
    // Covers the app-start window where the server or the local proxy is
    // not quite up yet — without the retry, one early failure leaves stale
    // data in place for the rest of the session.
    vi.useFakeTimers()
    const library = useLibraryStore()
    seedCache('artists', [makeArtist('cached')], 2 * HOUR)
    const getArtists = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue([makeArtist('fresh')])
    stubClient({ getArtists })

    await library.fetchArtists()
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    expect(getArtists).toHaveBeenCalledTimes(2)
    expect(library.artists.map((a) => a.id)).toEqual(['fresh'])
    vi.useRealTimers()
  })

  it('pages through the album catalog and stops on the short last page', async () => {
    // The offset has to advance by a full page each time and the loop has
    // to end: getting either wrong means duplicate albums or a request loop
    // against the server.
    const library = useLibraryStore()
    const full = Array.from({ length: 500 }, (_, i) => makeAlbum(`a${i}`))
    const getAlbumList2 = vi.fn(async (_type: string, size: number, offset: number) => {
      if (offset === 0) return full
      if (offset === 500) return [makeAlbum('last')]
      return []
    })
    stubClient({ getAlbumList2 })

    await library.fetchAlbums()

    expect(getAlbumList2).toHaveBeenNthCalledWith(1, 'alphabeticalByName', 500, 0)
    expect(getAlbumList2).toHaveBeenNthCalledWith(2, 'alphabeticalByName', 500, 500)
    expect(library.albums).toHaveLength(501)
  })

  it('asks for the pages after the first one at the same time', async () => {
    // Sequentially, a large library is one round trip's latency times the
    // number of pages, all of it spent waiting — 12 trips for 6000 albums,
    // each one crossing the proxy, connect and the media server.
    const library = useLibraryStore()
    const page = (n: number) => Array.from({ length: 500 }, (_, i) => makeAlbum(`p${n}-${i}`))
    let inFlight = 0
    let peak = 0
    const getAlbumList2 = vi.fn(async (_type: string, _size: number, offset: number) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight--
      // Four full pages, then the end — enough to fill one whole wave.
      return offset <= 1500 ? page(offset / 500) : []
    })
    stubClient({ getAlbumList2 })

    await library.fetchAlbums()

    // The first page alone (nothing else may compete with what paints the
    // view), then the rest in one wave.
    expect(peak).toBe(4)
    expect(library.albums).toHaveLength(2000)
  })

  it('keeps the albums in page order even though the pages race', async () => {
    // The list is alphabetical and the view simply appends what it is
    // handed, so a later page finishing first must not reorder it.
    const library = useLibraryStore()
    const first = Array.from({ length: 500 }, (_, i) => makeAlbum(`a${i}`))
    const getAlbumList2 = vi.fn(async (_type: string, _size: number, offset: number) => {
      if (offset === 0) return first
      // Page 2 resolves after page 3 does.
      if (offset === 500) {
        // Several microtasks, not a timer: this file runs on fake ones.
        for (let tick = 0; tick < 5; tick++) await Promise.resolve()
        return [makeAlbum('second-page')]
      }
      return []
    })
    stubClient({ getAlbumList2 })

    await library.fetchAlbums()

    expect(library.albums.at(-1)?.id).toBe('second-page')
  })

  it('keeps a partly loaded song catalog usable, and retryable', async () => {
    // allSongsLoaded stays false so revisiting the view fetches again,
    // rather than leaving a silently incomplete catalog in place forever.
    const library = useLibraryStore()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const firstPage = Array.from({ length: 3000 }, (_, i) => makeSong(`s${i}`))
    const search3 = vi
      .fn()
      .mockResolvedValueOnce({ songs: firstPage, totalRecordCount: null })
      .mockRejectedValue(new Error('502'))
    stubClient({ search3 })

    await library.fetchAllSongs()

    expect(library.allSongs).toHaveLength(3000)
    expect(library.allSongsLoaded).toBe(false)
  })

  it('has concurrent callers await one catalog fetch instead of each starting their own', async () => {
    // Several paths fan out into this at once (fetchAlbum()'s derived
    // lookups, fetchTopSongsForArtist()'s Promise.all) — without the dedupe
    // each would kick off its own full-catalog fetch.
    const library = useLibraryStore()
    const search3 = vi.fn().mockResolvedValue({ songs: [makeSong('a')], totalRecordCount: null })
    stubClient({ search3 })

    await Promise.all([library.fetchAllSongs(), library.fetchAllSongs(), library.fetchAllSongs()])

    expect(search3).toHaveBeenCalledOnce()
  })

  it('counts concurrent fetches, so the last one finishing clears the spinner', async () => {
    // A plain boolean flipped back as soon as the *first* of HomeView's
    // four parallel fetches returned.
    const library = useLibraryStore()
    let releaseFirst = (): void => {}
    const first = library.withLoading(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        }),
    )
    const second = library.withLoading(() => Promise.resolve())

    await second
    expect(library.loading).toBe(true)

    releaseFirst()
    await first
    expect(library.loading).toBe(false)
  })

  it('clears the rescan progress bar even when the rescan fails', async () => {
    const library = useLibraryStore()
    stubClient({ search3: vi.fn().mockRejectedValue(new Error('502')) })

    await expect(library.refreshLibrary()).rejects.toThrow('502')
    expect(library.songScanProgress).toBeNull()
  })

  describe('carrying an existing cache over', () => {
    // The cache used to be one JSON blob in localStorage, which is where an
    // upgrading install still has it. Throwing that away would mean
    // re-fetching the whole library once — minutes of scanning on a
    // Jellyfin server, which is exactly what the cache is for.
    it('reads a library cached by the previous version', async () => {
      const library = useLibraryStore()
      seedLegacyBlob('artists', [makeArtist('cached')], 0)
      const getArtists = vi.fn().mockResolvedValue([])
      stubClient({ getArtists })

      await library.fetchArtists()

      expect(library.artists.map((a) => a.id)).toEqual(['cached'])
      // Still fresh, so nothing was re-fetched behind it either.
      expect(getArtists).not.toHaveBeenCalled()
    })

    it('keeps each field as old as it really was', async () => {
      // A field that was already stale has to stay stale, or an upgrade
      // would silently skip the refresh it was due.
      const library = useLibraryStore()
      seedLegacyBlob('artists', [makeArtist('cached')], 2 * HOUR)
      const getArtists = vi.fn().mockResolvedValue([makeArtist('fresh')])
      stubClient({ getArtists })

      await library.fetchArtists()
      await flushPromises()

      expect(getArtists).toHaveBeenCalled()
      expect(library.artists.map((a) => a.id)).toEqual(['fresh'])
    })

    it('takes the old key with it, so this only ever happens once', async () => {
      const library = useLibraryStore()
      seedLegacyBlob('artists', [makeArtist('cached')], 0)
      stubClient()

      await library.fetchArtists()

      expect(localStorage.getItem(CACHE_KEY)).toBeNull()
    })
  })

  describe('how long a cached library is trusted', () => {
    it('refreshes an hour-old catalog on a Subsonic server', async () => {
      const library = useLibraryStore()
      seedCache('artists', [makeArtist('cached')], 2 * HOUR)
      const getArtists = vi.fn().mockResolvedValue([makeArtist('fresh')])
      stubClient({ getArtists })

      await library.fetchArtists()
      await flushPromises()

      expect(getArtists).toHaveBeenCalled()
    })

    it('leaves it alone far longer on Jellyfin, where re-scanning costs minutes', async () => {
      // Its recursive Items query runs at roughly 9ms per item (see
      // fetchAllSongsNow) — an hourly background re-scan of a large library
      // competes with whatever the user is actually doing.
      const library = useLibraryStore()
      useAuthStore().serverType = 'jellyfin'
      seedCache('artists', [makeArtist('cached')], 2 * HOUR)
      const getArtists = vi.fn().mockResolvedValue([makeArtist('fresh')])
      stubClient({ getArtists })

      await library.fetchArtists()
      await flushPromises()

      expect(getArtists).not.toHaveBeenCalled()
      expect(library.artists.map((a) => a.id)).toEqual(['cached'])
    })

    it('still refreshes a Jellyfin catalog once it is genuinely old', async () => {
      const library = useLibraryStore()
      useAuthStore().serverType = 'jellyfin'
      seedCache('artists', [makeArtist('cached')], 30 * 24 * HOUR)
      const getArtists = vi.fn().mockResolvedValue([makeArtist('fresh')])
      stubClient({ getArtists })

      await library.fetchArtists()
      await flushPromises()

      expect(getArtists).toHaveBeenCalled()
    })
  })
})
