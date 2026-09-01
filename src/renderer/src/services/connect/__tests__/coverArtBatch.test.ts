import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnect } from '../http'
import { fetchCoverArtBatched } from '../coverArtBatch'

vi.mock('../http', () => ({ fetchConnect: vi.fn() }))

function dataUrlFor(text: string): string {
  return `data:image/jpeg;base64,${btoa(text)}`
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('fetchCoverArtBatched', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fetchConnect).mockReset()
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
    vi.advanceTimersByTime(20)
    await flush()

    expect(fetchConnect).toHaveBeenCalledTimes(1)
    expect(fetchConnect).toHaveBeenCalledWith('/cover-art/batch', {
      method: 'POST',
      body: { ids: ['a', 'b'], size: 160 },
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
    vi.advanceTimersByTime(20)
    await flush()

    expect(fetchConnect).toHaveBeenCalledTimes(2)
    const sizes = vi
      .mocked(fetchConnect)
      .mock.calls.map((call) => (call[1] as { body: { size: number } }).body.size)
    expect(sizes.sort()).toEqual([160, 640])
  })

  it('rejects with a plain error when the batch has no art for an id', async () => {
    vi.mocked(fetchConnect).mockResolvedValue({ results: { a: null } })

    const promise = fetchCoverArtBatched('a', 160, new AbortController().signal)
    vi.advanceTimersByTime(20)
    await flush()

    await expect(promise).rejects.toThrow()
    await expect(promise).rejects.not.toMatchObject({ name: 'AbortError' })
  })

  it('rejects every pending request in a batch that fails outright', async () => {
    vi.mocked(fetchConnect).mockRejectedValue(new Error('network down'))

    const a = fetchCoverArtBatched('a', 160, new AbortController().signal)
    const b = fetchCoverArtBatched('b', 160, new AbortController().signal)
    vi.advanceTimersByTime(20)
    await flush()

    await expect(a).rejects.toThrow('network down')
    await expect(b).rejects.toThrow('network down')
  })

  it('never sends an id whose request was aborted before the batch window closed', async () => {
    vi.mocked(fetchConnect).mockResolvedValue({ results: { keep: dataUrlFor('img') } })
    const controller = new AbortController()

    const aborted = fetchCoverArtBatched('drop', 160, controller.signal)
    fetchCoverArtBatched('keep', 160, new AbortController().signal)
    controller.abort()
    vi.advanceTimersByTime(20)
    await flush()

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchConnect).toHaveBeenCalledWith('/cover-art/batch', {
      method: 'POST',
      body: { ids: ['keep'], size: 160 },
    })
  })

  it('rejects immediately, with no batch call at all, for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(fetchCoverArtBatched('a', 160, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    vi.advanceTimersByTime(20)
    await flush()
    expect(fetchConnect).not.toHaveBeenCalled()
  })

  it('resolves both callers when the same cover is requested twice at once', async () => {
    vi.mocked(fetchConnect).mockResolvedValue({ results: { a: dataUrlFor('img') } })

    const first = fetchCoverArtBatched('a', 160, new AbortController().signal)
    const second = fetchCoverArtBatched('a', 160, new AbortController().signal)
    vi.advanceTimersByTime(20)
    await flush()

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
    vi.advanceTimersByTime(20)
    await flush()

    expect(fetchConnect).toHaveBeenCalledTimes(2)
  })
})
