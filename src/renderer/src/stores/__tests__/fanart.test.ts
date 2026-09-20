import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useFanartStore } from '../fanart'
import { useAuthStore } from '../auth'
import { pushAccountSettings } from '@/services/connect/accountSettings'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

describe('fanart store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(pushAccountSettings).mockClear()
  })

  it('defaults to enabled for an account that never toggled it', () => {
    expect(useFanartStore().enabled).toBe(true)
  })

  it('setEnabled updates state, persists locally, and pushes the account sync', async () => {
    const store = useFanartStore()

    store.setEnabled(false)

    expect(store.enabled).toBe(false)
    await vi.waitFor(() =>
      expect(pushAccountSettings).toHaveBeenCalledWith({ fanartEnabled: false }),
    )
  })

  it('reloadForAccount re-reads whatever this account already has stored', () => {
    const auth = useAuthStore()
    auth.serverType = 'subsonic'
    auth.serverUrl = 'https://music.example.com'
    auth.username = 'alice'

    const store = useFanartStore()
    store.setEnabled(false)

    store.enabled = true
    store.reloadForAccount()

    expect(store.enabled).toBe(false)
  })
})
