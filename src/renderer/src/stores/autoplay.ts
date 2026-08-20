import { defineStore } from 'pinia'

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
function loadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === 'true'
  } catch {
    return false
  }
}

function loadBatchSize(): number {
  try {
    const raw = Number(localStorage.getItem(BATCH_SIZE_KEY))
    return AUTOPLAY_BATCH_SIZE_OPTIONS.includes(raw as (typeof AUTOPLAY_BATCH_SIZE_OPTIONS)[number])
      ? raw
      : DEFAULT_AUTOPLAY_BATCH_SIZE
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
        localStorage.setItem(ENABLED_KEY, String(value))
      } catch {
        // Non-critical — worst case the preference doesn't survive to the
        // next launch.
      }
    },
    setBatchSize(value: number): void {
      this.batchSize = value
      try {
        localStorage.setItem(BATCH_SIZE_KEY, String(value))
      } catch {
        // Non-critical — worst case the preference doesn't survive to the
        // next launch.
      }
    },
  },
})
