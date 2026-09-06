import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'

const CAST_DIRECTLY_KEY = 'beacon.radio-cast-directly'

// Absent (never toggled before) defaults to false — routing radio through
// Beacon's own backend relay is the default (TODO.md, decided 2026-09-01):
// one fetch of the station feeds every cast target's audio, the
// visualizer, and the now-playing title at once, instead of the up to
// three independent connections to it "direct to device" meant. This is
// the opt-out, for anyone who'd rather not make connect a single point of
// failure for radio that's already playing — see core/radio_relay.py's own
// docstring for that trade-off.
//
// The name is narrower than what it decides. It speaks for this device's
// own player too (stores/playback.ts's startLocalRadio(), and
// connect/routes/stream.py's /stream/radio-local for what that buys):
// a browser is one more thing being fed a station, the trade-off it makes
// is the same one, and a listener who wants radio to survive a connect
// restart wants that for whatever is playing it. Kept as-is rather than
// renamed because the value is stored under this key on every existing
// install and synced to the account under this name
// (services/connect/accountSettings.ts's castRadioDirectly).
function loadCastDirectly(): boolean {
  try {
    return localStorage.getItem(accountScopedKey(CAST_DIRECTLY_KEY)) === 'true'
  } catch {
    return false
  }
}

export const useRadioSettingsStore = defineStore('radioSettings', {
  state: () => ({
    castDirectly: loadCastDirectly(),
  }),
  actions: {
    setCastDirectly(value: boolean): void {
      this.castDirectly = value
      try {
        localStorage.setItem(accountScopedKey(CAST_DIRECTLY_KEY), String(value))
      } catch {
        // Non-critical — worst case the preference doesn't survive to the
        // next launch.
      }
      // Best-effort account sync — see services/connect/accountSettings.ts.
      // Dynamic import to dodge a real circular import, the same one
      // stores/autoplay.ts documents: services/connect/accountSettings.ts
      // pulls in stores/auth.ts, which pulls in stores/playback.ts, which
      // imports *this* store back in. A static import here would cycle.
      void import('@/services/connect/accountSettings').then(({ pushAccountSettings }) =>
        pushAccountSettings({ castRadioDirectly: value }).catch(() => {}),
      )
    },

    /** Re-reads this account's own stored value — state() only ever runs
     * once, at app boot, before login has resolved who's logged in. Wired
     * up from services/accountScopedStores.ts. */
    reloadForAccount(): void {
      this.castDirectly = loadCastDirectly()
    },
  },
})
