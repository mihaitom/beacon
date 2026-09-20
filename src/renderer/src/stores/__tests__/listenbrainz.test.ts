import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useListenbrainzStore } from '../listenbrainz'
import { pushAccountSettings } from '@/services/connect/accountSettings'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

describe('listenbrainz store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(pushAccountSettings).mockClear()
  })

  it('starts with no username for an account that never entered one', () => {
    expect(useListenbrainzStore().username).toBe('')
  })

  it('setUsername stores it locally and syncs it to the account', async () => {
    const store = useListenbrainzStore()

    store.setUsername('listener')

    expect(store.username).toBe('listener')
    // Dynamic import, same circular-import reason stores/lastfm.ts documents.
    await vi.waitFor(() =>
      expect(pushAccountSettings).toHaveBeenCalledWith({ listenbrainzUsername: 'listener' }),
    )
  })

  it('trims what was typed, so a stray space is not part of the name', () => {
    const store = useListenbrainzStore()
    store.setUsername('  listener  ')
    expect(store.username).toBe('listener')
  })

  it('reloadForAccount re-reads what this account already has stored', () => {
    const store = useListenbrainzStore()
    store.setUsername('listener')

    store.username = 'someone-else'
    store.reloadForAccount()

    expect(store.username).toBe('listener')
  })
})
