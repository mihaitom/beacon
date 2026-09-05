import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'

const ENABLED_KEY = 'beacon.autoplay-enabled'

/** How many similar songs each Autoplay top-up fetches.
 *
 * A constant, not a setting. It used to be a four-way select in Settings,
 * which asked people to pick a number none of them could have an opinion
 * about before trying it — the kind of question the app should answer
 * itself (see the README's own note on staying lean). Ten is roughly a
 * side's worth of listening: long enough that a top-up is rare, short
 * enough that a queue nobody wanted doesn't run for an hour. */
export const AUTOPLAY_BATCH_SIZE = 10

// Absent (never toggled before) defaults to *disabled* — unlike
// recommendations.ts's equivalent, this doesn't just change what a shelf
// displays, it silently appends songs to whatever's actually playing and
// keeps going indefinitely. That's worth opting into, not something that
// should surprise anyone the first time their queue would otherwise run
// out. Toggled from PlayerBar.vue (next to Lyrics/Queue) rather than
// buried in Settings — this is a "turn it on for this listening session"
// decision people reach for in the moment, not a set-once preference.
//
// Account-scoped like every other device-local setting (see
// services/accountKey.ts) — "autoplay is on" is a decision about someone's
// own listening session, not something the next person to log in on this
// device should inherit mid-queue.
function loadEnabled(): boolean {
  try {
    return localStorage.getItem(accountScopedKey(ENABLED_KEY)) === 'true'
  } catch {
    return false
  }
}

export const useAutoplayStore = defineStore('autoplay', {
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
    },
    /** Re-reads this account's own stored values — state() only ever runs
     * once, at app boot, before login has resolved who's logged in. Wired
     * up from services/accountScopedStores.ts. */
    reloadForAccount(): void {
      this.enabled = loadEnabled()
    },
  },
})
