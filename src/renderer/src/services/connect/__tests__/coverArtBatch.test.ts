import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnect } from '../http'
import { clearArtwork, readArtwork, writeArtwork } from '../artworkStore'
import {
  _resetCoverArtBatch,
  clearCoverArtCache,
  fetchArtistImageBatched,
  fetchCoverArtBatched,
} from '../coverArtBatch'

vi.mock('../http', () => ({ fetchConnect: vi.fn() }))

// The on-disk half of the cache has no store to talk to under jsdom (no
// IndexedDB) and is exercised against a real one in
// artworkStore.browser.test.ts. Mocked here so these tests can say what it
// answered, and assert what it was told to keep.
vi.mock('../artworkStore', () => ({
  readArtwork: vi.fn(),
  writeArtwork: vi.fn(),
  clearArtwork: vi.fn(),
}))

function dataUrlFor(text: string): string {
  return `data:image/jpeg;base64,${btoa(text)}`
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Lets a pending request reach the network and come back: the look on
 * disk it does first (a promise, even when there is no store to look in),
 * then the batch window, then the call itself.
 *
 * The first flush() is what the persistent cache added — a request only
 * joins a batch once it knows the image isn't already stored, so advancing
 * the timer before that would close a window nothing had joined yet. */
async function runBatch(): Promise<void> {
  await flush()
  vi.advanceTimersByTime(20)
  await flush()
}

/** Drives one request all the way to its answer. What a test needs before
 * asking whether a *second* request for the same thing costs anything. */
async function settled(promise: Promise<Blob>): Promise<Blob> {
  await runBatch()
  return promise
}

describe('fetchCoverArtBatched', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fetchConnect).mockReset()
    vi.mocked(readArtwork).mockReset().mockResolvedValue(null)
    vi.mocked(writeArtwork).mockReset()
    vi.mocked(clearArtwork).mockReset()
    // The cache outlives any one test, so without this a test asking for
    // an id an earlier one already fetched is answered from memory and
    // never makes the call it is about to assert on.
    _resetCoverArtBatch()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('groups covers requested within the batch window into one call', async () => {
    vi.mocked(fetchConnect).mockResolvedValue({
      results: { a: dataUrlFor('img-a'), b: dataUrlFor('img-b') },
    })

    const a = fetchCoverArtBatched('a', 160, new AbortController().signal)
    const b = fetchCoverArtBatched('b', 160, new AbortController().signal)
    await runBatch()

    expect(fetchConnect).toHaveBeenCalledTimes(1)
    expect(fetchConnect).toHaveBeenCalledWith('/cover-art/batch', {
      method: 'POST',
      body: { ids: ['a', 'b'], image_urls: [], size: 160 },
    })
    const blobA = await a
    const blobB = await b
    expect(await blobA.text()).toBe('img-a')
    expect(await blobB.text()).toBe('img-b')
  })

  it('sends a separate batch per requested size', async () => {
    vi.mocked(fetchConnect).mockResolvedValue({ results: { a: dataUrlFor('img') } })

    fetchCoverArtBatched('a', 160, new AbortController().signal)
    fetchCoverArtBatched('a', 640, new AbortController().signal)
    await runBatch()

    expect(fetchConnect).toHaveBeenCalledTimes(2)
    const sizes = vi
      .mocked(fetchConnect)
      .mock.calls.map((call) => (call[1] as { body: { size: number } }).body.size)
    expect(sizes.sort()).toEqual([160, 640])
  })

  it('rejects with a settled answer when the batch has no art for an id', async () => {
    vi.mocked(fetchConnect).mockResolvedValue({ results: { a: null } })

    const promise = fetchCoverArtBatched('a', 160, new AbortController().signal)
    await runBatch()

    await expect(promise).rejects.toThrow()
    await expect(promise).rejects.not.toMatchObject({ name: 'AbortError' })
  })

  it('rejects every pending request in a batch that fails outright', async () => {
    vi.mocked(fetchConnect).mockRejectedValue(new Error('network down'))

    const a = fetchCoverArtBatched('a', 160, new AbortController().signal)
    const b = fetchCoverArtBatched('b', 160, new AbortController().signal)
    await runBatch()

    await expect(a).rejects.toThrow('network down')
    await expect(b).rejects.toThrow('network down')
  })

  it('never sends an id whose request was aborted before the batch window closed', async () => {
    vi.mocked(fetchConnect).mockResolvedValue({ results: { keep: dataUrlFor('img') } })
    const controller = new AbortController()

    const aborted = fetchCoverArtBatched('drop', 160, controller.signal)
    fetchCoverArtBatched('keep', 160, new AbortController().signal)
    controller.abort()
    await runBatch()

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchConnect).toHaveBeenCalledWith('/cover-art/batch', {
      method: 'POST',
      body: { ids: ['keep'], image_urls: [], size: 160 },
    })
  })

  it('rejects immediately, with no batch call at all, for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(fetchCoverArtBatched('a', 160, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    await runBatch()
    expect(fetchConnect).not.toHaveBeenCalled()
  })

  it('resolves both callers when the same cover is requested twice at once', async () => {
    vi.mocked(fetchConnect).mockResolvedValue({ results: { a: dataUrlFor('img') } })

    const first = fetchCoverArtBatched('a', 160, new AbortController().signal)
    const second = fetchCoverArtBatched('a', 160, new AbortController().signal)
    await runBatch()

    expect(fetchConnect).toHaveBeenCalledTimes(1)
    expect(await (await first).text()).toBe('img')
    expect(await (await second).text()).toBe('img')
  })

  it('splits a batch larger than the server-side cap into multiple calls', async () => {
    vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
      const body = (options as { body: { ids: string[] } }).body
      return {
        results: Object.fromEntries(body.ids.map((id) => [id, dataUrlFor(id)])),
      }
    })

    for (let i = 0; i < 205; i++) {
      fetchCoverArtBatched(`id-${i}`, 160, new AbortController().signal)
    }
    await runBatch()

    expect(fetchConnect).toHaveBeenCalledTimes(2)
  })

  describe('remembering what has already been fetched', () => {
    // Why this cache exists at all: the endpoint behind this file is a
    // POST, which nothing on the way is allowed to cache the way it cached
    // the plain image GET it replaced. Without this, every re-visit of a
    // view re-fetched every cover on it - which is exactly what it looked
    // like in the browser.
    it('answers a cover it already has without a request at all', async () => {
      vi.mocked(fetchConnect).mockResolvedValue({ results: { a: dataUrlFor('img') } })

      await settled(fetchCoverArtBatched('a', 160, new AbortController().signal))
      const again = fetchCoverArtBatched('a', 160, new AbortController().signal)
      await runBatch()

      expect(await (await again).text()).toBe('img')
      expect(fetchConnect).toHaveBeenCalledTimes(1)
    })

    it('remembers that an id has no art, rather than asking again', async () => {
      vi.mocked(fetchConnect).mockResolvedValue({ results: { a: null } })

      await expect(
        settled(fetchCoverArtBatched('a', 160, new AbortController().signal)),
      ).rejects.toMatchObject({ name: 'NoCoverArtError' })
      await expect(
        settled(fetchCoverArtBatched('a', 160, new AbortController().signal)),
      ).rejects.toMatchObject({ name: 'NoCoverArtError' })

      expect(fetchConnect).toHaveBeenCalledTimes(1)
    })

    it("does not answer one size out of another size's image", async () => {
      vi.mocked(fetchConnect).mockResolvedValue({ results: { a: dataUrlFor('img') } })

      await settled(fetchCoverArtBatched('a', 160, new AbortController().signal))
      await settled(fetchCoverArtBatched('a', 640, new AbortController().signal))

      expect(fetchConnect).toHaveBeenCalledTimes(2)
    })

    it('keeps nothing across an account change', async () => {
      // Cover ids are only unique within one media server (see
      // services/accountScopedStores.ts, which calls this).
      vi.mocked(fetchConnect).mockResolvedValue({ results: { a: dataUrlFor('img') } })

      await settled(fetchCoverArtBatched('a', 160, new AbortController().signal))
      clearCoverArtCache()
      await settled(fetchCoverArtBatched('a', 160, new AbortController().signal))

      expect(fetchConnect).toHaveBeenCalledTimes(2)
    })

    it('remembers a batch that failed outright as nothing at all', async () => {
      // A backend that could not be reached says nothing about whether the
      // artwork exists — remembering that as "there is none" would blank
      // every cover in the batch for the rest of the session.
      vi.mocked(fetchConnect).mockRejectedValueOnce(new Error('network down'))
      vi.mocked(fetchConnect).mockResolvedValue({ results: { a: dataUrlFor('img') } })

      await expect(
        settled(fetchCoverArtBatched('a', 160, new AbortController().signal)),
      ).rejects.toThrow('network down')
      const retry = fetchCoverArtBatched('a', 160, new AbortController().signal)
      await runBatch()

      expect(await (await retry).text()).toBe('img')
    })

    it('treats an id the backend left out of its answer as worth asking again', async () => {
      // The batch arrived, but the backend could not fetch this one just
      // now (its media server timed out or answered 5xx) and says nothing
      // about whether it exists — see _FetchUnavailable in
      // connect/routes/coverart.py. A `null` here would be remembered as
      // "there is no cover" and leave the tile blank for the session.
      vi.mocked(fetchConnect).mockResolvedValueOnce({ results: {} })
      vi.mocked(fetchConnect).mockResolvedValue({ results: { a: dataUrlFor('img') } })

      await expect(
        settled(fetchCoverArtBatched('a', 160, new AbortController().signal)),
      ).rejects.toMatchObject({ name: 'Error' })
      expect(writeArtwork).not.toHaveBeenCalled()

      const retry = fetchCoverArtBatched('a', 160, new AbortController().signal)
      await runBatch()

      expect(await (await retry).text()).toBe('img')
      expect(fetchConnect).toHaveBeenCalledTimes(2)
    })
  })

  describe('an account change mid-flight', () => {
    it('keeps the previous account artwork out of both caches', async () => {
      // Cover ids are only unique within one media server, so an answer
      // that was already on the wire when the account changed would
      // otherwise be written under keys the new session reads — on Plex
      // (small integer ratingKeys) that is one account being shown
      // another's covers.
      let answer!: (response: unknown) => void
      vi.mocked(fetchConnect).mockReturnValueOnce(
        new Promise<never>((resolve) => {
          answer = resolve as (response: unknown) => void
        }),
      )
      const pending = fetchCoverArtBatched('a', 160, new AbortController().signal)
      await runBatch()

      clearCoverArtCache()
      answer({ results: { a: dataUrlFor('other-account') } })
      await flush()

      await expect(pending).rejects.toThrow(/account changed/i)
      expect(writeArtwork).not.toHaveBeenCalled()

      vi.mocked(fetchConnect).mockResolvedValue({ results: { a: dataUrlFor('mine') } })
      const next = fetchCoverArtBatched('a', 160, new AbortController().signal)
      await runBatch()

      expect(await (await next).text()).toBe('mine')
    })

    it('never sends a batch that was still waiting for its window', async () => {
      const pending = fetchCoverArtBatched('a', 160, new AbortController().signal)
      await flush() // joined the batch; the window has not closed yet

      clearCoverArtCache()

      await expect(pending).rejects.toThrow(/account changed/i)
      vi.advanceTimersByTime(20)
      await flush()
      expect(fetchConnect).not.toHaveBeenCalled()
    })
  })

  describe('artist photos', () => {
    it('sends them along with the covers of the same moment', async () => {
      // A view showing artists has both kinds on screen at once, and one
      // request for the screenful is the whole point of this file.
      vi.mocked(fetchConnect).mockResolvedValue({
        results: { a: dataUrlFor('cover') },
        image_results: { 'https://cdn.test/artist.jpg': dataUrlFor('photo') },
      })

      const cover = fetchCoverArtBatched('a', 160, new AbortController().signal)
      const photo = fetchArtistImageBatched(
        'https://cdn.test/artist.jpg',
        new AbortController().signal,
      )
      await runBatch()

      expect(fetchConnect).toHaveBeenCalledTimes(1)
      expect(fetchConnect).toHaveBeenCalledWith('/cover-art/batch', {
        method: 'POST',
        body: { ids: ['a'], image_urls: ['https://cdn.test/artist.jpg'], size: 160 },
      })
      expect(await (await cover).text()).toBe('cover')
      expect(await (await photo).text()).toBe('photo')
    })

    it('sends a request of their own when no cover is being fetched', async () => {
      vi.mocked(fetchConnect).mockResolvedValue({
        results: {},
        image_results: { 'https://cdn.test/artist.jpg': dataUrlFor('photo') },
      })

      const photo = fetchArtistImageBatched(
        'https://cdn.test/artist.jpg',
        new AbortController().signal,
      )
      await runBatch()

      expect(fetchConnect).toHaveBeenCalledWith('/cover-art/batch', {
        method: 'POST',
        body: { ids: [], image_urls: ['https://cdn.test/artist.jpg'], size: 300 },
      })
      expect(await (await photo).text()).toBe('photo')
    })

    it('rejects with a settled answer for an artist who has no photo', async () => {
      // The common case by far - the caller falls through to the album
      // cover behind it, and must not keep retrying this.
      vi.mocked(fetchConnect).mockResolvedValue({
        results: {},
        image_results: { 'https://cdn.test/artist.jpg': null },
      })

      await expect(
        settled(
          fetchArtistImageBatched('https://cdn.test/artist.jpg', new AbortController().signal),
        ),
      ).rejects.toMatchObject({ name: 'NoArtistImageError' })
    })

    it('is remembered too, and asked for once', async () => {
      vi.mocked(fetchConnect).mockResolvedValue({
        results: {},
        image_results: { 'https://cdn.test/artist.jpg': dataUrlFor('photo') },
      })

      await settled(
        fetchArtistImageBatched('https://cdn.test/artist.jpg', new AbortController().signal),
      )
      await settled(
        fetchArtistImageBatched('https://cdn.test/artist.jpg', new AbortController().signal),
      )

      expect(fetchConnect).toHaveBeenCalledTimes(1)
    })

    it('is never sent when its request was aborted before the window closed', async () => {
      vi.mocked(fetchConnect).mockResolvedValue({
        results: { a: dataUrlFor('cover') },
        image_results: {},
      })
      const controller = new AbortController()

      const aborted = fetchArtistImageBatched('https://cdn.test/artist.jpg', controller.signal)
      fetchCoverArtBatched('a', 160, new AbortController().signal)
      controller.abort()
      await runBatch()

      await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
      expect(fetchConnect).toHaveBeenCalledWith('/cover-art/batch', {
        method: 'POST',
        body: { ids: ['a'], image_urls: [], size: 160 },
      })
    })
  })

  describe('what survives a reload', () => {
    // The memory cache above only lives as long as the page does, which in
    // the Docker/web build is exactly the thing that kept restarting. The
    // store behind these is exercised against a real IndexedDB in
    // artworkStore.browser.test.ts.
    it('shows a stored cover without asking the backend at all', async () => {
      vi.mocked(readArtwork).mockResolvedValue(new Blob(['stored']))

      const cover = fetchCoverArtBatched('a', 160, new AbortController().signal)
      await runBatch()

      expect(await (await cover).text()).toBe('stored')
      expect(readArtwork).toHaveBeenCalledWith('cover:160:a')
      expect(fetchConnect).not.toHaveBeenCalled()
    })

    it('keeps a fetched cover for next time, under the size it was fetched at', async () => {
      vi.mocked(fetchConnect).mockResolvedValue({ results: { a: dataUrlFor('img') } })

      await settled(fetchCoverArtBatched('a', 160, new AbortController().signal))

      const [key, blob] = vi.mocked(writeArtwork).mock.calls[0]!
      expect(key).toBe('cover:160:a')
      expect(await blob.text()).toBe('img')
    })

    it('keeps an artist photo the same way', async () => {
      vi.mocked(fetchConnect).mockResolvedValue({
        results: {},
        image_results: { 'https://cdn.test/artist.jpg': dataUrlFor('photo') },
      })

      await settled(
        fetchArtistImageBatched('https://cdn.test/artist.jpg', new AbortController().signal),
      )

      expect(vi.mocked(writeArtwork).mock.calls[0]![0]).toBe('image:https://cdn.test/artist.jpg')
    })

    it('stores nothing for artwork that does not exist', async () => {
      // A remembered "there is none" is worth keeping for the session, but
      // not past a reload: a library scan that fills the artwork in later
      // would stay invisible behind it.
      vi.mocked(fetchConnect).mockResolvedValue({ results: { a: null } })

      await expect(
        settled(fetchCoverArtBatched('a', 160, new AbortController().signal)),
      ).rejects.toMatchObject({ name: 'NoCoverArtError' })

      expect(writeArtwork).not.toHaveBeenCalled()
    })

    it('throws away what is stored when the account changes', async () => {
      clearCoverArtCache()

      expect(clearArtwork).toHaveBeenCalled()
    })

    it('never joins a batch for a request abandoned while the disk was read', async () => {
      // The row scrolled away during the lookup — this must not turn into a
      // request for a cover nobody is waiting for any more.
      let answer: (blob: Blob | null) => void = () => {}
      vi.mocked(readArtwork).mockReturnValue(
        new Promise((resolve) => {
          answer = resolve
        }),
      )
      const controller = new AbortController()

      const cover = fetchCoverArtBatched('a', 160, controller.signal)
      controller.abort()
      answer(null)
      await runBatch()

      await expect(cover).rejects.toMatchObject({ name: 'AbortError' })
      expect(fetchConnect).not.toHaveBeenCalled()
    })
  })
})
