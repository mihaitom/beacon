import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'

const USERNAME_KEY = 'beacon.listenbrainz-username'

// A public ListenBrainz name, not a credential: the stats and
// recommendation endpoints take it as a plain parameter and read whatever
// that profile shares (see connect/core/listenbrainz.py). Stored per
// account like every other personal setting, and synced so the same
// person's phone and desktop don't each have to be told who they are on
// ListenBrainz.
function loadUsername(): string {
  try {
    return localStorage.getItem(accountScopedKey(USERNAME_KEY)) ?? ''
  } catch {
    return ''
  }
}

export const useListenbrainzStore = defineStore('listenbrainz', {
  state: () => ({
    username: loadUsername(),
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
      // circular-import reason stores/lastfm.ts documents.
      void import('@/services/connect/accountSettings').then(({ pushAccountSettings }) =>
        pushAccountSettings({ listenbrainzUsername: trimmed }).catch(() => {}),
      )
    },

    /** Re-reads this account's own stored value — see
     * services/accountScopedStores.ts. */
    reloadForAccount(): void {
      this.username = loadUsername()
    },
  },
})
