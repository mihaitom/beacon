// Whether the player offers a lights button, and that the store carries
// what connect answered.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { forgetBridge, getLights, type LightsState } from '@/services/connect/lights'
import { useLightsStore } from '../lights'

vi.mock('@/services/connect/lights', () => ({
  getLights: vi.fn(),
  pairBridge: vi.fn(),
  updateLights: vi.fn(),
  forgetBridge: vi.fn(),
}))

const BASE: LightsState = {
  paired: false,
  found: [],
  bridge: null,
  reachable: null,
  areas: null,
  area_id: null,
  enabled: false,
  lead_ms: 80,
  style: 'pulse',
  colour_mode: 'palette',
  fixed_colour: '#3b6bff',
  theme_colour: '#f5a94e',
  brightness: 100,
  picture: null,
  playing: false,
  start_error: null,
}

describe('lights store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('offers nothing without a bridge', async () => {
    vi.mocked(getLights).mockResolvedValue(BASE)
    const store = useLightsStore()
    await store.load()
    expect(store.available).toBe(false)
  })

  it('offers the button once a bridge is on the network', async () => {
    vi.mocked(getLights).mockResolvedValue({ ...BASE, found: [{ host: 'h', id: 'i' }] })
    const store = useLightsStore()
    await store.load()
    expect(store.available).toBe(true)
    expect(store.active).toBe(false)
  })

  it('is active only when paired, on and with an area', async () => {
    const store = useLightsStore()
    vi.mocked(getLights).mockResolvedValue({ ...BASE, paired: true, enabled: true })
    await store.load()
    expect(store.available).toBe(true)
    expect(store.active).toBe(false)
    vi.mocked(getLights).mockResolvedValue({ ...BASE, paired: true, enabled: true, area_id: 'a' })
    await store.load()
    expect(store.active).toBe(true)
  })

  it('a failed load keeps what it had and says so', async () => {
    const store = useLightsStore()
    vi.mocked(getLights).mockResolvedValue({ ...BASE, paired: true })
    await store.load()
    vi.mocked(getLights).mockRejectedValue(new Error('down'))
    await store.load()
    expect(store.loadFailed).toBe(true)
    expect(store.lights?.paired).toBe(true)
    vi.mocked(getLights).mockResolvedValue(BASE)
    await store.load()
    expect(store.loadFailed).toBe(false)
  })

  it('forgetting reloads', async () => {
    const store = useLightsStore()
    vi.mocked(forgetBridge).mockResolvedValue()
    vi.mocked(getLights).mockResolvedValue(BASE)
    await store.forget()
    expect(getLights).toHaveBeenCalled()
    expect(store.lights?.paired).toBe(false)
  })
})
