import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'

const ENABLED_KEY = 'beacon.autoplay-enabled'
const BATCH_SIZE_KEY = 'beacon.autoplay-batch-size'

export const DEFAULT_AUTOPLAY_BATCH_SIZE = 10
export const AUTOPLAY_BATCH_SIZE_OPTIONS = [5, 10, 20, 30] as const

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

/** The only place a batch size is ever accepted from — stored values,
 * hand-edited storage, and the server sync (see
 * services/accountScopedStores.ts) all land here. Anything that isn't one
 * of the offered options falls back to the default rather than being
 * taken at face value: it would otherwise reach maybeAutoplay() as a raw
 * fetch limit *and* leave SettingsView.vue's v-select sitting on a value
 * it has no item for. */
export function sanitizeBatchSize(value: unknown): number {
  const raw = Number(value)
  return AUTOPLAY_BATCH_SIZE_OPTIONS.includes(raw as (typeof AUTOPLAY_BATCH_SIZE_OPTIONS)[number])
    ? raw
    : DEFAULT_AUTOPLAY_BATCH_SIZE
}

function loadBatchSize(): number {
  try {
    return sanitizeBatchSize(localStorage.getItem(accountScopedKey(BATCH_SIZE_KEY)))
  } catch {
    return DEFAULT_AUTOPLAY_BATCH_SIZE
  }
}

export const useAutoplayStore = defineStore('autoplay', {
  state: () => ({
    enabled: loadEnabled(),
    // How many similar songs playback.ts's maybeAutoplay() fetches per
    // top-up — the actual on/off switch lives in PlayerBar.vue, this is
    // the one part of Autoplay that *does* belong in Settings (a "how it
    // behaves" tuning knob, not a moment-to-moment toggle).
    batchSize: loadBatchSize(),
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
    setBatchSize(value: number): void {
      // Sanitized here rather than only on load: this is also the entry
      // point the server sync applies a pulled value through, and that
      // value comes from whatever some other device (or a hand-edited
      // account_settings.json) wrote.
      this.batchSize = sanitizeBatchSize(value)
      try {
        localStorage.setItem(accountScopedKey(BATCH_SIZE_KEY), String(this.batchSize))
      } catch {
        // Non-critical — worst case the preference doesn't survive to the
        // next launch.
      }
      // Best-effort account sync — batchSize is the one Autoplay setting
      // that's a real preference rather than a session decision (see this
      // module's own comment on `enabled`, which deliberately stays local).
      // Dynamic import to dodge a real circular import: services/connect/
      // accountSettings.ts pulls in stores/auth.ts, which pulls in *this*
      // store back in (playback.ts imports useAutoplayStore, auth.ts
      // imports playback.ts) — a static import here would cycle.
      void import('@/services/connect/accountSettings').then(({ pushAccountSettings }) =>
        pushAccountSettings({ autoplayBatchSize: this.batchSize }).catch(() => {}),
      )
    },

    /** Re-reads this account's own stored values — state() only ever runs
     * once, at app boot, before login has resolved who's logged in. Wired
     * up from services/accountScopedStores.ts. */
    reloadForAccount(): void {
      this.enabled = loadEnabled()
      this.batchSize = loadBatchSize()
    },
  },
})
