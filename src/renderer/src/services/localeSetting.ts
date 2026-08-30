/** The stored/synced half of the language setting — kept out of i18n/
 * index.ts on purpose (see LOCALE_STORAGE_KEY's comment there: that module
 * can't reach services/accountKey.ts without a circular import, and it
 * runs createI18n() at load time).
 *
 * Account-scoped in localStorage like every other device-local setting
 * (services/accountKey.ts) *and* server-synced (services/connect/
 * accountSettings.ts). Both, not either: the scoped local key is what
 * keeps two accounts sharing one device apart even before/without a sync,
 * the server copy is what carries one person's choice to their other
 * devices. */

import { accountScopedKey } from '@/services/accountKey'
import { pushAccountSettings } from '@/services/connect/accountSettings'
import {
  applyLocale,
  browserLocale,
  getLocale,
  LOCALE_STORAGE_KEY,
  parseLocale,
  type SupportedLocale,
} from '@/i18n'

function persist(locale: SupportedLocale): void {
  try {
    localStorage.setItem(accountScopedKey(LOCALE_STORAGE_KEY), locale)
  } catch {
    // Non-critical — worst case the preference doesn't survive to the next
    // launch.
  }
}

/** Applies and remembers a locale *without* pushing it back to connect —
 * for accountScopedStores.ts's pull, where the value came from the server
 * in the first place. */
export function adoptLocale(locale: SupportedLocale): void {
  applyLocale(locale)
  persist(locale)
}

/** A deliberate language change (SettingsView.vue). */
export function setLocale(locale: SupportedLocale): void {
  adoptLocale(locale)
  // Best-effort — a language preference should follow the account across
  // devices (see services/connect/accountSettings.ts).
  void pushAccountSettings({ locale }).catch(() => {})
}

/** Re-reads the language from *this* account's own key on login/account
 * switch — the boot-time detectLocale() could only read the un-namespaced
 * one, since it runs before Pinia. Falls back to the browser's language
 * rather than leaving the previous account's choice in place: an account
 * that never picked a language hasn't implicitly picked the other
 * account's. Deliberately does not push — this is a local read, not a
 * change anyone made. */
export function reloadLocaleForAccount(): void {
  const stored = parseLocale(localStorage.getItem(accountScopedKey(LOCALE_STORAGE_KEY)))
  const next = stored ?? browserLocale()
  if (next !== getLocale()) applyLocale(next)
}
