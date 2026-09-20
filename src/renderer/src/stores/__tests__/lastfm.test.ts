import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useLastfmStore } from '../lastfm'
import { pushAccountSettings } from '@/services/connect/accountSettings'
import { getLastfmStatus } from '@/services/connect/lastfm'

vi.mock('@/services/connect/accountSettings', () => ({
  pushAccountSettings: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/services/connect/lastfm', () => ({
  getLastfmStatus: vi.fn(),
}))

describe('lastfm store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.mocked(pushAccountSettings).mockClear()
    vi.mocked(getLastfmStatus).mockReset()
  })

  it('starts with no username for an account that never entered one', () => {
    expect(useLastfmStore().username).toBe('')
  })

  it('setUsername stores it locally and syncs it to the account', async () => {
    const store = useLastfmStore()

    store.setUsername('listener')

    expect(store.username).toBe('listener')
    // Dynamic import, same circular-import reason radioSettings documents.
    await vi.waitFor(() =>
      expect(pushAccountSettings).toHaveBeenCalledWith({ lastfmUsername: 'listener' }),
    )
  })

  it('trims what was typed, so a stray space is not part of the name', async () => {
    const store = useLastfmStore()
    store.setUsername('  listener  ')
    expect(store.username).toBe('listener')
  })

  it('reloadForAccount re-reads what this account already has stored', () => {
    const store = useLastfmStore()
    store.setUsername('listener')

    store.username = 'someone-else'
    store.reloadForAccount()

    expect(store.username).toBe('listener')
  })

  it('checkConfigured asks once and reuses the answer', async () => {
    vi.mocked(getLastfmStatus).mockResolvedValue({ configured: true, fromEnvironment: false })
    const store = useLastfmStore()

    expect(await store.checkConfigured()).toBe(true)
    expect(await store.checkConfigured()).toBe(true)
    expect(getLastfmStatus).toHaveBeenCalledTimes(1)
  })

  it('treats an unreachable backend as not configured', async () => {
    // The builder is only offered on a definite yes - a failed check must
    // not leave a button that could only ever fail.
    vi.mocked(getLastfmStatus).mockRejectedValue(new Error('offline'))
    const store = useLastfmStore()

    expect(await store.checkConfigured()).toBe(false)
    expect(store.configured).toBe(false)
  })
})
