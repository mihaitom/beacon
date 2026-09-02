import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectStore } from '../connect'
import { getDiscover } from '@/services/connect/discovery'
import type { DiscoverResponse } from '@/services/connect/types'

vi.mock('@/services/connect/discovery', () => ({ getDiscover: vi.fn() }))

const empty: DiscoverResponse = { sonos: [], airplay: [], chromecast: [], dlna: [] }

/** A discover call the test decides when to answer — isScanning is only
 * observable while the request is still in flight. */
function pendingDiscover() {
  let settle: () => void = () => {}
  const done = new Promise<DiscoverResponse>((resolve) => {
    settle = () => resolve(empty)
  })
  vi.mocked(getDiscover).mockReturnValue(done)
  return { settle, done }
}

describe('what counts as "scanning" in the device pickers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('reports the first refresh of the session as a scan', async () => {
    const connect = useConnectStore()
    const { settle } = pendingDiscover()

    // App.vue's own post-login refresh — no fresh flag, but with an empty
    // backend cache it still waits out the whole SSDP/mDNS sweep.
    const first = connect.refreshDevices()
    expect(connect.isScanning).toBe(true)

    settle()
    await first
    expect(connect.isScanning).toBe(false)
  })

  it('stays quiet for the background poll once a list has arrived', async () => {
    const connect = useConnectStore()
    vi.mocked(getDiscover).mockResolvedValue(empty)
    await connect.refreshDevices()

    const { settle } = pendingDiscover()
    const poll = connect.refreshDevices()
    expect(connect.isScanning).toBe(false)

    settle()
    await poll
  })

  it('keeps treating the next attempt as the first one while they keep failing', async () => {
    const connect = useConnectStore()
    vi.mocked(getDiscover).mockRejectedValue(new Error('offline'))
    await connect.refreshDevices()

    const { settle } = pendingDiscover()
    const retry = connect.refreshDevices()
    expect(connect.isScanning).toBe(true)

    settle()
    await retry
  })

  it('reports an explicit rescan as a scan even long after the first one', async () => {
    const connect = useConnectStore()
    vi.mocked(getDiscover).mockResolvedValue(empty)
    await connect.refreshDevices()

    const { settle } = pendingDiscover()
    const rescan = connect.refreshDevices(true)
    expect(connect.isScanning).toBe(true)

    settle()
    await rescan
    expect(connect.isScanning).toBe(false)
  })
})
