import { createI18n } from 'vue-i18n'
import de from './locales/de'
import en from './locales/en'
import es from './locales/es'
import fr from './locales/fr'
import it from './locales/it'

export const SUPPORTED_LOCALES = ['de', 'en', 'es', 'fr', 'it'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

const STORAGE_KEY = 'beacon.locale'

function detectLocale(): SupportedLocale {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && SUPPORTED_LOCALES.includes(stored as SupportedLocale)) {
    return stored as SupportedLocale
  }
  const browserLang = navigator.language.slice(0, 2)
  return SUPPORTED_LOCALES.includes(browserLang as SupportedLocale)
    ? (browserLang as SupportedLocale)
    : 'en'
}

export const i18n = createI18n({
  legacy: true,
  globalInjection: true,
  locale: detectLocale(),
  fallbackLocale: 'en',
  messages: { de, en, es, fr, it },
})

export function setLocale(locale: SupportedLocale): void {
  // legacy:true means i18n.global is a Composer-like instance whose
  // `.locale` is a plain string, not a Ref (that's only the composition-mode shape).
  ;(i18n.global.locale as unknown as string) = locale
  localStorage.setItem(STORAGE_KEY, locale)
  document.documentElement.setAttribute('lang', locale)
}

export function getLocale(): SupportedLocale {
  return i18n.global.locale as unknown as SupportedLocale
}
