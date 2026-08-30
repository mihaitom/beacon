import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { accountScopedKey, getAccountKey, onAccountChange } from '../accountKey'
import { useAuthStore } from '@/stores/auth'

/** Logs `username` in as if _authenticate() had just succeeded — the
 * distinction matters throughout this module (see accountScopedKey()'s and
 * onAccountChange()'s own comments): login() populates the identity fields
 * *before* authenticating, so "an identity exists" and "someone is logged
 * in" are two different states, and only the second one may move data. */
function signIn(username: string): ReturnType<typeof useAuthStore> {
  const auth = useAuthStore()
  auth.serverType = 'subsonic'
  auth.serverUrl = 'https://music.example.com'
  auth.username = username
  auth.authenticated = true
  return auth
}

describe('accountKey', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  describe('getAccountKey', () => {
    it('is null pre-login', () => {
      expect(getAccountKey()).toBeNull()
    })

    it('combines server type, url, and username once logged in', () => {
      signIn('alice')

      expect(getAccountKey()).toBe('subsonic|https://music.example.com|alice')
    })

    it('still scopes by server when the username lookup came up empty', () => {
      // Plex's plex.tv username lookup is best-effort — selectPlexServer()
      // tolerates an empty name. Falling back to null here would switch
      // scoping (and every onAccountChange() consumer with it) off entirely
      // for those installs.
      const auth = useAuthStore()
      auth.serverType = 'plex'
      auth.serverUrl = 'https://plex.example.com'
      auth.username = ''

      expect(getAccountKey()).toBe('plex|https://plex.example.com|')
    })
  })

  describe('accountScopedKey', () => {
    it('returns the base key unchanged pre-login', () => {
      expect(accountScopedKey('beacon.quality')).toBe('beacon.quality')
    })

    it('namespaces the key by account once logged in', () => {
      signIn('alice')

      expect(accountScopedKey('beacon.quality')).toBe(
        'beacon.quality::subsonic|https://music.example.com|alice',
      )
    })

    it('gives two different accounts on the same device independent keys', () => {
      const auth = signIn('alice')
      const aliceKey = accountScopedKey('beacon.quality')
      auth.username = 'bob'
      const bobKey = accountScopedKey('beacon.quality')

      expect(aliceKey).not.toBe(bobKey)
    })

    it('migrates a pre-existing unscoped value into the account-scoped key exactly once', () => {
      localStorage.setItem('beacon.quality', 'legacy-value')
      signIn('alice')

      const scoped = accountScopedKey('beacon.quality')

      expect(localStorage.getItem(scoped)).toBe('legacy-value')
      expect(localStorage.getItem('beacon.quality')).toBeNull()
    })

    it('does not migrate anything for an identity that has not authenticated yet', () => {
      // login() sets serverUrl/username before _authenticate() runs, so a
      // typo'd username reaches this point looking exactly like a real
      // account. Migrating there would move every legacy key into a scope
      // nobody owns and delete the original.
      localStorage.setItem('beacon.quality', 'legacy-value')
      const auth = useAuthStore()
      auth.serverType = 'subsonic'
      auth.serverUrl = 'https://music.example.com'
      auth.username = 'alicce'

      const scoped = accountScopedKey('beacon.quality')

      expect(localStorage.getItem(scoped)).toBeNull()
      expect(localStorage.getItem('beacon.quality')).toBe('legacy-value')
    })

    it('still migrates for the real account after a failed login attempt', () => {
      localStorage.setItem('beacon.quality', 'legacy-value')
      const auth = useAuthStore()
      auth.serverType = 'subsonic'
      auth.serverUrl = 'https://music.example.com'
      auth.username = 'alicce'
      accountScopedKey('beacon.quality') // the typo'd attempt — must be a no-op

      auth.username = 'alice'
      auth.authenticated = true
      const scoped = accountScopedKey('beacon.quality')

      expect(localStorage.getItem(scoped)).toBe('legacy-value')
    })

    it('does not hand a second account the first account migrated legacy value', () => {
      localStorage.setItem('beacon.quality', 'legacy-value')
      const auth = signIn('alice')
      accountScopedKey('beacon.quality') // alice migrates it into her own key

      auth.username = 'bob'
      const bobScoped = accountScopedKey('beacon.quality')

      expect(localStorage.getItem(bobScoped)).toBeNull()
    })

    it('leaves an already-scoped value alone on a later call', () => {
      signIn('alice')
      const scoped = accountScopedKey('beacon.quality')
      localStorage.setItem(scoped, 'current-value')

      expect(accountScopedKey('beacon.quality')).toBe(scoped)
      expect(localStorage.getItem(scoped)).toBe('current-value')
    })
  })

  describe('onAccountChange', () => {
    it('fires once an account resolves after starting out logged out', async () => {
      const callback = vi.fn()
      onAccountChange(callback)

      signIn('alice')
      await nextTick()

      expect(callback).toHaveBeenCalledTimes(1)
    })

    it('fires again when a different account logs in', async () => {
      const auth = signIn('alice')
      const callback = vi.fn()
      onAccountChange(callback)

      auth.username = 'bob'
      await nextTick()

      expect(callback).toHaveBeenCalledTimes(1)
    })

    it('does not fire while nothing about the account actually changes', async () => {
      const callback = vi.fn()
      onAccountChange(callback)
      const auth = useAuthStore()

      auth.serverUrl = 'https://music.example.com' // still nobody logged in
      await nextTick()

      expect(callback).not.toHaveBeenCalled()
    })

    it('does not fire for an identity that never authenticated', async () => {
      const callback = vi.fn()
      onAccountChange(callback)
      const auth = useAuthStore()

      auth.serverType = 'subsonic'
      auth.serverUrl = 'https://music.example.com'
      auth.username = 'alicce' // typo'd login, _authenticate() is about to fail
      await nextTick()

      expect(callback).not.toHaveBeenCalled()
    })
  })
})
