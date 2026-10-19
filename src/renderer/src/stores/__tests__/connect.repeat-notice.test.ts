import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectStore } from '../connect'
import { emitter } from '@/emitter'
import type Toast from '@/types/toast'
import type { ConnectStatus, ConnectStatusTarget } from '@/services/connect/types'

vi.mock('@/services/connect/volume', () => ({
  getDeviceVolume: vi.fn(),
  setDeviceVolume: vi.fn(),
  turnDeviceRepeatOff: vi.fn(() => Promise.resolve()),
}))

import { turnDeviceRepeatOff } from '@/services/connect/volume'

/** A Sonos with repeat on in its own app starts every song over at its end
 * (#56); Beacon points that out once and offers to switch it off. */
describe('noticeDeviceRepeat', () => {
  let toasts: Toast[]
  const onToast = (toast: Toast | unknown) => toasts.push(toast as Toast)

  beforeEach(() => {
    setActivePinia(createPinia())
    toasts = []
    emitter.on('toast', onToast)
  })

  afterEach(() => {
    emitter.off('toast', onToast)
    // The noticed set is module state: report the device as not repeating
    // so the next test starts from nothing noticed.
    useConnectStore().noticeDeviceRepeat(status({ device_repeat: false }))
    vi.mocked(turnDeviceRepeatOff).mockClear()
  })

  function status(target: Partial<ConnectStatusTarget>): ConnectStatus {
    return { targets: [{ name: 'Küche', type: 'sonos', ...target }] } as unknown as ConnectStatus
  }

  it('points a repeating Sonos out once, not on every status', () => {
    const connect = useConnectStore()

    connect.noticeDeviceRepeat(status({ device_repeat: true }))
    connect.noticeDeviceRepeat(status({ device_repeat: true }))

    expect(toasts).toHaveLength(1)
  })

  it('points it out again once repeat was off in between', () => {
    const connect = useConnectStore()

    connect.noticeDeviceRepeat(status({ device_repeat: true }))
    connect.noticeDeviceRepeat(status({ device_repeat: false }))
    connect.noticeDeviceRepeat(status({ device_repeat: true }))

    expect(toasts).toHaveLength(2)
  })

  it('stays quiet while repeat is unknown', () => {
    useConnectStore().noticeDeviceRepeat(status({}))

    expect(toasts).toHaveLength(0)
  })

  it("switches the speaker's repeat off from the toast", () => {
    useConnectStore().noticeDeviceRepeat(status({ device_repeat: true }))

    toasts[0]?.action?.onClick()

    expect(turnDeviceRepeatOff).toHaveBeenCalledWith('Küche')
  })
})
