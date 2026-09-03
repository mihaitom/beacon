import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnect } from '../http'
import { radioFaviconRequest } from '../radio'
import {
  _resetRadioFaviconBatch,
  fetchRadioFaviconBatched,
  NoRadioFaviconError,
} from '../radioFaviconBatch'

vi.mock('../http', () => ({ fetchConnect: vi.fn() }))

const PNG = 'data:image/png;base64,aGVsbG8='

function answer(entries: Record<string, { transparent?: boolean } | null>, pending: string[] = []) {
  return {
    results: Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [
        key,
        value === null ? null : { data_url: PNG, transparent: value.transparent ?? false },
      ]),
    ),
    pending,
  }
}

/** The keys the last call actually asked for, in order. */
function askedKeys(call = 0): string[] {
  const body = vi.mocked(fetchConnect).mock.calls[call]![1]!.body as {
    stations: { key: string }[]
  }
  return body.stations.map((station) => station.key)
}

describe('fetchRadioFaviconBatched', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    _resetRadioFaviconBatch()
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetRadioFaviconBatch()
  })

  it('collapses a screenful of stations into one request', async () => {
    // The whole point of this module: a radio list renders one logo per
    // station, and fifty separate one-off URLs from one IP is the traffic
    // shape a probe detector counts.
    vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
      const stations = (options!.body as { stations: { key: string }[] }).stations
      return answer(Object.fromEntries(stations.map((s) => [s.key, {}])))
    })

    const pending = ['a', 'b', 'c'].map((host) =>
      fetchRadioFaviconBatched(
        radioFaviconRequest(`https://${host}.example`, 32),
        new AbortController().signal,
      ),
    )
    await vi.advanceTimersByTimeAsync(50)
    await Promise.all(pending)

    expect(fetchConnect).toHaveBeenCalledOnce()
    expect(askedKeys()).toHaveLength(3)
  })

  it('asks once for a station two places on screen both want', async () => {
    vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
      const stations = (options!.body as { stations: { key: string }[] }).stations
      return answer(Object.fromEntries(stations.map((s) => [s.key, {}])))
    })

    const request = radioFaviconRequest('https://station.example', 96)
    const first = fetchRadioFaviconBatched(request, new AbortController().signal)
    const second = fetchRadioFaviconBatched(request, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(50)

    expect(askedKeys()).toHaveLength(1)
    expect((await first).blob).toBeInstanceOf(Blob)
    expect((await second).blob).toBeInstanceOf(Blob)
  })

  it('carries the transparency reading alongside the image', async () => {
    // Not a second request against the same URL just to read a header —
    // that was one extra round trip per station.
    vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
      const key = (options!.body as { stations: { key: string }[] }).stations[0]!.key
      return answer({ [key]: { transparent: true } })
    })

    const promise = fetchRadioFaviconBatched(
      radioFaviconRequest('https://station.example', 512),
      new AbortController().signal,
    )
    await vi.advanceTimersByTimeAsync(50)

    expect((await promise).transparent).toBe(true)
  })

  it('rejects with a settled answer for a station that simply has no logo', async () => {
    vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
      const key = (options!.body as { stations: { key: string }[] }).stations[0]!.key
      return answer({ [key]: null })
    })

    // Caught up front, not after the timers run: an unhandled rejection in
    // between is a warning this test would otherwise print for nothing.
    const caught = fetchRadioFaviconBatched(
      radioFaviconRequest('https://station.example', 32),
      new AbortController().signal,
    ).catch((error) => error)
    await vi.advanceTimersByTimeAsync(50)

    expect(await caught).toBeInstanceOf(NoRadioFaviconError)
  })

  it('remembers that a station has no logo, rather than asking again', async () => {
    vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
      const key = (options!.body as { stations: { key: string }[] }).stations[0]!.key
      return answer({ [key]: null })
    })
    const request = radioFaviconRequest('https://station.example', 32)

    const first = fetchRadioFaviconBatched(request, new AbortController().signal).catch(
      (error) => error,
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(await first).toBeInstanceOf(NoRadioFaviconError)

    const second = fetchRadioFaviconBatched(request, new AbortController().signal).catch(
      (error) => error,
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(await second).toBeInstanceOf(NoRadioFaviconError)
    expect(fetchConnect).toHaveBeenCalledOnce()
  })

  it('answers a repeat of a resolved station without a request at all', async () => {
    vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
      const key = (options!.body as { stations: { key: string }[] }).stations[0]!.key
      return answer({ [key]: {} })
    })
    const request = radioFaviconRequest('https://station.example', 96)

    const first = fetchRadioFaviconBatched(request, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(50)
    await first

    const second = await fetchRadioFaviconBatched(request, new AbortController().signal)
    expect(second.blob).toBeInstanceOf(Blob)
    expect(fetchConnect).toHaveBeenCalledOnce()
  })

  describe('a station the backend has not finished looking up', () => {
    it('asks again, and the answer arrives on the second try', async () => {
      let call = 0
      vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
        const key = (options!.body as { stations: { key: string }[] }).stations[0]!.key
        call += 1
        return call === 1 ? answer({}, [key]) : answer({ [key]: {} })
      })

      const promise = fetchRadioFaviconBatched(
        radioFaviconRequest('https://slow.example', 32),
        new AbortController().signal,
      )
      await vi.advanceTimersByTimeAsync(50)
      expect(fetchConnect).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(1000)
      expect((await promise).blob).toBeInstanceOf(Blob)
      expect(fetchConnect).toHaveBeenCalledTimes(2)
    })

    it('gives up transiently rather than asking forever', async () => {
      vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
        const key = (options!.body as { stations: { key: string }[] }).stations[0]!.key
        return answer({}, [key])
      })

      const promise = fetchRadioFaviconBatched(
        radioFaviconRequest('https://slow.example', 32),
        new AbortController().signal,
      )
      const caught = promise.catch((error) => error)
      await vi.advanceTimersByTimeAsync(30_000)

      const error = await caught
      // Not a NoRadioFaviconError — the station may well have a logo, this
      // just never got one, so CoverArt.vue's own retry budget applies.
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(NoRadioFaviconError)
    })

    it('stops asking once nobody is waiting for it any more', async () => {
      vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
        const key = (options!.body as { stations: { key: string }[] }).stations[0]!.key
        return answer({}, [key])
      })

      const controller = new AbortController()
      const promise = fetchRadioFaviconBatched(
        radioFaviconRequest('https://slow.example', 32),
        controller.signal,
      )
      const caught = promise.catch((error) => error)
      await vi.advanceTimersByTimeAsync(50)

      controller.abort()
      await caught
      await vi.advanceTimersByTimeAsync(30_000)

      expect(fetchConnect).toHaveBeenCalledOnce()
    })
  })

  describe('a row that scrolls away', () => {
    it('is never asked for at all when it goes before the batch is sent', async () => {
      vi.mocked(fetchConnect).mockResolvedValue(answer({}))
      const controller = new AbortController()
      const promise = fetchRadioFaviconBatched(
        radioFaviconRequest('https://station.example', 32),
        controller.signal,
      )
      const caught = promise.catch((error) => error)

      controller.abort()
      await vi.advanceTimersByTimeAsync(50)

      expect((await caught).name).toBe('AbortError')
      expect(fetchConnect).not.toHaveBeenCalled()
    })

    it('leaves the rest of its batch alone', async () => {
      vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
        const stations = (options!.body as { stations: { key: string }[] }).stations
        return answer(Object.fromEntries(stations.map((s) => [s.key, {}])))
      })

      const gone = new AbortController()
      const dropped = fetchRadioFaviconBatched(
        radioFaviconRequest('https://gone.example', 32),
        gone.signal,
      ).catch((error) => error)
      const kept = fetchRadioFaviconBatched(
        radioFaviconRequest('https://kept.example', 32),
        new AbortController().signal,
      )

      gone.abort()
      await vi.advanceTimersByTimeAsync(50)

      expect((await dropped).name).toBe('AbortError')
      expect((await kept).blob).toBeInstanceOf(Blob)
      expect(askedKeys()).toHaveLength(1)
    })

    it('rejects immediately, with no network cost, when it was already gone', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(
        fetchRadioFaviconBatched(
          radioFaviconRequest('https://station.example', 32),
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(fetchConnect).not.toHaveBeenCalled()
    })
  })

  it('fails every station in a batch the backend could not answer at all', async () => {
    vi.mocked(fetchConnect).mockRejectedValue(new Error('unreachable'))

    const promises = ['a', 'b'].map((host) =>
      fetchRadioFaviconBatched(
        radioFaviconRequest(`https://${host}.example`, 32),
        new AbortController().signal,
      ).catch((error) => error),
    )
    await vi.advanceTimersByTimeAsync(50)

    for (const settled of await Promise.all(promises)) {
      expect(settled).toBeInstanceOf(Error)
      expect(settled).not.toBeInstanceOf(NoRadioFaviconError)
    }
  })

  it('never leaves a caller waiting on a station the answer forgot', async () => {
    // A malformed reply is not this station's fault, so it fails as
    // something that might work later rather than hanging forever.
    vi.mocked(fetchConnect).mockResolvedValue(answer({}))

    const promise = fetchRadioFaviconBatched(
      radioFaviconRequest('https://station.example', 32),
      new AbortController().signal,
    ).catch((error) => error)
    await vi.advanceTimersByTimeAsync(50)

    expect(await promise).toBeInstanceOf(Error)
  })

  it('splits a list longer than the server accepts rather than losing its tail', async () => {
    vi.mocked(fetchConnect).mockImplementation(async (_path, options) => {
      const stations = (options!.body as { stations: { key: string }[] }).stations
      return answer(Object.fromEntries(stations.map((s) => [s.key, {}])))
    })

    const promises = Array.from({ length: 250 }, (_, i) =>
      fetchRadioFaviconBatched(
        radioFaviconRequest(`https://s${i}.example`, 32),
        new AbortController().signal,
      ),
    )
    await vi.advanceTimersByTimeAsync(50)
    await Promise.all(promises)

    expect(fetchConnect).toHaveBeenCalledTimes(2)
    expect(askedKeys(0)).toHaveLength(200)
    expect(askedKeys(1)).toHaveLength(50)
  })
})
