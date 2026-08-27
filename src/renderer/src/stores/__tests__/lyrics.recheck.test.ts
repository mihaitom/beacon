import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { FILE_SOURCE, shouldRecheckFile } from '../lyrics'
import { makeSong } from './fixtures'

vi.mock('@/services/connect/lyrics', () => ({
  autoLyrics: vi.fn(async () => null),
  getLyricsByRemoteId: vi.fn(),
  searchLyrics: vi.fn(),
}))

const DAY_MS = 24 * 60 * 60 * 1000

/** Lyrics found at a provider are cached, and used to be cached forever.
 * That is wrong for the one case the file-lyrics feature exists for:
 * someone tagging a library they have already listened to. */
describe('shouldRecheckFile', () => {
  const providerHit = {
    synced: false,
    lines: [],
    source: 'lrclib.net',
    remoteId: '1',
    cachedAt: Date.now(),
  }

  it('never re-checks lyrics that already came from the file', () => {
    // There is nothing better to find — the file's own copy is the best
    // answer by definition.
    const fileHit = { ...providerHit, source: FILE_SOURCE, cachedAt: 0 }

    expect(shouldRecheckFile(fileHit)).toBe(false)
  })

  it('leaves a fresh provider hit alone', () => {
    expect(shouldRecheckFile(providerHit)).toBe(false)
  })

  it('re-checks a provider hit once it has sat there a while', () => {
    expect(shouldRecheckFile({ ...providerHit, cachedAt: Date.now() - 8 * DAY_MS })).toBe(true)
  })

  it('treats an entry from before this existed as due', () => {
    // Exactly the entries this was written for: cached back when a
    // positive hit was kept forever, from a library that has since been
    // tagged.
    const legacy = { synced: false, lines: [], source: 'lrclib.net', remoteId: '1' }

    expect(shouldRecheckFile(legacy)).toBe(true)
  })
})

describe('lyrics cache re-check', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  /** The store parses the persisted cache once and keeps it in a
   * module-level variable, so a test that seeds localStorage has to reach
   * it before that first read — hence a fresh module per test rather than
   * clearing between them. Every store comes from the same fresh graph, or
   * they would be talking to different instances. */
  async function loadStores() {
    vi.resetModules()
    const [lyricsModule, libraryModule, authModule] = await Promise.all([
      import('../lyrics'),
      import('../library'),
      import('../auth'),
    ])
    return {
      lyrics: lyricsModule.useLyricsStore(),
      library: libraryModule.useLibraryStore(),
      auth: authModule.useAuthStore(),
      shouldRecheckFile: lyricsModule.shouldRecheckFile,
      FILE_SOURCE: lyricsModule.FILE_SOURCE,
    }
  }

  function cacheProviderHit(songId: string, cachedAt: number): void {
    localStorage.setItem(
      'beacon.lyricsCache',
      JSON.stringify({
        [songId]: {
          synced: false,
          lines: [{ time: 0, text: 'from the internet' }],
          source: 'lrclib.net',
          remoteId: '1',
          cachedAt,
        },
      }),
    )
  }

  type LibraryStore = ReturnType<typeof import('../library').useLibraryStore>

  function stubFileLyrics(
    library: LibraryStore,
    lyrics: unknown[],
    settle?: Promise<void>,
  ): ReturnType<typeof vi.fn> {
    const getLyricsBySongId = vi.fn(async () => {
      if (settle) await settle
      return lyrics
    })
    vi.spyOn(library, 'client').mockReturnValue({
      getLyricsBySongId,
    } as unknown as ReturnType<LibraryStore['client']>)
    return getLyricsBySongId
  }

  it("swaps in the file's own lyrics once the library has been tagged", async () => {
    const song = makeSong('a')
    cacheProviderHit(song.id, Date.now() - 8 * DAY_MS)
    const { lyrics, library, auth } = await loadStores()
    auth.serverType = 'subsonic'
    // Held open so the assertion below lands while the re-check is still
    // in flight, the way a real round trip would.
    let release: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    stubFileLyrics(
      library,
      [{ lang: 'xxx', synced: true, line: [{ start: 1000, value: 'from the file' }] }],
      inFlight,
    )

    await lyrics.ensureLoaded(song)
    // The cached copy shows immediately — the re-check must not blank the
    // panel while it runs.
    expect(lyrics.source).toBe('lrclib.net')
    expect(lyrics.loading).toBe(false)

    release()
    await flushPromises()
    expect(lyrics.source).toBe(FILE_SOURCE)
    expect(lyrics.lines[0]?.text).toBe('from the file')
    expect(lyrics.synced).toBe(true)
  })

  it('keeps the cached lyrics when the file still has none', async () => {
    const song = makeSong('a')
    cacheProviderHit(song.id, Date.now() - 8 * DAY_MS)
    const { lyrics, library, auth, shouldRecheckFile: isDue } = await loadStores()
    auth.serverType = 'subsonic'
    stubFileLyrics(library, [])

    await lyrics.ensureLoaded(song)
    await flushPromises()

    expect(lyrics.source).toBe('lrclib.net')
    // Marked as checked, so this doesn't repeat on every play from here on.
    const stored = JSON.parse(localStorage.getItem('beacon.lyricsCache') ?? '{}')
    expect(isDue(stored[song.id])).toBe(false)
  })

  it('does not ask the file again for a hit that was just cached', async () => {
    const song = makeSong('a')
    cacheProviderHit(song.id, Date.now())
    const { lyrics, library, auth } = await loadStores()
    auth.serverType = 'subsonic'
    const getLyricsBySongId = stubFileLyrics(library, [])

    await lyrics.ensureLoaded(song)
    await flushPromises()

    expect(getLyricsBySongId).not.toHaveBeenCalled()
  })
})
