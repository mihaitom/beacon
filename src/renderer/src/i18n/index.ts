import { createI18n } from 'vue-i18n'
import de from './locales/de'
import en from './locales/en'
import es from './locales/es'
import fr from './locales/fr'
import it from './locales/it'

export const SUPPORTED_LOCALES = ['de', 'en', 'es', 'fr', 'it'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/** Base key only — the account-scoped read/write lives in
 * services/localeSetting.ts, which is where anything that needs a *stored*
 * language should go. This module deliberately knows nothing about
 * accounts: services/accountKey.ts imports stores/auth.ts, which reaches
 * stores/playback.ts, which imports this very module back — a static
 * import here would be a real circular import, and this module runs
 * createI18n() at load time. */
export const LOCALE_STORAGE_KEY = 'beacon.locale'

export function parseLocale(value: null | string): null | SupportedLocale {
  return value && SUPPORTED_LOCALES.includes(value as SupportedLocale)
    ? (value as SupportedLocale)
    : null
}

/** What the browser itself suggests — the fallback for an account that has
 * never picked a language, rather than whichever language the account
 * before it happened to pick. */
export function browserLocale(): SupportedLocale {
  return parseLocale(navigator.language.slice(0, 2)) ?? 'en'
}

/** Runs at module load, i.e. before Pinia exists, so it can only read the
 * un-namespaced key. That's fine and intentional: it just gets the app to
 * *a* sensible language for the login screen, and localeSetting.ts's
 * reloadLocaleForAccount() re-reads it account-scoped the moment login
 * resolves. */
function detectLocale(): SupportedLocale {
  return parseLocale(localStorage.getItem(LOCALE_STORAGE_KEY)) ?? browserLocale()
}

export const i18n = createI18n({
  legacy: true,
  globalInjection: true,
  locale: detectLocale(),
  fallbackLocale: 'en',
  messages: { de, en, es, fr, it },
})

/** Switches the live language without remembering or syncing it — see
 * services/localeSetting.ts for the callers that also persist. */
export function applyLocale(locale: SupportedLocale): void {
  // legacy:true means i18n.global is a Composer-like instance whose
  // `.locale` is a plain string, not a Ref (that's only the composition-mode shape).
  ;(i18n.global.locale as unknown as string) = locale
  document.documentElement.setAttribute('lang', locale)
}

export function getLocale(): SupportedLocale {
  return i18n.global.locale as unknown as SupportedLocale
}
