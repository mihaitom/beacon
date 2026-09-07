import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectStore } from '../connect'
import type { ConnectStatusTarget } from '@/services/connect/types'

/** Which cast targets could drive the radio visualizer. The device half of
 * that answer is the backend's now (connect/core/state.py's
 * supports_radio_position, reported per target in the status) — this store
 * used to keep a second copy of the same device-type list, hand-synced,
 * with nothing to catch the two drifting apart. */
describe('isRadioPositionCapable', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function target(overrides: Partial<ConnectStatusTarget> = {}): ConnectStatusTarget {
    return { name: 'Küche', type: 'sonos', ...overrides }
  }

  /** RADIO_VISUALIZER_ENABLED has been off since 2026-09-04 — see the flag's
   * own comment. Whoever flips it back is meant to land here. */
  it('answers false while the visualizer is switched off, capable device or not', () => {
    const connect = useConnectStore()

    expect(connect.isRadioPositionCapable(target({ supports_radio_position: true }))).toBe(false)
  })

  it('answers false for a device the backend says has no position to watch', () => {
    const connect = useConnectStore()

    expect(connect.isRadioPositionCapable(target({ supports_radio_position: false }))).toBe(false)
  })

  /** An older connect sends no such field at all. Nothing to read means
   * nothing to switch on. */
  it('answers false for a backend that does not report the capability', () => {
    const connect = useConnectStore()

    expect(connect.isRadioPositionCapable(target())).toBe(false)
  })
})
