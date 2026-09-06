// A library scan belongs to the store rather than to the settings page
// that starts it, and these pin the reason: a scan outlives that page. A
// large Plex library takes minutes, nobody waits on the settings screen
// for it, and everything that used to be wired to that page — the poll
// timer, the "finished" cache invalidation, the toast — went with it the
// moment somebody navigated away.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { emitter } from '@/emitter'
import { useLibraryStore } from '../library'
import type { SubsonicClient } from '@/services/subsonic/client'

vi.mock('@/services/library/libraryCacheStore', () => ({
  LEGACY_CACHE_KEY: 'beacon.library-cache',
  readLibraryField: vi.fn(async () => null),
  writeLibraryField: vi.fn(),
  clearLibraryFields: vi.fn(),
}))

/** Whatever the server would say, in the order it would say it. */
function stubClient(
  statuses: { scanning: boolean; count: number | null; percent: number | null }[],
) {
  const getScanStatus = vi.fn()
  for (const status of statuses) getScanStatus.mockResolvedValueOnce(status)
  // Anything asked for beyond the script: the scan is over.
  getScanStatus.mockResolvedValue({ scanning: false, count: null, percent: null })
  const client = {
    startScan: vi.fn().mockResolvedValue({ scanning: true, count: null, percent: null }),
    getScanStatus,
  }
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue(client as unknown as SubsonicClient)
  return client
}

/** startScan() asks once straight away and only then arms the timer, so
 * the first answer has already landed before any interval has passed. */
async function firstAnswer() {
  await vi.advanceTimersByTimeAsync(0)
}

/** One poll interval, plus the request it makes. */
async function pollOnce() {
  await vi.advanceTimersByTimeAsync(2000)
}

describe('library scan', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    useLibraryStore().stopScanTracking()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps following the scan after the page that started it is gone', async () => {
    const client = stubClient([
      { scanning: true, count: 100, percent: null },
      { scanning: true, count: 900, percent: null },
    ])
    const library = useLibraryStore()

    await library.startScan()
    await firstAnswer()
    expect(library.scanCount).toBe(100)

    // Nothing here stands in for a component: the poll belongs to the
    // store, so there is nothing to unmount for it to survive.
    await pollOnce()

    expect(library.scanCount).toBe(900)
    expect(client.getScanStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('clears the cache and says so once the scan is done', async () => {
    stubClient([
      { scanning: true, count: 100, percent: null },
      { scanning: false, count: 4321, percent: null },
    ])
    const library = useLibraryStore()
    const invalidate = vi.spyOn(library, 'invalidateCache').mockResolvedValue()
    const toasts: { level: string }[] = []
    emitter.on('toast', (toast) => toasts.push(toast as { level: string }))

    await library.startScan()
    await firstAnswer()
    await pollOnce()
    emitter.all.clear()

    expect(library.scanning).toBe(false)
    // The whole point: a scan that finishes while the person is somewhere
    // else still makes its results show up.
    expect(invalidate).toHaveBeenCalled()
    expect(toasts).toEqual([expect.objectContaining({ level: 'success' })])
  })

  it('rides out a failed poll rather than dropping the scan', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const library = useLibraryStore()
    const client = stubClient([{ scanning: true, count: 100, percent: null }])
    client.getScanStatus.mockReset()
    client.getScanStatus
      .mockRejectedValueOnce(new Error('gateway timeout'))
      .mockResolvedValue({ scanning: true, count: 700, percent: null })

    await library.startScan()
    await firstAnswer()

    // Still following it - a scan running for minutes will meet a hiccup.
    expect(library.scanning).toBe(true)

    await pollOnce()

    expect(library.scanCount).toBe(700)
  })

  it('gives up after a run of failures, and says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const library = useLibraryStore()
    const client = stubClient([])
    client.getScanStatus.mockReset()
    client.getScanStatus.mockRejectedValue(new Error('unreachable'))
    const toasts: { level: string }[] = []
    emitter.on('toast', (toast) => toasts.push(toast as { level: string }))

    await library.startScan()
    await firstAnswer()
    await pollOnce()
    await pollOnce()
    emitter.all.clear()

    expect(library.scanning).toBe(false)
    expect(toasts).toEqual([expect.objectContaining({ level: 'error' })])
  })

  it('picks up a scan that was already running', async () => {
    // A restart, or somebody starting one on the server itself.
    stubClient([
      { scanning: true, count: 4200, percent: null },
      { scanning: false, count: 4300, percent: null },
    ])
    const library = useLibraryStore()

    await library.resumeScanIfRunning()

    expect(library.scanning).toBe(true)
    expect(library.scanCount).toBe(4200)
  })

  it('leaves the button alone when nothing is running', async () => {
    stubClient([{ scanning: false, count: null, percent: null }])
    const library = useLibraryStore()

    await library.resumeScanIfRunning()

    expect(library.scanning).toBe(false)
  })

  it('says nothing and starts nothing when the server cannot be asked', async () => {
    const library = useLibraryStore()
    const client = stubClient([])
    client.getScanStatus.mockReset()
    client.getScanStatus.mockRejectedValue(new Error('no permission'))

    await library.resumeScanIfRunning()

    expect(library.scanning).toBe(false)
  })

  it('stops following a scan when the account logs out', async () => {
    const client = stubClient([{ scanning: true, count: 100, percent: null }])
    const library = useLibraryStore()
    await library.startScan()
    await firstAnswer()

    library.resetForLogout()
    const asked = client.getScanStatus.mock.calls.length
    await pollOnce()
    await pollOnce()

    // A poll left running would be asking the next account's server about
    // the previous account's scan.
    expect(client.getScanStatus.mock.calls.length).toBe(asked)
    expect(library.scanning).toBe(false)
  })
})
