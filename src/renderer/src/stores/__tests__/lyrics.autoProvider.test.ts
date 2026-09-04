import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { makeSong } from './fixtures'
import * as connectLyrics from '@/services/connect/lyrics'

// A real vi.fn(), not the recheck suite's fixed `async () => null` — these
// tests need to assert on call args and vary the return value per test.
vi.mock('@/services/connect/lyrics', () => ({
  autoLyrics: vi.fn(),
  getLyricsByRemoteId: vi.fn(),
  searchLyrics: vi.fn(),
}))

/** ensureLoaded()'s use of stores/lyricsProviders.ts — the third-party
 * fallback used to run unconditionally; it now only fires for whatever is
 * currently enabled there (every provider, by default — see that store's
 * own comment — until Settings empties it out). */
describe('lyrics store — provider gating', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(connectLyrics.autoLyrics).mockReset()
  })

  async function loadStores() {
    vi.resetModules()
    const [lyricsModule, libraryModule, authModule, providersModule, storeModule] =
      await Promise.all([
        import('../lyrics'),
        import('../library'),
        import('../auth'),
        import('../lyricsProviders'),
        // Read back through the store's own API rather than by poking at
        // localStorage: what a cached entry is written to (IndexedDB in a
        // browser, a bounded blob where there is none) is that module's
        // business, and asserting on it here would be asserting on the
        // fallback backend specifically.
        import('@/services/lyrics/lyricsStore'),
      ])
    return {
      lyrics: lyricsModule.useLyricsStore(),
      library: libraryModule.useLibraryStore(),
      auth: authModule.useAuthStore(),
      providers: providersModule.useLyricsProvidersStore(),
      readLyrics: storeModule.readLyrics,
      reloadForAccount: lyricsModule.reloadLyricsCacheForAccount,
    }
  }

  type LibraryStore = ReturnType<typeof import('../library').useLibraryStore>

  function stubEmptyFileLyrics(library: LibraryStore): void {
    vi.spyOn(library, 'client').mockReturnValue({
      getLyricsBySongId: vi.fn(async () => []),
    } as unknown as ReturnType<LibraryStore['client']>)
  }

  it('queries every provider by default, with nothing configured', async () => {
    const song = makeSong('a')
    vi.mocked(connectLyrics.autoLyrics).mockResolvedValue(null)
    const { lyrics, library, auth } = await loadStores()
    auth.serverType = 'subsonic'
    stubEmptyFileLyrics(library)

    await lyrics.ensureLoaded(song)

    expect(connectLyrics.autoLyrics).toHaveBeenCalledWith(
      expect.objectContaining({ name: song.title, artist: song.artist }),
      ['lrclib.net', 'NetEase', 'SimpMusic'],
    )
  })

  it('never calls autoLyrics once every provider has been deselected', async () => {
    const song = makeSong('a')
    const { lyrics, library, auth, providers } = await loadStores()
    auth.serverType = 'subsonic'
    providers.setEnabled([])
    stubEmptyFileLyrics(library)

    await lyrics.ensureLoaded(song)

    expect(connectLyrics.autoLyrics).not.toHaveBeenCalled()
    expect(lyrics.source).toBeNull()
    expect(lyrics.error).toBe(false)
  })

  it('does not cache a negative result when the lookup was skipped, not tried', async () => {
    // Otherwise a song played once with everything deselected would still
    // show "no lyrics" for NEGATIVE_TTL_MS after someone re-enables a
    // provider — the miss was never actually attempted.
    const song = makeSong('a')
    const { lyrics, library, auth, providers, readLyrics } = await loadStores()
    auth.serverType = 'subsonic'
    providers.setEnabled([])
    stubEmptyFileLyrics(library)

    await lyrics.ensureLoaded(song)
    await flushPromises()

    expect(await readLyrics(song.id)).toBeNull()
  })

  it('queries only the enabled providers when the selection has been narrowed', async () => {
    const song = makeSong('a')
    vi.mocked(connectLyrics.autoLyrics).mockResolvedValue(null)
    const { lyrics, library, auth, providers } = await loadStores()
    auth.serverType = 'subsonic'
    providers.setEnabled(['lrclib.net'])
    stubEmptyFileLyrics(library)

    await lyrics.ensureLoaded(song)

    expect(connectLyrics.autoLyrics).toHaveBeenCalledWith(
      expect.objectContaining({ name: song.title, artist: song.artist }),
      ['lrclib.net'],
    )
  })

  it('shows a real provider hit and caches it once a provider is enabled', async () => {
    const song = makeSong('a')
    vi.mocked(connectLyrics.autoLyrics).mockResolvedValue({
      artist: song.artist,
      id: 'abc',
      lyrics: '[00:01.00]hello',
      name: song.title,
      source: 'lrclib.net',
    })
    const { lyrics, library, auth, providers, readLyrics } = await loadStores()
    auth.serverType = 'subsonic'
    providers.setEnabled(['lrclib.net'])
    stubEmptyFileLyrics(library)

    await lyrics.ensureLoaded(song)
    await flushPromises()

    expect(lyrics.source).toBe('lrclib.net')
    expect(lyrics.lines[0]?.text).toBe('hello')
    const stored = await readLyrics<{ source: string }>(song.id)
    expect(stored?.source).toBe('lrclib.net')
  })

  it('caches a genuine miss as negative once a provider was actually asked', async () => {
    const song = makeSong('a')
    vi.mocked(connectLyrics.autoLyrics).mockResolvedValue(null)
    const { lyrics, library, auth, providers, readLyrics } = await loadStores()
    auth.serverType = 'subsonic'
    providers.setEnabled(['lrclib.net'])
    stubEmptyFileLyrics(library)

    await lyrics.ensureLoaded(song)
    await flushPromises()

    const stored = await readLyrics<{ negative: boolean }>(song.id)
    expect(stored?.negative).toBe(true)
  })

  it('stores nothing for a lookup that was still running when the account changed', async () => {
    // Song ids are only unique within one media server (Plex hands out
    // small integers), so an answer fetched for the account that has just
    // been left must not be filed under the one that just arrived - it
    // would show up as another library's lyrics for an unrelated song.
    const song = makeSong('a')
    let answer: (result: null) => void = () => {}
    vi.mocked(connectLyrics.autoLyrics).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )
    const { lyrics, library, auth, providers, readLyrics, reloadForAccount } = await loadStores()
    auth.serverType = 'subsonic'
    providers.setEnabled(['lrclib.net'])
    stubEmptyFileLyrics(library)

    const loading = lyrics.ensureLoaded(song)
    await flushPromises()
    reloadForAccount()
    answer(null)
    await loading
    await flushPromises()

    expect(await readLyrics(song.id)).toBeNull()
  })
})
