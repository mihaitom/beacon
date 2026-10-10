import { defineStore } from 'pinia'
import { checkForUpdate } from '@/services/updateCheck'
import { accountScopedKey } from '@/services/accountKey'

// The key predates the dot - it held the version an update toast was
// dismissed for - and is kept so a version already dismissed there does not
// light the dot up again.
const SEEN_VERSION_KEY = 'beacon.update-dismissed-version'

interface UpdateState {
  available: boolean
  latestVersion: string | null
  releaseUrl: string | null
  // Seeded from localStorage once here (not read live in the unseen getter
  // below) — a getter only re-runs when a *reactive* dependency it read
  // changes, and localStorage isn't one; markSeen() writes through to both
  // this state and localStorage so the dot goes out immediately.
  seenVersion: string | null
}

export const useUpdateStore = defineStore('update', {
  state: (): UpdateState => ({
    available: false,
    latestVersion: null,
    releaseUrl: null,
    seenVersion: localStorage.getItem(accountScopedKey(SEEN_VERSION_KEY)),
  }),
  getters: {
    /** Whether the dot on the settings button should show: a newer version
     * exists and Settings hasn't been opened since it appeared. Settings'
     * own notice (AboutSection.vue) reads `available` instead - it states
     * a fact, and stays for as long as that fact holds. */
    unseen(state): boolean {
      if (!state.available || !state.latestVersion) return false
      return state.seenVersion !== state.latestVersion
    },
  },
  actions: {
    async check(): Promise<void> {
      const result = await checkForUpdate()
      this.available = result.available
      this.latestVersion = result.latestVersion
      this.releaseUrl = result.releaseUrl
    },
    /** Settings has shown the notice for this version. A *newer* version
     * lights the dot again; only this exact one is done with. */
    markSeen(): void {
      if (!this.latestVersion) return
      this.seenVersion = this.latestVersion
      localStorage.setItem(accountScopedKey(SEEN_VERSION_KEY), this.latestVersion)
    },
    /** Re-derives seenVersion for whichever account is *actually* logged in
     * — see services/accountKey.ts's onAccountChange(). This store gets
     * created at app boot (App.vue's created()), before login/restore() has
     * resolved an account, so the state() read above runs too early to see
     * the real account's own value. */
    reload(): void {
      this.seenVersion = localStorage.getItem(accountScopedKey(SEEN_VERSION_KEY))
    },
  },
})
