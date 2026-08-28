import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '../auth'
import { useConnectStore } from '../connect'
import { useLibraryStore } from '../library'
import { usePlaybackStore } from '../playback'
import { getHealth, postConfig } from '@/services/connect/config'
import type { SubsonicClient } from '@/services/subsonic/client'

vi.mock('@/services/connect/config', () => ({
  postConfig: vi.fn().mockResolvedValue(undefined),
  getHealth: vi.fn(),
}))
vi.mock('@/services/audioEngine', () => ({ getAudioEngine: vi.fn(() => ({ stop: vi.fn() })) }))

const STORAGE_KEY = 'beacon.auth'

/** In the web build (no window.api) the store's secure storage falls back
 * to plain localStorage, which is what these tests write to. */
function storeCredentials(overrides: Record<string, unknown> = {}): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      serverUrl: 'https://music.example',
      username: 'thomas',
      password: 'secret',
      credential: 'stored-credential',
      serverType: 'subsonic',
      userId: '',
      machineIdentifier: '',
      ...overrides,
    }),
  )
}

function stubAdminLookup(): void {
  vi.spyOn(useLibraryStore(), 'client').mockReturnValue({
    isAdmin: vi.fn().mockResolvedValue(false),
  } as unknown as SubsonicClient)
}

describe('auth session handling', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.mocked(postConfig).mockResolvedValue(undefined)
    vi.mocked(getHealth).mockResolvedValue({
      ffmpeg: true,
      navidrome_configured: true,
    } as Awaited<ReturnType<typeof getHealth>>)
  })

  describe('restore', () => {
    it('replays the credential that was issued, rather than deriving a new one', async () => {
      // Jellyfin's AccessToken cannot be rebuilt from a stored password at
      // all — re-deriving here would silently break every Jellyfin restore.
      const auth = useAuthStore()
      stubAdminLookup()
      storeCredentials({ serverType: 'jellyfin', credential: 'jellyfin-access-token' })

      await expect(auth.restore()).resolves.toBe(true)

      expect(auth.credential).toBe('jellyfin-access-token')
      expect(postConfig).toHaveBeenCalledWith(
        expect.objectContaining({ credential: 'jellyfin-access-token', server_type: 'jellyfin' }),
      )
    })

    it('treats an entry saved before server types existed as Subsonic', async () => {
      const auth = useAuthStore()
      stubAdminLookup()
      storeCredentials({ serverType: undefined, credential: '' })

      await auth.restore()

      expect(auth.serverType).toBe('subsonic')
      // Nothing was stored to replay, so a fresh credential is built.
      expect(auth.credential).not.toBe('')
    })

    it('reports a failed silent restore instead of throwing at the router guard', async () => {
      const auth = useAuthStore()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      storeCredentials()
      vi.mocked(postConfig).mockRejectedValue(new Error('Media server rejected the credential'))

      await expect(auth.restore()).resolves.toBe(false)

      expect(auth.authenticated).toBe(false)
      expect(auth.loginError).toBe('Media server rejected the credential')
    })

    it('has nothing to restore when nothing was ever stored', async () => {
      const auth = useAuthStore()

      await expect(auth.restore()).resolves.toBe(false)
      expect(postConfig).not.toHaveBeenCalled()
    })
  })

  describe('readStored', () => {
    it('keeps the stored credentials after a transient read failure', async () => {
      // A keyring that is not ready yet is not proof the data is corrupt —
      // deleting here would turn a one-off glitch into a forced re-login.
      const auth = useAuthStore()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      storeCredentials()
      const remove = vi.spyOn(Storage.prototype, 'removeItem')
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('keyring unavailable')
      })

      await expect(auth.readStored()).resolves.toBeNull()

      expect(remove).not.toHaveBeenCalled()
    })

    it('drops an entry that is genuinely unreadable', async () => {
      const auth = useAuthStore()
      localStorage.setItem(STORAGE_KEY, '{not json')

      await expect(auth.readStored()).resolves.toBeNull()

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    })
  })

  describe('_authenticate', () => {
    it('refuses to run before there is anything to authenticate with', async () => {
      // A Remote-Control status poll racing ahead of restore() used to POST
      // /config with an empty URL on every cold boot.
      const auth = useAuthStore()
      auth.serverUrl = ''
      auth.credential = ''

      await expect(auth._authenticate()).rejects.toThrow()
      expect(postConfig).not.toHaveBeenCalled()
    })
  })

  describe('logout', () => {
    it('leaves nothing of the previous account behind', async () => {
      const auth = useAuthStore()
      const library = vi.spyOn(useLibraryStore(), 'resetForLogout').mockImplementation(() => {})
      const playback = vi.spyOn(usePlaybackStore(), 'resetForLogout').mockImplementation(() => {})
      const connect = vi.spyOn(useConnectStore(), 'resetForLogout').mockImplementation(() => {})
      storeCredentials()
      auth.authenticated = true
      auth.password = 'secret'
      auth.credential = 'stored-credential'
      auth.sessionId = 'session-abc'
      auth.userId = 'user-1'

      await auth.logout()

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
      expect(auth.authenticated).toBe(false)
      expect(auth.password).toBe('')
      expect(auth.credential).toBe('')
      expect(auth.sessionId).toBe('')
      expect(auth.userId).toBe('')
      // The other stores hold the queue, the library and the cast session —
      // all of it account-specific.
      expect(library).toHaveBeenCalledOnce()
      expect(playback).toHaveBeenCalledOnce()
      expect(connect).toHaveBeenCalledOnce()
    })
  })
})
