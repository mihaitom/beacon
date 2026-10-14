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
    expect(store.payload).toEqual({
      mode: 'crossfade',
      crossfade_seconds: 16,
      beatmix_bars: 8,
    })
    await vi.waitFor(() =>
      expect(pushAccountSettings).toHaveBeenCalledWith({
        transitions: { mode: 'crossfade', crossfadeSeconds: 16, beatmixBars: 8 },
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
      crossfadeSeconds: 4,
      beatmixBars: 8,
    })
    expect(sanitizeTransitions({ mode: 'gapless', crossfadeSeconds: 999 }).crossfadeSeconds).toBe(
      30,
    )
    expect(sanitizeTransitions({ mode: 'gapless', crossfadeSeconds: 0 }).crossfadeSeconds).toBe(2)
  })

  it('the beatmix length is set apart from the crossfade one', () => {
    const store = useTransitionsStore()
    store.set({ mode: 'crossfade', crossfadeSeconds: 6, beatmixBars: 16 })
    expect(store.payload).toMatchObject({ crossfade_seconds: 6, beatmix_bars: 16 })
    store.set({ crossfadeSeconds: 8 })
    expect(store.beatmixBars).toBe(16)
  })

  it('a beatmix is only ever 4, 8 or 16 bars', () => {
    expect(sanitizeTransitions({ beatmixBars: 12 }).beatmixBars).toBe(8)
    expect(sanitizeTransitions({ beatmixBars: 4 }).beatmixBars).toBe(4)
  })

  it('a beatmix length kept in seconds becomes the bars it played', () => {
    expect(sanitizeTransitions({ beatmixSeconds: 8 }).beatmixBars).toBe(4)
    expect(sanitizeTransitions({ beatmixSeconds: 16 }).beatmixBars).toBe(8)
    expect(sanitizeTransitions({ beatmixSeconds: 30 }).beatmixBars).toBe(16)
  })
})
