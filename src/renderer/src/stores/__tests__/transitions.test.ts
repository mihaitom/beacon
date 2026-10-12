import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { sanitizeTransitions, useTransitionsStore } from '../transitions'
import { pushAccountSettings } from '@/services/connect/accountSettings'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

describe('transitions store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(pushAccountSettings).mockClear()
  })

  it('is off for an account that never chose', () => {
    const store = useTransitionsStore()
    expect(store.mode).toBe('off')
    expect(store.enabled).toBe(false)
  })

  it('set() keeps the choice, stores it and syncs it to the account', async () => {
    const store = useTransitionsStore()
    store.set({ mode: 'crossfade', crossfadeSeconds: 16 })

    expect(store.enabled).toBe(true)
    expect(store.payload).toEqual({ mode: 'crossfade', crossfade_seconds: 16 })
    await vi.waitFor(() =>
      expect(pushAccountSettings).toHaveBeenCalledWith({
        transitions: { mode: 'crossfade', crossfadeSeconds: 16 },
      }),
    )

    store.mode = 'off'
    store.reloadForAccount()
    expect(store.mode).toBe('crossfade')
  })

  it('changing one half leaves the other as it was', () => {
    const store = useTransitionsStore()
    store.set({ mode: 'crossfade', crossfadeSeconds: 6 })
    store.set({ mode: 'gapless' })
    expect(store.crossfadeSeconds).toBe(6)
  })

  it('a value from another build or a hand edit is brought back into range', () => {
    expect(sanitizeTransitions({ mode: 'dj', crossfadeSeconds: 'x' })).toEqual({
      mode: 'off',
      crossfadeSeconds: 10,
    })
    expect(sanitizeTransitions({ mode: 'gapless', crossfadeSeconds: 999 }).crossfadeSeconds).toBe(
      30,
    )
    expect(sanitizeTransitions({ mode: 'gapless', crossfadeSeconds: 0 }).crossfadeSeconds).toBe(2)
  })
})
