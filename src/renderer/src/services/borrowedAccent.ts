// Kept out of stores/appearance.ts: Now Playing lends its colour on the
// party guest page too, which must not bundle the app's stores.
import { appAccent } from '@/services/appAccent'
import { hexToTriplet, towardsContrast, tripletToHex } from '@/services/themeColors'
import { dayTheme, nightTheme, themeDefinitions, type ThemePreference } from '@/plugins/theme'

// A borrowed accent on a light page: as far towards black as it takes to
// read there, the same floor the presets' own accents keep.
const BORROWED_ACCENT_CONTRAST = 4.5

/** What borrowAccent() last lent, for applyThemePreference() to lend again. */
let borrowed: string | null = null

export function lentAccent(): string | null {
  return borrowed
}

export type ThemeColorsTable = Record<string, { colors: Record<string, unknown> }>

/**
 * Puts an "r, g, b" colour into the theme's primary - Now Playing's
 * artwork colour, which the whole app's accent follows while it is open -
 * or, with null, gives the theme its own back. The night theme takes the
 * colour as it is (it was picked to stand off a dark picture); a light
 * theme gets it darkened until it reads on the page.
 *
 * Goes through the theme objects rather than --v-theme-primary directly so
 * Vuetify re-derives `on-primary` with it.
 */
export function borrowAccent(
  themes: ThemeColorsTable,
  preference: ThemePreference,
  color: string | null,
): void {
  borrowed = color
  const definitions = themeDefinitions(preference)
  const night = nightTheme(preference)
  for (const name of new Set([preference.theme, night, dayTheme(preference)])) {
    const own = definitions[name]!.colors!
    const target = themes[name]?.colors
    if (!target) continue
    if (color === null) {
      target.primary = own.primary
    } else if (name === night) {
      target.primary = tripletToHex(color)
    } else {
      target.primary = towardsContrast(
        tripletToHex(color),
        own.background as string,
        BORROWED_ACCENT_CONTRAST,
      )
    }
  }
  const current = themes[preference.theme]?.colors.primary
  appAccent.value =
    typeof current === 'string'
      ? hexToTriplet(current)
      : (color ?? hexToTriplet(definitions[preference.theme]!.colors!.primary as string))
}
