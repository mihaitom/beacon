import { defineStore } from 'pinia'
import { accountScopedKey } from '@/services/accountKey'

const ENABLED_KEY = 'beacon.advanced-mode'

/**
 * Whether Settings shows the things that take setting up.
 *
 * The person who runs the music server is often not the person listening
 * to it: a household shares one Navidrome, and the interface everyone else
 * uses should not carry the parts only its administrator will ever touch.
 * The dividing line is how much work something is to *put in place*, not
 * who is allowed to use it - registering an application with Last.fm to
 * get an API key is the kind of errand that belongs behind this, while the
 * playlist builder that key enables is not. So this only ever hides
 * setup: anything already configured stays available to everyone.
 *
 * Deliberately not derived from the media server's admin flag
 * (authStore.isAdmin, which gates the library scan and the log level).
 * Being an administrator says what an account may do, not whether its
 * owner wants to fill in API keys - and on a household that shares one
 * login it says nothing at all.
 *
 * Device-local rather than synced to the account, unlike most settings
 * here. Two reasons, and they point the same way: a shared family login
 * would otherwise put everyone in the same bucket, and the two mistakes
 * are not equally bad. Having to switch it on again on a second device is
 * a minor annoyance; having it arrive switched on for someone it was meant
 * to stay hidden from defeats the point.
 */
function loadEnabled(): boolean {
  try {
    return localStorage.getItem(accountScopedKey(ENABLED_KEY)) === 'true'
  } catch {
    return false
  }
}

export const useAdvancedModeStore = defineStore('advancedMode', {
  state: () => ({
    enabled: loadEnabled(),
  }),
  actions: {
    setEnabled(value: boolean): void {
      this.enabled = value
      try {
        localStorage.setItem(accountScopedKey(ENABLED_KEY), String(value))
      } catch {
        // Non-critical — worst case it has to be switched on again.
      }
    },

    /** Re-reads this account's own stored value — see
     * services/accountScopedStores.ts. */
    reloadForAccount(): void {
      this.enabled = loadEnabled()
    },
  },
})
