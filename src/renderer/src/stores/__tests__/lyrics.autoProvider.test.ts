import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
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
    const [lyricsModule, libraryModule, authModule, providersModule] = await Promise.all([
      import('../lyrics'),
      import('../library'),
      import('../auth'),
      import('../lyricsProviders'),
    ])
    return {
      lyrics: lyricsModule.useLyricsStore(),
      library: libraryModule.useLibraryStore(),
      auth: authModule.useAuthStore(),
      providers: providersModule.useLyricsProvidersStore(),
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
    const { lyrics, library, auth, providers } = await loadStores()
    auth.serverType = 'subsonic'
    providers.setEnabled([])
    stubEmptyFileLyrics(library)

    await lyrics.ensureLoaded(song)

    expect(localStorage.getItem('beacon.lyricsCache')).toBeNull()
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
    const { lyrics, library, auth, providers } = await loadStores()
    auth.serverType = 'subsonic'
    providers.setEnabled(['lrclib.net'])
    stubEmptyFileLyrics(library)

    await lyrics.ensureLoaded(song)

    expect(lyrics.source).toBe('lrclib.net')
    expect(lyrics.lines[0]?.text).toBe('hello')
    const stored = JSON.parse(localStorage.getItem('beacon.lyricsCache') ?? '{}')
    expect(stored[song.id]?.source).toBe('lrclib.net')
  })

  it('caches a genuine miss as negative once a provider was actually asked', async () => {
    const song = makeSong('a')
    vi.mocked(connectLyrics.autoLyrics).mockResolvedValue(null)
    const { lyrics, library, auth, providers } = await loadStores()
    auth.serverType = 'subsonic'
    providers.setEnabled(['lrclib.net'])
    stubEmptyFileLyrics(library)

    await lyrics.ensureLoaded(song)

    const stored = JSON.parse(localStorage.getItem('beacon.lyricsCache') ?? '{}')
    expect(stored[song.id]?.negative).toBe(true)
  })
})
