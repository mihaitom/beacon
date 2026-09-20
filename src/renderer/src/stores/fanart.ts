import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'
import { pushAccountSettings } from '@/services/connect/accountSettings'

const ENABLED_KEY = 'beacon.fanart-enabled'

// Absent (never toggled before) defaults to enabled. A frontend decision
// only, like stores/recommendations.ts: connect has no enable/disable state
// of its own for Fanart.tv, the artist page and Now Playing simply decide
// whether to ask for the images at all. The API key stays stored either way,
// so turning this off and back on never means re-entering it.
function loadEnabled(): boolean {
  try {
    return localStorage.getItem(accountScopedKey(ENABLED_KEY)) !== 'false'
  } catch {
    return true
  }
}

export const useFanartStore = defineStore('fanart', {
  state: () => ({
    enabled: loadEnabled(),
  }),
  actions: {
    setEnabled(value: boolean): void {
      this.enabled = value
      try {
        localStorage.setItem(accountScopedKey(ENABLED_KEY), String(value))
      } catch {
        // Non-critical — worst case the preference doesn't survive to the
        // next launch.
      }
      // Best-effort account sync — see services/connect/accountSettings.ts.
      void pushAccountSettings({ fanartEnabled: value }).catch(() => {})
    },

    /** Re-reads this account's own stored value — state() only ever runs
     * once, at app boot, before login has resolved who's logged in. Wired
     * up from services/accountScopedStores.ts. */
    reloadForAccount(): void {
      this.enabled = loadEnabled()
    },
  },
})
