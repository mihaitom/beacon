import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAudioMuseStore } from '../audiomuse'
import { getAudioMuseStatus } from '@/services/connect/audiomuse'

vi.mock('@/services/connect/audiomuse', () => ({ getAudioMuseStatus: vi.fn() }))

const AVAILABLE = { available: true, version: '3.7.4', server: 'Navidrome' }

describe('the AudioMuse-AI status', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(getAudioMuseStatus).mockReset()
  })

  it('is asked once and kept for a while', async () => {
    vi.mocked(getAudioMuseStatus).mockResolvedValue(AVAILABLE)
    const store = useAudioMuseStore()

    expect(await store.ensure(1_000)).toBe(true)
    expect(await store.ensure(1_000 + 60_000)).toBe(true)
    expect(getAudioMuseStatus).toHaveBeenCalledTimes(1)

    await store.ensure(1_000 + 10 * 60_000)
    expect(getAudioMuseStatus).toHaveBeenCalledTimes(2)
  })

  it('asks again sooner after a no', async () => {
    vi.mocked(getAudioMuseStatus).mockResolvedValue({ available: false, reason: 'unreachable' })
    const store = useAudioMuseStore()

    await store.ensure(1_000)
    await store.ensure(1_000 + 60_000)

    expect(getAudioMuseStatus).toHaveBeenCalledTimes(2)
  })

  it('counts connect not answering as unavailable', async () => {
    vi.mocked(getAudioMuseStatus).mockRejectedValue(new Error('offline'))
    const store = useAudioMuseStore()

    expect(await store.ensure()).toBe(false)
    expect(store.status?.reason).toBe('unreachable')
  })

  it('asks only once for several callers at the same time', async () => {
    vi.mocked(getAudioMuseStatus).mockResolvedValue(AVAILABLE)
    const store = useAudioMuseStore()

    await Promise.all([store.ensure(), store.ensure(), store.ensure()])

    expect(getAudioMuseStatus).toHaveBeenCalledTimes(1)
  })

  it('answers usable() from what it knows and refreshes behind it', async () => {
    let answer!: (status: typeof AVAILABLE) => void
    vi.mocked(getAudioMuseStatus).mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const store = useAudioMuseStore()

    expect(store.usable()).toBe(false)
    answer(AVAILABLE)
    await vi.waitFor(() => expect(store.usable()).toBe(true))
  })

  it('forgets on reset', async () => {
    vi.mocked(getAudioMuseStatus).mockResolvedValue(AVAILABLE)
    const store = useAudioMuseStore()
    await store.ensure()

    store.reset()

    expect(store.available).toBe(false)
    await store.ensure()
    expect(getAudioMuseStatus).toHaveBeenCalledTimes(2)
  })
})
