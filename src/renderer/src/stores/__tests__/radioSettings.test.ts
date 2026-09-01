import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useRadioSettingsStore } from '../radioSettings'
import { pushAccountSettings } from '@/services/connect/accountSettings'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

describe('radioSettings store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(pushAccountSettings).mockClear()
  })

  it('defaults to relayed (castDirectly false) for an account that never toggled it', () => {
    expect(useRadioSettingsStore().castDirectly).toBe(false)
  })

  it('setCastDirectly updates state, persists locally, and pushes the account sync', async () => {
    const store = useRadioSettingsStore()

    store.setCastDirectly(true)

    expect(store.castDirectly).toBe(true)
    // The push goes through a dynamic import (see the store's own comment
    // on the circular import that forces it), so it lands a microtask
    // later rather than synchronously.
    await vi.waitFor(() =>
      expect(pushAccountSettings).toHaveBeenCalledWith({ castRadioDirectly: true }),
    )
  })

  it('reloadForAccount re-reads whatever this account already has stored', () => {
    const store = useRadioSettingsStore()
    store.setCastDirectly(true)

    // Simulates a fresh store instance seeing the value this account's
    // localStorage already carries — same shape as switching accounts on
    // one device (services/accountScopedStores.ts's own trigger).
    store.castDirectly = false
    store.reloadForAccount()

    expect(store.castDirectly).toBe(true)
  })

  it('a push failure does not throw back at the caller', async () => {
    vi.mocked(pushAccountSettings).mockRejectedValueOnce(new Error('network down'))
    const store = useRadioSettingsStore()

    expect(() => store.setCastDirectly(true)).not.toThrow()
    await vi.waitFor(() => expect(pushAccountSettings).toHaveBeenCalled())
  })
})
