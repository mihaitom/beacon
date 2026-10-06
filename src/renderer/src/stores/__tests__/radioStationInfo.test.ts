import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useRadioStationInfoStore } from '../radioStationInfo'
import { fetchRadioStationInfo } from '@/services/connect/radio'
import { rememberRadioBrowserStation } from '@/services/radioBrowserLinks'
import type { RadioStation } from '@/types/library'

vi.mock('@/services/connect/radio', () => ({ fetchRadioStationInfo: vi.fn() }))

const fetchInfo = vi.mocked(fetchRadioStationInfo)

function station(id: string, streamUrl = `http://s/${id}`): RadioStation {
  return { id, name: id, streamUrl, homePageUrl: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  fetchInfo.mockReset()
})

describe('radio station info', () => {
  it('asks once for the whole list, passing the directory id where one is known', async () => {
    rememberRadioBrowserStation('http://s/a', 'uuid-a')
    fetchInfo.mockResolvedValue({ 'http://s/a': { tags: ['jazz'], lastTitle: null } })
    const store = useRadioStationInfoStore()

    await store.load([station('a'), station('b'), station('b2', 'http://s/b')])

    expect(fetchInfo).toHaveBeenCalledTimes(1)
    expect(fetchInfo).toHaveBeenCalledWith([
      { url: 'http://s/a', uuid: 'uuid-a' },
      { url: 'http://s/b', uuid: null },
    ])
    expect(store.infoFor(station('a'))?.tags).toEqual(['jazz'])
    expect(store.infoFor(station('b'))).toBeNull()
    expect(store.settled).toBe(true)
  })

  it('keeps what it knows when a later load fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchInfo.mockResolvedValueOnce({ 'http://s/a': { country: 'Austria', lastTitle: null } })
    const store = useRadioStationInfoStore()
    await store.load([station('a')])

    fetchInfo.mockRejectedValueOnce(new Error('offline'))
    await store.load([station('a')])

    expect(store.infoFor(station('a'))?.country).toBe('Austria')
    expect(store.settled).toBe(true)
  })

  it('asks for nothing for an empty list', async () => {
    const store = useRadioStationInfoStore()

    await store.load([])

    expect(fetchInfo).not.toHaveBeenCalled()
    expect(store.settled).toBe(true)
  })

  it('drops an answer that arrives after the account changed', async () => {
    const pending = deferred<Record<string, { lastTitle: null; country: string }>>()
    fetchInfo.mockReturnValueOnce(pending.promise)
    const store = useRadioStationInfoStore()

    const load = store.load([station('a')])
    store.reset()
    pending.resolve({ 'http://s/a': { country: 'Austria', lastTitle: null } })
    await load

    expect(store.infoFor(station('a'))).toBeNull()
    expect(store.settled).toBe(false)
  })
})
