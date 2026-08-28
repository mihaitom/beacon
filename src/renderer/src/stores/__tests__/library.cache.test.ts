import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useLibraryStore } from '../library'
import type { SubsonicClient } from '@/services/subsonic/client'
import type { Album, Artist } from '@/types/library'
import { makeSong } from './fixtures'

const CACHE_KEY = 'beacon.library-cache'
const HOUR = 60 * 60 * 1000

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
 * an hour, so this is how a test picks the stale or the fresh branch. */
function seedCache(field: string, value: unknown, ageMs: number): void {
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
    const getAlbumList2 = vi
      .fn()
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([makeAlbum('last')])
    stubClient({ getAlbumList2 })

    await library.fetchAlbums()

    expect(getAlbumList2).toHaveBeenCalledTimes(2)
    expect(getAlbumList2).toHaveBeenLastCalledWith('alphabeticalByName', 500, 500)
    expect(library.albums).toHaveLength(501)
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
})
