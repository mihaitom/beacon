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
const CROSSFADE_SECONDS_DEFAULT = 10

export interface TransitionSettings {
  mode: TransitionMode
  crossfadeSeconds: number
}

const KEY = 'beacon.transitions'

export function sanitizeTransitions(value: unknown): TransitionSettings {
  const raw = (value ?? {}) as Partial<TransitionSettings>
  const mode = TRANSITION_MODES.includes(raw.mode as TransitionMode)
    ? (raw.mode as TransitionMode)
    : 'off'
  const seconds = Number(raw.crossfadeSeconds)
  const crossfadeSeconds = Number.isFinite(seconds)
    ? Math.min(CROSSFADE_SECONDS_MAX, Math.max(CROSSFADE_SECONDS_MIN, Math.round(seconds)))
    : CROSSFADE_SECONDS_DEFAULT
  return { mode, crossfadeSeconds }
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
    /** What connect's /play takes - see PlayRequest.transitions. */
    payload: (state): { mode: TransitionMode; crossfade_seconds: number } => ({
      mode: state.mode,
      crossfade_seconds: state.crossfadeSeconds,
    }),
  },
  actions: {
    set(patch: Partial<TransitionSettings>): void {
      const next = sanitizeTransitions({
        mode: this.mode,
        crossfadeSeconds: this.crossfadeSeconds,
        ...patch,
      })
      this.mode = next.mode
      this.crossfadeSeconds = next.crossfadeSeconds
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
    },
  },
})
