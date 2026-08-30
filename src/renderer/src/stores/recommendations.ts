import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'
import { pushAccountSettings } from '@/services/connect/accountSettings'

const ENABLED_KEY = 'beacon.recommendations-enabled'

// Absent (never toggled before) defaults to enabled — same convention as
// NowPlayingView.vue's readShowVisualizer(): this is what actually fixes
// the "Discover is just random albums" complaint out of the box, not
// something that needs opting into. The Settings toggle exists for anyone
// who'd rather HomeView.vue never share a library artist name or two with
// MusicBrainz/ListenBrainz at all (see core/recommendations.py) — purely a
// frontend decision, connect itself has no enable/disable state of its
// own for this: HomeView.vue is the only thing that ever decides whether
// to call the endpoint in the first place.
function loadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'false'
  } catch {
    return true
  }
}

export const useRecommendationsStore = defineStore('recommendations', {
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
      void pushAccountSettings({ recommendationsEnabled: value }).catch(() => {})
    },

    /** Re-reads this account's own stored value — state() only ever runs
     * once, at app boot, before login has resolved who's logged in. Wired
     * up from services/accountScopedStores.ts. */
    reloadForAccount(): void {
      this.enabled = loadEnabled()
    },
  },
})
