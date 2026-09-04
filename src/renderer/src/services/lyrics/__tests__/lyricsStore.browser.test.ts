import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _countForTest,
  _resetLyricsStore,
  _trimNow,
  clearLyricsStore,
  readLyrics,
  writeLyrics,
  writeManyLyrics,
} from '../lyricsStore'

// Real Chromium rather than jsdom, for the IndexedDB backend — jsdom has no
// IndexedDB at all, and a stand-in would only test the stand-in. The
// fallback backend is covered in jsdom instead (lyricsStore.test.ts), which
// is the environment that actually uses it.

/** Waits for a fire-and-forget write to have landed. writeLyrics() returns
 * nothing on purpose, so a test waits for the result rather than the call. */
async function eventually<T>(read: () => Promise<T>, want: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read()
    if (want(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the store never reached the expected state')
}

describe('lyricsStore', () => {
  beforeEach(async () => {
    await _resetLyricsStore()
  })

  afterEach(async () => {
    await _resetLyricsStore()
  })

  it('reads back what it stored', async () => {
    writeLyrics('song-1', { source: 'lrclib.net', lines: [{ time: 0, text: 'hello' }] })

    const stored = await eventually(
      () => readLyrics<{ source: string }>('song-1'),
      (value) => value !== null,
    )

    expect(stored?.source).toBe('lrclib.net')
  })

  it('answers null for something it never stored', async () => {
    expect(await readLyrics('song-1')).toBeNull()
  })

  it('keeps entries apart per account', async () => {
    // The keys stores/lyrics.ts builds carry the account, because song ids
    // are only unique within one media server — two people sharing a
    // browser must not read each other's lyrics for the same id.
    writeLyrics('alice::song-1', { source: 'lrclib.net' })
    writeLyrics('bob::song-1', { source: 'NetEase' })

    await eventually(
      () => readLyrics<{ source: string }>('bob::song-1'),
      (value) => value !== null,
    )
    expect((await readLyrics<{ source: string }>('alice::song-1'))?.source).toBe('lrclib.net')
    expect((await readLyrics<{ source: string }>('bob::song-1'))?.source).toBe('NetEase')
  })

  it('gives up its oldest entries once the budget is used up', async () => {
    // Against a small budget rather than the real 32 MB, which a test would
    // otherwise have to actually write to disk.
    const entry = (i: number) => ({ i, lines: [{ time: 0, text: 'x'.repeat(200) }] })
    const size = JSON.stringify(entry(0)).length

    writeManyLyrics(Array.from({ length: 8 }, (_, i) => [`old-${i}`, entry(i)]))
    await eventually(_countForTest, (count) => count === 8)
    // A gap, so "written later" is actually later on the clock the store
    // sorts by rather than the same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Single-digit `i`, so every entry serializes to exactly `size` and the
    // budget below is a clean "room for two".
    writeLyrics('new-1', entry(1))
    writeLyrics('new-2', entry(2))
    await eventually(_countForTest, (count) => count === 10)

    await _trimNow(2 * size)

    expect(await _countForTest()).toBe(2)
    expect(await readLyrics('new-2')).not.toBeNull()
    expect(await readLyrics('new-1')).not.toBeNull()
    expect(await readLyrics('old-7')).toBeNull()
  })

  it('throws everything away when asked to', async () => {
    writeLyrics('song-1', { source: 'lrclib.net' })
    await eventually(_countForTest, (count) => count === 1)

    clearLyricsStore()

    await eventually(_countForTest, (count) => count === 0)
    expect(await readLyrics('song-1')).toBeNull()
  })

  it('does not let a read that crossed a wipe answer from what was thrown away', async () => {
    writeLyrics('song-1', { source: 'lrclib.net' })
    await eventually(_countForTest, (count) => count === 1)

    const reading = readLyrics('song-1')
    clearLyricsStore()

    expect(await reading).toBeNull()
  })
})
