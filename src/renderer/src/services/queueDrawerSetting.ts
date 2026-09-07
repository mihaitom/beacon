/** Whether the queue drawer is open, remembered per device.
 *
 * It did not use to be remembered at all: the drawer shared a store with a
 * second, transient one (the lyrics drawer, gone since 2026-09-06) whose
 * whole point was that it came and went with a peek. With the queue drawer
 * the only one left, "open" is a working arrangement rather than a moment -
 * somebody who keeps the queue beside the library wants it there again next
 * time, not one click away on every start.
 *
 * Device-local and account-scoped like the sidebar's own collapsed state
 * (services/sidebarSetting.ts), and for the same reason: this belongs to
 * the window, not to the account signed into it. */

import { accountScopedKey } from '@/services/accountKey'

const STORAGE_KEY = 'beacon.queueDrawerOpen'

/** Closed by default - the app has always started this way, and an empty
 * queue behind a drawer somebody never opened is not worth the screen. */
export function loadQueueDrawerOpen(): boolean {
  try {
    return localStorage.getItem(accountScopedKey(STORAGE_KEY)) === 'true'
  } catch {
    // Storage unavailable (private mode, blocked site data) - the drawer
    // still works, it just starts closed every time.
    return false
  }
}

export function saveQueueDrawerOpen(open: boolean): void {
  try {
    localStorage.setItem(accountScopedKey(STORAGE_KEY), String(open))
  } catch {
    // The drawer still opens and closes for this session; it just won't be
    // where it was left next time. Not worth surfacing.
  }
}
