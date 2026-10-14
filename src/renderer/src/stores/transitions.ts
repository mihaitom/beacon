import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'

/** How one song turns into the next: a plain cut (`off`, one file at a
 * time, as Beacon always played), `gapless`, or `crossfade`. Anything but
 * `off` plays through connect's mixer as one continuous stream - see
 * connect/routes/mix_cast.py and docs/plans/gapless-and-transitions.md. */
export type TransitionMode = 'off' | 'gapless' | 'crossfade'

export const TRANSITION_MODES: readonly TransitionMode[] = ['off', 'gapless', 'crossfade']

export const CROSSFADE_SECONDS_MIN = 2
export const CROSSFADE_SECONDS_MAX = 30
const CROSSFADE_SECONDS_DEFAULT = 4
// A beatmix is counted the way a DJ counts it: in phrases of 4, 8 or 16
// bars. Lined up on the beat it can blend for longer than a plain
// crossfade before it turns to mush; 8 bars are ~15 s at 128 BPM.
export const BEATMIX_BARS = [4, 8, 16] as const
export type BeatmixBars = (typeof BEATMIX_BARS)[number]
const BEATMIX_BARS_DEFAULT: BeatmixBars = 8

export interface TransitionSettings {
  mode: TransitionMode
  /** The longest overlap of a plain crossfade, and how many bars a beatmix
   * - songs matched on the beat - lasts where the songs leave room for it
   * (connect/core/transition_planner.py). */
  crossfadeSeconds: number
  beatmixBars: BeatmixBars
}

/** What connect's /play and the local mix take - see TransitionSettings in
 * connect/routes/mix_cast.py. */
export interface TransitionsPayload {
  mode: TransitionMode
  crossfade_seconds: number
  beatmix_bars: BeatmixBars
}

const KEY = 'beacon.transitions'

export function sanitizeTransitions(value: unknown): TransitionSettings {
  const raw = (value ?? {}) as Partial<TransitionSettings> & { beatmixSeconds?: unknown }
  const mode = TRANSITION_MODES.includes(raw.mode as TransitionMode)
    ? (raw.mode as TransitionMode)
    : 'off'
  const crossfadeSeconds = seconds(raw.crossfadeSeconds) ?? CROSSFADE_SECONDS_DEFAULT
  const beatmixBars = BEATMIX_BARS.includes(raw.beatmixBars as BeatmixBars)
    ? (raw.beatmixBars as BeatmixBars)
    : (barsFromSeconds(raw.beatmixSeconds) ?? BEATMIX_BARS_DEFAULT)
  return { mode, crossfadeSeconds, beatmixBars }
}

/** Up to 1.8.0 a beatmix was set in seconds, as an upper bound: the bars
 * that fitted under it at a club tempo (128 BPM, 1.875 s a bar). */
function barsFromSeconds(value: unknown): BeatmixBars | null {
  const n = Number(value)
  if (value === undefined || value === null || !Number.isFinite(n)) return null
  if (n < 15) return 4
  return n < 30 ? 8 : 16
}

function seconds(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(CROSSFADE_SECONDS_MAX, Math.max(CROSSFADE_SECONDS_MIN, Math.round(n)))
}

function load(): TransitionSettings {
  try {
    const stored = localStorage.getItem(accountScopedKey(KEY))
    return sanitizeTransitions(stored ? JSON.parse(stored) : null)
  } catch {
    return sanitizeTransitions(null)
  }
}

export const useTransitionsStore = defineStore('transitions', {
  state: (): TransitionSettings => load(),
  getters: {
    enabled: (state): boolean => state.mode !== 'off',
    payload: (state): TransitionsPayload => ({
      mode: state.mode,
      crossfade_seconds: state.crossfadeSeconds,
      beatmix_bars: state.beatmixBars,
    }),
  },
  actions: {
    set(patch: Partial<TransitionSettings>): void {
      const next = sanitizeTransitions({
        mode: this.mode,
        crossfadeSeconds: this.crossfadeSeconds,
        beatmixBars: this.beatmixBars,
        ...patch,
      })
      this.mode = next.mode
      this.crossfadeSeconds = next.crossfadeSeconds
      this.beatmixBars = next.beatmixBars
      try {
        localStorage.setItem(accountScopedKey(KEY), JSON.stringify(next))
      } catch {
        // Non-critical - the setting just doesn't survive to the next launch.
      }
      // Dynamic import for the circular import stores/radioSettings.ts
      // documents.
      void import('@/services/connect/accountSettings').then(({ pushAccountSettings }) =>
        pushAccountSettings({ transitions: next }).catch(() => {}),
      )
    },

    /** See services/accountScopedStores.ts. */
    reloadForAccount(): void {
      const next = load()
      this.mode = next.mode
      this.crossfadeSeconds = next.crossfadeSeconds
      this.beatmixBars = next.beatmixBars
    },
  },
})
