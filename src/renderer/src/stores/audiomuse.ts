import { defineStore } from 'pinia'
import { getAudioMuseStatus, type AudioMuseStatus } from '@/services/connect/audiomuse'

// How long an answer about whether AudioMuse can be used holds. Asked right
// after login (stores/auth.ts) and refreshed when a song menu opens or
// Autoplay runs on an old answer. A "no" is kept shorter so a fixed setting
// or a restarted AudioMuse shows up soon.
const AVAILABLE_TTL_MS = 5 * 60_000
const UNAVAILABLE_TTL_MS = 30_000

let pending: Promise<boolean> | null = null

/** Whether AudioMuse-AI answers for this session (docs/plans/audiomuse.md).
 * Autoplay and the radios use it when it does and fall back on their own
 * when it does not; only Discovery Radio exists solely because of it. */
export const useAudioMuseStore = defineStore('audiomuse', {
  state: () => ({
    status: null as AudioMuseStatus | null,
    checkedAt: 0,
  }),
  getters: {
    available: (state): boolean => state.status?.available === true,
  },
  actions: {
    /** The current answer, asking connect when the last one has run out. */
    async ensure(now = Date.now()): Promise<boolean> {
      const ttl = this.available ? AVAILABLE_TTL_MS : UNAVAILABLE_TTL_MS
      if (this.status && now - this.checkedAt < ttl) return this.available
      if (!pending) {
        pending = getAudioMuseStatus()
          .catch((): AudioMuseStatus => ({ available: false, reason: 'unreachable' }))
          .then((status) => {
            this.status = status
            this.checkedAt = now
            return status.available
          })
          .finally(() => {
            pending = null
          })
      }
      return pending
    },
    /** What is known right now, without waiting: Autoplay and the radios
     * must not hold a song change up for a status check. A stale or missing
     * answer is refreshed in the background for the next time. */
    usable(now = Date.now()): boolean {
      const ttl = this.available ? AVAILABLE_TTL_MS : UNAVAILABLE_TTL_MS
      if (!this.status || now - this.checkedAt >= ttl) void this.ensure(now)
      return this.available
    },
    /** After Settings changed, an account change, or a mix that failed:
     * the next ensure() asks again. */
    reset(): void {
      this.status = null
      this.checkedAt = 0
    },
  },
})
