import { beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUpdateStore } from '../update'
import { useAuthStore } from '../auth'

/** update.ts's state() bakes dismissedVersion/snoozedUntil in at store
 * creation — this store gets created at App.vue's created(), before
 * login/restore() resolves an account (see services/accountKey.ts's
 * onAccountChange()), so reload() is what actually picks up the real
 * account's own dismiss/snooze state once it's known. */
describe('update store — account-scoped reload', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('reload() picks up the current account state, not whatever was there pre-login', () => {
    const store = useUpdateStore()
    // Simulates the pre-login state() read finding nothing (nobody logged
    // in yet at store-creation time).
    expect(store.dismissedVersion).toBeNull()

    const auth = useAuthStore()
    auth.serverType = 'subsonic'
    auth.serverUrl = 'https://music.example.com'
    auth.username = 'alice'
    store.latestVersion = '2.0.0'
    store.dismiss()

    // A second store instance, as if the app were freshly booted again —
    // its state() factory would still see the same account this time
    // (unlike the very first pre-login boot), matching reload()'s result.
    store.reload()
    expect(store.dismissedVersion).toBe('2.0.0')
  })

  it("does not leak one account's dismissed version into another's reload()", () => {
    const store = useUpdateStore()
    const auth = useAuthStore()
    auth.serverType = 'subsonic'
    auth.serverUrl = 'https://music.example.com'
    auth.username = 'alice'
    store.latestVersion = '2.0.0'
    store.dismiss()

    auth.username = 'bob'
    store.reload()

    expect(store.dismissedVersion).toBeNull()
  })
})
