import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _countForTest,
  _maintainNow,
  _resetArtworkStore,
  _seedForTest,
  clearArtwork,
  readArtwork,
  writeArtwork,
} from '../artworkStore'

// Real Chromium rather than jsdom, for the same kind of reason the layout
// suite is here: jsdom has no IndexedDB at all, and a stand-in for one
// would only test the stand-in. What this file is about — that a stored
// image comes back, that an old one doesn't, that the store stays bounded —
// is exactly the part a fake would have to invent.

const TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Waits for a fire-and-forget write to have landed. writeArtwork()
 * deliberately returns nothing (see its own comment), so a test has to wait
 * for the result rather than for the call. */
async function eventually<T>(read: () => Promise<T>, want: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read()
    if (want(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the store never reached the expected state')
}

describe('artworkStore', () => {
  beforeEach(async () => {
    await _resetArtworkStore()
  })

  afterEach(async () => {
    await _resetArtworkStore()
  })

  it('reads back an image it stored', async () => {
    writeArtwork('cover:160:a', new Blob(['img-a']))

    const stored = await eventually(() => readArtwork('cover:160:a'), Boolean)

    expect(await stored!.text()).toBe('img-a')
  })

  it('answers null for something it never stored', async () => {
    expect(await readArtwork('cover:160:missing')).toBeNull()
  })

  it('refuses to answer with an image past its lifetime, and drops it', async () => {
    // A cover re-tagged on the music server has to be able to catch up
    // without anyone clearing anything.
    await _seedForTest([
      { key: 'cover:160:old', blob: new Blob(['stale']), savedAt: Date.now() - TTL_MS - 1000 },
      { key: 'cover:160:new', blob: new Blob(['fresh']), savedAt: Date.now() },
    ])

    expect(await readArtwork('cover:160:old')).toBeNull()
    expect(await readArtwork('cover:160:new')).not.toBeNull()
    await eventually(_countForTest, (count) => count === 1)
  })

  it('sweeps out everything that has expired when it maintains itself', async () => {
    await _seedForTest([
      { key: 'a', blob: new Blob(['a']), savedAt: Date.now() - TTL_MS - 1 },
      { key: 'b', blob: new Blob(['b']), savedAt: Date.now() - TTL_MS - 1 },
      { key: 'c', blob: new Blob(['c']), savedAt: Date.now() },
    ])

    await _maintainNow()

    expect(await _countForTest()).toBe(3 - 2)
    expect(await readArtwork('c')).not.toBeNull()
  })

  it('gives up its oldest entries once the budget is used up', async () => {
    // Against a small budget rather than the real 250 MB, which a test
    // would otherwise have to actually write to disk. Ten equal-sized
    // images, room for four.
    const now = Date.now()
    const image = new Blob([new Uint8Array(1000)])
    await _seedForTest(
      Array.from({ length: 10 }, (_, i) => ({
        key: `cover:160:${i}`,
        blob: image.slice(),
        savedAt: now - 10 + i,
      })),
    )

    await _maintainNow(4 * image.size)

    expect(await _countForTest()).toBe(4)
    // The oldest went, the newest stayed.
    expect(await readArtwork('cover:160:0')).toBeNull()
    expect(await readArtwork('cover:160:5')).toBeNull()
    expect(await readArtwork('cover:160:6')).not.toBeNull()
    expect(await readArtwork('cover:160:9')).not.toBeNull()
  })

  it('counts what it stores, not what it was asked to store', async () => {
    // The budget is enforced off the byte count kept beside each image, so
    // that has to be the image's real size rather than anything a caller
    // said about it.
    writeArtwork('cover:160:a', new Blob([new Uint8Array(500)]))
    await eventually(() => readArtwork('cover:160:a'), Boolean)

    await _maintainNow(499)
    expect(await _countForTest()).toBe(0)
  })

  it('uses an oversized image without storing it', async () => {
    // One big artist photo is not worth a noticeable share of the budget;
    // the memory cache still covers it for this session.
    writeArtwork('image:https://cdn.test/huge.jpg', new Blob([new Uint8Array(3 * 1024 * 1024)]))
    writeArtwork('cover:160:small', new Blob(['img']))

    await eventually(() => readArtwork('cover:160:small'), Boolean)
    expect(await readArtwork('image:https://cdn.test/huge.jpg')).toBeNull()
  })

  it('throws everything away when the account changes', async () => {
    await _seedForTest([{ key: 'cover:160:a', blob: new Blob(['img']), savedAt: Date.now() }])

    clearArtwork()

    await eventually(_countForTest, (count) => count === 0)
  })

  it('does not let a read that crossed an account change answer from the old library', async () => {
    await _seedForTest([{ key: 'cover:160:a', blob: new Blob(['img']), savedAt: Date.now() }])

    const reading = readArtwork('cover:160:a')
    clearArtwork()

    expect(await reading).toBeNull()
  })
})
