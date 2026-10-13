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
// A beatmix lines the songs up on the beat and can blend for longer before
// it turns to mush; a plain crossfade cannot.
const CROSSFADE_SECONDS_DEFAULT = 4
const BEATMIX_SECONDS_DEFAULT = 12

export interface TransitionSettings {
  mode: TransitionMode
  /** The longest overlap of a plain crossfade, and of a beatmix - songs
   * matched on the beat, whose overlap connect rounds down to whole bars
   * (connect/core/transition_planner.py). */
  crossfadeSeconds: number
  beatmixSeconds: number
}

/** What connect's /play and the local mix take - see TransitionSettings in
 * connect/routes/mix_cast.py. */
export interface TransitionsPayload {
  mode: TransitionMode
  crossfade_seconds: number
  beatmix_seconds: number
}

const KEY = 'beacon.transitions'

export function sanitizeTransitions(value: unknown): TransitionSettings {
  const raw = (value ?? {}) as Partial<TransitionSettings>
  const mode = TRANSITION_MODES.includes(raw.mode as TransitionMode)
    ? (raw.mode as TransitionMode)
    : 'off'
  const crossfadeSeconds = seconds(raw.crossfadeSeconds) ?? CROSSFADE_SECONDS_DEFAULT
  const beatmixSeconds = seconds(raw.beatmixSeconds) ?? BEATMIX_SECONDS_DEFAULT
  return { mode, crossfadeSeconds, beatmixSeconds }
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
      beatmix_seconds: state.beatmixSeconds,
    }),
  },
  actions: {
    set(patch: Partial<TransitionSettings>): void {
      const next = sanitizeTransitions({
        mode: this.mode,
        crossfadeSeconds: this.crossfadeSeconds,
        beatmixSeconds: this.beatmixSeconds,
        ...patch,
      })
      this.mode = next.mode
      this.crossfadeSeconds = next.crossfadeSeconds
      this.beatmixSeconds = next.beatmixSeconds
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
      this.beatmixSeconds = next.beatmixSeconds
    },
  },
})
