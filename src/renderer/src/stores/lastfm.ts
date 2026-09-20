import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'
import { getLastfmStatus } from '@/services/connect/lastfm'

const USERNAME_KEY = 'beacon.lastfm-username'

// A public Last.fm name, not a credential: user.getTopTracks takes it as a
// plain parameter and reads whatever that profile shares (see
// connect/core/lastfm.py). Stored per account like every other personal
// setting, and synced so the same person's phone and desktop don't each
// have to be told who they are on Last.fm.
function loadUsername(): string {
  try {
    return localStorage.getItem(accountScopedKey(USERNAME_KEY)) ?? ''
  } catch {
    return ''
  }
}

export const useLastfmStore = defineStore('lastfm', {
  state: () => ({
    username: loadUsername(),
    /** Whether this installation has an application key at all. `null`
     * until asked — the builder is offered only on a definite yes, so an
     * unreachable backend hides it rather than offering a dialog that
     * cannot work. */
    configured: null as boolean | null,
  }),
  actions: {
    setUsername(value: string): void {
      const trimmed = value.trim()
      this.username = trimmed
      try {
        localStorage.setItem(accountScopedKey(USERNAME_KEY), trimmed)
      } catch {
        // Non-critical — worst case it has to be typed again next launch.
      }
      // Best-effort account sync, and a dynamic import for the same
      // circular-import reason stores/radioSettings.ts documents.
      void import('@/services/connect/accountSettings').then(({ pushAccountSettings }) =>
        pushAccountSettings({ lastfmUsername: trimmed }).catch(() => {}),
      )
    },

    /** Asked once per session, before offering the builder anywhere.
     * SettingsView sets `configured` directly when the key changes, so a
     * key entered there takes effect without a reload. */
    async checkConfigured(): Promise<boolean> {
      if (this.configured !== null) return this.configured
      try {
        this.configured = (await getLastfmStatus()).configured
      } catch {
        this.configured = false
      }
      return this.configured
    },

    /** Re-reads this account's own stored value — see
     * services/accountScopedStores.ts. */
    reloadForAccount(): void {
      this.username = loadUsername()
    },
  },
})
