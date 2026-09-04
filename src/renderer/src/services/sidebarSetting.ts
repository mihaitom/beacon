/** Whether the navigation rail is collapsed to icons, remembered per
 * device.
 *
 * It used to expand on hover instead of being switched, which meant the
 * layout moved whenever the pointer crossed the left edge on its way
 * somewhere else — and gave no way to simply keep the labels visible.
 * Device-local, and account-scoped like every other setting of that kind
 * (see services/accountKey.ts): two people sharing a machine have no reason
 * to share a sidebar width, and this one belongs to the window rather than
 * to the account it is signed into. */

import { accountScopedKey } from '@/services/accountKey'

const STORAGE_KEY = 'beacon.sidebarCollapsed'

/** Collapsed by default: what the rail has always shown at rest, so an
 * existing install opens looking exactly as it did. */
export function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(accountScopedKey(STORAGE_KEY)) !== 'false'
  } catch {
    // Storage unavailable (private mode, blocked site data) — the rail
    // still works, it just starts collapsed every time.
    return true
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(accountScopedKey(STORAGE_KEY), String(collapsed))
  } catch {
    // The setting still applies for this session; it just won't survive a
    // reload. Not worth surfacing.
  }
}
