import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetLibraryCacheStore,
  clearLibraryFields,
  readLibraryField,
  writeLibraryField,
} from '../libraryCacheStore'

// Real Chromium, for a real IndexedDB — jsdom has none, and what this file
// is about is precisely what the localStorage version could not do: hold a
// catalog far past the ~5 MB an origin gets, one field at a time.

interface Album {
  id: string
  name: string
}

function albums(count: number, prefix = 'al'): Album[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, name: `Album ${i}` }))
}

async function eventually<T>(read: () => Promise<T>, want: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read()
    if (want(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the store never reached the expected state')
}

describe('libraryCacheStore', () => {
  beforeEach(async () => {
    await _resetLibraryCacheStore()
  })

  afterEach(async () => {
    await _resetLibraryCacheStore()
  })

  it('reads back a field it stored', async () => {
    writeLibraryField('acc::albums', albums(3))

    const stored = await eventually(
      () => readLibraryField<Album>('acc::albums'),
      (value) => value !== null,
    )

    expect(stored?.items.map((album) => album.id)).toEqual(['al-0', 'al-1', 'al-2'])
  })

  it('answers null for a field it never stored', async () => {
    expect(await readLibraryField('acc::albums')).toBeNull()
  })

  it('holds a catalog far past what localStorage would take', async () => {
    // The whole reason for this store: 20,000 songs' worth of records is
    // several times the ~5 MB an origin gets in localStorage, where the
    // write simply failed and the library was re-fetched on every start.
    const big = Array.from({ length: 20000 }, (_, i) => ({
      id: `mf-${i}`,
      title: `A reasonably long track title number ${i}`,
      artist: `Artist ${i % 900}`,
      artistId: `ar-${i % 900}`,
      album: `Album ${i % 1500}`,
      albumId: `al-${i % 1500}`,
      coverArtId: `al-${i % 1500}_1712345678`,
      genre: 'Electronic',
      suffix: 'flac',
      duration: 231,
      track: i % 14,
      discNumber: 1,
      year: 2000 + (i % 25),
      playCount: 0,
      starred: false,
      rating: 0,
    }))
    // Comfortably past the budget the whole cache used to share.
    expect(JSON.stringify(big).length).toBeGreaterThan(5 * 1024 * 1024)

    writeLibraryField('acc::songs', big)

    const stored = await eventually(
      () => readLibraryField<{ id: string }>('acc::songs'),
      (value) => value !== null,
    )
    expect(stored?.items).toHaveLength(20000)
  })

  it('keeps each field on its own, so writing one leaves the others alone', async () => {
    // In the blob this replaces, saving the albums rewrote the entire song
    // catalog beside them.
    writeLibraryField('acc::albums', albums(2))
    writeLibraryField('acc::songs', albums(5, 'song'))
    await eventually(
      () => readLibraryField<Album>('acc::songs'),
      (value) => value !== null,
    )

    writeLibraryField('acc::albums', albums(4))

    await eventually(
      () => readLibraryField<Album>('acc::albums'),
      (value) => value?.items.length === 4,
    )
    expect((await readLibraryField<Album>('acc::songs'))?.items).toHaveLength(5)
  })

  it('keeps accounts apart', async () => {
    writeLibraryField('alice::albums', albums(1, 'alice'))
    writeLibraryField('bob::albums', albums(1, 'bob'))

    await eventually(
      () => readLibraryField<Album>('bob::albums'),
      (value) => value !== null,
    )
    expect((await readLibraryField<Album>('alice::albums'))?.items[0]!.id).toBe('alice-0')
  })

  it('remembers when a field was fetched, and takes what it is told', async () => {
    // Carrying an older cache over must not make it look freshly fetched,
    // or the refresh it was due never runs.
    const longAgo = Date.now() - 5 * 60 * 60 * 1000
    writeLibraryField('acc::albums', albums(1), longAgo)

    const stored = await eventually(
      () => readLibraryField<Album>('acc::albums'),
      (value) => value !== null,
    )
    expect(stored?.fetchedAt).toBe(longAgo)
  })

  it('forgets the fields it is told to forget', async () => {
    writeLibraryField('acc::albums', albums(1))
    writeLibraryField('acc::songs', albums(1, 'song'))
    await eventually(
      () => readLibraryField<Album>('acc::songs'),
      (value) => value !== null,
    )

    clearLibraryFields(['acc::albums', 'acc::songs'])

    await eventually(
      () => readLibraryField<Album>('acc::albums'),
      (value) => value === null,
    )
    expect(await readLibraryField('acc::songs')).toBeNull()
  })
})
