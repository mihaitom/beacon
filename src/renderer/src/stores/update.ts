import { defineStore } from 'pinia'
import { checkForUpdate } from '@/services/updateCheck'
import { accountScopedKey } from '@/services/accountKey'

const DISMISSED_VERSION_KEY = 'beacon.update-dismissed-version'
const SNOOZED_UNTIL_KEY = 'beacon.update-snoozed-until'

// "Remind me later" (UpdateToast.vue) re-asks after this long rather than
// just "next app launch" — a session that stays open for days (Electron
// left running, or a browser tab never closed) would otherwise never see
// the toast again despite explicitly asking to be reminded.
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000

interface UpdateState {
  available: boolean
  latestVersion: string | null
  releaseUrl: string | null
  // Seeded from localStorage once here (not read live in the shouldNotify
  // getter below) — a getter only re-runs when a *reactive* dependency it
  // read changes, and localStorage isn't one; dismiss()/snooze() write
  // through to both this state and localStorage so shouldNotify actually
  // reacts to them immediately instead of only after some unrelated
  // reactive change happens to force a re-evaluation.
  dismissedVersion: string | null
  snoozedUntil: number
}

export const useUpdateStore = defineStore('update', {
  state: (): UpdateState => ({
    available: false,
    latestVersion: null,
    releaseUrl: null,
    dismissedVersion: localStorage.getItem(accountScopedKey(DISMISSED_VERSION_KEY)),
    snoozedUntil: Number(localStorage.getItem(accountScopedKey(SNOOZED_UNTIL_KEY)) ?? 0),
  }),
  getters: {
    /** Whether UpdateToast.vue should actually be showing right now —
     * `available` alone isn't enough once dismiss/snooze enter the
     * picture. Settings' own always-on alert (SettingsView.vue) reads
     * `available` directly instead of this — it's a passive "is one
     * currently out there" fact, not a proactive interruption, so it stays
     * accurate regardless of whether the toast was dismissed/snoozed. */
    shouldNotify(state): boolean {
      if (!state.available || !state.latestVersion) return false
      if (state.dismissedVersion === state.latestVersion) return false
      return Date.now() >= state.snoozedUntil
    },
  },
  actions: {
    async check(): Promise<void> {
      const result = await checkForUpdate()
      this.available = result.available
      this.latestVersion = result.latestVersion
      this.releaseUrl = result.releaseUrl
    },
    /** X on the toast — never mention this specific version again. A
     * *newer* version than this still notifies normally once one exists;
     * only an exact re-check of the same latestVersion is suppressed. */
    dismiss(): void {
      if (!this.latestVersion) return
      this.dismissedVersion = this.latestVersion
      localStorage.setItem(accountScopedKey(DISMISSED_VERSION_KEY), this.latestVersion)
    },
    /** "Remind me later" — re-shows after SNOOZE_DURATION_MS regardless of
     * which version is latest by then, unlike dismiss() which is pinned to
     * one specific version string. */
    snooze(): void {
      this.snoozedUntil = Date.now() + SNOOZE_DURATION_MS
      localStorage.setItem(accountScopedKey(SNOOZED_UNTIL_KEY), String(this.snoozedUntil))
    },
    /** Re-derives dismissedVersion/snoozedUntil for whichever account is
     * *actually* logged in — see services/accountKey.ts's onAccountChange().
     * This store gets created at app boot (App.vue's created()), before
     * login/restore() has resolved an account, so the state() read above
     * runs too early to see the real account's own dismiss/snooze state. */
    reload(): void {
      this.dismissedVersion = localStorage.getItem(accountScopedKey(DISMISSED_VERSION_KEY))
      this.snoozedUntil = Number(localStorage.getItem(accountScopedKey(SNOOZED_UNTIL_KEY)) ?? 0)
    },
  },
})
