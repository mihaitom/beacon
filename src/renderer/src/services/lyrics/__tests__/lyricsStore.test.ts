import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _countForTest,
  _resetLyricsStore,
  clearLyricsStore,
  readLyrics,
  writeLyrics,
  writeManyLyrics,
} from '../lyricsStore'

// jsdom has no IndexedDB, which is exactly the environment this file is
// about: the fallback backend, which is what the packaged desktop app runs
// on (its renderer loads from file://, where Chromium denies IndexedDB but
// still allows localStorage). The IndexedDB path is covered against a real
// browser in lyricsStore.browser.test.ts.

const LOCAL_KEY = 'beacon.lyricsStore'

function stored(): Record<string, { value: unknown; savedAt: number }> {
  return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}')
}

describe('lyricsStore without IndexedDB', () => {
  beforeEach(async () => {
    localStorage.clear()
    await _resetLyricsStore()
  })

  afterEach(async () => {
    await _resetLyricsStore()
    vi.unstubAllGlobals()
  })

  it('reads back what it stored', async () => {
    writeLyrics('song-1', { source: 'lrclib.net' })
    await Promise.resolve()

    expect(await readLyrics('song-1')).toEqual({ source: 'lrclib.net' })
  })

  it('answers null for something it never stored', async () => {
    expect(await readLyrics('song-1')).toBeNull()
  })

  it('keeps a bound on how much of localStorage it takes', async () => {
    // The whole reason this module exists: the cache it replaces grew
    // without limit inside the ~5 MB every other persisted thing in the app
    // shares, and the first write to run out of room was silently lost -
    // possibly the library catalog's rather than this cache's own.
    for (let i = 0; i < 600; i++) writeLyrics(`song-${i}`, { i })
    await Promise.resolve()

    const count = Object.keys(stored()).length
    expect(count).toBeLessThanOrEqual(500)
    // The newest survive, the oldest are the ones let go.
    expect(await readLyrics('song-599')).toEqual({ i: 599 })
    expect(await readLyrics('song-0')).toBeNull()
  })

  it('makes room and carries on when the browser says storage is full', async () => {
    writeLyrics('song-1', { source: 'lrclib.net' })
    await Promise.resolve()

    let refusals = 2
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === LOCAL_KEY && refusals-- > 0) {
        throw new DOMException('exceeded the quota', 'QuotaExceededError')
      }
      real.call(this, key, value)
    })

    writeLyrics('song-2', { source: 'NetEase' })
    await Promise.resolve()

    // The failed write didn't take the store with it: the next one lands.
    vi.mocked(Storage.prototype.setItem).mockRestore()
    writeLyrics('song-3', { source: 'SimpMusic' })
    await Promise.resolve()
    expect(await readLyrics('song-3')).toEqual({ source: 'SimpMusic' })
  })

  it('writes a whole cache in one go', async () => {
    // Carrying an existing cache over at upgrade: one write for all of it,
    // not one per song, since each of these rewrites the entire blob.
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    writeManyLyrics([
      ['song-1', { i: 1 }],
      ['song-2', { i: 2 }],
    ])
    await Promise.resolve()

    expect(writes.mock.calls.filter(([key]) => key === LOCAL_KEY)).toHaveLength(1)
    expect(await _countForTest()).toBe(2)
  })

  it('throws everything away when asked to', async () => {
    writeLyrics('song-1', { source: 'lrclib.net' })
    await Promise.resolve()

    clearLyricsStore()

    expect(await readLyrics('song-1')).toBeNull()
    expect(localStorage.getItem(LOCAL_KEY)).toBeNull()
  })

  it('does not store what it cannot serialize', async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    writeLyrics('song-1', circular)
    await Promise.resolve()

    expect(await readLyrics('song-1')).toBeNull()
  })
})
