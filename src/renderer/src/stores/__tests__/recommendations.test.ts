import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useRecommendationsStore } from '../recommendations'
import { useAuthStore } from '../auth'
import { pushAccountSettings } from '@/services/connect/accountSettings'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

describe('recommendations store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(pushAccountSettings).mockClear()
  })

  it('defaults to enabled for an account that never toggled it', () => {
    expect(useRecommendationsStore().enabled).toBe(true)
  })

  it('setEnabled updates state, persists locally, and pushes the account sync', async () => {
    const store = useRecommendationsStore()

    store.setEnabled(false)

    expect(store.enabled).toBe(false)
    await vi.waitFor(() =>
      expect(pushAccountSettings).toHaveBeenCalledWith({ recommendationsEnabled: false }),
    )
  })

  it('reloadForAccount re-reads whatever this account already has stored', () => {
    // An account has to actually be known (accountScopedKey() only scopes
    // the storage key once getAccountKey() has something to scope by —
    // see services/accountKey.ts) for this to exercise the real bug: with
    // no account, setEnabled()'s write key and loadEnabled()'s read key
    // both fall back to the same unscoped key, hiding a mismatch between
    // the two that only shows up once they diverge.
    const auth = useAuthStore()
    auth.serverType = 'subsonic'
    auth.serverUrl = 'https://music.example.com'
    auth.username = 'alice'

    const store = useRecommendationsStore()
    store.setEnabled(false)

    // Simulates a fresh store instance seeing the value this account's
    // localStorage already carries — same shape as switching accounts on
    // one device (services/accountScopedStores.ts's own trigger). Also
    // regression coverage for loadEnabled() reading a different key than
    // setEnabled() writes: that mismatch silently reverted the toggle back
    // to the default on every reload past the first one.
    store.enabled = true
    store.reloadForAccount()

    expect(store.enabled).toBe(false)
  })
})
